// Asio.cs — Uscita ASIO (driver delle schede audio professionali) con NAudio. Il motore continua
// a renderizzare sul suo thread; il driver preleva i campioni dal buffer ad anello (Pull).

using DrumBort.Host;
using NAudio.Wave;

namespace DrumBort.Win;

public static class Asio
{
    static AsioOut? asio;
    public static string? Driver { get; private set; }
    public static int Frames => asio?.FramesPerBuffer ?? 0;

    public static string[] Drivers()
    {
        try { return AsioOut.GetDriverNames(); } catch { return Array.Empty<string>(); }
    }

    public static void Start(AudioEngine e, string driver)
    {
        Close();
        var o = new AsioOut(driver);
        try
        {
            if (!o.IsSampleRateSupported(e.Ctx.SampleRate)) throw new InvalidOperationException($"Il driver non supporta {e.Ctx.SampleRate} Hz");
            o.Init(new Provider(e));
            e.AttachExternal($"ASIO · {driver}", o.FramesPerBuffer);
            o.Play();
        }
        catch
        {
            try { o.Dispose(); } catch { }
            e.DetachExternal();
            throw;
        }
        asio = o; Driver = driver;
        Settings.Save("asio", driver);
        Console.WriteLine($"Audio: ASIO {driver} · {e.Ctx.SampleRate} Hz · buffer {o.FramesPerBuffer} frame");
    }

    static void Close()
    {
        if (asio == null) return;
        try { asio.Stop(); asio.Dispose(); } catch { }
        asio = null; Driver = null;
    }

    /// <summary>Torna all'uscita di Windows (WASAPI).</summary>
    public static void Stop(AudioEngine e)
    {
        Close();
        Settings.Save("asio", "");
        e.DetachExternal();
    }

    public static void ShowPanel() { try { asio?.ShowControlPanel(); } catch { } }

    sealed class Provider : IWaveProvider
    {
        readonly AudioEngine e;
        float[] tmp = new float[4096];
        public Provider(AudioEngine e) { this.e = e; WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(e.Ctx.SampleRate, 2); }
        public WaveFormat WaveFormat { get; }
        public int Read(byte[] buffer, int offset, int count)
        {
            int frames = count / 8;
            if (tmp.Length < frames * 2) tmp = new float[frames * 2];
            e.Pull(tmp, frames);
            Buffer.BlockCopy(tmp, 0, buffer, offset, frames * 8);
            return frames * 8;
        }
    }
}
