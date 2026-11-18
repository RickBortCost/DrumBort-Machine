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
    const long MaxBytes = 256L << 20;     // 256 MB
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
                var data = new float[frames];
                var l = new float[AudioContext.Block]; var r = new float[AudioContext.Block];
                for (int f = 0; f < frames; f += AudioContext.Block)
                {
                    ctx.RenderBlock(l, r, 0);
                    Array.Copy(l, 0, data, f, AudioContext.Block);
                }
                // Coda silenziosa tagliata (−90 dB)
                int end = frames;
                while (end > 0 && Math.Abs(data[end - 1]) < 3e-5f) end--;
                var buf = new AudioBuf(1, Math.Max(1, end), sampleRate);
                Array.Copy(data, buf.Data[0], buf.Length);
                map[key] = buf;
                order.Enqueue(key);
                Rendered++;
                if (Interlocked.Add(ref bytes, buf.Length * 4L) > MaxBytes)
                    while (Interlocked.Read(ref bytes) > MaxBytes * 3 / 4 && order.TryDequeue(out var old))
                        if (map.TryRemove(old, out var ob)) Interlocked.Add(ref bytes, -ob.Length * 4L);
            }
            catch (Exception e) { Console.Error.WriteLine($"[cache] {key}: {e.Message}"); }
            finally { pending.TryRemove(key, out _); }
        }
    }

    public void Dispose() => queue.CompleteAdding();
}
