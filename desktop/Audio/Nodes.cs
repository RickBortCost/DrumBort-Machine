// Nodes.cs — Nodi del grafo: gain, oscillatori band-limited, sorgenti, filtri biquad (formule
// della specifica Web Audio), waveshaper, panner stereo, delay.

namespace DrumBort.Audio;

public sealed class GainNode : AudioNode
{
    public readonly AudioParam GainParam;
    public GainNode(AudioContext c) : base(c) { GainParam = new AudioParam(c, 1); }
    protected override void Process()
    {
        SumInputs(L, R, out bool st);
        Stereo = st;
        GainParam.Compute();
        var g = GainParam.Values;
        if (GainParam.Constant)
        {
            float k = g[0];
            if (k == 1) return;
            for (int i = 0; i < AudioContext.Block; i++) L[i] *= k;
            if (st) for (int i = 0; i < AudioContext.Block; i++) R[i] *= k;
        }
        else
        {
            for (int i = 0; i < AudioContext.Block; i++) L[i] *= g[i];
            if (st) for (int i = 0; i < AudioContext.Block; i++) R[i] *= g[i];
        }
    }
}

/// <summary>Sorgente con start/stop accurati al campione.</summary>
public abstract class SourceNode : AudioNode
{
    public double StartTime = double.MaxValue, StopTime = double.MaxValue;
    public bool Started => StartTime != double.MaxValue;
    protected SourceNode(AudioContext c) : base(c) { c.Scope?.Sources.Add(this); }
    public virtual void Start(double t) { StartTime = Math.Max(0, t); }
    public void Stop(double t) { if (t < StopTime) StopTime = t; }

    /// <summary>Intervallo [from, to) del blocco in cui la sorgente suona; false se mai.</summary>
    protected bool ActiveRange(out int from, out int to)
    {
        double t0 = Ctx.CurrentTime, sr = Ctx.SampleRate;
        from = 0; to = AudioContext.Block;
        if (StartTime == double.MaxValue) return false;
        double sEnd = t0 + AudioContext.Block / sr;
        if (StartTime >= sEnd || StopTime <= t0) return false;
        if (StartTime > t0) from = (int)Math.Ceiling((StartTime - t0) * sr - 1e-9);
        if (StopTime < sEnd) to = (int)Math.Ceiling((StopTime - t0) * sr - 1e-9);
        from = Math.Clamp(from, 0, AudioContext.Block); to = Math.Clamp(to, 0, AudioContext.Block);
        return to > from;
    }
}

/// <summary>Forma d'onda periodica con tabelle band-limited per fascia di frequenza (come PeriodicWave).</summary>
public sealed class PeriodicWave
{
    public const int Size = 4096;
    readonly float[] real, imag;
    // Fasce di 1/6 di ottava: ogni tabella contiene tutte le armoniche sotto Nyquist per la nota più
    // acuta della fascia (niente aliasing, al massimo 1/6 di ottava di brillantezza in meno).
    const int PerOct = 6, Bands = 13 * PerOct;
    readonly float[]?[] tables = new float[Bands + 1][];
    readonly Dictionary<int, float[]> byH = new();
    float norm = 0;

    public PeriodicWave(float[] real, float[] imag) { this.real = real; this.imag = imag; }

    static readonly Dictionary<string, PeriodicWave> builtin = new();
    public static PeriodicWave Builtin(string type)
    {
        lock (builtin)
        {
            if (builtin.TryGetValue(type, out var w)) return w;
            const int N = 2048;
            var re = new float[N]; var im = new float[N];
            for (int n = 1; n < N; n++)
            {
                switch (type)
                {
                    case "square": im[n] = n % 2 == 1 ? 4f / (MathF.PI * n) : 0; break;
                    case "sawtooth": im[n] = (n % 2 == 1 ? 2f : -2f) / (MathF.PI * n); break;
                    case "triangle": im[n] = n % 2 == 1 ? 8f / (MathF.PI * MathF.PI * n * n) * ((n / 2) % 2 == 0 ? 1 : -1) : 0; break;
                    default: im[n] = n == 1 ? 1 : 0; break;
                }
            }
            w = new PeriodicWave(re, im);
            builtin[type] = w;
            return w;
        }
    }

    /// <summary>Un periodo con le armoniche 1…maxH: x[k] = Re Σ (aₙ − i·bₙ)·e^{i2πnk/N} (FFT inversa).</summary>
    float[] Build(int maxH)
    {
        int H = Math.Min(Math.Min(maxH, Size / 2 - 1), Math.Min(real.Length, imag.Length) - 1);
        var re = new double[Size]; var im = new double[Size];
        for (int n = 1; n <= H; n++) { re[n] = real[n]; im[n] = -imag[n]; }
        Fft.Transform(re, im, inverse: true);
        var t = new float[Size + 1];
        for (int i = 0; i < Size; i++) t[i] = (float)re[i];
        t[Size] = t[0];
        return t;
    }

    /// <summary>Pre-calcola tutte le fasce (evita il lavoro durante il rendering).</summary>
    public void Warm(float nyquist)
    {
        for (int j = 0; j <= Bands; j++) TableFor(nyquist / Size * MathF.Pow(2, j / (float)PerOct) * 0.999f, nyquist);
    }

    /// <summary>Tabella per la frequenza f (armoniche sotto Nyquist), normalizzata sul picco a banda piena.</summary>
    public float[] TableFor(float f, float nyquist)
    {
        // Fascia j: fondamentali fino a fMin·2^(j/6), con fMin = Nyquist / Size
        float fMin = nyquist / Size;
        int j = f <= fMin ? 0 : Math.Min(Bands, (int)MathF.Ceiling(PerOct * MathF.Log2(f / fMin)));
        var hit = tables[j];
        if (hit != null) return hit;
        int avail = Math.Min(real.Length, imag.Length) - 1;
        int maxH = Math.Max(1, Math.Min(avail, (int)(nyquist / (fMin * MathF.Pow(2, j / (float)PerOct)))));
        lock (tables)
        {
            if (norm == 0)
            {
                var full = Build(Math.Min(real.Length, imag.Length) - 1);
                float pk = 0;
                foreach (var v in full) pk = Math.Max(pk, Math.Abs(v));
                norm = pk > 0 ? 1 / pk : 1;
            }
            if (tables[j] == null)
            {
                // Fasce con lo stesso numero di armoniche condividono la tabella
                if (!byH.TryGetValue(maxH, out var t))
                {
                    t = Build(maxH);
                    for (int i = 0; i < t.Length; i++) t[i] *= norm;
                    byH[maxH] = t;
                }
                tables[j] = t;
            }
            return tables[j]!;
        }
    }
}

public sealed class OscillatorNode : SourceNode
{
    public readonly AudioParam Frequency, Detune;
    PeriodicWave wave;
    double phase;
    public OscillatorNode(AudioContext c, string type) : base(c)
    {
        Frequency = new AudioParam(c, 440); Detune = new AudioParam(c, 0);
        wave = PeriodicWave.Builtin(type);
    }
    public string Type { set => wave = PeriodicWave.Builtin(value); }
    public void SetPeriodicWave(PeriodicWave w) => wave = w;

    protected override void Process()
    {
        Stereo = false;
        Array.Clear(L);
        if (!ActiveRange(out int from, out int to)) return;
        Frequency.Compute(); Detune.Compute();
        var fq = Frequency.Values; var dt = Detune.Values;
        float sr = Ctx.SampleRate, ny = Ctx.Nyquist;
        bool constF = Frequency.Constant && Detune.Constant;
        float f0 = fq[0] * (dt[0] == 0 ? 1 : MathF.Pow(2, dt[0] / 1200f));
        float[] table = wave.TableFor(Math.Abs(f0), ny);
        const double N = PeriodicWave.Size;
        double ph = phase * N;          // fase in campioni di tabella
        if (constF)
        {
            double inc = Math.Abs(f0) / sr * N;
            if (f0 < 0) inc = -inc;
            for (int i = from; i < to; i++)
            {
                int idx = (int)ph;
                float fr = (float)(ph - idx);
                L[i] = table[idx] + (table[idx + 1] - table[idx]) * fr;
                ph += inc;
                if (ph >= N) ph -= N; else if (ph < 0) ph += N;
            }
        }
        else
        {
            bool dz = Detune.Constant && dt[0] == 0;
            for (int i = from; i < to; i++)
            {
                float f = dz ? fq[i] : fq[i] * MathF.Pow(2, dt[i] / 1200f);
                if ((i & 31) == 0) table = wave.TableFor(Math.Abs(f), ny);
                int idx = (int)ph;
                float fr = (float)(ph - idx);
                L[i] = table[idx] + (table[idx + 1] - table[idx]) * fr;
                ph += f / sr * N;
                if (ph >= N) ph -= N * Math.Floor(ph / N); else if (ph < 0) ph += N * Math.Ceiling(-ph / N);
            }
        }
        phase = ph / N;
    }
}

public sealed class ConstantSourceNode : SourceNode
{
    public readonly AudioParam Offset;
    public ConstantSourceNode(AudioContext c) : base(c) { Offset = new AudioParam(c, 1); }
    protected override void Process()
    {
        Stereo = false;
        Array.Clear(L);
        if (!ActiveRange(out int from, out int to)) return;
        Offset.Compute();
        Array.Copy(Offset.Values, from, L, from, to - from);
    }
}

public sealed class BufferSourceNode : SourceNode
{
    static float Hermite(float xm, float x0, float x1, float x2, float t)
    {
        float c1 = 0.5f * (x1 - xm), c2 = xm - 2.5f * x0 + 2f * x1 - 0.5f * x2, c3 = 0.5f * (x2 - xm) + 1.5f * (x0 - x1);
        return ((c3 * t + c2) * t + c1) * t + x0;
    }
    public readonly AudioBuf Buffer;
    public readonly AudioParam PlaybackRate;
    public bool Loop;
    double pos;
    public BufferSourceNode(AudioContext c, AudioBuf b) : base(c) { Buffer = b; PlaybackRate = new AudioParam(c, 1); }
    // Come Chrome: l'offset iniziale è arrotondato al campione (niente interpolazione del rumore)
    public void Start(double t, double offset) { Start(t); pos = Math.Round(offset * Buffer.SampleRate); }

    protected override void Process()
    {
        Stereo = Buffer.Data.Length > 1;
        Array.Clear(L); Array.Clear(R);
        if (!ActiveRange(out int from, out int to)) return;
        PlaybackRate.Compute();
        var rate = PlaybackRate.Values;
        int len = Buffer.Length;
        var d0 = Buffer.Data[0]; var d1 = Stereo ? Buffer.Data[1] : d0;
        for (int i = from; i < to; i++)
        {
            if (pos >= len)
            {
                if (!Loop) { StopTime = Math.Min(StopTime, Ctx.CurrentTime + i / (double)Ctx.SampleRate); break; }
                pos %= len;
            }
            int a = (int)pos;
            float fr = (float)(pos - a);
            if (fr == 0) { L[i] = d0[a]; if (Stereo) R[i] = d1[a]; }
            else
            {
                // Hermite a 4 punti: meno attenuazione degli acuti e meno immagini dell'interpolazione lineare
                int am = a > 0 ? a - 1 : (Loop ? len - 1 : 0), b = a + 1 >= len ? (Loop ? 0 : a) : a + 1, c = b + 1 >= len ? (Loop ? (b + 1) % len : b) : b + 1;
                L[i] = Hermite(d0[am], d0[a], d0[b], d0[c], fr);
                if (Stereo) R[i] = Hermite(d1[am], d1[a], d1[b], d1[c], fr);
            }
            pos += rate[i];
        }
    }
}

public sealed class BiquadFilterNode : AudioNode
{
    public readonly AudioParam Frequency, Q, Detune, GainParam;
    public string Type;
    double b0, b1, b2, a1, a2, gainDb;
    double x1L, x2L, y1L, y2L, x1R, x2R, y1R, y2R;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];

    public BiquadFilterNode(AudioContext c, string type) : base(c)
    {
        Type = type;
        Frequency = new AudioParam(c, 350); Q = new AudioParam(c, 1); Detune = new AudioParam(c, 0); GainParam = new AudioParam(c, 0);
    }

    void Coefs(double f, double q, double det)
    {
        double sr = Ctx.SampleRate, ny = sr / 2;
        f = f * (det == 0 ? 1 : Math.Pow(2, det / 1200));
        double fn = Math.Clamp(f / ny, 0, 1);
        if (Type is "lowshelf" or "highshelf")
        {
            double A = Math.Pow(10, gainDb / 40), w0 = Math.PI * Math.Clamp(fn, 1e-6, 0.999999), cs = Math.Cos(w0);
            double sal = Math.Sin(w0) / 2 * Math.Sqrt(2), sa = 2 * Math.Sqrt(A) * sal;
            if (Type == "lowshelf")
            {
                double a0 = (A + 1) + (A - 1) * cs + sa;
                Set(A * ((A + 1) - (A - 1) * cs + sa) / a0, 2 * A * ((A - 1) - (A + 1) * cs) / a0, A * ((A + 1) - (A - 1) * cs - sa) / a0,
                    -2 * ((A - 1) + (A + 1) * cs) / a0, ((A + 1) + (A - 1) * cs - sa) / a0);
            }
            else
            {
                double a0 = (A + 1) - (A - 1) * cs + sa;
                Set(A * ((A + 1) + (A - 1) * cs + sa) / a0, -2 * A * ((A - 1) + (A + 1) * cs) / a0, A * ((A + 1) + (A - 1) * cs - sa) / a0,
                    2 * ((A - 1) - (A + 1) * cs) / a0, ((A + 1) - (A - 1) * cs - sa) / a0);
            }
            return;
        }
        if (Type is "lowpass" or "highpass")
        {
            bool lp = Type == "lowpass";
            if (fn >= 1) { Set(lp ? 1 : 0, 0, 0, 0, 0); return; }
            if (fn <= 0) { Set(lp ? 0 : 1, 0, 0, 0, 0); return; }
            double w0 = Math.PI * fn, cs = Math.Cos(w0), alpha = Math.Sin(w0) / (2 * Math.Pow(10, q / 20));
            double a0 = 1 + alpha;
            if (lp) Set((1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, -2 * cs / a0, (1 - alpha) / a0);
            else Set((1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - alpha) / a0);
            return;
        }
        if (Type == "peaking")
        {
            double A = Math.Pow(10, gainDb / 40);
            if (fn <= 0 || fn >= 1) { Set(1, 0, 0, 0, 0); return; }
            double w0 = Math.PI * fn, cs = Math.Cos(w0), pal = Math.Sin(w0) / (2 * Math.Max(q, 1e-4)), a0 = 1 + pal / A;
            Set((1 + pal * A) / a0, -2 * cs / a0, (1 - pal * A) / a0, -2 * cs / a0, (1 - pal / A) / a0);
            return;
        }
        if (fn <= 0 || fn >= 1) { if (Type == "notch") Set(1, 0, 0, 0, 0); else Set(0, 0, 0, 0, 0); return; }
        double ww = Math.PI * fn, c = Math.Cos(ww);
        double qq = Math.Max(q, 1e-4), al = Math.Sin(ww) / (2 * qq), n0 = 1 + al;
        if (Type == "bandpass") Set(al / n0, 0, -al / n0, -2 * c / n0, (1 - al) / n0);
        else Set(1 / n0, -2 * c / n0, 1 / n0, -2 * c / n0, (1 - al) / n0);   // notch
    }

    void Set(double c0, double c1, double c2, double d1, double d2) { b0 = c0; b1 = c1; b2 = c2; a1 = d1; a2 = d2; }

    protected override void Process()
    {
        SumInputs(inL, inR, out bool st);
        Stereo = st;
        Frequency.Compute(); Q.Compute(); Detune.Compute(); GainParam.Compute();
        gainDb = GainParam.Values[0];
        bool cst = Frequency.Constant && Q.Constant && Detune.Constant && GainParam.Constant;
        var fq = Frequency.Values; var qv = Q.Values; var dv = Detune.Values;
        if (cst) Coefs(fq[0], qv[0], dv[0]);
        for (int i = 0; i < AudioContext.Block; i++)
        {
            if (!cst && (i & 7) == 0) Coefs(fq[i], qv[i], dv[i]);
            double x = inL[i];
            double y = b0 * x + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L;
            x2L = x1L; x1L = x; y2L = y1L; y1L = y;
            L[i] = (float)y;
            if (st)
            {
                double xr = inR[i];
                double yr = b0 * xr + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R;
                x2R = x1R; x1R = xr; y2R = y1R; y1R = yr;
                R[i] = (float)yr;
            }
        }
        // Denormali e stati residui
        if (Math.Abs(y1L) < 1e-15) { y1L = y2L = 0; }
        if (Math.Abs(y1R) < 1e-15) { y1R = y2R = 0; }
    }
}

public sealed class WaveShaperNode : AudioNode
{
    public float[] Curve;
    /// <summary>Sovracampionamento (1, 2 o 4) come WaveShaperNode.oversample: riduce l'aliasing della saturazione.</summary>
    public int Oversample = 1;
    readonly Resampler upL = new(), upR = new();
    public WaveShaperNode(AudioContext c, float[] curve) : base(c) { Curve = curve; }
    protected override void Process()
    {
        SumInputs(L, R, out bool st);
        Stereo = st;
        if (Oversample > 1)
        {
            upL.Process(L, Oversample, Shape);
            if (st) upR.Process(R, Oversample, Shape);
            return;
        }
        Shape(L, AudioContext.Block);
        if (st) Shape(R, AudioContext.Block);
    }
    void Shape(float[] b, int count)
    {
        var c = Curve; int n = c.Length;
        for (int i = 0; i < count; i++)
        {
            float v = (n - 1) * (b[i] + 1) * 0.5f;
            if (v <= 0) b[i] = c[0];
            else if (v >= n - 1) b[i] = c[n - 1];
            else { int k = (int)v; b[i] = c[k] + (c[k + 1] - c[k]) * (v - k); }
        }
    }
}

/// <summary>
/// Sovracampionamento ×2/×4 per elaborazioni non lineari: interpolazione polifase con un FIR
/// passa-basso (sinc finestrata, 24 prese per fase), elaborazione, filtro e decimazione.
/// </summary>
public sealed class Resampler
{
    const int Taps = 24, B = AudioContext.Block;
    // Kernel per fase (interpolazione) e kernel completo (decimazione), già invertiti: i prodotti
    // diventano scalari su memoria contigua, vettorizzati con SIMD.
    static readonly Dictionary<int, (float[][] up, float[] down)> kernels = new();
    float[] extIn = new float[Taps - 1 + B], extUp = Array.Empty<float>(), up = Array.Empty<float>();
    int factor;
    bool silent = true;                  // ingressi e storia a zero: l'uscita è costante

    static (float[][] up, float[] down) Kernels(int os)
    {
        lock (kernels)
        {
            if (kernels.TryGetValue(os, out var kk)) return kk;
            int n = Taps * os; var k = new float[n];
            double fc = 0.45 / os, sum = 0, mid = (n - 1) / 2.0;
            for (int i = 0; i < n; i++)
            {
                double x = i - mid;
                double sinc = x == 0 ? 2 * fc : Math.Sin(2 * Math.PI * fc * x) / (Math.PI * x);
                double w = 0.42 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.Cos(4 * Math.PI * i / (n - 1));   // Blackman
                k[i] = (float)(sinc * w); sum += k[i];
            }
            for (int i = 0; i < n; i++) k[i] = (float)(k[i] / sum);
            var upK = new float[os][];
            for (int p = 0; p < os; p++)
            {
                upK[p] = new float[Taps];
                for (int u = 0; u < Taps; u++) upK[p][u] = (float)(k[(Taps - 1 - u) * os + p] * os);
            }
            var down = new float[n];
            for (int u = 0; u < n; u++) down[u] = k[n - 1 - u];
            kernels[os] = kk = (upK, down);
            return kk;
        }
    }

    static float Dot(ReadOnlySpan<float> a, ReadOnlySpan<float> b)
    {
        int i = 0, n = a.Length;
        float acc = 0;
        if (System.Numerics.Vector.IsHardwareAccelerated && n >= System.Numerics.Vector<float>.Count)
        {
            var v = System.Numerics.Vector<float>.Zero;
            int w = System.Numerics.Vector<float>.Count;
            for (; i <= n - w; i += w) v += new System.Numerics.Vector<float>(a.Slice(i, w)) * new System.Numerics.Vector<float>(b.Slice(i, w));
            acc = System.Numerics.Vector.Dot(v, System.Numerics.Vector<float>.One);
        }
        for (; i < n; i++) acc += a[i] * b[i];
        return acc;
    }

    public void Process(float[] buf, int os, Action<float[], int> fn)
    {
        int n = Taps * os;
        if (os != factor)
        {
            factor = os;
            extIn = new float[Taps - 1 + B]; extUp = new float[n - 1 + B * os]; up = new float[B * os];
            silent = true;
        }
        bool zero = true;
        for (int i = 0; i < B; i++) if (buf[i] != 0) { zero = false; break; }
        if (zero && silent)
        {
            // Silenzio prolungato: la non linearità di 0 è costante, il filtro la lascia invariata
            up[0] = 0; fn(up, 1);
            Array.Fill(buf, up[0]);
            return;
        }
        var (upK, down) = Kernels(os);
        // 1) interpolazione polifase
        Array.Copy(buf, 0, extIn, Taps - 1, B);
        for (int i = 0; i < B; i++)
        {
            var x = extIn.AsSpan(i, Taps);
            for (int p = 0; p < os; p++) up[i * os + p] = Dot(x, upK[p]);
        }
        Array.Copy(extIn, B, extIn, 0, Taps - 1);
        // 2) non linearità alla frequenza alta
        fn(up, B * os);
        // 3) filtro anti-aliasing e decimazione
        Array.Copy(up, 0, extUp, n - 1, B * os);
        for (int i = 0; i < B; i++) buf[i] = Dot(extUp.AsSpan(i * os + os - 1, n), down);
        Array.Copy(extUp, B * os, extUp, 0, n - 1);
        // Torna "silenzioso" quando ingresso e storia sono a zero (fine della coda del filtro)
        silent = zero && AllZero(extIn) && AllEqual(buf);
    }
    static bool AllZero(float[] a) { foreach (var v in a) if (v != 0) return false; return true; }
    static bool AllEqual(float[] a) { for (int i = 1; i < a.Length; i++) if (a[i] != a[0]) return false; return true; }
}

public sealed class StereoPannerNode : AudioNode
{
    public readonly AudioParam Pan;
    public StereoPannerNode(AudioContext c) : base(c) { Pan = new AudioParam(c, 0); }
    protected override void Process()
    {
        SumInputs(L, R, out bool st);
        Pan.Compute();
        var p = Pan.Values;
        for (int i = 0; i < AudioContext.Block; i++)
        {
            float pan = Math.Clamp(p[i], -1, 1);
            if (!st)
            {
                float x = (pan + 1) * 0.5f, v = L[i];
                L[i] = v * MathF.Cos(x * MathF.PI / 2);
                R[i] = v * MathF.Sin(x * MathF.PI / 2);
            }
            else if (pan <= 0)
            {
                float x = pan + 1, l = L[i], r = R[i];
                L[i] = l + r * MathF.Cos(x * MathF.PI / 2);
                R[i] = r * MathF.Sin(x * MathF.PI / 2);
            }
            else
            {
                float x = pan, l = L[i], r = R[i];
                L[i] = l * MathF.Cos(x * MathF.PI / 2);
                R[i] = r + l * MathF.Sin(x * MathF.PI / 2);
            }
        }
        Stereo = true;
    }
}

/// <summary>Delay stereo; può stare in un anello di feedback (l'uscita è calcolata prima di leggere gli ingressi).</summary>
public sealed class DelayNode : AudioNode
{
    public readonly AudioParam DelayTime;
    readonly float[] bufL, bufR;
    int w;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];
    bool busy;

    public DelayNode(AudioContext c, double max) : base(c)
    {
        DelayTime = new AudioParam(c, 0);
        int n = (int)(max * c.SampleRate) + AudioContext.Block * 2 + 4;
        bufL = new float[n]; bufR = new float[n];
    }

    protected override void Process()
    {
        if (busy) return;
        busy = true;
        DelayTime.Compute();
        int n = bufL.Length;
        double sr = Ctx.SampleRate;
        // 1) uscita dal buffer (ritardo minimo un blocco, come nei cicli Web Audio)
        for (int i = 0; i < AudioContext.Block; i++)
        {
            double d = Math.Max(AudioContext.Block, DelayTime.Values[i] * sr);
            double rp = w + i - d;
            while (rp < 0) rp += n;
            int a = (int)rp; int b = (a + 1) % n; float fr = (float)(rp - a);
            a %= n;
            L[i] = bufL[a] + (bufL[b] - bufL[a]) * fr;
            R[i] = bufR[a] + (bufR[b] - bufR[a]) * fr;
        }
        Stereo = true;
        // 2) ingressi (possono includere il feedback, che legge l'uscita appena calcolata)
        SumInputs(inL, inR, out bool st);
        for (int i = 0; i < AudioContext.Block; i++)
        {
            int k = (w + i) % n;
            bufL[k] = inL[i];
            bufR[k] = st ? inR[i] : inL[i];
        }
        w = (w + AudioContext.Block) % n;
        busy = false;
    }
}
