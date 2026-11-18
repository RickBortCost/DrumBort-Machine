// Graph.cs — Grafo audio a blocchi (128 campioni) con la stessa semantica delle API Web Audio
// usate dalla web app: nodi, connessioni, parametri automatizzabili (a-rate) e modulabili.
// Tutto gira su un solo thread (il thread di rendering): nessun lock.

namespace DrumBort.Audio;

public sealed class AudioContext
{
    public const int Block = 128;
    public readonly int SampleRate;
    public readonly float Nyquist;
    public long Frame { get; private set; }
    internal long Quantum;
    public double CurrentTime => Frame / (double)SampleRate;
    public readonly GainNode Destination;
    /// <summary>Sorgenti create durante la costruzione di una voce (per liberarla quando ha finito).</summary>
    public VoiceScope? Scope;

    public AudioContext(int sampleRate = 48000)
    {
        SampleRate = sampleRate;
        Nyquist = sampleRate / 2f;
        Destination = new GainNode(this);
    }

    /// <summary>Calcola un blocco e lo scrive (stereo) a partire da `offset`.</summary>
    public void RenderBlock(float[] left, float[] right, int offset)
    {
        Quantum++;
        Destination.Pull();
        var d = Destination;
        for (int i = 0; i < Block; i++)
        {
            left[offset + i] = d.L[i];
            right[offset + i] = d.Stereo ? d.R[i] : d.L[i];
        }
        Frame += Block;
    }

    public GainNode Gain(float v = 1) { var g = new GainNode(this); g.GainParam.Value = v; return g; }
    public OscillatorNode Oscillator(string type = "sine") => new(this, type);
    public BiquadFilterNode Biquad(string type = "lowpass") => new(this, type);
    public WaveShaperNode Shaper(float[] curve) => new(this, curve);
    public BufferSourceNode BufferSource(AudioBuf buf) => new(this, buf);
    public ConstantSourceNode Constant(float v = 1) { var c = new ConstantSourceNode(this); c.Offset.Value = v; return c; }
    public StereoPannerNode Panner() => new(this);
    public DelayNode Delay(double max) => new(this, max);
}

/// <summary>Buffer audio (1 o 2 canali) alla frequenza del contesto.</summary>
public sealed class AudioBuf
{
    public readonly float[][] Data;
    public readonly int Length;
    public readonly int SampleRate;
    public AudioBuf(int channels, int length, int sampleRate)
    {
        Data = new float[channels][];
        for (int c = 0; c < channels; c++) Data[c] = new float[length];
        Length = length; SampleRate = sampleRate;
    }
    public double Duration => Length / (double)SampleRate;
}

/// <summary>Registro delle sorgenti di una voce: la voce si stacca quando sono tutte ferme.</summary>
public sealed class VoiceScope
{
    public readonly List<SourceNode> Sources = new();
    public bool Finished(double now, double grace)
    {
        foreach (var s in Sources)
        {
            if (!s.Started) return false;
            if (s.StopTime == double.MaxValue || now < s.StopTime + grace) return false;
        }
        return true;
    }
}

public abstract class AudioNode
{
    public readonly AudioContext Ctx;
    internal readonly List<AudioNode> Inputs = new();
    readonly List<AudioNode> outNodes = new();
    readonly List<AudioParam> outParams = new();
    public readonly float[] L = new float[AudioContext.Block];
    public readonly float[] R = new float[AudioContext.Block];
    public bool Stereo;
    long done = -1;

    protected AudioNode(AudioContext ctx) { Ctx = ctx; }

    public T Connect<T>(T dest) where T : AudioNode { dest.Inputs.Add(this); outNodes.Add(dest); return dest; }
    public void Connect(AudioParam p) { p.Inputs.Add(this); outParams.Add(p); }
    public void Disconnect()
    {
        foreach (var n in outNodes) n.Inputs.Remove(this);
        foreach (var p in outParams) p.Inputs.Remove(this);
        outNodes.Clear(); outParams.Clear();
    }
    public void Disconnect(AudioNode dest) { dest.Inputs.Remove(this); outNodes.Remove(dest); }

    /// <summary>Calcola l'uscita del blocco corrente (una sola volta per blocco).</summary>
    public void Pull()
    {
        if (done == Ctx.Quantum) return;
        done = Ctx.Quantum;
        if (!Profiler.On) { Process(); return; }
        long t0 = System.Diagnostics.Stopwatch.GetTimestamp(), child = Profiler.Child;
        Profiler.Child = 0;
        Process();
        long el = System.Diagnostics.Stopwatch.GetTimestamp() - t0;
        Profiler.Add(GetType().Name, el - Profiler.Child);
        Profiler.Child = child + el;
    }

    protected abstract void Process();

    /// <summary>Somma degli ingressi in L/R (mono → stereo come in Web Audio).</summary>
    protected void SumInputs(float[] l, float[] r, out bool stereo)
    {
        stereo = false;
        Array.Clear(l); Array.Clear(r);
        // Copia: un ingresso può staccarsi durante il calcolo (voci finite)
        int n = Inputs.Count;
        for (int k = 0; k < n && k < Inputs.Count; k++)
        {
            var src = Inputs[k];
            src.Pull();
            if (src.Stereo && !stereo)
            {
                // Passaggio a stereo: quanto sommato finora era mono
                Array.Copy(l, r, AudioContext.Block);
                stereo = true;
            }
            var sl = src.L; var sr = src.Stereo ? src.R : src.L;
            if (stereo) for (int i = 0; i < AudioContext.Block; i++) { l[i] += sl[i]; r[i] += sr[i]; }
            else for (int i = 0; i < AudioContext.Block; i++) l[i] += sl[i];
        }
    }
}

/// <summary>Parametro con automazioni (come AudioParam) e ingressi di modulazione sommati.</summary>
public sealed class AudioParam
{
    enum Kind { Set, Linear, Exp, Target }
    struct Ev { public Kind K; public double T; public float V; public double Tc; public bool HasV0; public float V0; }

    readonly AudioContext ctx;
    readonly List<Ev> ev = new();
    internal readonly List<AudioNode> Inputs = new();
    float def;
    public readonly float[] Values = new float[AudioContext.Block];
    /// <summary>Vero se nel blocco corrente il valore è costante (nessuna automazione né modulazione).</summary>
    public bool Constant { get; private set; }
    bool filled; float filledValue;

    public AudioParam(AudioContext c, float v) { ctx = c; def = v; }

    public float Value
    {
        get => ev.Count == 0 ? def : Eval(ctx.CurrentTime);
        set { if (ev.Count == 0) def = value; else SetValueAtTime(value, ctx.CurrentTime); }
    }

    void Insert(Ev e)
    {
        int i = ev.Count;
        while (i > 0 && ev[i - 1].T > e.T) i--;
        ev.Insert(i, e);
    }

    public AudioParam SetValueAtTime(float v, double t) { Insert(new Ev { K = Kind.Set, T = t, V = v }); return this; }
    public AudioParam LinearRampToValueAtTime(float v, double t) { EnsureStart(); Insert(new Ev { K = Kind.Linear, T = t, V = v }); return this; }
    public AudioParam ExponentialRampToValueAtTime(float v, double t) { EnsureStart(); Insert(new Ev { K = Kind.Exp, T = t, V = v }); return this; }
    public AudioParam SetTargetAtTime(float v, double t, double tc) { Insert(new Ev { K = Kind.Target, T = t, V = v, Tc = Math.Max(1e-5, tc) }); return this; }
    public void CancelScheduledValues(double t)
    {
        for (int i = ev.Count - 1; i >= 0; i--) if (ev[i].T >= t) ev.RemoveAt(i);
    }

    /// <summary>Una rampa senza evento precedente parte dal valore attuale (come Web Audio).</summary>
    void EnsureStart()
    {
        if (ev.Count == 0) Insert(new Ev { K = Kind.Set, T = ctx.CurrentTime, V = def });
    }

    /// <summary>Valore subito prima dell'evento k (usa solo gli eventi precedenti).</summary>
    float StartValue(int k)
    {
        if (ev[k].HasV0) return ev[k].V0;
        return k == 0 ? def : EvalUpTo(ev[k].T, k);
    }

    /// <summary>Valore al tempo x considerando gli eventi [0, upto) (nessuna rampa futura).</summary>
    float EvalUpTo(double x, int upto)
    {
        int i = upto - 1;
        while (i >= 0 && ev[i].T > x) i--;
        if (i < 0) return def;
        var e = ev[i];
        if (e.K != Kind.Target) return e.V;
        float v0 = StartValue(i);
        return (float)(e.V + (v0 - e.V) * Math.Exp(-(x - e.T) / e.Tc));
    }

    float Eval(double x)
    {
        int n = 0;
        while (n < ev.Count && ev[n].T <= x) n++;
        if (n < ev.Count && (ev[n].K == Kind.Linear || ev[n].K == Kind.Exp))
        {
            double t0; float v0;
            if (n > 0) { t0 = ev[n - 1].T; v0 = EvalUpTo(t0, n); }
            else { t0 = x; v0 = def; }
            var e = ev[n];
            double f = e.T > t0 ? (x - t0) / (e.T - t0) : 1;
            if (e.K == Kind.Linear) return (float)(v0 + (e.V - v0) * f);
            if (v0 * e.V <= 0) return v0;
            return (float)(v0 * Math.Pow(e.V / v0, f));
        }
        return EvalUpTo(x, n);
    }

    /// <summary>Elimina gli eventi passati mantenendo la curva in corso.</summary>
    void Prune(double now)
    {
        int i = -1;
        for (int k = 0; k < ev.Count; k++) if (ev[k].T <= now) i = k; else break;
        if (i < 1) return;
        var e = ev[i];
        if (e.K == Kind.Target) { e.V0 = StartValue(i); e.HasV0 = true; }
        else { e.K = Kind.Set; }
        ev.RemoveRange(0, i);
        ev[0] = e;
    }

    /// <summary>Calcola i valori del blocco (automazioni + ingressi).</summary>
    internal void Compute()
    {
        double t0 = ctx.CurrentTime, dt = 1.0 / ctx.SampleRate;
        bool automated = false;
        if (ev.Count > 0)
        {
            Prune(t0);
            // Ultimo evento già passato e non è una curva: valore costante
            var last = ev[^1];
            if (last.T <= t0 && last.K != Kind.Target) { def = last.V; ev.Clear(); }
            // Curva esponenziale ormai arrivata al valore finale (> 12 costanti di tempo)
            else if (last.K == Kind.Target && ev.Count == 1 && t0 - last.T > 12 * last.Tc) { def = last.V; ev.Clear(); }
            else if (ev.Count == 1 && ev[0].K == Kind.Set && ev[0].T <= t0) { def = ev[0].V; ev.Clear(); }
            else automated = true;
        }
        if (automated)
        {
            // Curva valutata ogni 8 campioni e interpolata linearmente: stesso risultato udibile,
            // 1/8 delle funzioni trascendenti (le automazioni sono il costo principale del grafo)
            const int S = 8;
            float prev = Eval(t0);
            for (int s = S; s <= AudioContext.Block; s += S)
            {
                float next = Eval(t0 + s * dt);
                float step = (next - prev) / S;
                for (int j = 0; j < S; j++) Values[s - S + j] = prev + step * j;
                prev = next;
            }
        }
        else if (!(filled && filledValue == def)) { Array.Fill(Values, def); }
        // Valori costanti già presenti nel buffer: nessuna riscrittura al blocco successivo
        filled = !automated && Inputs.Count == 0;
        filledValue = def;
        Constant = !automated;
        if (Inputs.Count > 0)
        {
            Constant = false;
            for (int k = 0; k < Inputs.Count; k++)
            {
                var n = Inputs[k];
                n.Pull();
                if (n.Stereo) for (int i = 0; i < AudioContext.Block; i++) Values[i] += 0.5f * (n.L[i] + n.R[i]);
                else for (int i = 0; i < AudioContext.Block; i++) Values[i] += n.L[i];
            }
        }
    }
}

/// <summary>Profilazione opzionale (variabile d'ambiente DRUMBORT_PROFILE=1): tempo esclusivo per tipo di nodo.</summary>
public static class Profiler
{
    public static readonly bool On = Environment.GetEnvironmentVariable("DRUMBORT_PROFILE") == "1";
    [ThreadStatic] public static long Child;
    static readonly Dictionary<string, long> totals = new();
    public static void Add(string k, long ticks) { totals.TryGetValue(k, out var v); totals[k] = v + ticks; }
    public static void Report()
    {
        if (!On) return;
        double sum = totals.Values.Sum();
        foreach (var (k, v) in totals.OrderByDescending(x => x.Value))
            Console.WriteLine($"{k,-22} {v * 1000.0 / System.Diagnostics.Stopwatch.Frequency,8:0} ms  {100 * v / sum,5:0.0}%");
    }
}
