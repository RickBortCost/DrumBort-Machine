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
    readonly int capacity;
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
        capacity = Math.Max(AudioContext.Block * 2, bufferFrames);
        ringL = new float[capacity * 2]; ringR = new float[capacity * 2];
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
    int wantDevice = -1;                 // −1 = segue il dispositivo predefinito del sistema
    string? wantName;                    // dispositivo scelto (per nome: gli indici cambiano)
    public string CurrentDevice { get; private set; } = "";
    public bool FollowDefault => wantName == null;
    long lastActivity = Environment.TickCount64;
    /// <summary>Notifica di cambio uscita (per i dispositivi collegati).</summary>
    public event Action<string>? DeviceChanged;
    Timer? watch;

    /// <summary>Attività dal vivo (pad, note): il controllo del dispositivo predefinito aspetta.</summary>
    public void Touch() => lastActivity = Environment.TickCount64;

    void OpenStream()
    {
        int dev = -1;
        if (wantName != null)
            for (int i = 0; i < PortAudio.DeviceCount; i++)
            {
                var d = PortAudio.GetDeviceInfo(i);
                if (d.maxOutputChannels >= 2 && d.name == wantName) { dev = i; break; }
            }
        if (dev < 0) dev = PortAudio.DefaultOutputDevice;
        if (dev == PortAudio.NoDevice) throw new InvalidOperationException("Nessun dispositivo audio di uscita");
        var info = PortAudio.GetDeviceInfo(dev);
        var p = new StreamParameters
        {
            device = dev, channelCount = 2, sampleFormat = SampleFormat.Float32,
            suggestedLatency = info.defaultLowOutputLatency, hostApiSpecificStreamInfo = IntPtr.Zero,
        };
        stream = new PaStream(null, p, Ctx.SampleRate, 256, StreamFlags.ClipOff, Callback, null!);
        stream.Start();
        CurrentDevice = info.name;
        Console.WriteLine($"Audio: {info.name} · {Ctx.SampleRate} Hz · buffer {capacity} frame ({1000.0 * capacity / Ctx.SampleRate:0} ms)");
    }

    /// <summary>Chiude e riapre PortAudio (rilegge i dispositivi collegati nel frattempo) e l'uscita.</summary>
    void Reopen()
    {
        lock (paLock)
        {
            try { stream?.Stop(); stream?.Dispose(); } catch { /* già chiuso */ }
            stream = null;
            try { PortAudio.Terminate(); } catch { }
            PortAudio.Initialize();
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
            int def = PortAudio.DefaultOutputDevice;
            for (int i = 0; i < PortAudio.DeviceCount; i++)
            {
                var d = PortAudio.GetDeviceInfo(i);
                if (d.maxOutputChannels < 2) continue;
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
        // Segue il dispositivo predefinito (cuffie collegate/scollegate): controlla a riposo ogni 4 s
        watch = new Timer(_ => CheckDefault(), null, 4000, 4000);
    }

    void CheckDefault()
    {
        if (!running || !FollowDefault || Seq.Playing || Environment.TickCount64 - lastActivity < 5000) return;
        try
        {
            string? now;
            lock (paLock)
            {
                // PortAudio aggiorna l'elenco solo dopo una nuova inizializzazione: si apre una sessione
                // separata solo per leggere il nome del predefinito
                PortAudio.Terminate(); PortAudio.Initialize();
                int def = PortAudio.DefaultOutputDevice;
                now = def == PortAudio.NoDevice ? null : PortAudio.GetDeviceInfo(def).name;
                if (now == null || now == CurrentDevice)
                {
                    // Stessa uscita: si riapre lo stream (la terminazione l'ha chiuso)
                    try { stream?.Dispose(); } catch { }
                    OpenStream();
                    return;
                }
                try { stream?.Dispose(); } catch { }
                OpenStream();
            }
            Console.WriteLine($"Uscita audio cambiata: {CurrentDevice}");
            DeviceChanged?.Invoke(CurrentDevice);
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
        load = Math.Round(RenderLoad, 3),
        steps = Seq.P.Slots[Seq.P.Slot].Steps.Sum(r => r.Count(v => v > 0)),
        kit = Seq.P.Slots[Seq.P.Slot].Kit,
        sounds = Kits.UserSoundCount,
    };

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
