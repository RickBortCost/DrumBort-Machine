# DrumBort-Machine

[![Deploy to GitHub Pages](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/pages.yml/badge.svg)](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/pages.yml)
[![CI](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/ci.yml/badge.svg)](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RickBortCost/DrumBort-Machine)](https://github.com/RickBortCost/DrumBort-Machine/releases)

Drum machine e groovebox per il web: step sequencer 16 × 8, pad live, una libreria di kit ispirati alle drum machine storiche e una sezione synth con basso, lead e pad di accordi. Tutti i suoni sono sintetizzati in tempo reale con la Web Audio API, senza campioni esterni. Ottimizzata per il touch su iPhone e iPad, installabile come PWA e utilizzabile offline.

**Demo:** https://rickbortcost.github.io/DrumBort-Machine/

## Funzioni

**Sequencer**
- 16 step × 8 tracce, due livelli di accento (tap: off → normale → accento), trascinamento per dipingere.
- Lunghezza per traccia 1–16 step: poliritmi e terzine (12 step).
- Opzioni per step (modalità **EDIT**): probabilità, ratchet 2–4, flam, nudge ±50%.
- Scheduler look-ahead (timer 25 ms, pianificazione 100 ms avanti).
- Tempo 40–240 BPM, **TAP** tempo, swing 50–75%, metronomo (**MET**).
- Annulla/ripeti (↶ ↷, Ctrl/Cmd+Z), copia/incolla dei pattern (**CPY**/**PST**).

**Pattern e song**
- 8 pattern salvati in `localStorage`, groove demo per ogni kit.
- **SONG**: catena di pattern con ripetizioni 1–8; la vista segue la riproduzione.
- 🔒 blocca il kit quando cambi pattern.
- Export/import JSON (pattern, song, effetti).

**Suono**
- Mute/Solo, volume, tune, decay, pan, mandate riverbero e delay per traccia (pagine SND/MIX).
- **FX** master: filtro LP/HP con risonanza, riverbero, delay sincronizzato al tempo, volume master.
- Campioni WAV propri per traccia, salvati nel browser (IndexedDB).
- Export **WAV** del pattern (×4) o della song.

**Live e MIDI**
- 8 pad; con **●** (REC) attivo i colpi vengono registrati nello step più vicino.
- Web MIDI: note in → pad, note out su canale 10 (mappa GM), clock in/out. Non disponibile su Safari iOS/iPadOS.

**App**
- PWA installabile, funziona offline, avviso "Nuova versione disponibile".
- Accessibilità: step leggibili da VoiceOver, navigazione con frecce e Invio.

## Libreria suoni

Il nome del suono nella testa dei parametri synth apre la **libreria**: 59 strumenti in 13 categorie (Bass, Lead, Pad, Keys, Piano, Organ, Strings, Brass, Pluck, Mallet, Bell, Choir, FX), ricerca per nome o tag (es. *warm*, *fm*, *vintage*), preferiti ★ e ascolto al tocco. I suoni sono tutti sintetizzati: piano additivo, corde pizzicate (Karplus-Strong), organo a drawbar, cori a formanti, FM, sottrattiva con LFO e rumore. La libreria si ispira al flusso di lavoro dei *rompler* (sfoglia, ascolta, assegna) senza riprodurne nomi, grafica o suoni.

## Layout Studio (PC)

Su computer (finestra di almeno 1000×600) l'app si apre nel layout **Studio**, pensato per mouse e tastiera e organizzato come una *session view*:

- **Browser** (sinistra): suoni per categoria e ricerca; kit. Un clic assegna il suono alla traccia synth selezionata o il kit al pattern.
- **Clip** (centro): colonne = 12 tracce (8 batteria + 4 synth), righe = 8 pattern. ▶ lancia la clip di quella traccia, ▶ P1…P8 lancia la scena intera, ■ ferma una traccia o tutte. I lanci sono quantizzati (menu **LANCIO**: nessuna, 1/4, 1/2, 1, 2 o 4 battute). Un clic sul corpo della clip la apre nell'editor sottostante (doppio clic: lancia).
- **Follow action** per scena (colonna FOLLOW): dopo N battute lancia la scena successiva, precedente, la prima, una casuale, un'altra o ferma tutto.
- **Arrangement** (pulsante ARRANGE o **Tab**): timeline tracce × battute. **● REC ARR** registra i lanci della session battuta per battuta; **▶ ARR** riproduce l'arrangiamento (un lancio manuale torna alla session, come in Live). Le celle si dipingono con il pattern selezionato (trascinando), la riga TEMPO sceglie il pattern che dà tempo e swing, il righello fissa il punto di partenza; + BAR, − BAR, ×2, DA SONG (converte la catena del song mode), SVUOTA.
- **Editor** (sotto le clip): la griglia step della batteria o le corsie note del synth per la clip selezionata.
- **Parametri e pad** (destra), **mixer** (in basso) con fader, pan, mandate, mute/solo e indicatori di livello.
- Tastiera: **1-8** lanciano le scene, **.** ferma tutto, **Tab** session/arrangement, **W** synth wavetable, **Spazio** play/stop, **Ctrl/Cmd+Z** annulla.

Il pulsante **▦** nella barra (o Menu → Layout) passa tra Studio e layout compatto.

## Versione PC (DrumBort Host)

App desktop per **Windows, macOS e Linux** (cartella [`desktop/`](desktop/README.md), zip nella pagina Release): un **motore audio nativo C#** genera gli stessi suoni della web app e il **telefono fa da controller** sulla rete Wi-Fi.

1. Avvia `DrumBortHost` sul PC: compaiono gli indirizzi e un QR code.
2. Inquadra il QR con il telefono: in alto appare **CTRL·C#**. Tutto ciò che fai sul telefono (step, suoni, editor wavetable, mixer, pad, lanci, play/stop) suona sul PC.
3. Anche il browser del PC (`http://localhost:8765/`) può comandare l'host, con il layout Studio.

Con `--mode browser` l'audio lo produce invece il browser del PC (badge **AUDIO**) e il telefono lo comanda (badge **CTRL**).

Il motore C# è verificato in CI contro la web app, voce per voce (livello e inviluppo entro ±3 dB) e su compressore e riverbero. Grazie alla cache delle voci su thread separato, rende il mix completo a circa 20–25× il tempo reale; il browser, a parità di cache, arriva a 12–14×.

## Synth wavetable

Il motore wavetable (categoria **Wavetable** della libreria; editor dal pulsante **WT** in alto, dal menu Suoni o con il tasto W) segue l'approccio dei grandi synth wavetable software con un'implementazione e un'interfaccia originali:

- **3 oscillatori** con morph continuo tra i frame di 7 tabelle generate (Analog, Sync, Vocal, Digital, Additive, Growl, FM), semitoni, fine, livello; **unisono** fino a 3 voci sull'oscillatore 1; **rumore**.
- **2 filtri** LP/BP/HP/Notch in serie o in parallelo, con **drive**.
- **Modulazione**: inviluppo dedicato, 2 LFO (liberi o a tempo), **step sequencer** a 16 passi; matrice a 6 slot verso posizione wavetable, cutoff, pitch, volume, risonanza.
- Le modifiche restano nel pattern; **Salva come preset** le aggiunge alla libreria (categoria Utente).

## Performance

La vista **PRF** (pulsante vista: DRM▸ → SYN▸ → PRF▸) trasforma l'app in uno strumento dal vivo:

- **Pad XY**: filtro master (LP ← → HP) e risonanza; con SNAP torna al valore di partenza al rilascio.
- **Beat repeat** 1/2, 1/4, 1/8, 1/16 (tieni premuto) e **FILL** (tieni premuto).
- **Mute rapidi** per gruppi: kick, snare, hats, perc, bass, lead, pad, keys.
- **Sidechain**: la cassa abbassa i synth.
- **● REC**: registra l'uscita in WAV, compreso tutto ciò che suoni.

## Altre funzioni (menu ☰)

- **Progetti…**: salva e riapri progetti con nome.
- **Condividi pattern (link)**: crea un link che contiene il pattern; chi lo apre lo ritrova nello slot corrente (annullabile).
- **Generatore…**: ritmo euclideo sulla traccia selezionata, variazioni di batteria e synth, humanize.
- **Crea kit personalizzato…**: scegli per ogni strumento una voce da qualsiasi kit.
- **Esporta MIDI** di pattern o song, **Registra l'uscita**.
- Pulsante **WAV** dei parametri batteria: carica un file o registra dal **microfono**.

## Synth e pad a note

Il pulsante vista apre la sezione melodica. Quattro tracce suonano a tempo con la batteria:

| Traccia | Preset |
| --- | --- |
| BASS | Acid 303, Mono Bass 101, Ladder Bass, FM Bass, Reese, Sub, Wobble… |
| LEAD | Mono Lead 101, Ladder Lead, Screamer Lead, Supersaw, Vox Lead… |
| PAD | Poly Strings 106, Poly Pad 5, Dream Pad 80, Glass Pad (+ tutta la libreria) |
| KEYS | Tine E-Piano, Grand Piano, organi, mallet… (+ tutta la libreria) |

Ogni traccia può usare qualsiasi suono della libreria. BASS e LEAD sono monofoniche, PAD e KEYS suonano accordi.

- **Pad a note**: 8 pad sui gradi della scala scelta (tonalità, 9 scale, ottava −/+); sulla traccia PAD suonano accordi diatonici. Tieni premuto per sostenere la nota.
- **Corsie**: tocca uno step vuoto per inserire l'ultima nota suonata sui pad, tocca una nota per cancellarla, trascina per più step.
- **EDIT** su uno step synth: nota ±1 semitono / ±1 ottava, gate 1–16 step, accento, slide, tipo di accordo.
- Parametri a pagine: SND (CUT, RESO, ENV, DECAY, LEN), MOD (ATTACK, RELEASE, LFO, RATE), MIX (VOL, PAN, REV, DLY), FX (DRIVE, CRUSH).
- **ARP**: arpeggiatore che segue gli accordi di PAD o KEYS (modo, velocità, ottave, gate).
- **Parameter lock**: in EDIT ogni step può avere cutoff, decay e velocity propri (anche sulla batteria: tune, decay, velocity).
- Con **●** attivo i pad registrano note e durata. Cambiare tonalità traspone le note esistenti.
- MIDI: nella vista synth le note in arrivo suonano sulla traccia selezionata; in uscita BASS/LEAD/PAD/KEYS usano i canali 1/2/3/4.

## Kit

| Kit | Carattere |
| --- | --- |
| Roland TR-808 | Cassa con pitch-sweep e coda sub lunga, hat a 6 oscillatori, cowbell |
| Roland TR-909 | Cassa con click e drive, hat a sei square inarmoniche, ride, rimshot |
| Roland TR-606 | Suoni corti e secchi, clave |
| Roland CR-78 | Analogico e sottile, bongo, guiro |
| Linn LM-1 | "Campionato" a 8 bit, conga |
| LinnDrum | 8 bit, crash, cowbell |
| Oberheim DMX | 8 bit con drive, tamburello |
| Simmons SDS-V | Tom e rullante elettronici con rumore filtrato |
| Sequential Drumtraks | 10 bit, cowbell |
| E-mu Drumulator | 9 bit con filtro scuro, clave |

Kit di genere (sezione *Generi* del selettore):

| Kit | BPM | Suoni |
| --- | --- | --- |
| Dubstep | 140 | Cassa distorta, rullante a strati (rullante + clap + coda), sub drop, riser, laser |
| Riddim | 150 | Cassa corta saturata, gunshot snare, 808 sub, snap, crash |
| EDM Big Room | 128 | Cassa lunga con click e drive, rullante + clap, ride, riser, impact |
| House | 124 | Cassa, clap, shaker, rim, conga |
| Techno | 132 | Rumble kick, rim, ride, perc metallica, noise sweep |
| Trap | 140 | 808 lungo, cassa corta, snap, hat per i roll |
| Drum & Bass | 174 | Breakbeat con ghost snare, shaker, ride, crash |
| Future Bass | 150 | Rullante lungo, snap, chime, downlifter |
| Lo-Fi Hip Hop | 84 | 10 bit con filtro scuro, swing alto, crackle, shaker |

Tracce dei kit classici: Kick, Snare, Clap/Rim, Closed Hat, Open Hat, Tom, Cymbal/Ride, Percussione; nei kit di genere le ultime tracce ospitano FX e percussioni tipiche del genere. Ogni voce è usabile in **Crea kit**. Il closed hat strozza l'open hat.

## Aggiungi a Home (iOS)

1. Apri la demo in **Safari** su iPhone o iPad.
2. Tocca **Condividi** (quadrato con freccia).
3. Scegli **Aggiungi alla schermata Home** e conferma.
4. Avvia DrumBort dall'icona: si apre a schermo intero e funziona anche offline.

Al primo avvio tocca "Tocca per iniziare" per attivare l'audio. Su iPhone in orizzontale pad e strumenti stanno nel cassetto ◧.

## Struttura

```
index.html              pagina unica
css/style.css           layout responsive e stile
js/kits.js              sintesi dei suoni per kit
js/engine.js            AudioContext, mixer, catena master
js/sequencer.js         pattern, step, swing, tempo
js/synth.js             voci synth, preset, scale e accordi
js/synthpattern.js      dati e demo della sezione synth
js/synthui.js           interfaccia della sezione synth
js/voicecache.js        cache delle voci pre-renderizzate (prestazioni)
js/presets.js           libreria suoni (categorie, tag)
js/library.js           browser della libreria
js/performance.js       vista performance
js/panels.js            generatore, kit, progetti, campionatore, condivisione
js/generate.js          euclideo, variazioni, fill
js/recorder.js          registrazione uscita e microfono
js/midifile.js          export MIDI
js/projects.js          progetti e link di condivisione
js/wavetable.js         motore wavetable, tabelle e preset
js/waveeditor.js        editor wavetable
js/session.js           modalità session (clip, scene, follow action, arrangiamento)
js/remote.js            controllo remoto tramite l'host desktop (WebSocket)
desktop/                host desktop C#: motore audio nativo, server, sincronizzazione
tools/export-dsp.mjs    esporta kit e preset per il motore desktop
js/studio.js            layout Studio: browser, clip, mixer
js/ui.js                interfaccia, salvataggio, undo, song, PWA
js/export.js            render offline e codifica WAV
js/midi.js              Web MIDI (note e clock)
js/idb.js               campioni WAV in IndexedDB
js/version.js           versione dell'app
manifest.webmanifest    manifest PWA
sw.js                   service worker (cache-first, versionato)
icons/                  icone 192, 512, apple-touch-icon 180
tests/                  test end-to-end e controllo versione
```

Nessun build step, nessuna dipendenza a runtime (Playwright serve solo ai test). Tutti i percorsi sono relativi perché il sito è servito sotto `/DrumBort-Machine/`.

## Sviluppo locale

```sh
npm start            # http://127.0.0.1:8080/DrumBort-Machine/
# oppure: python3 -m http.server 8000
```

## Test

```sh
npm ci && npx playwright install chromium webkit
npm test             # versione + e2e su Chromium
npm run test:all     # Chromium + WebKit
npm run test:live    # contro il sito pubblicato
npm run perf         # benchmark audio e UI
```

Controllano layout di batteria e synth (440×956, 956×440, 820×1180, 1180×820: niente scroll, target ≥ 44 px), funzioni, segnale delle 80 voci di batteria e dei 15 preset synth, export, service worker e uso offline.

## Deploy

Il workflow `.github/workflows/pages.yml` esegue i test (`ci.yml`) e, se passano, pubblica il sito su GitHub Pages a ogni push su `main` (o manualmente da *Actions → Run workflow*). In *Settings → Pages* la sorgente deve essere **GitHub Actions**.

## Versioni

Versionamento [SemVer](https://semver.org/lang/it/) con tag git `vX.Y.Z`; storico in [CHANGELOG.md](CHANGELOG.md). Per un rilascio:

1. aggiorna `APP_VERSION` in `js/version.js` e `VERSION` in `sw.js` (invalida la cache offline);
2. aggiungi la voce in `CHANGELOG.md` (`npm run version:check` verifica la coerenza, anche in CI);
3. commit e push su `main`: dopo test e deploy riusciti il workflow `release.yml` crea tag e GitHub Release con le note del changelog.

La versione installata è visibile nel menu ☰.

## Nota sui nomi

Kit e suoni sono sintetizzati e descrivono lo *stile* di strumenti storici; i nomi dei modelli citati appartengono ai rispettivi proprietari e non implicano alcuna affiliazione.

## Licenza

[MIT](LICENSE)
