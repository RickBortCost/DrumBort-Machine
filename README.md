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

## Synth e pad a note

Il pulsante **SYN** apre la sezione melodica (**DRM** torna alla batteria). Tre tracce suonano a tempo con la batteria:

| Traccia | Preset |
| --- | --- |
| BASS | TB-303 Acid, SH-101 Bass, Minimoog Bass, DX7 FM Bass, Reese Bass |
| LEAD | SH-101 Lead, Minimoog Lead, MS-20 Lead, Chip Square, DX7 FM Bell |
| PAD | Juno-106 Strings, Prophet-5 Pad, OB-X Brass, CS-80 Pad, DX7 Glass Pad |

- **Pad a note**: 8 pad sui gradi della scala scelta (tonalità, 9 scale, ottava −/+); sulla traccia PAD suonano accordi diatonici. Tieni premuto per sostenere la nota.
- **Corsie**: tocca uno step vuoto per inserire l'ultima nota suonata sui pad, tocca una nota per cancellarla, trascina per più step.
- **EDIT** su uno step synth: nota ±1 semitono / ±1 ottava, gate 1–16 step, accento, slide, tipo di accordo.
- Parametri: CUT, RESO, ENV, DECAY, LEN (pagina SND) e VOL, PAN, REV, DLY (pagina MIX).
- Con **●** attivo i pad registrano note e durata. Cambiare tonalità traspone le note esistenti.
- MIDI: nella vista synth le note in arrivo suonano sulla traccia selezionata; in uscita BASS/LEAD/PAD usano i canali 1/2/3.

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

Tracce: Kick, Snare, Clap/Rim, Closed Hat, Open Hat, Tom, Cymbal/Ride, Percussione. Il closed hat strozza l'open hat.

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

## Licenza

[MIT](LICENSE)
