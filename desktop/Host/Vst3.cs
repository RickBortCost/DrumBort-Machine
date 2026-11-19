// Vst3.cs — Plugin VST 3 (effetti) come device della catena, tramite la libreria nativa
// drumbort_vst3 (desktop/Native/vst3host, SDK VST 3 con licenza MIT).
//
// Device: { type: "vst3", p: { path, cid, name, state (base64) } }. Lo stato del plugin si salva nel
// progetto; la finestra del plugin si apre dall'interfaccia (Windows).

using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using DrumBort.Audio;

namespace DrumBort.Host;

public static class Vst3
{
    const string Lib = "drumbort_vst3";
    static bool? available;

    static Vst3()
    {
        NativeLibrary.SetDllImportResolver(typeof(Vst3).Assembly, (name, asm, path) =>
        {
            if (name != Lib) return IntPtr.Zero;
            string file = OperatingSystem.IsWindows() ? "drumbort_vst3.dll" : OperatingSystem.IsMacOS() ? "libdrumbort_vst3.dylib" : "libdrumbort_vst3.so";
            foreach (var dir in new[] { AppContext.BaseDirectory, Path.Combine(AppContext.BaseDirectory, "native"), Environment.GetEnvironmentVariable("DRUMBORT_VST3_LIB") ?? "" })
                if (dir != "" && File.Exists(Path.Combine(dir, file)) && NativeLibrary.TryLoad(Path.Combine(dir, file), out var h)) return h;
            return IntPtr.Zero;
        });
    }

    [DllImport(Lib)] static extern IntPtr dbv_error();
    [DllImport(Lib)] static extern int dbv_scan([MarshalAs(UnmanagedType.LPUTF8Str)] string path, byte[]? outBuf, int cap);
    [DllImport(Lib)] static extern IntPtr dbv_open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, [MarshalAs(UnmanagedType.LPUTF8Str)] string? cid, double rate, int maxBlock);
    [DllImport(Lib)] static extern IntPtr dbv_name(IntPtr h);
    [DllImport(Lib)] static extern void dbv_set_tempo(IntPtr h, double bpm);
    [DllImport(Lib)] static extern unsafe int dbv_process(IntPtr h, float* inL, float* inR, float* outL, float* outR, int n);
    [DllImport(Lib)] static extern int dbv_param_count(IntPtr h);
    [DllImport(Lib)] static extern int dbv_param_info(IntPtr h, int i, byte[]? outBuf, int cap);
    [DllImport(Lib)] static extern double dbv_param_get(IntPtr h, uint id);
    [DllImport(Lib)] static extern int dbv_param_text(IntPtr h, uint id, double v, byte[]? outBuf, int cap);
    [DllImport(Lib)] static extern void dbv_param_set(IntPtr h, uint id, double v);
    [DllImport(Lib)] static extern int dbv_get_state(IntPtr h, byte[]? outBuf, int cap);
    [DllImport(Lib)] static extern int dbv_set_state(IntPtr h, byte[] buf, int len);
    [DllImport(Lib)] static extern int dbv_editor_open(IntPtr h, IntPtr parent, out int w, out int hgt);
    [DllImport(Lib)] static extern int dbv_editor_size(IntPtr h, out int w, out int hgt);
    [DllImport(Lib)] static extern void dbv_editor_close(IntPtr h);
    [DllImport(Lib)] static extern void dbv_close(IntPtr h);

    /// <summary>La libreria nativa è presente e caricabile?</summary>
    public static bool Available
    {
        get
        {
            if (available is bool b) return b;
            try { dbv_error(); available = true; } catch { available = false; }
            return available.Value;
        }
    }
    static string LastError() { try { return Marshal.PtrToStringUTF8(dbv_error()) ?? ""; } catch { return ""; } }

    static string Call(Func<byte[]?, int, int> f)
    {
        int n = f(null, 0);
        if (n < 0) return "";
        var buf = new byte[n + 1];
        f(buf, buf.Length);
        return Encoding.UTF8.GetString(buf, 0, n);
    }

    public sealed record PluginInfo(string Path, string Cid, string Name, string Vendor, string Sub);

    /// <summary>Cartelle standard dei plugin VST 3.</summary>
    public static IEnumerable<string> Folders()
    {
        if (OperatingSystem.IsWindows())
        {
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonProgramFiles), "VST3");
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Common", "VST3");
        }
        else if (OperatingSystem.IsMacOS()) { yield return "/Library/Audio/Plug-Ins/VST3"; yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library/Audio/Plug-Ins/VST3"); }
        else { yield return "/usr/lib/vst3"; yield return "/usr/local/lib/vst3"; yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".vst3"); }
        if (Environment.GetEnvironmentVariable("DRUMBORT_VST3_PATH") is string extra && extra != "") yield return extra;
    }

    /// <summary>Effetti nei file .vst3 delle cartelle (un file che non si carica viene saltato).</summary>
    public static List<PluginInfo> Scan(IEnumerable<string>? folders = null)
    {
        var list = new List<PluginInfo>();
        if (!Available) return list;
        foreach (var dir in folders ?? Folders())
        {
            if (!Directory.Exists(dir)) continue;
            IEnumerable<string> found;
            try { found = Directory.EnumerateFileSystemEntries(dir, "*.vst3", SearchOption.AllDirectories).ToList(); } catch { continue; }
            foreach (var f in found)
            {
                // Un bundle .vst3 contiene a sua volta cartelle: si prende solo il livello più esterno
                if (found.Any(o => o != f && f.StartsWith(o + Path.DirectorySeparatorChar))) continue;
                try
                {
                    var json = Call((b, c) => dbv_scan(f, b, c));
                    if (json == "") { Console.Error.WriteLine($"[vst3] {f}: {LastError()}"); continue; }
                    if (JsonNode.Parse(json) is JsonArray a)
                        foreach (var x in a)
                            list.Add(new PluginInfo(f, x!["cid"]!.GetValue<string>(), x["name"]!.GetValue<string>(), x["vendor"]?.GetValue<string>() ?? "", x["sub"]?.GetValue<string>() ?? ""));
                }
                catch (Exception e) { Console.Error.WriteLine($"[vst3] {f}: {e.Message}"); }
            }
        }
        return list;
    }

    /// <summary>Istanze vive per id del device (la finestra del plugin le cerca qui).</summary>
    public static readonly Dictionary<string, Plugin> Live = new();
    /// <summary>Chiusura dei plugin tolti dalla catena: sul thread dell'interfaccia se c'è (la finestra del plugin vive lì).</summary>
    public static Action<Plugin>? Reaper;
    public static void Retire(Plugin p) { if (Reaper != null) Reaper(p); else p.Dispose(); }
    public static event Action<string>? StateChanged;
    internal static void NotifyState(string id) => StateChanged?.Invoke(id);

    public sealed record Param(uint Id, string Name, string Units, int Steps, double Def);

    /// <summary>Un effetto caricato. Process sul thread audio, il resto dall'interfaccia.</summary>
    public sealed class Plugin : IDisposable
    {
        IntPtr h;
        public readonly string Name, Path, Cid;
        public string? AppliedState;
        Plugin(IntPtr h, string path, string cid) { this.h = h; Path = path; Cid = cid; Name = Marshal.PtrToStringUTF8(dbv_name(h)) ?? "VST3"; }

        public static Plugin Open(string path, string cid, int rate, int block)
        {
            if (!Available) throw new InvalidOperationException("Libreria VST 3 non disponibile");
            var h = dbv_open(path, cid, rate, block);
            if (h == IntPtr.Zero) throw new InvalidOperationException(LastError());
            return new Plugin(h, path, cid);
        }

        public unsafe bool Process(float[] inL, float[] inR, float[] outL, float[] outR, int n)
        {
            if (h == IntPtr.Zero) return false;
            fixed (float* a = inL, b = inR, c = outL, d = outR) return dbv_process(h, a, b, c, d, n) == 0;
        }
        public void SetTempo(double bpm) { if (h != IntPtr.Zero) dbv_set_tempo(h, bpm); }

        public List<Param> Params()
        {
            var l = new List<Param>();
            int n = dbv_param_count(h);
            for (int i = 0; i < n; i++)
            {
                int k = i;
                var j = JsonNode.Parse(Call((b, c) => dbv_param_info(h, k, b, c)));
                if (j == null) continue;
                l.Add(new Param((uint)j["id"]!.GetValue<long>(), j["name"]!.GetValue<string>(), j["units"]!.GetValue<string>(), j["steps"]!.GetValue<int>(), j["def"]!.GetValue<double>()));
            }
            return l;
        }
        public double Get(uint id) => dbv_param_get(h, id);
        public void Set(uint id, double v) => dbv_param_set(h, id, Math.Clamp(v, 0, 1));
        public string Text(uint id, double v) => Call((b, c) => dbv_param_text(h, id, v, b, c));

        public string GetState()
        {
            int n = dbv_get_state(h, null, 0);
            if (n <= 0) return "";
            var buf = new byte[n];
            dbv_get_state(h, buf, n);
            return Convert.ToBase64String(buf);
        }
        public bool SetState(string b64)
        {
            if (string.IsNullOrEmpty(b64)) return false;
            try { var buf = Convert.FromBase64String(b64); return dbv_set_state(h, buf, buf.Length) == 0; }
            catch { return false; }
        }

        public bool OpenEditor(IntPtr parent, out int w, out int hgt) { w = hgt = 0; return h != IntPtr.Zero && dbv_editor_open(h, parent, out w, out hgt) == 0; }
        public bool EditorSize(out int w, out int hgt) { w = hgt = 0; return h != IntPtr.Zero && dbv_editor_size(h, out w, out hgt) == 0; }
        public void CloseEditor() { if (h != IntPtr.Zero) dbv_editor_close(h); }

        public void Dispose()
        {
            if (h == IntPtr.Zero) return;
            var x = h; h = IntPtr.Zero;
            dbv_close(x);
        }
    }
}

/// <summary>Nodo del grafo che fa passare l'audio nel plugin (blocchi di 128 campioni).</summary>
public sealed class Vst3Node : AudioNode
{
    public readonly Vst3.Plugin? Plugin;
    readonly float[] inL = new float[AudioContext.Block], inR = new float[AudioContext.Block];
    public Vst3Node(AudioContext c, Vst3.Plugin? p) : base(c) { Plugin = p; }
    protected override void Process()
    {
        SumInputs(inL, inR, out bool st);
        if (!st) Array.Copy(inL, inR, AudioContext.Block);
        if (Plugin == null || !Plugin.Process(inL, inR, L, R, AudioContext.Block))
        {
            // Plugin assente o in errore: l'audio passa invariato
            Array.Copy(inL, L, AudioContext.Block); Array.Copy(inR, R, AudioContext.Block);
        }
        Stereo = true;
    }
}
