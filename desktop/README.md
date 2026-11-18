# DrumBort Host (desktop)

> **Windows**: lo zip contiene `DrumBort.exe`, l'app con **interfaccia nativa** (WPF) che include motore audio e server per i telefoni (progetto in [`Win/`](Win)). Le istruzioni qui sotto valgono per l'host di macOS e Linux; su Windows le opzioni utili sono `--no-audio` e `--port`.

Applicazione per PC (Windows, macOS, Linux) che:

- genera l'audio di DrumBort con un **motore nativo C#** (stessi suoni della web app);
- serve la web app sulla rete locale, così il **telefono diventa il controller**: pattern, suoni, synth wavetable, mixer, pad e trasporto si modificano dal telefono e il PC suona.

## Avvio

1. Scarica dalla [pagina Release](https://github.com/RickBortCost/DrumBort-Machine/releases) lo zip per il tuo sistema (`win-x64`, `osx-arm64` per Mac Apple Silicon, `osx-x64` per Mac Intel, `linux-x64`) ed estrailo.
2. Avvia `DrumBortHost` (Windows: `DrumBortHost.exe`, l'unico programma nella cartella; accanto ci sono solo le cartelle `Assets` e `wwwroot`, da lasciare dove sono). Non serve installare .NET.
3. Si apre la **finestra del programma** DrumBort Machine, senza browser né console: è una finestra nativa che mostra l'interfaccia con il motore web del sistema (WebView2 su Windows, WebKit su macOS e Linux). Chiudendola si chiude tutto. Il registro è in `DrumBort/host.log` nella cartella dei dati dell'utente (Windows: `%LOCALAPPDATA%\DrumBort\host.log`).
4. Per collegare il telefono: **Menu → 📱 Collega telefono** mostra il **QR code** e l'indirizzo. Sul telefono, collegato alla **stessa rete Wi-Fi**, inquadra il QR (o apri l'indirizzo): si apre il **Sound Lab** (badge **⇄ PC**) e i suoni che salvi arrivano nella libreria del PC. Con `?full` il telefono diventa invece il controller della drum machine (badge **CTRL·C#**) e l'audio esce dal PC.

Il primo dispositivo con la drum machine che si collega porta il proprio progetto sull'host; quelli successivi lo ricevono, sostituendo il progetto locale. Un telefono in **Sound Lab** invia solo i suoni che crei (synth e batteria): arrivano nella libreria del PC e al motore senza toccare il progetto. Per usare il telefono come controller della drum machine apri l'indirizzo con `?full`.

- **Windows**: al primo avvio consenti l'accesso alle reti private nel firewall.
- **macOS**: il pacchetto non ha una firma Apple. La prima volta, nel Terminale dentro la cartella estratta:
  ```bash
  xattr -dr com.apple.quarantine .
  codesign --force --sign - DrumBortHost libportaudio.dylib   # necessario sui Mac Apple Silicon
  ./DrumBortHost
  ```
- **Linux**: serve ALSA, PulseAudio o PipeWire (la libreria PortAudio è inclusa) e, per la finestra nativa, WebKitGTK (`libwebkit2gtk-4.1-0`, già presente nei desktop GNOME). Senza WebKitGTK l'interfaccia si apre in Chrome/Chromium. Avvio: `./DrumBortHost` (se serve, prima `chmod +x DrumBortHost`).
- **Windows**: la finestra usa il runtime WebView2, già incluso in Windows 10 e 11; se manca, l'interfaccia si apre in Edge. Lanciato da un terminale, il programma scrive lì i messaggi.

## Opzioni

| Opzione | Significato |
| --- | --- |
| `--port 8765` | Porta HTTP/WebSocket |
| `--mode browser` | Relay: l'audio lo produce il browser del PC (`http://localhost:8765/`), il telefono comanda |
| `--device N` | Uscita audio (elenco con `--list-devices`) |
| `--buffer 1024` | Buffer in campioni: più basso = meno latenza, più rischio di interruzioni |
| `--rate 48000` | Frequenza di campionamento |
| `--no-audio` | Motore attivo senza scheda audio (test, server) |
| `--no-qr` | Non stampa il QR code nel terminale |
| `--no-browser` | Non apre la finestra dell'interfaccia (server) |
| `--browser-window` | Interfaccia in una finestra di Edge/Chrome invece della finestra nativa |
| `--export prog.json out.wav` | Export offline senza interfaccia: `--source pattern\|arr\|song`, `--reps 4`, `--bits 16\|24\|32`, `--stems` (un file per traccia) |

Se la scheda audio non è disponibile l'host passa da solo alla modalità browser.

## Come funziona

- **Motore**: grafo audio a blocchi di 128 campioni con la stessa semantica delle API Web Audio usate dalla web app (oscillatori band-limited, filtri biquad della specifica, automazioni dei parametri, waveshaper, delay), porting 1:1 di kit, synth sottrattivo/FM, piano, corde, organo e synth wavetable. Il riverbero è algoritmico (al posto della convoluzione) e tarato sul livello e sulla durata originali; il compressore master riproduce la curva di Chrome.
- **Prestazioni**: il rendering gira su un thread dedicato con buffer ad anello verso PortAudio. Le voci vengono pre-renderizzate in background: dal secondo colpo in poi ogni voce costa un solo buffer.
- **Sincronizzazione**: i dispositivi si scambiano le parti del progetto (pattern, effetti, song, session, arrangiamento, kit e preset utente) e le azioni dal vivo (play/stop, lanci di clip e scene, pad, note, beat repeat, fill, mute, filtro XY). Ogni azione è eseguita anche dal motore.
- **Asset**: `Assets/kits.json` e `Assets/presets.json` sono generati dalla web app (`node tools/export-dsp.mjs`), quindi kit e preset restano gli stessi.

## Sviluppo

```bash
cd desktop
dotnet build -c Release
./bin/Release/net8.0/DrumBortHost --no-audio          # host senza scheda audio
./bin/Release/net8.0/DrumBortHost --render-voices v.json && node ../tests/desktop-compare.mjs v.json
node ../tests/remote.mjs                               # test telefono ↔ PC
```

Limiti attuali: i campioni WAV caricati nel browser non vengono trasferiti all'host; sul controller i misuratori del mixer restano fermi; con più controller la modalità (session o pattern) segue l'ultimo dispositivo che l'ha cambiata.
