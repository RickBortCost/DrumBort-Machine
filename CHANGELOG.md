# Changelog

Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/); versioni secondo [SemVer](https://semver.org/lang/it/).

## [1.13.0] - 2026-11-18

### Aggiunto
- **Scelta dell'uscita audio** (Menu → 🎧 Uscita audio). Host desktop: elenco dei dispositivi della scheda audio, scelta salvata; con "Predefinito di sistema" l'host segue il dispositivo predefinito (cuffie collegate dopo l'avvio comprese). Browser: `setSinkId` dove supportato.
- **Vista TRACCE** stile Logic Pro, predefinita nel layout Studio: tracce attive in colonna, timeline con regioni da creare, spostare, allungare ed eliminare; ＋ TRACCIA.
- **Pannelli nascondibili**: browser (◧, **B**), pannello laterale (◨, **I**), mixer (▤).
- **Catena di effetti** della traccia selezionata, stile device: un riquadro per effetto con interruttore, manopole rotative e curve di EQ e filtro. La barra inferiore è ridimensionabile.

### Modificato
- **Nuovo progetto vuoto**: primo avvio e Nuovo progetto non caricano più groove o preset (`?demo` per i groove dimostrativi).

## [1.12.0] - 2026-11-18

### Aggiunto
- **Clip lunghe**: pattern di 1, 2 o 4 battute (selettore BAR nella barra, su tablet e PC). Allungando, il contenuto viene ripetuto; la griglia mostra una battuta alla volta e segue la riproduzione; il piano roll mostra tutte le battute. Song mode, export WAV/MIDI/stem e motore C# contano le battute.
- **Automazione disegnabile** (∿ AUTO nel layout Studio, tasto **A**, Menu → Automazione): corsie per step su volume, pan, tune, decay e mandate della batteria; volume, pan, cutoff, risonanza e mandate dei synth; filtro master. Gomma, rampa, "dal valore", cancella. In session ogni traccia usa l'automazione della propria clip. Applicata anche nell'export e nel motore C#.
- **Effetti per traccia** (pagina FX dei parametri): filtro LP/HP, EQ a due bande (shelf 200 Hz e 5 kHz, ±12 dB), compressore, oltre a drive e bit crusher; anche nel motore C# (EQ verificato identico a Chrome).
- **4 macro di progetto** (◎ MACRO, tasto **M**, Menu → Macro): ogni macro muove insieme fino a 8 parametri di tracce, effetti o master, ognuno nel proprio intervallo.
- **Export degli stem**: Menu → Stem WAV crea uno ZIP con un WAV per traccia (batteria e synth, effetti master inclusi), dal pattern o dalla song.

## [1.11.0] - 2026-11-18

### Aggiunto
- **Piano roll** per le tracce synth (pulsante ROLL o tasto **P**): tastiera verticale con ascolto, scala e tonica evidenziate, note colorate per traccia con nome, playhead. Clic per creare (trascinando a destra si allunga), clic su una nota per eliminarla, trascinamento verticale per spostarla, bordo destro per la durata, Shift+clic per l'accento, corsia di accento e slide (BASS/LEAD). Su PAD/KEYS le note sullo stesso step formano un accordo.
- **Tastiera del computer come tastiera musicale** (pulsante ⌨ nel layout Studio o nel piano roll): A–L suonano la scala cromatica, W E T Y U O P i diesis, Z/X cambiano ottava; con REC le note vengono registrate.

### Modificato
- Testa dei parametri synth su due righe (nome del suono, poi M S WT ROLL ARP MOD).

## [1.10.0] - 2026-11-18

### Modificato
- **Nuovo aspetto da workstation (DAW)**, colori ispirati a FL Studio: pannelli ardesia blu-grigio, accenti arancio e verdi, pulsanti piatti, display verdi, carattere di sistema.
- **Rack dei canali**: step a gruppi di 4 alternati grigio / rosso spento, step attivi chiari, accenti arancio, playhead verde.
- Layout Studio: barre del titolo sui pannelli (Browser, Session · Arrangement, Channel Rack), mixer con misuratori verdi e selezione arancio, **contatore di posizione** BAR · BEAT · STEP nella barra di trasporto.
- Stesso tema nel Sound Lab del telefono.

## [1.9.1] - 2026-11-18

### Modificato
- **DrumBort Host si apre come un programma**: all'avvio apre l'interfaccia in una finestra dedicata (Edge o Chrome in modalità app, senza barre del browser; altrimenti il browser predefinito). Chiudendo la finestra si chiude anche l'host. `--no-browser` per non aprirla.
- Pacchetti desktop come eseguibile singolo: nella cartella c'è solo `DrumBortHost.exe` (più le cartelle `Assets` e `wwwroot`).
- Ogni pacchetto desktop viene allegato alla release appena pronto, senza attendere gli altri sistemi.

## [1.9.0] - 2026-11-18

### Aggiunto
- **Sound Lab**: sul telefono l'app diventa un generatore di suoni, senza drum machine.
  - SYNTH: editor wavetable a tutta pagina con libreria e pad a note.
  - BATTERIA: designer a strati (fino a 4 voci parametriche: cassa, rullante, clap, rim, hat/piatto, tom, cowbell, rumore/FX), partenza da qualsiasi voce dei kit, forma d'onda, pad sensibile alla posizione, prova di tune e decay.
  - I MIEI SUONI: ascolto, modifica, eliminazione, condivisione.
- **Invio dei suoni al PC**: automatico con DrumBort Host (solo la libreria, il progetto del PC resta intatto), oppure con link `#snd=` o file JSON.
- Sul PC: suoni di batteria utente nel browser Studio (KIT → I miei suoni, un clic li assegna alla traccia selezionata creando un kit personalizzato) e in Crea kit; i kit utente possono usare suoni del Sound Lab, anche nel motore C#.

### Modificato
- Sul telefono la drum machine completa si apre con `?full`.
- CI desktop: un runner non disponibile (es. macOS) non blocca gli altri pacchetti, che vengono allegati comunque; pacchetto macOS Intel su `macos-13`.

## [1.8.0] - 2026-11-18

### Aggiunto
- **DrumBort Host**, versione PC per Windows, macOS e Linux (`desktop/`, zip allegati alla Release):
  - motore audio nativo C# con gli stessi suoni della web app: porting 1:1 di kit, synth sottrattivo/FM, piano, corde, organo e wavetable su un grafo audio compatibile con le API Web Audio;
  - riverbero algoritmico tarato sull'originale e compressore master con la curva di Chrome;
  - rendering su un thread dedicato con buffer ad anello verso PortAudio, voci pre-renderizzate in background;
  - serve la web app sulla rete locale e stampa un QR code per il telefono.
- **Telefono come controller**: con l'host il telefono (badge CTRL·C#) modifica il progetto e comanda trasporto, lanci di clip e scene, pad, note, beat repeat, fill, mute e filtro XY; l'audio esce dal PC. Modalità relay (`--mode browser`): l'audio lo produce il browser del PC.
- Test in CI: confronto del motore C# con la web app (voci, compressore, riverbero) e test end-to-end telefono ↔ PC in modalità nativa e relay.

### Modificato
- Le voci dei kit portano la propria descrizione (`spec`), esportata in `desktop/Assets/kits.json` da `tools/export-dsp.mjs`; la CI verifica che sia aggiornata.
- Le follow action casuali usano una sequenza deterministica, uguale su tutti i dispositivi collegati.

## [1.7.0] - 2026-11-18

### Aggiunto
- **9 kit di genere**, tutti sintetizzati e con groove demo: Dubstep, Riddim, EDM Big Room, House, Techno, Trap, Drum & Bass, Future Bass, Lo-Fi Hip Hop.
- Nuove voci: rullanti a strati, gunshot snare, 808 e sub drop lunghi, riser, downlifter, impact, laser, noise sweep, shaker, snap, chime, crackle. Sono disponibili anche in *Crea kit*.
- Selettore dei kit diviso in *Drum machine classiche* e *Generi*.

## [1.6.1] - 2026-11-18

### Modificato
- **Synth wavetable più visibile**: pulsante **WT** nell'intestazione (in ogni vista, anche su iPhone), voce *Synth wavetable* nel menu Suoni, tasto **W** su PC; il pulsante ✎ del pannello synth diventa **WT**.
- L'editor wavetable ha la scelta della traccia (BASS, LEAD, PAD, KEYS) senza tornare alla vista synth.

## [1.6.0] - 2026-11-18

### Aggiunto
- **Arrangement view** nel layout Studio (ARRANGE o Tab): timeline tracce × battute fino a 256 battute, con pittura delle celle, riga del pattern principale, punto di partenza e indicatore di riproduzione. Strumenti + BAR, − BAR, ×2, DA SONG, SVUOTA.
- **Registrazione session → arrangement** (● REC ARR) e riproduzione dell'arrangiamento (▶ ARR); un lancio manuale torna alla session.
- **Quantizzazione del lancio** selezionabile: nessuna, 1/4, 1/2, 1, 2, 4 battute.
- **Follow action per scena**: successiva, precedente, prima, casuale, altra, stop dopo 1-16 battute.
- Il progetto esportato include session e arrangiamento.

### Corretto
- Lo stop del trasporto annulla i lanci in coda (prima potevano applicarsi al play successivo).

## [1.5.0] - 2026-11-18

### Aggiunto
- **Layout Studio per PC** (finestre ≥ 1000×600; automatico su computer, pulsante ▦ o Menu → Layout): browser di suoni e kit a sinistra, griglia delle clip al centro, editor della clip selezionata, parametri e pad a destra, mixer in basso.
- **Modalità session**: ogni traccia (8 batteria + 4 synth) suona la propria clip, cioè la sua parte in uno degli 8 pattern. Lancio di clip e di scene quantizzato alla battuta, stop per traccia e stop totale; il pattern della scena lanciata fornisce tempo, swing e kit del bus.
- **Mixer**: 12 strisce con fader, pan, mandate riverbero/delay, mute/solo e indicatori di livello, più master.
- **Scorciatoie da tastiera** nel layout Studio: 1-8 lanciano le scene, "." ferma tutte le clip, Spazio play/stop, Ctrl/Cmd+Z annulla.

### Modificato
- **Menu riorganizzato** in quattro sezioni con icone e descrizioni (Progetto, Pattern, Suoni, Esporta e registra); su PC si apre come pannello a tendina.



### Aggiunto
- **Synth wavetable** (nuovo motore): 3 oscillatori con morph continuo della posizione in 7 tabelle generate (Analog, Sync, Vocal, Digital, Additive, Growl, FM), unisono fino a 3 voci, rumore, 2 filtri LP/BP/HP/Notch in serie o parallelo con drive, inviluppo di modulazione, 2 LFO liberi o a tempo, step sequencer di modulazione a 16 passi e matrice a 6 slot (posizione wavetable, cutoff, pitch, volume, risonanza).
- **16 preset wavetable** nella nuova categoria Wavetable: Growl Bass, Talking Bass, Neuro Bass, Sub Wobble, Step Filter Bass, Hoover Lead, Sync Sweep Lead, Formant Lead, Digital Pluck, Glass Keys, Morph Bell, Evolving Pad, Shimmer Pad, Trance Gate Pad, Vocal Morph Choir, Wavetable Riser.
- **Editor wavetable** (✎ nei parametri synth): schede OSC, FILTRI, ENV, LFO, STEP, MOD con display della forma d'onda; le modifiche restano nel pattern (nome con *) e si possono salvare come preset nella categoria Utente della libreria.
- Macro **WAVE** nella pagina MOD: sposta la posizione wavetable della traccia.
- I preset utente viaggiano nei progetti, nell'export JSON e nei link di condivisione.



### Aggiunto
- **Libreria suoni**: 59 strumenti in 13 categorie (Bass, Lead, Pad, Keys, Piano, Organ, Strings, Brass, Pluck, Mallet, Bell, Choir, FX) con ricerca per nome/tag, preferiti e ascolto immediato. Nuovi motori: piano additivo, corde pizzicate (Karplus-Strong), organo a drawbar, formanti per cori e voci, LFO, strati di rumore, inviluppi di pitch.
- **Traccia KEYS**: quarta traccia synth polifonica (accordi), MIDI out sul canale 4.
- **Macro synth** nella pagina MOD: ATTACK, RELEASE, LFO, RATE.
- **Arpeggiatore** (ARP) su qualsiasi traccia synth: segue gli accordi di PAD o KEYS; modi su/giù/su-giù/random, 1/32–1/4, 1–3 ottave, gate.
- **Effetti per traccia** (pagina FX): drive e bit crusher su batteria e synth.
- **Sidechain**: la cassa abbassa i synth (FX master e vista performance).
- **Parameter lock** per step: tune/decay/velocity sulla batteria, cutoff/decay/velocity sul synth.
- **Generatore**: ritmi euclidei, "varia batteria", "varia synth", humanize per pattern.
- **Modalità performance** (vista PRF): pad XY filtro/risonanza con ritorno automatico, beat repeat 1/2–1/16, fill, mute rapidi per gruppi, registrazione dell'uscita.
- **Registrazione dell'uscita** in WAV (performance dal vivo compresa).
- **Export MIDI** (.mid) di pattern e song: batteria canale 10, synth canali 1–4.
- **Campionamento dal microfono** sulla traccia di batteria selezionata (taglio del silenzio, normalizzazione).
- **Kit personalizzati**: combina voci di kit diversi, con bit crush opzionale.
- **Progetti** con nome, con auto-salvataggio prima di aprirne un altro.
- **Condivisione via link**: il pattern viaggia compresso nell'indirizzo, senza server.

### Modificato
- Il pulsante vista ruota tra batteria, synth e performance (DRM▸ / SYN▸ / PRF▸).
- I preset synth esistenti hanno nomi descrittivi senza marchi (es. "Acid 303", "Ladder Bass", "Poly Strings 106").
- Attacco lineare per inviluppi lunghi (pad, riser): la salita è udibile da subito.
- La ricerca nella libreria cerca in tutte le categorie.

## [1.2.1] - 2026-11-18

### Prestazioni
- Cache delle voci: ogni suono di batteria e ogni nota del sequencer viene sintetizzato una sola volta in background e poi riprodotto come buffer. Carico audio in riproduzione circa 5–6 volte più basso (benchmark: da 2,5× a ~14× tempo reale).
- Pre-render all'avvio, al cambio pattern/kit e dopo ogni modifica: anche il primo giro usa le voci in cache.
- Polifonia limitata: una voce per strumento della batteria (come l'hardware), BASS/LEAD monofonici, massimo 3 accordi PAD.
- Scheduler con timer in un Web Worker e finestra di anticipo di 120 ms: meno buchi quando la UI è occupata o la pagina è in background.
- UI: playhead senza filtri CSS, contenimento del rendering delle celle (layout da ~44 ms a ~2 ms in 6 s), animazione dei pad senza reflow forzati.

### Aggiunto
- `npm run perf`: benchmark di audio e UI.

## [1.2.0] - 2026-11-18

### Aggiunto
- Sezione **SYNTH** (pulsante SYN/DRM): tre tracce melodiche BASS, LEAD e PAD sincronizzate con la batteria.
- 15 preset sintetizzati ispirati a TB-303, SH-101, Minimoog, MS-20, DX7, Juno-106, Prophet-5, OB-X, CS-80 e altri (sottrattivi e FM).
- Corsie note in stile piano roll: tap per inserire la nota del pennello, tap per cancellare, trascinamento.
- Pad a note nella tonalità e scala scelte (9 scale), ottava −/+; sulla traccia PAD suonano accordi diatonici.
- Editor step synth (EDIT): nota ±1/±8va, gate 1–16 step, accento, slide (glide), accordo triade/settima/sus4.
- Parametri per traccia: cutoff, risonanza, inviluppo filtro, decay, lunghezza, volume, pan, mandate riverbero e delay.
- Registrazione dal vivo dai pad a note con gate pari alla durata della pressione.
- Cambio tonalità con trasposizione automatica delle note.
- MIDI: note in alla traccia synth selezionata, note out sui canali 1–3.
- Groove synth demo al primo avvio e da menu; export WAV, song, copia/incolla e undo includono il synth.

### Corretto
- Safari/WebKit: alla prima visita compariva il banner "Nuova versione disponibile" senza aggiornamenti reali.



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

[1.5.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/RickBortCost/DrumBort-Machine/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/RickBortCost/DrumBort-Machine/releases/tag/v1.0.0
