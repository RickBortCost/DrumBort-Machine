// VoiceCache.cs — Voci pre-renderizzate su un thread separato (come js/voicecache.js, ma senza
// pesare sul thread audio). Primo colpo: sintesi dal vivo + richiesta; i successivi: 1 buffer.

using System.Collections.Concurrent;
using DrumBort.Audio;

namespace DrumBort.Engine;

public sealed class VoiceCache : IDisposable
{
    readonly int sampleRate;
    readonly ConcurrentDictionary<string, AudioBuf> map = new();
    readonly ConcurrentDictionary<string, byte> pending = new();
    readonly BlockingCollection<(string key, double dur, Action<AudioContext, AudioNode> play)> queue = new(256);
    readonly ConcurrentQueue<string> order = new();
    readonly Thread worker;
    long bytes;
    const long MaxBytes = 768L << 20;     // 768 MB: più voci pronte, meno sintesi dal vivo
    public int Count => map.Count;
    public long Rendered;

    public VoiceCache(int sampleRate)
    {
        this.sampleRate = sampleRate;
        worker = new Thread(Work) { IsBackground = true, Name = "DrumBort voice cache", Priority = ThreadPriority.BelowNormal };
        worker.Start();
    }

    public bool TryGet(string key, out AudioBuf buf) => map.TryGetValue(key, out buf!);

    /// <summary>Chiede il rendering (ignorato se già presente, in coda o se la coda è piena).</summary>
    public void Request(string key, double dur, Action<AudioContext, AudioNode> play)
    {
        if (map.ContainsKey(key) || !pending.TryAdd(key, 0)) return;
        if (!queue.TryAdd((key, dur, play))) pending.TryRemove(key, out _);
    }

    void Work()
    {
        foreach (var (key, dur, play) in queue.GetConsumingEnumerable())
        {
            try
            {
                var ctx = new AudioContext(sampleRate);
                play(ctx, ctx.Destination);
                int frames = (int)Math.Ceiling(dur * sampleRate / AudioContext.Block) * AudioContext.Block;
                var data = new float[frames]; var dataR = new float[frames];
                var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
                bool stereo = false;
                for (int f = 0; f < frames; f += AudioContext.Block)
                {
                    ctx.RenderBlock(l, r, 0);
                    Array.Copy(l, 0, data, f, AudioContext.Block);
                    Array.Copy(r, 0, dataR, f, AudioContext.Block);
                    if (!stereo) for (int i = 0; i < AudioContext.Block; i++) if (l[i] != r[i]) { stereo = true; break; }
                }
                // Coda silenziosa tagliata (−90 dB); voci stereo (unisono, spread) conservate in stereo
                int end = frames;
                while (end > 0 && Math.Abs(data[end - 1]) < 3e-5f && Math.Abs(dataR[end - 1]) < 3e-5f) end--;
                var buf = new AudioBuf(stereo ? 2 : 1, Math.Max(1, end), sampleRate);
                Array.Copy(data, buf.Data[0], buf.Length);
                if (stereo) Array.Copy(dataR, buf.Data[1], buf.Length);
                map[key] = buf;
                order.Enqueue(key);
                Rendered++;
                if (Interlocked.Add(ref bytes, buf.Length * 4L * buf.Data.Length) > MaxBytes)
                    while (Interlocked.Read(ref bytes) > MaxBytes * 3 / 4 && order.TryDequeue(out var old))
                        if (map.TryRemove(old, out var ob)) Interlocked.Add(ref bytes, -ob.Length * 4L * ob.Data.Length);
            }
            catch (Exception e) { Console.Error.WriteLine($"[cache] {key}: {e.Message}"); }
            finally { pending.TryRemove(key, out _); }
        }
    }

    public void Dispose() => queue.CompleteAdding();
}
