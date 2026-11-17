# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni secondo [SemVer](https://semver.org/lang/it/).

## [1.1.2] - 2026-11-17

### Corretto
- I messaggi a comparsa non intercettano più i tocchi sui pulsanti sottostanti (es. "Chiudi" nei fogli).

### Test
- WebKit: verifica della cache offline al posto del reload offline simulato; errori più dettagliati.

## [1.1.1] - 2026-11-17

### Corretto
- Editor delle opzioni step: su Safari/WebKit il tap in modalità EDIT non apriva il foglio. Ora si apre al tocco e il click successivo non lo richiude.

## [1.1.0] - 2026-11-17

### Aggiunto
- Registrazione dal vivo dai pad (REC) con quantizzazione allo step più vicino e metronomo (MET).
- Annulla/ripeti (fino a 100 passi, anche Ctrl/Cmd+Z) e copia/incolla dei pattern tra gli 8 slot.
- Song mode: catena di pattern con ripetizioni 1–8, la vista segue la riproduzione.
- Lunghezza per traccia 1–16 step (poliritmi, 12 per le terzine).
- Opzioni per step (EDIT): probabilità, ratchet 2–4, flam, nudge ±50%.
- Effetti master: riverbero e delay a mandata per traccia, filtro LP/HP con risonanza, volume master.
- Export WAV del pattern (×4) o della song, con condivisione su iOS.
- Tap tempo e blocco del kit al cambio pattern (🔒).
- Web MIDI: note in → pad, note out (canale 10, mappa GM), clock in/out.
- Avviso "Nuova versione disponibile" con aggiornamento immediato dell'app offline.
- Campioni WAV persistenti (IndexedDB).
- Accessibilità: stato degli step per VoiceOver, navigazione da tastiera (frecce, Invio), focus visibile.
- Test end-to-end (Chromium e WebKit) e controllo di coerenza della versione in CI; il deploy parte solo con i test verdi.

### Modificato
- iPhone landscape: griglia a tutta larghezza, pad e strumenti in un cassetto laterale (◧).
- Pannello parametri a due pagine: SND (vol, tune, decay, len) e MIX (vol, pan, rev, dly).

## [1.0.1] - 2026-11-17

### Corretto
- Zoom della pagina disabilitato su iOS/iPadOS: pinch, doppio tap e zoom automatico al focus delle select (font 16px). Bloccato anche Ctrl/Cmd + rotella/+/- su desktop.

### Aggiunto
- Versione dell'app visibile nel menu (`js/version.js`).
- Cache del service worker legata alla versione: ogni rilascio invalida la cache precedente.

## [1.0.0] - 2026-11-17

### Aggiunto
- Step sequencer 16 × 8 con accenti, swing, tempo 40–240 BPM, mute/solo.
- 10 kit sintetizzati ispirati a TR-808, TR-909, TR-606, CR-78, LM-1, LinnDrum, DMX, SDS-V, Drumtraks, Drumulator.
- 8 pad live, parametri per traccia, campioni WAV opzionali.
- 8 pattern in localStorage, export/import JSON, groove demo.
- Layout touch per iPhone e iPad (portrait/landscape), PWA offline.
- Deploy automatico su GitHub Pages.

[1.1.2]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RickBortCost/DrumBort-Machine/releases/tag/v1.0.0
