# DrumBort-Machine

[![Deploy to GitHub Pages](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/pages.yml/badge.svg)](https://github.com/RickBortCost/DrumBort-Machine/actions/workflows/pages.yml)

Drum machine virtuale per il web: step sequencer 16 × 8, pad live e una libreria di kit ispirati alle drum machine storiche. Tutti i suoni sono sintetizzati in tempo reale con la Web Audio API, senza campioni esterni. Ottimizzata per il touch su iPhone e iPad, installabile come PWA e utilizzabile offline.

**Demo:** https://rickbortcost.github.io/DrumBort-Machine/

## Funzioni

- Step sequencer 16 step × 8 tracce, due livelli di accento (tap: off → normale → accento).
- Scheduler look-ahead (timer 25 ms, pianificazione 100 ms avanti) per un timing stabile.
- Tempo 40–240 BPM, swing 50–75%, play/stop, playhead.
- Mute/Solo, volume, tune, decay e pan per traccia.
- 8 pad per suonare dal vivo.
- 8 pattern salvati in `localStorage`, export/import JSON, groove demo per ogni kit.
- Campioni WAV propri per traccia (opzionale, tenuti solo in memoria).

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

Al primo avvio tocca "Tocca per iniziare" per attivare l'audio.

## Struttura

```
index.html              pagina unica
css/style.css           layout responsive e stile
js/kits.js              sintesi dei suoni per kit
js/engine.js            AudioContext, mixer, catena master
js/sequencer.js         pattern, step, swing, tempo
js/ui.js                griglia, pad, controlli, salvataggio
manifest.webmanifest    manifest PWA
sw.js                   service worker (cache-first)
icons/                  icone 192, 512, apple-touch-icon 180
```

Nessun build step, nessuna dipendenza. Tutti i percorsi sono relativi perché il sito è servito sotto `/DrumBort-Machine/`.

## Sviluppo locale

```sh
python3 -m http.server 8000
# http://localhost:8000/
```

## Deploy

Il workflow `.github/workflows/pages.yml` pubblica il sito su GitHub Pages a ogni push su `main` (o manualmente da *Actions → Run workflow*). In *Settings → Pages* la sorgente deve essere **GitHub Actions**.

## Licenza

[MIT](LICENSE)
