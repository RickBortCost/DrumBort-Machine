# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni secondo [SemVer](https://semver.org/lang/it/).

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

[1.0.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RickBortCost/DrumBort-Machine/releases/tag/v1.0.0
