/**
 * midi.js — Web MIDI: note in (pad/synth), note out (batteria canale 10 mappa GM,
 * synth canali 1-3), clock in/out.
 * Non disponibile su iOS/iPadOS Safari: la UI mostra un avviso.
 * Il clock in segue tempo, start e stop esterni (non è un aggancio di fase).
 */

/** Nota GM inviata per ogni traccia: BD, SD, CP, CH, OH, TOM, CY, PERC. */
export const GM_OUT = [36, 38, 39, 42, 46, 45, 49, 56];

/** Note GM in ingresso → traccia. */
const GM_IN = {
  35: 0, 36: 0,
  38: 1, 40: 1,
  37: 2, 39: 2,
  42: 3, 44: 3,
  46: 4,
  41: 5, 43: 5, 45: 5, 47: 5, 48: 5, 50: 5,
  49: 6, 51: 6, 52: 6, 55: 6, 57: 6, 59: 6,
  53: 7, 54: 7, 56: 7, 58: 7, 60: 7, 61: 7, 62: 7, 63: 7, 64: 7, 69: 7, 70: 7, 75: 7, 76: 7, 77: 7,
};

export class Midi {
  constructor() {
    this.access = null;
    this.input = null;
    this.output = null;
    this.opts = { noteIn: true, noteOut: false, clockOut: false, clockIn: false };
    this._ticks = [];
    // Hook
    this.onNote = null;      // (track, velocity)  — batteria, mappa GM
    this.onRaw = null;       // (note, velocity, on) → true se gestita (sezione synth)
    this.onStart = null;     // ()
    this.onStop = null;      // ()
    this.onTempo = null;     // (bpm)
    this.onDevices = null;   // ()
  }

  get supported() { return typeof navigator.requestMIDIAccess === 'function'; }
  get enabled() { return !!this.access; }

  async enable() {
    if (this.access) return this;
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.onDevices && this.onDevices();
    return this;
  }

  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }

  setInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = (id && this.access && this.access.inputs.get(id)) || null;
    if (this.input) this.input.onmidimessage = (e) => this._message(e);
  }

  setOutput(id) {
    this.output = (id && this.access && this.access.outputs.get(id)) || null;
  }

  // -------------------------------------------------------------------
  // Ingresso
  // -------------------------------------------------------------------
  _message(e) {
    const [st, d1, d2] = e.data;
    if (st === 0xf8) { if (this.opts.clockIn) this._clockTick(e.timeStamp); return; }
    if (st === 0xfa || st === 0xfb) { if (this.opts.clockIn) { this._ticks = []; this.onStart && this.onStart(); } return; }
    if (st === 0xfc) { if (this.opts.clockIn) this.onStop && this.onStop(); return; }
    const type = st & 0xf0;
    if (!this.opts.noteIn || (type !== 0x90 && type !== 0x80)) return;
    const on = type === 0x90 && d2 > 0;
    if (this.onRaw && this.onRaw(d1, d2 / 127, on)) return;
    if (on) {
      const t = GM_IN[d1];
      if (t !== undefined && this.onNote) this.onNote(t, d2 / 127);
    }
  }

  /** Stima il BPM dalla media degli ultimi 24 impulsi (24 ppqn). */
  _clockTick(ts) {
    const tk = this._ticks;
    tk.push(ts);
    if (tk.length > 25) tk.shift();
    if (tk.length === 25 && this.onTempo) {
      const bpm = 60000 / (tk[24] - tk[0]);
      if (bpm >= 40 && bpm <= 240) this.onTempo(bpm);
      tk.splice(0, 12);   // aggiorna ogni mezza battuta circa
    }
  }

  // -------------------------------------------------------------------
  // Uscita (timestamp convertiti da tempo audio a performance.now)
  // -------------------------------------------------------------------
  _ts(ctx, time) { return performance.now() + (time - ctx.currentTime) * 1000; }

  note(ctx, track, time, vel) {
    if (!this.output || !this.opts.noteOut) return;
    const ts = this._ts(ctx, time), n = GM_OUT[track];
    this.output.send([0x99, n, Math.max(1, Math.round(vel * 127))], ts);
    this.output.send([0x89, n, 0], ts + 60);
  }

  /** Note synth: BASS canale 1, LEAD canale 2, PAD canale 3. */
  synthNotes(ctx, k, notes, time, dur, vel) {
    if (!this.output || !this.opts.noteOut) return;
    const ts = this._ts(ctx, time), v = Math.max(1, Math.round(vel * 127));
    for (const n of notes) {
      this.output.send([0x90 | k, n, v], ts);
      this.output.send([0x80 | k, n, 0], ts + dur * 1000);
    }
  }

  /** 6 impulsi di clock per sedicesimo. */
  clock(ctx, time, stepDur) {
    if (!this.output || !this.opts.clockOut) return;
    for (let k = 0; k < 6; k++) this.output.send([0xf8], this._ts(ctx, time + (k * stepDur) / 6));
  }

  start(ctx, time) { if (this.output && this.opts.clockOut) this.output.send([0xfa], this._ts(ctx, time)); }
  stop() { if (this.output && this.opts.clockOut) this.output.send([0xfc]); }
}
