// Hub.cs — WebSocket /ws: ruoli (engine/control), cache del progetto, inoltro di parti e
// azioni tra i dispositivi e, in modalità nativa, comandi al motore C#.

using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using DrumBort.Engine;

namespace DrumBort.Host;

public sealed class Hub
{
    sealed class Client
    {
        public required int Id; public required WebSocket Ws; public required bool Local;
        public string Role = "control";
        public readonly SemaphoreSlim Lock = new(1, 1);
    }

    readonly ConcurrentDictionary<int, Client> clients = new();
    readonly JsonObject cache = new();
    readonly object cacheLock = new();
    readonly AudioEngine? engine;
    readonly Dictionary<string, IVoiceHandle> held = new();
    int nextId;

    public Hub(AudioEngine? engine) { this.engine = engine; }
    public bool Native => engine != null;
    public int Count => clients.Count;

    public async Task Handle(HttpContext http)
    {
        if (!http.WebSockets.IsWebSocketRequest) { http.Response.StatusCode = 400; return; }
        using var ws = await http.WebSockets.AcceptWebSocketAsync();
        var ip = http.Connection.RemoteIpAddress;
        var c = new Client { Id = Interlocked.Increment(ref nextId), Ws = ws, Local = ip != null && IPAddress.IsLoopback(ip) };
        clients[c.Id] = c;
        Console.WriteLine($"+ dispositivo {c.Id} ({ip}) — collegati: {clients.Count}");
        try
        {
            var buf = new byte[1 << 16];
            var ms = new MemoryStream();
            while (ws.State == WebSocketState.Open)
            {
                var r = await ws.ReceiveAsync(buf, http.RequestAborted);
                if (r.MessageType == WebSocketMessageType.Close) break;
                ms.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                ms.SetLength(0);
                await OnMessage(c, text);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        finally
        {
            clients.TryRemove(c.Id, out _);
            Console.WriteLine($"- dispositivo {c.Id} — collegati: {clients.Count}");
            if (c.Role == "engine") await PromoteEngine();
            await Broadcast(new JsonObject { ["t"] = "peers", ["n"] = clients.Count }, null);
        }
    }

    /// <summary>Relay: se il browser che suonava esce, un altro browser del PC prende il ruolo.</summary>
    async Task PromoteEngine()
    {
        if (Native || clients.Values.Any(x => x.Role == "engine")) return;
        var next = clients.Values.FirstOrDefault(x => x.Local);
        if (next == null) return;
        next.Role = "engine";
        await Send(next, new JsonObject { ["t"] = "welcome", ["role"] = "engine", ["native"] = false, ["seed"] = false });
    }

    async Task OnMessage(Client c, string text)
    {
        JsonObject? m;
        try { m = JsonNode.Parse(text) as JsonObject; } catch { return; }
        if (m == null) return;
        switch (J.S(m, "t", ""))
        {
            case "hello":
            {
                bool seed;
                // Il progetto lo porta il primo dispositivo con i pattern (il Sound Lab manda solo i suoni)
                lock (cacheLock) seed = !cache.ContainsKey("p0");
                c.Role = !Native && c.Local && !clients.Values.Any(x => x.Id != c.Id && x.Role == "engine") ? "engine" : "control";
                await Send(c, new JsonObject { ["t"] = "welcome", ["role"] = c.Role, ["native"] = Native, ["seed"] = seed });
                if (!seed)
                {
                    JsonObject parts;
                    lock (cacheLock) parts = (JsonObject)cache.DeepClone();
                    await Send(c, new JsonObject { ["t"] = "state", ["parts"] = parts, ["full"] = true });
                }
                await Broadcast(new JsonObject { ["t"] = "peers", ["n"] = clients.Count }, null);
                break;
            }
            case "state":
            {
                if (m["parts"] is not JsonObject parts) return;
                lock (cacheLock)
                    foreach (var (k, v) in parts)
                    {
                        // Librerie dei suoni: unione per id (Sound Lab e PC aggiungono, nessuno cancella quelli dell'altro)
                        if ((k == "userSounds" || k == "userPresets") && v is JsonArray add && cache[k] is JsonArray have)
                        {
                            var ids = add.Select(x => J.S(x, "id", "")).ToHashSet();
                            var merged = new JsonArray(have.Where(x => !ids.Contains(J.S(x, "id", ""))).Select(x => x!.DeepClone()).Concat(add.Select(x => x!.DeepClone())).ToArray());
                            cache[k] = merged;
                        }
                        else cache[k] = v?.DeepClone();
                    }
                if (engine != null)
                {
                    var copy = (JsonObject)parts.DeepClone();
                    lock (cacheLock)
                        foreach (var k in new[] { "userSounds", "userPresets" })
                            if (copy.ContainsKey(k)) copy[k] = cache[k]?.DeepClone();
                    engine.Post(() => { engine.Seq.P.Apply(copy); engine.Seq.Sync(); });
                }
                await Broadcast(m, c);
                break;
            }
            case "op":
                if (engine != null) { engine.Touch(); var op = (JsonObject)m.DeepClone(); engine.Post(() => Op(op)); }
                await Broadcast(m, c);
                break;
        }
    }

    /// <summary>Azioni dal vivo eseguite dal motore nativo (thread audio).</summary>
    void Op(JsonObject m)
    {
        var e = engine!; var seq = e.Seq; double now = e.Ctx.CurrentTime;
        int[] Notes() => J.Nums(m["notes"]).Select(x => (int)x).ToArray();
        SynthTrack Tr(int k) => seq.P.Slots[seq.P.Slot].Synth.Tracks[Math.Clamp(k, 0, 3)];
        switch (J.S(m, "op", ""))
        {
            case "play": seq.Start(); break;
            case "stop": seq.Stop(); break;
            case "launch": seq.LaunchClip(J.I(m, "i", 0), J.I(m, "s", 0)); break;
            case "scene": seq.LaunchScene(J.I(m, "s", 0)); break;
            case "stopall": seq.StopAllClips(); break;
            case "arr": seq.ToggleArr(); break;
            case "met": seq.Metronome = J.B(m, "on"); break;
            case "trig":
            {
                int i = J.I(m, "i", 0);
                if (i >= 0 && i < 8) e.Mx.Trigger(i, now, Math.Clamp(J.D(m, "vel", 0.8), 0, 1), seq.Pattern.Tracks[i]);
                break;
            }
            case "prev": e.Mx.PlaySynth(Math.Clamp(J.I(m, "k", 0), 0, 3), now, 0.22, Notes(), 0.8, Tr(J.I(m, "k", 0))); break;
            case "non":
            {
                string id = $"{J.S(m, "cid", "")}:{J.S(m, "id", "")}";
                if (held.Remove(id, out var prev)) prev.Release(now);
                var h = e.Mx.PlaySynth(Math.Clamp(J.I(m, "k", 0), 0, 3), now, null, Notes(), Math.Clamp(J.D(m, "vel", 0.85), 0, 1), Tr(J.I(m, "k", 0)));
                if (h != null) held[id] = h;
                break;
            }
            case "noff":
                if (held.Remove($"{J.S(m, "cid", "")}:{J.S(m, "id", "")}", out var hh)) hh.Release(now);
                break;
            case "stut": seq.StartStutter(J.I(m, "len", 0)); break;
            case "fill": seq.Fill(J.B(m, "on")); break;
            case "mutes":
                seq.MuteD = J.Nums(m["d"]).Select(x => (int)x).ToHashSet();
                seq.MuteS = J.Nums(m["s"]).Select(x => (int)x).ToHashSet();
                break;
            case "fxl":
                if (m["fx"] is JsonObject fx) e.Mx.SetLiveFilter(J.D(fx, "filter", seq.P.Fx.Filter), J.D(fx, "res", seq.P.Fx.Res));
                break;
        }
    }

    public Task Broadcast(JsonObject m) => Broadcast(m, null);

    async Task Broadcast(JsonObject m, Client? except)
    {
        var data = Encoding.UTF8.GetBytes(m.ToJsonString());
        foreach (var c in clients.Values) if (c != except) await Send(c, data);
    }

    static Task Send(Client c, JsonObject m) => Send(c, Encoding.UTF8.GetBytes(m.ToJsonString()));
    static async Task Send(Client c, byte[] data)
    {
        await c.Lock.WaitAsync();
        try { if (c.Ws.State == WebSocketState.Open) await c.Ws.SendAsync(data, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch (WebSocketException) { }
        finally { c.Lock.Release(); }
    }
}
