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
/// MIDI Learn: tasto destro su una manopola o un cursore → "MIDI Learn" → si muove un controllo
/// del controller. Le assegnazioni (canale:CC → controllo) restano tra un avvio e l'altro.
/// </summary>
public static class MidiLearn
{
    sealed class Target { public FrameworkElement El = null!; public Action Begin = null!; public Action<double> Set = null!; public Action End = null!; public DispatcherTimer? Idle; }
    static readonly Dictionary<string, Target> live = new();
    static Dictionary<string, string> map = Load();      // "canale:cc" → id del controllo
    static string? learning;
    public static event Action<string>? Status;

    static Dictionary<string, string> Load()
    {
        try { return (JsonNode.Parse(Settings.Load("midimap") ?? "{}") as JsonObject)?.ToDictionary(kv => kv.Key, kv => kv.Value!.GetValue<string>()) ?? new(); }
        catch { return new(); }
    }
    static void Save() => Settings.Save("midimap", new JsonObject(map.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))).ToJsonString());

    public static bool Learning(string? id) => id != null && id == learning;
    public static bool Mapped(string? id) => id != null && map.ContainsValue(id);
    public static int Count => map.Count;

    public static void Attach(FrameworkElement el, Func<string?> id, Action begin, Action<double> set, Action end)
    {
        el.Loaded += (_, _) => { if (id() is string k) live[k] = new Target { El = el, Begin = begin, Set = set, End = end }; };
        el.Unloaded += (_, _) => { if (id() is string k && live.TryGetValue(k, out var t) && t.El == el) live.Remove(k); };
        el.MouseRightButtonUp += (_, e) =>
        {
            if (id() is not string k) return;
            e.Handled = true;
            var items = new List<(string, Action?)>
            {
                (learning == k ? "Annulla MIDI Learn" : "MIDI Learn: muovi un controllo del controller", () => { learning = learning == k ? null : k; el.InvalidateVisual(); Status?.Invoke(learning != null ? "MIDI Learn: muovi una manopola o un fader del controller" : ""); }),
            };
            var cc = map.Where(kv => kv.Value == k).Select(kv => kv.Key).ToList();
            if (cc.Count > 0) items.Add(($"Rimuovi assegnazione (CC {string.Join(", ", cc.Select(x => x.Split(':')[1]))})", () => { foreach (var c in cc) map.Remove(c); Save(); el.InvalidateVisual(); }));
            Menu.Show(el, items);
        };
    }

    public static void Forget() { map.Clear(); Save(); foreach (var t in live.Values) t.El.InvalidateVisual(); }

    public static void OnControl(int ch, int cc, int val)
    {
        string key = $"{ch}:{cc}";
        if (learning != null)
        {
            foreach (var k in map.Where(kv => kv.Value == learning).Select(kv => kv.Key).ToList()) map.Remove(k);
            map[key] = learning;
            Save();
            Status?.Invoke($"Assegnato al CC {cc} (canale {ch})");
            if (live.TryGetValue(learning, out var lt)) lt.El.InvalidateVisual();
            learning = null;
        }
        if (!map.TryGetValue(key, out var id) || !live.TryGetValue(id, out var t)) return;
        // Un gruppo di messaggi ravvicinati = un solo passo di annulla
        if (t.Idle == null)
        {
            t.Begin();
            t.Idle = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            t.Idle.Tick += (_, _) => { t.Idle!.Stop(); t.Idle = null; t.End(); };
        }
        t.Idle.Stop(); t.Idle.Start();
        t.Set(val / 127.0);
    }
}
