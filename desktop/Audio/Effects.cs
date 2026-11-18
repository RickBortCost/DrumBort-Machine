// Effects.cs — FFT, riverbero algoritmico (al posto del ConvolverNode), compressore master
// con la stessa impostazione e il guadagno di compensazione del DynamicsCompressor di Chrome.

namespace DrumBort.Audio;

public static class Fft
{
    /// <summary>FFT radix-2 in place (inverse: esponente positivo, senza divisione per N).</summary>
    public static void Transform(double[] re, double[] im, bool inverse)
    {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (re[i], re[j]) = (re[j], re[i]); (im[i], im[j]) = (im[j], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            double wr = Math.Cos(ang), wi = Math.Sin(ang);
            for (int i = 0; i < n; i += len)
            {
                double cr = 1, ci = 0;
                for (int j = 0; j < len / 2; j++)
                {
                    int a = i + j, b = a + len / 2;
                    double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
                }
            }
        }
    }
}

/// <summary>
/// Riverbero stereo (8 comb + 4 all-pass per canale, schema Freeverb). La durata segue il
/// parametro "size" della web app (secondi di coda), il livello è tarato sul convolver originale.
/// </summary>
public sealed class ReverbNode : AudioNode
{
    static readonly int[] CombT = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
    static readonly int[] ApT = { 556, 441, 341, 225 };
    const int Spread = 23;
    readonly Comb[] cl, cr;
    readonly Allpass[] al, ar;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];
    public static double RtFactor = double.TryParse(Environment.GetEnvironmentVariable("DRUMBORT_RT"), System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 1.2;
    public static float Cal = float.TryParse(Environment.GetEnvironmentVariable("DRUMBORT_CAL"), System.Globalization.CultureInfo.InvariantCulture, out var c) ? c : 0.88f;

    sealed class Comb
    {
        readonly float[] b; int i; float store;
        public float Feedback, Damp = 0.25f;
        public Comb(int n) { b = new float[n]; }
        public float Run(float x)
        {
            float y = b[i];
            store = y * (1 - Damp) + store * Damp;
            b[i] = x + store * Feedback;
            if (++i >= b.Length) i = 0;
            return y;
        }
    }
    sealed class Allpass
    {
        readonly float[] b; int i;
        public Allpass(int n) { b = new float[n]; }
        public float Run(float x)
        {
            float bo = b[i];
            b[i] = x + bo * 0.5f;
            if (++i >= b.Length) i = 0;
            return bo - x;
        }
    }

    public ReverbNode(AudioContext c) : base(c)
    {
        double k = c.SampleRate / 44100.0;
        cl = CombT.Select(t => new Comb((int)(t * k))).ToArray();
        cr = CombT.Select(t => new Comb((int)((t + Spread) * k))).ToArray();
        al = ApT.Select(t => new Allpass((int)(t * k))).ToArray();
        ar = ApT.Select(t => new Allpass((int)((t + Spread) * k))).ToArray();
        SetSize(2.2);
    }

    /// <summary>Coda in secondi (RT60 approssimato): feedback dei comb dalla loro lunghezza media.</summary>
    public void SetSize(double seconds)
    {
        double avg = CombT.Average() / 44100.0;
        // La IR originale decade come (1 - t/len)^3: tempo "percepito" ≈ metà della durata
        double rt = Math.Max(0.2, seconds * RtFactor);
        float fb = (float)Math.Pow(10, -3 * avg / rt);
        foreach (var c in cl.Concat(cr)) c.Feedback = Math.Min(0.985f, fb);
    }

    protected override void Process()
    {
        SumInputs(inL, inR, out bool st);
        for (int i = 0; i < AudioContext.Block; i++)
        {
            float x = (st ? (inL[i] + inR[i]) * 0.5f : inL[i]) * 0.03f;
            float l = 0, r = 0;
            for (int k = 0; k < 8; k++) { l += cl[k].Run(x); r += cr[k].Run(x); }
            for (int k = 0; k < 4; k++) { l = al[k].Run(l); r = ar[k].Run(r); }
            L[i] = l * Cal; R[i] = r * Cal;
        }
        Stereo = true;
    }
}

/// <summary>
/// Compressore stereo collegato: soglia/knee/ratio/attacco/rilascio come il master della web app;
/// guadagno di compensazione calcolato come in Chrome: (1 / guadagno a 0 dBFS)^0.6.
/// </summary>
public sealed class CompressorNode : AudioNode
{
    public float Threshold = -12, Knee = 8, Ratio = 6, Attack = 0.003f, Release = 0.2f;
    float env = 0;   // riduzione in dB (≤ 0)
    float det;       // inviluppo di picco (ampiezza)
    // Lookahead di 6 ms (come il pre-delay di Chrome): il rilevatore vede i transienti prima dell'audio
    readonly float[] dl, dr;
    int dw;
    readonly int look;

    public CompressorNode(AudioContext c) : base(c)
    {
        look = (int)(0.006 * c.SampleRate);
        dl = new float[look + 1]; dr = new float[look + 1];
        qv = new float[look + 4]; qi = new long[look + 4];
        limAtk = 1 - MathF.Exp(-4f / look);            // ~98% dell'attenuazione prima che il picco esca
        limRel = 1 - MathF.Exp(-1f / (0.08f * c.SampleRate));
    }

    const float Ceiling = 0.97f;
    readonly float[] qv; readonly long[] qi;
    int qh, qn; long pos;
    float lim = 1;
    readonly float limAtk, limRel;

    // Curva statica come il DynamicsCompressor di Chrome: lineare fino alla soglia, ginocchio
    // esponenziale (in ampiezza) fino a soglia + knee, poi pendenza 1/ratio in dB.
    float kneeK = -1, linThr, kneeThr, kneeThrDb, yKneeDb;
    static float Db(float x) => 20 * MathF.Log10(Math.Max(x, 1e-9f));
    float KneeCurve(float x, float k) => x < linThr ? x : linThr + (1 - MathF.Exp(-k * (x - linThr))) / k;
    float Slope(float x, float k)
    {
        float x2 = x * 1.001f;
        return (Db(KneeCurve(x2, k)) - Db(KneeCurve(x, k))) / (Db(x2) - Db(x));
    }
    void InitCurve()
    {
        linThr = MathF.Pow(10, Threshold / 20);
        kneeThrDb = Threshold + Knee;
        kneeThr = MathF.Pow(10, kneeThrDb / 20);
        float lo = 0.1f, hi = 10000, k = 5;
        for (int i = 0; i < 15; i++)
        {
            if (Slope(kneeThr, k) < 1 / Ratio) hi = k; else lo = k;
            k = MathF.Sqrt(lo * hi);
        }
        kneeK = k;
        yKneeDb = Db(KneeCurve(kneeThr, k));
    }
    /// <summary>Nuove impostazioni (la curva statica viene ricalcolata).</summary>
    public void Configure(float threshold, float ratio, float knee, float attack, float release)
    {
        if (threshold == Threshold && ratio == Ratio && knee == Knee && attack == Attack && release == Release) return;
        Threshold = threshold; Ratio = ratio; Knee = knee; Attack = attack; Release = release;
        kneeK = -1;
    }

    float Curve(float db)
    {
        if (kneeK < 0) InitCurve();
        float x = MathF.Pow(10, db / 20);
        if (x < kneeThr) return Db(KneeCurve(x, kneeK));
        return yKneeDb + (db - kneeThrDb) / Ratio;
    }

    protected override void Process()
    {
        SumInputs(L, R, out bool st);
        float sr = Ctx.SampleRate;
        float aCo = MathF.Exp(-1 / (Attack * sr)), rCo = MathF.Exp(-1 / (Release * sr));
        float makeup = MathF.Pow(1 / MathF.Pow(10, Curve(0) / 20), 0.6f);
        int n = dl.Length;
        for (int i = 0; i < AudioContext.Block; i++)
        {
            float xl = L[i], xr = st ? R[i] : xl;
            float pk = Math.Max(Math.Abs(xl), Math.Abs(xr));
            // Rilevatore di picco: attacco istantaneo, rilascio con la costante di release
            det = pk > det ? pk : det * rCo;
            float db = det > 1e-6f ? 20 * MathF.Log10(det) : -120;
            float target = Curve(db) - db;       // riduzione desiderata (≤ 0)
            env = target < env ? aCo * env + (1 - aCo) * target : target;
            float g = MathF.Pow(10, env / 20) * makeup;
            // Limiter di sicurezza: massimo scorrevole (deque monotona) dei picchi nella finestra di lookahead
            float a = pk * g;
            pos++;
            while (qn > 0 && qv[(qh + qn - 1) % qv.Length] <= a) qn--;
            qv[(qh + qn) % qv.Length] = a; qi[(qh + qn) % qv.Length] = pos; qn++;
            while (qi[qh] <= pos - n) { qh = (qh + 1) % qv.Length; qn--; }
            float wmax = qv[qh];
            float lt = wmax > Ceiling ? Ceiling / wmax : 1;
            lim += (lt - lim) * (lt < lim ? limAtk : limRel);
            // Uscita ritardata di `look` campioni
            dl[dw] = xl; dr[dw] = xr;
            int rd = dw + 1 == n ? 0 : dw + 1;
            L[i] = dl[rd] * g * lim; R[i] = dr[rd] * g * lim;
            dw = rd;
        }
        Stereo = true;
    }
}
