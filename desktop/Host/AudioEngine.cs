// AudioEngine.cs — Thread di rendering dedicato + buffer ad anello verso PortAudio.
// Tutto il motore (grafo, mixer, sequencer) vive sul thread di rendering: i comandi dalla rete
// arrivano come azioni in coda e vengono eseguiti all'inizio di ogni blocco.

using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using DrumBort.Audio;
using DrumBort.Engine;
using PortAudioSharp;
using PaStream = PortAudioSharp.Stream;

namespace DrumBort.Host;

public sealed class AudioEngine : IDisposable
{
    public readonly AudioContext Ctx;
    public readonly Mixer Mx;
    public readonly Sequencer Seq;
    readonly ConcurrentQueue<Action> inbox = new();
    readonly float[] ringL, ringR;
    int capacity;                  // frame bufferizzati (latenza); il ring è più grande per poterla alzare
    int baseCapacity;
    long written, read;            // contatori di frame (scrittura: render, lettura: callback)
    readonly AutoResetEvent wake = new(false);
    Thread? thread;
    volatile bool running;
    PaStream? stream;
    readonly float[] bl = new float[AudioContext.Block], br = new float[AudioContext.Block];
    public long Underruns;
    public double RenderLoad;      // frazione del tempo reale usata dal rendering (media mobile)

    public AudioEngine(int sampleRate, int bufferFrames)
    {
        Ctx = new AudioContext(sampleRate);
        PeriodicWave.Builtin("sine");
        Synth.Warm(Ctx.Nyquist);
        Wavetable.Warm(Ctx.Nyquist);
        Mx = new Mixer(Ctx);
        if (Environment.GetEnvironmentVariable("DRUMBORT_NOCACHE") != "1") Mx.Cache = new VoiceCache(sampleRate);
        Seq = new Sequencer(Mx);
        capacity = baseCapacity = Math.Max(AudioContext.Block * 2, bufferFrames);
        ringL = new float[Math.Max(capacity, 2048) * 2]; ringR = new float[Math.Max(capacity, 2048) * 2];
    }

    /// <summary>Esegue un'azione sul thread audio prima del prossimo blocco.</summary>
    public void Post(Action a) => inbox.Enqueue(a);

    void RenderOne()
    {
        while (inbox.TryDequeue(out var a))
        {
            try { a(); } catch (Exception e) { Console.Error.WriteLine($"[engine] {e.Message}"); }
        }
        Seq.Run();
        Ctx.RenderBlock(bl, br, 0);
        Mx.AfterBlock();
    }

    /// <summary>Rendering offline (test ed export): `seconds` di audio stereo.</summary>
    public (float[] l, float[] r) RenderOffline(double seconds)
    {
        int frames = (int)(seconds * Ctx.SampleRate);
        frames -= frames % AudioContext.Block;
        var l = new float[frames]; var r = new float[frames];
        for (int i = 0; i < frames; i += AudioContext.Block)
        {
            RenderOne();
            Array.Copy(bl, 0, l, i, AudioContext.Block);
            Array.Copy(br, 0, r, i, AudioContext.Block);
        }
        return (l, r);
    }

    /// <summary>Export: rendering finché il sequencer suona (StopAt), poi `tail` secondi di coda.</summary>
    public (float[] l, float[] r) RenderSong(double tail, double maxSeconds, Action<double>? progress, CancellationToken ct)
    {
        var L = new List<float[]>(); var R = new List<float[]>();
        double end = double.MaxValue;
        long blocks = 0;
        while (Ctx.CurrentTime < end && Ctx.CurrentTime < maxSeconds)
        {
            ct.ThrowIfCancellationRequested();
            RenderOne();
            L.Add((float[])bl.Clone()); R.Add((float[])br.Clone());
            if (!Seq.Playing && end == double.MaxValue) end = Seq.EndTime + tail;
            if (++blocks % 256 == 0) progress?.Invoke(Ctx.CurrentTime);
        }
        int n = L.Count * AudioContext.Block;
        var l = new float[n]; var r = new float[n];
        for (int i = 0; i < L.Count; i++) { Array.Copy(L[i], 0, l, i * AudioContext.Block, AudioContext.Block); Array.Copy(R[i], 0, r, i * AudioContext.Block, AudioContext.Block); }
        return (l, r);
    }

    void Loop()
    {
        var sw = new System.Diagnostics.Stopwatch();
        double blockSec = AudioContext.Block / (double)Ctx.SampleRate;
        while (running)
        {
            if (written - Interlocked.Read(ref read) + AudioContext.Block > capacity) { wake.WaitOne(5); continue; }
            sw.Restart();
            RenderOne();
            int w = (int)(written % ringL.Length);
            for (int i = 0; i < AudioContext.Block; i++)
            {
                int k = (w + i) % ringL.Length;
                ringL[k] = Math.Clamp(bl[i], -1f, 1f);
                ringR[k] = Math.Clamp(br[i], -1f, 1f);
            }
            Interlocked.Add(ref written, AudioContext.Block);
            RenderLoad = RenderLoad * 0.99 + 0.01 * (sw.Elapsed.TotalSeconds / blockSec);
            Mx.Load = RenderLoad;
        }
    }

    StreamCallbackResult Callback(IntPtr input, IntPtr output, uint frames, ref StreamCallbackTimeInfo ti, StreamCallbackFlags flags, IntPtr user)
    {
        var tmp = cbBuf.Length >= frames * 2 ? cbBuf : cbBuf = new float[frames * 2];
        long avail = Interlocked.Read(ref written) - read;
        int n = (int)Math.Min(avail, frames);
        for (int i = 0; i < n; i++)
        {
            int k = (int)((read + i) % ringL.Length);
            tmp[2 * i] = ringL[k]; tmp[2 * i + 1] = ringR[k];
        }
        if (n < frames) { Array.Clear(tmp, 2 * n, (int)(2 * (frames - n))); Underruns++; }
        Interlocked.Add(ref read, n);
        Marshal.Copy(tmp, 0, output, (int)frames * 2);
        wake.Set();
        return StreamCallbackResult.Continue;
    }
    float[] cbBuf = new float[4096];

    // =================================================================
    // Uscita audio: scelta del dispositivo e cambio a caldo
    // =================================================================
    readonly object paLock = new();
    string? wantName;                    // dispositivo scelto (per nome: gli indici cambiano)
    public string CurrentDevice { get; private set; } = "";
    public bool FollowDefault => wantName == null;
    /// <summary>Notifica di cambio uscita (per i dispositivi collegati).</summary>
    public event Action<string>? DeviceChanged;
    Timer? watch;


    // ---------------------------------------------------------------- latenza e uscite esterne
    /// <summary>Windows: WASAPI esclusivo (latenza minima, l'app usa la scheda da sola).</summary>
    public bool Exclusive { get; private set; } = Settings.Load("exclusive") == "1";
    /// <summary>Buffer di uscita in campioni (latenza = buffer / frequenza).</summary>
    public int BufferFrames => baseCapacity;
    public bool ExclusiveActive { get; private set; }

    /// <summary>Imposta buffer e modalità esclusiva e riapre l'uscita.</summary>
    public void SetLatency(int frames, bool exclusive)
    {
        baseCapacity = Math.Clamp(frames, 64, 4096);
        Exclusive = exclusive && OperatingSystem.IsWindows();
        Settings.Save("buffer", baseCapacity.ToString());
        Settings.Save("exclusive", Exclusive ? "1" : "0");
        if (External == null) Reopen(); else capacity = baseCapacity;
    }

    /// <summary>Uscita esterna (ASIO): PortAudio chiuso, il driver chiama Pull().</summary>
    public string? External { get; private set; }
    public void AttachExternal(string name, int frames)
    {
        lock (paLock)
        {
            try { stream?.Stop(); stream?.Dispose(); } catch { }
            stream = null;
            External = name;
            capacity = Math.Max(AudioContext.Block * 2, frames * 2);
            CurrentDevice = name;
        }
        DeviceChanged?.Invoke(CurrentDevice);
    }
    public void DetachExternal()
    {
        if (External == null) return;
        External = null;
        Reopen();
    }
    /// <summary>Campioni stereo interlacciati per un'uscita esterna (thread del driver).</summary>
    public void Pull(float[] dst, int frames)
    {
        long avail = Interlocked.Read(ref written) - read;
        int n = (int)Math.Min(avail, frames);
        for (int i = 0; i < n; i++)
        {
            int k = (int)((read + i) % ringL.Length);
            dst[2 * i] = ringL[k]; dst[2 * i + 1] = ringR[k];
        }
        if (n < frames) { Array.Clear(dst, 2 * n, 2 * (frames - n)); Underruns++; }
        Interlocked.Add(ref read, n);
        wake.Set();
    }

    /// <summary>API host usata: WASAPI su Windows (latenza bassa e stabile), altrimenti quella predefinita.</summary>
    int HostApi() => OperatingSystem.IsWindows() && !noWasapi ? PaHost.Index(PaHost.WASAPI) : -1;
    bool noWasapi;                       // WASAPI non ha aperto l'uscita: si usa l'API predefinita (MME)

    /// <summary>Uscite stereo dell'API host in uso (su Windows ogni dispositivo compare una volta sola).</summary>
    IEnumerable<int> Outputs()
    {
        int api = HostApi();
        for (int i = 0; i < PortAudio.DeviceCount; i++)
        {
            var d = PortAudio.GetDeviceInfo(i);
            if (d.maxOutputChannels >= 2 && (api < 0 || d.hostApi == api)) yield return i;
        }
    }
    int DefaultOut()
    {
        int api = HostApi();
        int d = api >= 0 ? PaHost.DefaultOutput(api) : -1;
        return d >= 0 ? d : PortAudio.DefaultOutputDevice;
    }

    void OpenStream()
    {
        try { OpenOn(HostApi()); }
        catch (Exception e) when (HostApi() >= 0)
        {
            // WASAPI rifiuta il formato o il dispositivo: si ripiega sull'API predefinita
            Console.Error.WriteLine($"[audio] WASAPI: {e.Message} — uso l'API predefinita");
            noWasapi = true;
            OpenOn(-1);
        }
    }

    void OpenOn(int api)
    {
        int dev = -1;
        if (wantName != null)
            foreach (int i in Outputs())
                if (SameName(PortAudio.GetDeviceInfo(i).name, wantName)) { dev = i; break; }
        if (dev < 0) dev = DefaultOut();
        if (dev == PortAudio.NoDevice || dev < 0) throw new InvalidOperationException("Nessun dispositivo audio di uscita");
        var info = PortAudio.GetDeviceInfo(dev);
        bool wasapi = api >= 0 && info.hostApi == api;
        // MME chiama la callback a raffiche: serve più margine nel buffer di rendering
        capacity = OperatingSystem.IsWindows() && !wasapi ? Math.Max(baseCapacity, 2048) : baseCapacity;
        ExclusiveActive = false;
        if (wasapi && Exclusive)
        {
            // Esclusivo: buffer del driver = buffer scelto; se il formato non è accettato si torna al condiviso
            IntPtr ex = PaHost.WasapiInfo(true);
            try
            {
                var pe = new StreamParameters { device = dev, channelCount = 2, sampleFormat = SampleFormat.Float32, suggestedLatency = baseCapacity / (double)Ctx.SampleRate, hostApiSpecificStreamInfo = ex };
                stream = new PaStream(null, pe, Ctx.SampleRate, (uint)Math.Min(baseCapacity, 1024), StreamFlags.ClipOff, Callback, null!);
                stream.Start();
                ExclusiveActive = true;
            }
            catch (Exception e) { try { stream?.Dispose(); } catch { } stream = null; Console.Error.WriteLine($"[audio] WASAPI esclusivo non disponibile: {e.Message} — uso il condiviso"); }
            finally { Marshal.FreeHGlobal(ex); }
        }
        IntPtr extra = wasapi && !ExclusiveActive ? PaHost.WasapiInfo() : IntPtr.Zero;
        if (!ExclusiveActive)
            try
            {
                // Latenza: almeno 20 ms (WASAPI) o quella "alta" del driver (MME/DirectSound) per evitare crepitii
                double lat = wasapi ? Math.Max(Math.Min(0.02, baseCapacity / (double)Ctx.SampleRate), info.defaultLowOutputLatency)
                    : OperatingSystem.IsWindows() ? info.defaultHighOutputLatency : info.defaultLowOutputLatency;
                var p = new StreamParameters
                {
                    device = dev, channelCount = 2, sampleFormat = SampleFormat.Float32,
                    suggestedLatency = lat, hostApiSpecificStreamInfo = extra,
                };
                stream = new PaStream(null, p, Ctx.SampleRate, wasapi ? 0u : 256u, StreamFlags.ClipOff, Callback, null!);
                stream.Start();
            }
            catch { try { stream?.Dispose(); } catch { } stream = null; throw; }
            finally { if (extra != IntPtr.Zero) Marshal.FreeHGlobal(extra); }
        CurrentDevice = info.name;
        Console.WriteLine($"Audio: {info.name}{(wasapi ? ExclusiveActive ? " · WASAPI esclusivo" : " · WASAPI" : "")} · {Ctx.SampleRate} Hz · buffer {capacity} frame ({1000.0 * capacity / Ctx.SampleRate:0} ms)");
    }

    /// <summary>MME tronca i nomi a 31 caratteri: un nome salvato da un'altra API resta riconoscibile.</summary>
    static bool SameName(string a, string b) => a == b || (Math.Min(a.Length, b.Length) >= 31 && (a.StartsWith(b) || b.StartsWith(a)));

    /// <summary>Chiude e riapre PortAudio (rilegge i dispositivi collegati nel frattempo) e l'uscita.</summary>
    void Reopen()
    {
        if (External != null) return;
        lock (paLock)
        {
            try { stream?.Stop(); stream?.Dispose(); } catch { /* già chiuso */ }
            stream = null;
            try { PortAudio.Terminate(); } catch { }
            PortAudio.Initialize();
            noWasapi = false;
            OpenStream();
        }
        DeviceChanged?.Invoke(CurrentDevice);
    }

    /// <summary>Elenco delle uscite (rilette dal sistema).</summary>
    public List<(int index, string name, string api, bool isDefault)> Devices()
    {
        lock (paLock)
        {
            var list = new List<(int, string, string, bool)>();
            int def = DefaultOut();
            foreach (int i in Outputs())
            {
                var d = PortAudio.GetDeviceInfo(i);
                list.Add((i, d.name, $"API {d.hostApi}", i == def));
            }
            return list;
        }
    }

    /// <summary>Sceglie l'uscita: nome del dispositivo, oppure null per seguire il predefinito.</summary>
    public void SelectDevice(string? name)
    {
        wantName = string.IsNullOrEmpty(name) ? null : name;
        Settings.Save("device", wantName ?? "");
        Reopen();
    }

    /// <summary>Riapre l'uscita rileggendo i dispositivi (es. cuffie appena collegate).</summary>
    public void Refresh() => Reopen();

    /// <summary>Avvia il rendering e l'uscita audio. device: −1 = predefinito (o quello salvato).</summary>
    public void Start(int device = -1)
    {
        running = true;
        thread = new Thread(Loop) { IsBackground = true, Name = "DrumBort audio", Priority = ThreadPriority.Highest };
        thread.Start();
        PortAudio.Initialize();
        if (device >= 0) wantName = PortAudio.GetDeviceInfo(device).name;
        else { var saved = Settings.Load("device"); wantName = string.IsNullOrEmpty(saved) ? null : saved; }
        lock (paLock) OpenStream();
        // Windows: segue il dispositivo predefinito (cuffie collegate/scollegate). Si legge solo l'id
        // dell'uscita predefinita (nessun effetto sull'audio) e si riapre lo stream solo se cambia.
        lastDefault = PaHost.WindowsDefaultId();
        if (lastDefault != null) watch = new Timer(_ => CheckDefault(), null, 2000, 2000);
    }

    string? lastDefault;
    void CheckDefault()
    {
        if (!running) return;
        var now = PaHost.WindowsDefaultId();
        if (now == null || now == lastDefault) return;
        lastDefault = now;
        if (!FollowDefault) return;
        try
        {
            Console.WriteLine("Uscita predefinita di Windows cambiata: riapro l'audio");
            Reopen();
        }
        catch (Exception e) { Console.Error.WriteLine($"[audio] {e.Message}"); }
    }

    /// <summary>Senza scheda audio (test, server): il rendering segue l'orologio di sistema e l'uscita è scartata.</summary>
    public void StartVirtual()
    {
        running = true;
        thread = new Thread(() =>
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            double blockSec = AudioContext.Block / (double)Ctx.SampleRate;
            long blocks = 0;
            while (running)
            {
                double ahead = blocks * blockSec - clock.Elapsed.TotalSeconds;
                if (ahead > 0.02) { Thread.Sleep(5); continue; }
                RenderOne();
                blocks++;
            }
        }) { IsBackground = true, Name = "DrumBort audio (virtuale)" };
        thread.Start();
        Console.WriteLine($"Audio: nessuna uscita (modalità virtuale) · {Ctx.SampleRate} Hz");
    }

    /// <summary>Stato per /host.json (letto da un altro thread: valori indicativi).</summary>
    public object Status() => new
    {
        playing = Seq.Playing, tick = Seq.Tick, slot = Seq.P.Slot, mode = Seq.P.Mode, bpm = Seq.Pattern.Bpm,
        map = Seq.Map, voices = Mx.LiveVoices, cached = Mx.Cache?.Count ?? 0, underruns = Underruns,
        load = Math.Round(RenderLoad, 3), shed = Mx.Shedded,
        steps = Seq.P.Slots[Seq.P.Slot].Steps.Sum(r => r.Count(v => v > 0)),
        kit = Seq.P.Slots[Seq.P.Slot].Kit,
        sounds = Kits.UserSoundCount,
        devices = Seq.P.Devs.Sum(c => c.Length),
    };

    /// <summary>Frequenza di campionamento del dispositivo che verrà aperto (44,1–96 kHz), altrimenti `fallback`.</summary>
    public static int PreferredRate(int fallback)
    {
        try
        {
            PortAudio.Initialize();
            try
            {
                var saved = Settings.Load("device");
                int api = OperatingSystem.IsWindows() ? PaHost.Index(PaHost.WASAPI) : -1;
                int dev = -1;
                for (int i = 0; i < PortAudio.DeviceCount && !string.IsNullOrEmpty(saved); i++)
                {
                    var d = PortAudio.GetDeviceInfo(i);
                    if (d.maxOutputChannels >= 2 && (api < 0 || d.hostApi == api) && SameName(d.name, saved!)) { dev = i; break; }
                }
                if (dev < 0 && api >= 0) dev = PaHost.DefaultOutput(api);
                if (dev < 0) dev = PortAudio.DefaultOutputDevice;
                if (dev < 0 || dev == PortAudio.NoDevice) return fallback;
                int sr = (int)Math.Round(PortAudio.GetDeviceInfo(dev).defaultSampleRate);
                return sr is >= 44100 and <= 96000 ? sr : fallback;
            }
            finally { PortAudio.Terminate(); }
        }
        catch { return fallback; }
    }

    public static void ListDevices()
    {
        PortAudio.Initialize();
        for (int i = 0; i < PortAudio.DeviceCount; i++)
        {
            var d = PortAudio.GetDeviceInfo(i);
            if (d.maxOutputChannels >= 2) Console.WriteLine($"{i,3}  {d.name}  ({d.defaultSampleRate} Hz)");
        }
    }

    public void Dispose()
    {
        running = false;
        watch?.Dispose();
        wake.Set();
        try { stream?.Stop(); stream?.Dispose(); PortAudio.Terminate(); } catch { /* chiusura */ }
    }
}
