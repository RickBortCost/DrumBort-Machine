// Doc.cs — Progetto aperto nell'app Windows. Lo stato è nel formato della web app (lo stesso
// dell'export JSON), così il motore C#, i telefoni collegati e i file dei progetti restano
// compatibili. Ogni modifica passa da Commit(): il motore e i dispositivi ricevono le parti
// cambiate, il progetto si salva da solo, l'interfaccia si aggiorna.

using System.Text.Json;
using System.Text.Json.Nodes;
using DrumBort.Engine;
using DrumBort.Host;

namespace DrumBort.Win;

public sealed class Doc
{
    public const int Slots = 8, DrumTracks = 8;
    public static readonly string[] SynthNames = { "Bass", "Lead", "Pad", "Keys" };
    public static readonly string[] SynthShort = { "BS", "LD", "PD", "KY" };
    static readonly int[] SynthOct = { 2, 4, 3, 4 };
    static readonly bool[] SynthMono = { true, true, false, false };
    static readonly string[] SynthPreset = { "acid303", "sh101lead", "juno", "epiano" };

    public JsonObject Root = new();
    readonly Hub hub;
    readonly string savePath;
    readonly Stack<string> undo = new(), redo = new();
    public event Action? Changed;
    public string? FilePath;
    System.Windows.Threading.DispatcherTimer? saveTimer;

    public Doc(Hub hub, string dataDir)
    {
        this.hub = hub;
        savePath = Path.Combine(dataDir, "progetto-windows.json");
    }

    // ------------------------------------------------------------------ caricamento
    static JsonObject Template() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Assets", "empty-project.json")))!.AsObject();

    /// <summary>Ultimo progetto (salvataggio automatico) o progetto vuoto.</summary>
    public void LoadLast()
    {
        try { if (File.Exists(savePath)) { Load(JsonNode.Parse(File.ReadAllText(savePath))!.AsObject(), false); return; } }
        catch { /* file non valido: progetto vuoto */ }
        Load(Template(), false);
    }

    /// <summary>Sostituisce il progetto (file, nuovo progetto, progetto arrivato da un dispositivo).</summary>
    public void Load(JsonObject o, bool keepUndo)
    {
        var t = Template();
        foreach (var (k, v) in o) t[k] = v?.DeepClone();
        // Pattern mancanti: vuoti
        var slots = t["slots"] as JsonArray ?? new JsonArray();
        var empty = Template()["slots"]![0]!;
        while (slots.Count < Slots) slots.Add(empty.DeepClone());
        t["slots"] = slots;
        if (t["devs"] is not JsonArray devs || devs.Count < 12) t["devs"] = new JsonArray(Enumerable.Range(0, 12).Select(_ => (JsonNode)new JsonArray()).ToArray());
        if (t["tracks"] is not JsonArray) t["tracks"] = new JsonArray();
        Root = t;
        if (!keepUndo) { undo.Clear(); redo.Clear(); }
        PushAll();
        Changed?.Invoke();
    }

    public void New() { Snapshot(); Load(Template(), true); FilePath = null; }

    /// <summary>Tutte le parti al motore e ai dispositivi (progetto completo).</summary>
    public void PushAll() => hub.LocalState(Parts(null), full: true);

    /// <summary>Parti nel formato del protocollo (p0…p7, slot, fx, …).</summary>
    public JsonObject Parts(string[]? keys)
    {
        var p = new JsonObject();
        bool all = keys == null;
        for (int i = 0; i < Slots; i++) if (all || keys!.Contains($"p{i}")) p[$"p{i}"] = Root["slots"]![i]!.DeepClone();
        foreach (var k in new[] { "slot", "fx", "song", "lock", "arr", "tracks", "devs", "buses", "userKits", "userPresets", "userSounds" })
            if ((all || keys!.Contains(k)) && Root[k] != null) p[k] = Root[k]!.DeepClone();
        if (all || keys!.Contains("session"))
            p["session"] = new JsonObject { ["quant"] = Root["session"]?["quant"]?.DeepClone() ?? 16, ["follow"] = Root["session"]?["follow"]?.DeepClone() ?? new JsonArray() };
        if (all || keys!.Contains("mode")) p["mode"] = ArrView ? "session" : "pattern";
        if (all && Root["lock"] == null) p["lock"] = null;
        return JsonNode.Parse(p.ToJsonString())!.AsObject();
    }

    /// <summary>Modifiche dell'interfaccia: motore, dispositivi, salvataggio automatico, ridisegno.</summary>
    public void Commit(params string[] keys)
    {
        quietTimer?.Stop();
        foreach (var k in keys) pendingKeys.Remove(k);
        FlushQuiet();
        hub.LocalState(Parts(keys));
        ScheduleSave();
        Changed?.Invoke();
    }
    /// <summary>
    /// Come Commit, senza ridisegnare (trascinamento di manopole, cursori, controller MIDI). Gli invii
    /// al motore sono raggruppati (al massimo uno ogni 15 ms, con l'ultimo valore): un movimento
    /// veloce o un controller a 14 bit non riempie il motore di copie del progetto.
    /// </summary>
    public void CommitQuiet(params string[] keys)
    {
        foreach (var k in keys) pendingKeys.Add(k);
        if ((DateTime.UtcNow - lastQuiet).TotalMilliseconds >= 15) FlushQuiet();
        else
        {
            quietTimer ??= new System.Windows.Threading.DispatcherTimer(System.Windows.Threading.DispatcherPriority.Send) { Interval = TimeSpan.FromMilliseconds(15) };
            quietTimer.Tick -= OnQuiet; quietTimer.Tick += OnQuiet;
            if (!quietTimer.IsEnabled) quietTimer.Start();
        }
        ScheduleSave();
    }
    readonly HashSet<string> pendingKeys = new();
    DateTime lastQuiet;
    System.Windows.Threading.DispatcherTimer? quietTimer;
    void OnQuiet(object? s, EventArgs e) { quietTimer!.Stop(); FlushQuiet(); }
    /// <summary>Invia subito le modifiche raggruppate (anche prima di un Commit).</summary>
    public void FlushQuiet()
    {
        if (pendingKeys.Count == 0) return;
        var keys = pendingKeys.ToArray();
        pendingKeys.Clear();
        lastQuiet = DateTime.UtcNow;
        hub.LocalState(Parts(keys));
    }
    public string PatKey => $"p{Slot}";
    public string[] AllPatKeys => Enumerable.Range(0, Slots).Select(i => $"p{i}").ToArray();

    /// <summary>Parti arrivate da un telefono o da un browser collegato.</summary>
    public void ApplyRemote(JsonObject parts)
    {
        for (int i = 0; i < Slots; i++) if (parts[$"p{i}"] is JsonObject p) Root["slots"]![i] = p.DeepClone();
        foreach (var (k, v) in parts)
        {
            if (k.Length == 2 && k[0] == 'p' && char.IsDigit(k[1])) continue;
            if (k is "mode") continue;
            if (k == "session" && v is JsonObject s && Root["session"] is JsonObject rs) { foreach (var (sk, sv) in s) rs[sk] = sv?.DeepClone(); continue; }
            if ((k == "userSounds" || k == "userPresets") && v is JsonArray add && Root[k] is JsonArray have)
            {
                var ids = add.Select(x => x?["id"]?.ToString()).ToHashSet();
                Root[k] = new JsonArray(have.Where(x => !ids.Contains(x?["id"]?.ToString())).Select(x => x!.DeepClone()).Concat(add.Select(x => x!.DeepClone())).ToArray());
                continue;
            }
            Root[k] = v?.DeepClone();
        }
        ScheduleSave();
        Changed?.Invoke();
    }

    // ------------------------------------------------------------------ annulla / ripeti
    public void Snapshot()
    {
        undo.Push(Root.ToJsonString());
        if (undo.Count > 100) { var keep = undo.Take(100).Reverse().ToList(); undo.Clear(); foreach (var s in keep) undo.Push(s); }
        redo.Clear();
    }
    public bool CanUndo => undo.Count > 0;
    public bool CanRedo => redo.Count > 0;
    public void Undo() { if (undo.Count == 0) return; redo.Push(Root.ToJsonString()); Root = JsonNode.Parse(undo.Pop())!.AsObject(); PushAll(); ScheduleSave(); Changed?.Invoke(); }
    public void Redo() { if (redo.Count == 0) return; undo.Push(Root.ToJsonString()); Root = JsonNode.Parse(redo.Pop())!.AsObject(); PushAll(); ScheduleSave(); Changed?.Invoke(); }

    // ------------------------------------------------------------------ file
    void ScheduleSave()
    {
        if (saveTimer == null)
        {
            saveTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            saveTimer.Tick += (_, _) => { saveTimer.Stop(); SaveAuto(); };
        }
        saveTimer.Stop(); saveTimer.Start();
    }
    public void SaveAuto()
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(savePath)!); File.WriteAllText(savePath, Export().ToJsonString()); }
        catch (Exception e) { Console.Error.WriteLine($"[salvataggio] {e.Message}"); }
    }
    /// <summary>Progetto nel formato dell'export JSON della web app.</summary>
    /// <summary>Prima di salvare: lo stato dei plugin VST 3 aperti va nel progetto.</summary>
    public static Action<JsonObject>? CaptureStates;
    public JsonObject Export()
    {
        CaptureStates?.Invoke(Root);
        var o = (JsonObject)Root.DeepClone();
        o["app"] = "drumbort"; o["version"] = 3;
        o["appVersion"] = typeof(Doc).Assembly.GetName().Version?.ToString(3);
        return o;
    }
    public void SaveAs(string path)
    {
        File.WriteAllText(path, Export().ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        FilePath = path;
    }
    public void Open(string path)
    {
        var o = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidDataException("File non valido");
        if (o["slots"] is not JsonArray) throw new InvalidDataException("Non è un progetto DrumBort");
        Snapshot();
        Load(o, true);
        FilePath = path;
    }

    // ------------------------------------------------------------------ accesso ai dati
    public int Slot { get => (int)Val(Root["slot"], 0); set => Root["slot"] = Math.Clamp(value, 0, Slots - 1); }
    public JsonObject Pat => (JsonObject)Root["slots"]![Slot]!;
    public JsonObject PatAt(int i) => (JsonObject)Root["slots"]![i]!;
    public int Bars => Num(Pat, "bars", 1) is var b && (b == 2 || b == 4) ? (int)b : 1;
    public int StepCount => 16 * Bars;
    public List<int> Tracks => (Root["tracks"] as JsonArray ?? new JsonArray()).Select(x => (int)Val(x, 0)).ToList();
    public void SetTracks(IEnumerable<int> t) => Root["tracks"] = new JsonArray(t.Distinct().Select(x => (JsonNode)x).ToArray());
    public static bool IsSynth(int ch) => ch >= DrumTracks;

    /// <summary>Valore numerico (anche da int, float o bool creati in C#).</summary>
    public static double Val(JsonNode? v, double def = 0)
    {
        if (J.TryD(v, out double d)) return d;
        if (v is JsonValue jv && jv.TryGetValue(out bool b)) return b ? 1 : 0;
        return def;
    }
    public static double Num(JsonNode? n, string k, double def) => Val(n?[k], def);
    public static bool Bool(JsonNode? n, string k) => n?[k] is JsonValue jv && (jv.TryGetValue(out bool b) ? b : J.TryD(jv, out double d) && d != 0);
    public static string Str(JsonNode? n, string k, string def) => n?[k] is JsonValue jv && jv.TryGetValue(out string? s) && s != null ? s : def;

    /// <summary>Parametri della traccia (canale 0-11) nel pattern `p`.</summary>
    public static JsonObject TrackOf(JsonObject p, int ch) => ch < DrumTracks ? (JsonObject)p["tracks"]![ch]! : (JsonObject)p["synth"]!["tracks"]![ch - DrumTracks]!;
    public JsonObject Track(int ch) => TrackOf(Pat, ch);
    /// <summary>Un parametro per la traccia in tutti i pattern (come un canale di una DAW).</summary>
    public void SetAll(int ch, string k, JsonNode? v) { for (int i = 0; i < Slots; i++) TrackOf(PatAt(i), ch)[k] = v?.DeepClone(); }

    public KitDef Kit => Kits.ById(Str(Root, "lock", "") is var l && l != "" ? l : Str(Pat, "kit", Kits.All[0].Id));
    public string TrackShort(int ch) => IsSynth(ch) ? SynthShort[ch - 8] : Kit.Tracks[ch].Short;
    public string TrackName(int ch)
    {
        if (!IsSynth(ch)) return Kit.Tracks[ch].Name;
        var t = Track(ch);
        string pr = t["patch"] is JsonObject patch ? Str(patch, "name", "Wavetable") : PresetName(Str(t, "preset", SynthPreset[ch - 8]));
        return $"{SynthNames[ch - 8]} · {pr}";
    }
    public static string PresetName(string id) => Synth.Presets.TryGetValue(id, out var p) ? p.Name : id;
    public static bool Mono(int k) => SynthMono[k];

    /// <summary>Nota della tonica alla base della tastiera della traccia synth k (come trackBase).</summary>
    public int Base(int k) => 12 * (SynthOct[k] + (int)Num(Track(8 + k), "oct", 0) + 1) + (int)Num(Pat["synth"], "key", 9);

    public JsonArray Chain(int ch)
    {
        if (ch < 12) return (JsonArray)Root["devs"]![ch]!;
        var b = Buses;
        JsonObject owner = ch switch
        {
            12 or 13 => (JsonObject)((JsonArray)b["ret"]!)[ch - 12]!,
            14 => (JsonObject)b["master"]!,
            _ => (JsonObject)((JsonArray)b["stacks"]!)[ch - 16]!,
        };
        if (owner["devs"] is not JsonArray d) owner["devs"] = d = new JsonArray();
        return d;
    }
    /// <summary>Parte del progetto da inviare dopo una modifica della catena.</summary>
    public string ChainKey(int ch) => ch < 12 ? "devs" : "buses";

    // ------------------------------------------------------------------ ritorni, master, Track Stack
    public const int RetA = 12, RetB = 13, MasterBus = 14, StackBase = 16;
    public static bool IsBus(int ch) => ch >= 12;
    /// <summary>Ritorni, master e stack: { ret: [{devs}, {devs}], master: {devs}, stacks: [{name, tracks, vol, mute, devs}] }.</summary>
    public JsonObject Buses
    {
        get
        {
            if (Root["buses"] is not JsonObject b) Root["buses"] = b = new JsonObject();
            if (b["ret"] is not JsonArray r || r.Count < 2) b["ret"] = new JsonArray(new JsonObject { ["devs"] = new JsonArray() }, new JsonObject { ["devs"] = new JsonArray() });
            if (b["master"] is not JsonObject) b["master"] = new JsonObject { ["devs"] = new JsonArray() };
            if (b["stacks"] is not JsonArray) b["stacks"] = new JsonArray();
            return b;
        }
    }
    public JsonArray StackList => (JsonArray)Buses["stacks"]!;
    public bool BusExists(int ch) => ch is RetA or RetB or MasterBus || (ch >= StackBase && ch - StackBase < StackList.Count);
    public string BusName(int ch) => ch switch
    {
        RetA => "Ritorno A · Riverbero", RetB => "Ritorno B · Delay", MasterBus => "Master",
        _ => BusExists(ch) ? Str(StackList[ch - StackBase], "name", $"Stack {ch - StackBase + 1}") : "",
    };
    public string ChShort(int ch) => ch < 12 ? TrackShort(ch) : ch == RetA ? "A" : ch == RetB ? "B" : ch == MasterBus ? "MST" : $"ST{ch - StackBase + 1}";
    public string ChName(int ch) => ch < 12 ? TrackName(ch) : BusName(ch);
    /// <summary>Stack della traccia (−1 = nessuno).</summary>
    public int StackOf(int ch)
    {
        var l = StackList;
        for (int s = 0; s < l.Count; s++) if ((l[s]?["tracks"] as JsonArray)?.Any(x => (int)Val(x, -1) == ch) == true) return s;
        return -1;
    }
    /// <summary>Sposta la traccia nello stack s (−1 = fuori; s = numero di stack = nuovo stack). Gli stack vuoti spariscono.</summary>
    public void SetStack(int ch, int s)
    {
        var l = StackList;
        foreach (var st in l.OfType<JsonObject>())
            if (st["tracks"] is JsonArray t) st["tracks"] = new JsonArray(t.Where(x => (int)Val(x, -1) != ch).Select(x => x!.DeepClone()).ToArray());
        if (s >= 0 && s < Mixer.Stacks)
        {
            if (s >= l.Count) l.Add(new JsonObject { ["name"] = $"Stack {l.Count + 1}", ["tracks"] = new JsonArray(), ["vol"] = 0.8, ["mute"] = false, ["devs"] = new JsonArray() });
            ((JsonArray)l[Math.Min(s, l.Count - 1)]!["tracks"]!).Add(ch);
        }
        for (int i = l.Count - 1; i >= 0; i--) if ((l[i]?["tracks"] as JsonArray)?.Count is null or 0) l.RemoveAt(i);
    }

    // ------------------------------------------------------------------ arrangiamento
    /// <summary>Vista ARRANGIAMENTO: il motore suona la timeline (modalità session + arr.on).</summary>
    public bool ArrView;
    public const int MaxArrBars = 256;
    JsonObject ArrObj
    {
        get
        {
            if (Root["arr"] is not JsonObject a) Root["arr"] = a = new JsonObject { ["on"] = false, ["bars"] = new JsonArray() };
            if (a["bars"] is not JsonArray) a["bars"] = new JsonArray();
            return a;
        }
    }
    /// <summary>Battute dell'arrangiamento: m = pattern per traccia (−1 = vuota), s = pattern principale (tempo, kit).</summary>
    public List<(int[] m, int s)> ArrBars
    {
        get => ((JsonArray)ArrObj["bars"]!).Select(b => (Enumerable.Range(0, 12).Select(i => b?["m"] is JsonArray m && i < m.Count ? (int)Val(m[i], -1) : -1).ToArray(), (int)Num(b, "s", 0))).ToList();
        set
        {
            var list = value.Take(MaxArrBars).ToList();
            while (list.Count > 0 && list[^1].m.All(v => v < 0)) list.RemoveAt(list.Count - 1);
            ArrObj["bars"] = new JsonArray(list.Select(b => (JsonNode)new JsonObject { ["m"] = new JsonArray(b.m.Select(v => (JsonNode)v).ToArray()), ["s"] = b.s }).ToArray());
            ArrObj["on"] = ArrView && list.Count > 0;
        }
    }
    /// <summary>Allinea arr.on alla vista corrente e invia modalità e arrangiamento al motore.</summary>
    public void SyncArrMode()
    {
        ArrObj["on"] = ArrView && ((JsonArray)ArrObj["bars"]!).Count > 0;
        hub.LocalState(Parts(new[] { "arr", "mode" }));
    }

    // ------------------------------------------------------------------ battute del pattern
    /// <summary>Lunghezza del pattern corrente in battute (le nuove ripetono il contenuto).</summary>
    public void SetBars(int bars)
    {
        var p = Pat;
        int oldN = StepCount, n = 16 * bars;
        if (n == oldN) return;
        JsonArray Resize(JsonArray a, Func<JsonNode?> fill)
        {
            var r = new JsonArray();
            for (int s = 0; s < n; s++) r.Add(a.Count > 0 ? a[s % Math.Max(1, Math.Min(a.Count, oldN))]?.DeepClone() : fill());
            return r;
        }
        var steps = (JsonArray)p["steps"]!; var opts = (JsonArray)p["opts"]!;
        for (int t = 0; t < DrumTracks; t++)
        {
            steps[t] = Resize((JsonArray)steps[t]!, () => 0);
            opts[t] = Resize((JsonArray)opts[t]!, () => null);
            var tr = (JsonObject)p["tracks"]![t]!;
            double len = Num(tr, "len", oldN);
            tr["len"] = len >= oldN ? n : Math.Min(len, n);
        }
        foreach (var st in (JsonArray)p["synth"]!["tracks"]!)
        {
            var o = (JsonObject)st!;
            o["steps"] = Resize((JsonArray)o["steps"]!, () => null);
            double len = Num(o, "len", oldN);
            o["len"] = len >= oldN ? n : Math.Min(len, n);
        }
        if (p["auto"] is JsonObject auto)
            foreach (var k in auto.Select(x => x.Key).ToList())
                if (auto[k] is JsonArray lane) auto[k] = Resize(lane, () => null);
        p["bars"] = bars;
    }

    // ------------------------------------------------------------------ azioni dal vivo
    public void Op(string op, JsonObject? data = null)
    {
        var m = data ?? new JsonObject();
        m["op"] = op;
        hub.LocalOp(m);
    }
    public void PreviewDrum(int i) => Op("trig", new JsonObject { ["i"] = i, ["vel"] = 0.85 });
    public void PreviewSynth(int k, int note)
    {
        var notes = Mono(k) ? new JsonArray(note) : new JsonArray(note, note + 4, note + 7);
        Op("prev", new JsonObject { ["k"] = k, ["notes"] = notes });
    }
    public static string DefaultPreset(int k) => SynthPreset[k];
}
