// Convolver.cs — Convoluzione a partizioni (zero latenza), come il ConvolverNode del browser:
//   • testa della risposta (primi 1024 campioni): partizioni da 128 (FFT 256), uscita immediata;
//   • coda: partizioni da 1024 (FFT 2048), calcolata ogni 8 blocchi e riprodotta nei successivi.
// La risposta all'impulso del riverbero è generata come in js/engine.js (rumore stereo con
// decadimento (1 − t/len)³) e normalizzata con la formula di Chrome (RMS, −58 dB, 44.1 kHz).

namespace DrumBort.Audio;

/// <summary>Convoluzione di un canale con una risposta, a partizioni uniformi di dimensione B.</summary>
sealed class Partitioned
{
    readonly int B, N, bins;               // partizione, FFT (2B), bin utili (B + 1)
    readonly double[][] hRe, hIm;          // spettri delle partizioni della risposta
    readonly double[][] xRe, xIm;          // spettri degli ultimi ingressi (linea di ritardo in frequenza)
    readonly double[] input, re, im;       // ultimi 2B campioni d'ingresso, buffer FFT
    int head;                              // indice della partizione più recente in xRe/xIm
    public readonly int Parts;

    public Partitioned(float[] ir, int offset, int length, int b)
    {
        B = b; N = 2 * b; bins = b + 1;
        Parts = Math.Max(1, (length + B - 1) / B);
        hRe = new double[Parts][]; hIm = new double[Parts][];
        xRe = new double[Parts][]; xIm = new double[Parts][];
        re = new double[N]; im = new double[N]; input = new double[N];
        for (int p = 0; p < Parts; p++)
        {
            Array.Clear(re); Array.Clear(im);
            for (int i = 0; i < B; i++)
            {
                int k = offset + p * B + i;
                if (k < offset + length && k < ir.Length) re[i] = ir[k];
            }
            Fft.Transform(re, im, inverse: false);
            hRe[p] = re[..bins]; hIm[p] = im[..bins];
            xRe[p] = new double[bins]; xIm[p] = new double[bins];
        }
    }

    /// <summary>Elabora B nuovi campioni d'ingresso; scrive (aggiungendo) B campioni d'uscita.</summary>
    public void Process(float[] x, int xOff, float[] y, int yOff, float gain)
    {
        // Overlap-save: ingresso = ultimi 2B campioni
        Array.Copy(input, B, input, 0, B);
        for (int i = 0; i < B; i++) input[B + i] = x[xOff + i];
        Array.Copy(input, re, N); Array.Clear(im);
        Fft.Transform(re, im, inverse: false);
        head = head == 0 ? Parts - 1 : head - 1;
        Array.Copy(re, xRe[head], bins); Array.Copy(im, xIm[head], bins);
        // Somma dei prodotti partizione × ingresso ritardato
        Array.Clear(re); Array.Clear(im);
        for (int p = 0; p < Parts; p++)
        {
            var ar = xRe[(head + p) % Parts]; var ai = xIm[(head + p) % Parts];
            var br = hRe[p]; var bi = hIm[p];
            for (int k = 0; k < bins; k++)
            {
                re[k] += ar[k] * br[k] - ai[k] * bi[k];
                im[k] += ar[k] * bi[k] + ai[k] * br[k];
            }
        }
        // Spettro di un segnale reale: simmetria hermitiana
        for (int k = 1; k < B; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        Fft.Transform(re, im, inverse: true);
        float s = gain / N;
        for (int i = 0; i < B; i++) y[yOff + i] += (float)re[B + i] * s;
    }
}

/// <summary>Convoluzione stereo a latenza zero (testa 128 + coda 1024).</summary>
public sealed class ConvolverNode : AudioNode
{
    const int HeadLen = 1024, TailB = 1024;
    Partitioned? hl, hr, tl, tr;
    float scale = 1;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];
    // Coda: ingressi accumulati e uscita pronta per i prossimi 1024 campioni
    readonly float[] accL = new float[TailB], accR = new float[TailB];
    readonly float[] outL = new float[TailB], outR = new float[TailB];
    int accN;

    public ConvolverNode(AudioContext c) : base(c) { }

    /// <summary>Nuova risposta (2 canali); normalizzata come in Chrome.</summary>
    public void SetBuffer(float[] l, float[] r)
    {
        int len = l.Length;
        double pw = 0;
        for (int i = 0; i < len; i++) pw += l[i] * (double)l[i] + r[i] * (double)r[i];
        double power = Math.Sqrt(pw / (2.0 * Math.Max(1, len)));
        if (!double.IsFinite(power) || power < 0.000125) power = 0.000125;
        scale = (float)(1 / power * Math.Pow(10, -58 / 20.0) * (44100.0 / Ctx.SampleRate));
        int head = Math.Min(len, HeadLen);
        hl = new Partitioned(l, 0, head, AudioContext.Block);
        hr = new Partitioned(r, 0, head, AudioContext.Block);
        if (len > HeadLen)
        {
            tl = new Partitioned(l, HeadLen, len - HeadLen, TailB);
            tr = new Partitioned(r, HeadLen, len - HeadLen, TailB);
        }
        else tl = tr = null;
        Array.Clear(outL); Array.Clear(outR); accN = 0;
    }

    protected override void Process()
    {
        SumInputs(inL, inR, out bool st);
        if (!st) Array.Copy(inL, inR, AudioContext.Block);
        Array.Clear(L); Array.Clear(R);
        Stereo = true;
        if (hl == null) return;
        hl.Process(inL, 0, L, 0, scale);
        hr!.Process(inR, 0, R, 0, scale);
        if (tl == null) return;
        // Coda: uscita calcolata 1024 campioni fa (la risposta della coda parte da 1024)
        for (int i = 0; i < AudioContext.Block; i++) { L[i] += outL[accN + i]; R[i] += outR[accN + i]; }
        Array.Copy(inL, 0, accL, accN, AudioContext.Block);
        Array.Copy(inR, 0, accR, accN, AudioContext.Block);
        accN += AudioContext.Block;
        if (accN == TailB)
        {
            accN = 0;
            Array.Clear(outL); Array.Clear(outR);
            tl.Process(accL, 0, outL, 0, scale);
            tr!.Process(accR, 0, outR, 0, scale);
        }
    }
}

/// <summary>Riverbero della web app: convoluzione con la risposta sintetica di js/engine.js.</summary>
public sealed class ReverbNode : AudioNode
{
    readonly ConvolverNode conv;
    readonly Random rng = new(1234);
    public ReverbNode(AudioContext c) : base(c)
    {
        conv = new ConvolverNode(c);
        SetSize(2.2);
    }

    /// <summary>Durata della coda in secondi.</summary>
    public void SetSize(double seconds)
    {
        int len = Math.Max(1, (int)Math.Floor(Ctx.SampleRate * seconds));
        var l = new float[len]; var r = new float[len];
        for (int i = 0; i < len; i++)
        {
            double env = Math.Pow(1 - (double)i / len, 3);
            l[i] = (float)((rng.NextDouble() * 2 - 1) * env);
            r[i] = (float)((rng.NextDouble() * 2 - 1) * env);
        }
        conv.SetBuffer(l, r);
    }

    protected override void Process()
    {
        // Gli ingressi del riverbero passano al convolutore interno
        conv.Inputs.Clear();
        conv.Inputs.AddRange(Inputs);
        conv.Pull();
        Array.Copy(conv.L, L, AudioContext.Block);
        Array.Copy(conv.R, R, AudioContext.Block);
        Stereo = true;
    }
}
