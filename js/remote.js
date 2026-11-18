/**
 * remote.js — Controllo remoto tramite l'host desktop (DrumBort Host, cartella desktop/).
 *
 * Quando la pagina è servita dall'host (meta "drumbort-host"), si collega via WebSocket a /ws.
 * Ruoli assegnati dall'host:
 *   - engine:  produce l'audio (il browser del PC in modalità relay);
 *   - control: interfaccia senza audio (telefono/tablet); con il motore nativo C# tutti i
 *              browser sono control e l'audio lo genera l'host.
 *
 * Protocollo (JSON):
 *   { t:'hello', ver }                         client → host
 *   { t:'welcome', role, native, seed }        host → client (seed: l'host non ha ancora un progetto)
 *   { t:'state', parts:{ chiave: valore }, full? }   parti del progetto modificate
 *   { t:'op', op, ... }                        azioni dal vivo (transport, lanci, pad, performance)
 *   { t:'peers', n }                           numero di client collegati
 * Ogni client esegue in locale le proprie azioni e le inoltra; l'host le ritrasmette agli altri.
 */

const PART_KEYS = ['slot', 'fx', 'song', 'lock', 'layout', 'session', 'arr', 'userKits', 'userPresets', 'mode'];

export function hostInfo() {
  const m = document.querySelector('meta[name="drumbort-host"]');
  return m ? m.content : null;
}

/**
 * @param {object} app  { getParts(), applyParts(parts, full), onOp(msg), onRole(role, native), toast }
 */
export function initRemote(app) {
  if (!hostInfo() || !('WebSocket' in window)) return null;
  let ws = null, role = null, native = false, peers = 0, retry = 0;
  const cid = Math.random().toString(36).slice(2, 8);   // id del client (note tenute)
  const last = new Map();       // chiave → JSON inviato/ricevuto per ultimo
  let timer = null;
  const listeners = new Set();

  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  /** Parti cambiate rispetto all'ultimo invio (stringhe JSON confrontate). */
  function diff(force = false) {
    const parts = app.getParts(), out = {};
    let n = 0;
    for (const [k, v] of Object.entries(parts)) {
      const s = JSON.stringify(v);
      if (force || last.get(k) !== s) { last.set(k, s); out[k] = v; n++; }
    }
    return n ? out : null;
  }

  function flush(full = false) {
    timer = null;
    const parts = diff(full);
    if (parts) send({ t: 'state', parts, full: full || undefined });
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; send({ t: 'hello', ver: 1 }); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      switch (m.t) {
        case 'welcome':
          role = m.role; native = !!m.native;
          app.onRole(role, native);
          if (m.seed) flush(true);
          emit();
          break;
        case 'state':
          for (const [k, v] of Object.entries(m.parts || {})) last.set(k, JSON.stringify(v));
          app.applyParts(m.parts || {}, !!m.full);
          break;
        case 'op': app.onOp(m); break;
        case 'peers': peers = m.n | 0; emit(); break;
        default: break;
      }
    };
    ws.onclose = () => {
      role = null; emit();
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }

  function emit() { listeners.forEach((fn) => fn({ role, native, peers, connected: !!role })); }

  connect();
  return {
    get role() { return role; },
    get native() { return native; },
    /** Da chiamare a ogni modifica del progetto: invio raggruppato (max ~25 al secondo). */
    sync() { if (role && !timer) timer = setTimeout(() => flush(false), 40); },
    op(op, data = {}) { if (role) send({ t: 'op', op, cid, ...data }); },
    onStatus(fn) { listeners.add(fn); fn({ role, native, peers, connected: !!role }); },
  };
}

export { PART_KEYS };
