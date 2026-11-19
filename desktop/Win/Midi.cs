// Midi.cs — Tastiere e controller MIDI (come FL Studio e Logic): note alla traccia selezionata,
// pad sulla batteria, registrazione negli step e MIDI Learn delle manopole.

using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;
using DrumBort.Host;
using NAudio.Midi;

namespace DrumBort.Win;

/// <summary>Ingressi MIDI (tutti quelli collegati, riletti a richiesta). Gli eventi arrivano sul thread dell'interfaccia.</summary>
public static class MidiInput
{
    static readonly List<MidiIn> open = new();
    public static readonly List<string> Names = new();
    public static event Action<int, int, int>? NoteOn;     // canale 1-16, nota, velocity
    public static event Action<int, int>? NoteOff;         // canale, nota
    public static event Action<int, int, int>? Control;    // canale, CC, valore
    public static event Action? Activity;
    static Dispatcher? ui;

    public static void Start(Dispatcher dispatcher) { ui = dispatcher; Refresh(); }

    /// <summary>Chiude e riapre tutti gli ingressi (tastiera collegata dopo l'avvio).</summary>
    public static void Refresh()
    {
        foreach (var m in open) { try { m.Stop(); m.Dispose(); } catch { } }
        open.Clear(); Names.Clear();
        int n;
        try { n = MidiIn.NumberOfDevices; } catch (Exception e) { Console.Error.WriteLine($"[midi] {e.Message}"); return; }
        for (int i = 0; i < n; i++)
        {
            try
            {
                string name = MidiIn.DeviceInfo(i).ProductName;
                var m = new MidiIn(i);
                m.MessageReceived += (_, e) => ui?.BeginInvoke(() => Dispatch(e.MidiEvent));
                m.Start();
                open.Add(m); Names.Add(name);
                Console.WriteLine($"MIDI: {name}");
            }
            catch (Exception e) { Console.Error.WriteLine($"[midi] ingresso {i}: {e.Message}"); }
        }
    }

    public static void Dispatch(MidiEvent ev)
    {
        switch (ev)
        {
            case NoteOnEvent on when on.Velocity > 0: NoteOn?.Invoke(on.Channel, on.NoteNumber, on.Velocity); break;
            case NoteEvent off when off.CommandCode is MidiCommandCode.NoteOff or MidiCommandCode.NoteOn: NoteOff?.Invoke(off.Channel, off.NoteNumber); break;
            case ControlChangeEvent cc: Control?.Invoke(cc.Channel, (int)cc.Controller, cc.ControllerValue); MidiLearn.OnControl(cc.Channel, (int)cc.Controller, cc.ControllerValue); break;
            default: return;
        }
        Activity?.Invoke();
    }

    public static void Stop() { foreach (var m in open) { try { m.Stop(); m.Dispose(); } catch { } } open.Clear(); }
}

/// <summary>
/// MIDI Learn: tasto destro su una manopola, un cursore o un fader → "MIDI Learn" → si muove un
/// controllo del controller. Le assegnazioni restano tra un avvio e l'altro. Per ogni assegnazione:
///   • Aggancio (predefinita): il valore non salta; il controllo prende il parametro quando lo
///     raggiunge (soft takeover), poi lo segue;
///   • Salto: il parametro va subito alla posizione del controllo;
///   • Encoder infinito: messaggi relativi (64 ± n), passi fini e accelerazione dal controller.
/// I CC 0-31 con il rispettivo LSB (32-63) sono letti a 14 bit (16384 passi invece di 128).
/// </summary>
public static class MidiLearn
{
    sealed class Target
    {
        public FrameworkElement El = null!; public Func<double> Get = null!; public Action Begin = null!; public Action<double> Set = null!; public Action End = null!;
        public DispatcherTimer? Idle;
    }
    sealed class Lane { public bool Picked; public double? LastIn; public double LastSet = -1; public bool Hi; public int Msb = -1; }
    static readonly Dictionary<string, Target> live = new();
    static Dictionary<string, string> map = Load("midimap");      // "canale:cc" → id del controllo
    static Dictionary<string, string> modes = Load("midimodes");  // "canale:cc" → pickup | jump | rel
    static readonly Dictionary<string, Lane> lanes = new();
    static string? learning;
    static DateTime lastHint;
    public static event Action<string>? Status;

    static Dictionary<string, string> Load(string key)
    {
        try { return (JsonNode.Parse(Settings.Load(key) ?? "{}") as JsonObject)?.ToDictionary(kv => kv.Key, kv => kv.Value!.GetValue<string>()) ?? new(); }
        catch { return new(); }
    }
    static void Save()
    {
        Settings.Save("midimap", new JsonObject(map.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))).ToJsonString());
        Settings.Save("midimodes", new JsonObject(modes.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))).ToJsonString());
    }

    public static bool Learning(string? id) => id != null && id == learning;
    public static bool Mapped(string? id) => id != null && map.ContainsValue(id);
    public static int Count => map.Count;

    /// <summary>Collega un controllo a schermo: get/set in 0..1; `extra` = voci aggiunte al menu del tasto destro.</summary>
    public static void Attach(FrameworkElement el, Func<string?> id, Func<double> get, Action begin, Action<double> set, Action end, Func<IEnumerable<(string, Action?)>>? extra = null)
    {
        el.Loaded += (_, _) => { if (id() is string k) live[k] = new Target { El = el, Get = get, Begin = begin, Set = set, End = end }; };
        el.Unloaded += (_, _) => { if (id() is string k && live.TryGetValue(k, out var t) && t.El == el) live.Remove(k); };
        el.MouseRightButtonUp += (_, e) =>
        {
            var items = new List<(string, Action?)>();
            if (extra != null) items.AddRange(extra());
            if (id() is string k)
            {
                if (items.Count > 0) items.Add(("—", null));
                items.Add((learning == k ? "Annulla MIDI Learn" : "MIDI Learn: muovi un controllo del controller", () => { learning = learning == k ? null : k; el.InvalidateVisual(); Status?.Invoke(learning != null ? "MIDI Learn: muovi una manopola o un fader del controller" : ""); }));
                var cc = map.Where(kv => kv.Value == k).Select(kv => kv.Key).ToList();
                foreach (var c in cc)
                {
                    string cur = modes.GetValueOrDefault(c, "pickup");
                    string lbl = $"CC {c.Split(':')[1]} (canale {c.Split(':')[0]}){(lanes.GetValueOrDefault(c)?.Hi == true ? " · 14 bit" : "")}";
                    items.Add(($"{(cur == "pickup" ? "● " : "○ ")}{lbl}: aggancio (niente salti)", () => SetMode(c, "pickup")));
                    items.Add(($"{(cur == "jump" ? "● " : "○ ")}{lbl}: salto immediato", () => SetMode(c, "jump")));
                    items.Add(($"{(cur == "rel" ? "● " : "○ ")}{lbl}: encoder infinito (relativo)", () => SetMode(c, "rel")));
                }
                if (cc.Count > 0) items.Add(("Rimuovi assegnazione MIDI", () => { foreach (var c in cc) { map.Remove(c); modes.Remove(c); lanes.Remove(c); } Save(); el.InvalidateVisual(); }));
            }
            if (items.Count == 0) return;
            e.Handled = true;
            Menu.Show(el, items);
        };
    }
    static void SetMode(string key, string mode) { modes[key] = mode; if (lanes.TryGetValue(key, out var l)) l.Picked = false; Save(); }

    /// <summary>Assegnazione diretta (prove automatiche).</summary>
    public static void Map(string key, string id, string mode) { map[key] = id; modes[key] = mode; lanes.Remove(key); }

    public static void Forget() { map.Clear(); modes.Clear(); lanes.Clear(); Save(); foreach (var t in live.Values) t.El.InvalidateVisual(); }

    public static void OnControl(int ch, int cc, int val)
    {
        // 14 bit: LSB (CC 32-63) del controllo CC 0-31 già assegnato
        if (cc >= 32 && cc < 64 && map.ContainsKey($"{ch}:{cc - 32}") && lanes.TryGetValue($"{ch}:{cc - 32}", out var hiLane) && hiLane.Msb >= 0)
        {
            hiLane.Hi = true;
            Apply($"{ch}:{cc - 32}", (hiLane.Msb * 128 + val) / 16383.0, val);
            return;
        }
        string key = $"{ch}:{cc}";
        if (learning != null)
        {
            foreach (var k in map.Where(kv => kv.Value == learning).Select(kv => kv.Key).ToList()) { map.Remove(k); modes.Remove(k); }
            map[key] = learning;
            lanes.Remove(key);
            Save();
            Status?.Invoke($"Assegnato al CC {cc} (canale {ch}). Tasto destro sul controllo: modalità aggancio, salto o encoder infinito");
            if (live.TryGetValue(learning, out var lt)) lt.El.InvalidateVisual();
            learning = null;
        }
        if (!map.ContainsKey(key)) return;
        if (!lanes.TryGetValue(key, out var lane)) lanes[key] = lane = new Lane();
        lane.Msb = val;
        // Con un controller a 14 bit il valore completo arriva con l'LSB: qui solo il byte alto
        if (lane.Hi && modes.GetValueOrDefault(key, "pickup") != "rel") return;
        Apply(key, val / 127.0, val);
    }

    static void Apply(string key, double v, int raw)
    {
        if (!map.TryGetValue(key, out var id) || !live.TryGetValue(id, out var t)) return;
        var lane = lanes.TryGetValue(key, out var l) ? l : lanes[key] = new Lane();
        string mode = modes.GetValueOrDefault(key, "pickup");
        double cur = t.Get();
        double target;
        if (mode == "rel")
        {
            // Encoder: 1..63 = su, 65..127 = giù (complemento a due); più veloce = passi più grandi
            int d = raw >= 64 ? raw - 128 : raw;
            if (d == 0) return;
            target = Math.Clamp(cur + d / 400.0 * (Math.Abs(d) > 3 ? 4 : 1), 0, 1);
        }
        else
        {
            // Il parametro è stato cambiato altrove (mouse, telefono): serve un nuovo aggancio
            if (lane.LastSet >= 0 && Math.Abs(cur - lane.LastSet) > 0.01) lane.Picked = false;
            if (mode == "pickup" && !lane.Picked)
            {
                bool near = Math.Abs(v - cur) <= 0.03;
                bool crossed = lane.LastIn is double prev && Math.Sign(prev - cur) != Math.Sign(v - cur);
                lane.LastIn = v;
                if (!near && !crossed)
                {
                    if ((DateTime.Now - lastHint).TotalMilliseconds > 400)
                    {
                        lastHint = DateTime.Now;
                        Status?.Invoke($"Aggancio: porta il controllo a {cur * 100:0}% (ora {v * 100:0}%)");
                    }
                    return;
                }
                lane.Picked = true;
                Status?.Invoke("Agganciato");
            }
            lane.LastIn = v;
            target = v;
        }
        // Un gruppo di messaggi ravvicinati = un solo passo di annulla
        if (t.Idle == null)
        {
            t.Begin();
            t.Idle = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            t.Idle.Tick += (_, _) => { t.Idle!.Stop(); t.Idle = null; t.End(); };
        }
        t.Idle.Stop(); t.Idle.Start();
        t.Set(target);
        lane.LastSet = t.Get();
    }
}
