// PaHost.cs — Funzioni PortAudio non esposte da PortAudioSharp: API host (WASAPI su Windows) e
// parametri WASAPI. Più il dispositivo predefinito di Windows letto via MMDevice (COM), senza
// dover reinizializzare PortAudio: si riapre l'uscita solo quando il predefinito cambia davvero.

using System.Runtime.InteropServices;

namespace DrumBort.Host;

static class PaHost
{
    public const int WASAPI = 13;           // paWASAPI
    const string Lib = "portaudio";

    [StructLayout(LayoutKind.Sequential)]
    struct HostApiInfo
    {
        public int structVersion, type;
        public IntPtr name;
        public int deviceCount, defaultInputDevice, defaultOutputDevice;
    }

    [DllImport(Lib)] static extern int Pa_HostApiTypeIdToHostApiIndex(int type);
    [DllImport(Lib)] static extern IntPtr Pa_GetHostApiInfo(int hostApi);

    /// <summary>Indice dell'API host (es. WASAPI), −1 se assente.</summary>
    public static int Index(int type)
    {
        try { return Pa_HostApiTypeIdToHostApiIndex(type); } catch { return -1; }
    }

    /// <summary>Dispositivo di uscita predefinito di un'API host, −1 se assente.</summary>
    public static int DefaultOutput(int hostApi)
    {
        try
        {
            var p = Pa_GetHostApiInfo(hostApi);
            if (p == IntPtr.Zero) return -1;
            return Marshal.PtrToStructure<HostApiInfo>(p).defaultOutputDevice;
        }
        catch { return -1; }
    }

    // PaWasapiStreamInfo (pa_win_wasapi.h): "unsigned long" = 32 bit su Windows
    [StructLayout(LayoutKind.Sequential)]
    struct WasapiStreamInfo
    {
        public uint size;
        public int hostApiType;
        public uint version;
        public uint flags;
        public uint channelMask;
        public IntPtr hostProcessorOutput, hostProcessorInput;
        public int threadPriority, streamCategory, streamOption;
    }
    const uint AutoConvert = 1 << 6;       // paWinWasapiAutoConvert: conversione di frequenza in modalità condivisa

    /// <summary>Struttura WASAPI (memoria non gestita, da liberare con Marshal.FreeHGlobal).</summary>
    const uint Exclusive = 1;              // paWinWasapiExclusive: accesso esclusivo, latenza minima
    const uint ThreadPriority = 1 << 4;    // paWinWasapiThreadPriority
    public static IntPtr WasapiInfo(bool exclusive = false)
    {
        var s = new WasapiStreamInfo
        {
            size = (uint)Marshal.SizeOf<WasapiStreamInfo>(), hostApiType = WASAPI, version = 1,
            flags = exclusive ? Exclusive | ThreadPriority : AutoConvert,
            threadPriority = exclusive ? 5 : 0,   // eThreadPriorityProAudio
        };
        var p = Marshal.AllocHGlobal(Marshal.SizeOf<WasapiStreamInfo>());
        Marshal.StructureToPtr(s, p, false);
        return p;
    }

    // ---------------------------------------------------------------- Windows: predefinito di sistema
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    static IMMDeviceEnumerator? enumerator;

    /// <summary>Id dell'uscita predefinita di Windows (eRender, eConsole); null altrove o in caso di errore.</summary>
    public static string? WindowsDefaultId()
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            enumerator ??= (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(0, 0, out var dev) != 0 || dev == null) return null;
            try { return dev.GetId(out var id) == 0 ? id : null; }
            finally { Marshal.ReleaseComObject(dev); }
        }
        catch { return null; }
    }
}
