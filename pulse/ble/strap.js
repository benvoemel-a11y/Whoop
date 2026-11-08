// Pulse – Whoop 4.0 direkt per Web Bluetooth (Bluefy auf dem iPhone, Chrome am Mac).
// Protokoll-Dateien (crc.js, packet.js, parsers.js, uuids.js) stammen aus OpenWhoop (MIT, siehe LICENSE-OpenWhoop).
// Sicherheit: Es werden NUR diese Befehle gesendet: HELLO, GET/SET_CLOCK, GET_BATTERY, ABORT_HISTORICAL_TRANSMITS,
// ENTER/EXIT_HIGH_FREQ_SYNC, SEND_HISTORICAL_DATA, HISTORICAL_DATA_RESULT, TOGGLE_REALTIME_HR.
// Wecker: SET_ALARM_TIME, RUN_ALARM, DISABLE_ALARM.
// Niemals: FORCE_TRIM, REBOOT, POWER_CYCLE, Firmware, Bonds löschen.
import { FAMILIES } from './uuids.js';
import { WhoopPacket, PacketType, CommandNumber, EventNumber, buildCommandFrame } from './packet.js';
import { parseHistorical, parseRealtime, parseMetadata, parseBatteryResponse, parseClockResponse, parseHelloResponse } from './parsers.js';

const F = FAMILIES.whoop4;
const SAFE = new Set([CommandNumber.GET_HELLO_HARVARD, CommandNumber.GET_CLOCK, CommandNumber.SET_CLOCK, CommandNumber.GET_BATTERY_LEVEL,
  CommandNumber.ABORT_HISTORICAL_TRANSMITS, CommandNumber.ENTER_HIGH_FREQ_SYNC, CommandNumber.EXIT_HIGH_FREQ_SYNC,
  CommandNumber.SEND_HISTORICAL_DATA, CommandNumber.HISTORICAL_DATA_RESULT, CommandNumber.TOGGLE_REALTIME_HR,
  CommandNumber.SET_ALARM_TIME, CommandNumber.RUN_ALARM, CommandNumber.DISABLE_ALARM]);

/* ---------------- Speicher (IndexedDB): eine Zeile pro Minute ---------------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((ok, bad) => {
    const r = indexedDB.open('pulse-strap', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('min', { keyPath: 'm' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  return dbp;
}
// samples: [{t: unix s, hr, rr:[ms]}] → Minuten zusammenführen. Fertig erst, wenn die Transaktion geschrieben ist.
async function storeSamples(samples) {
  if (!samples.length) return [];
  const by = new Map();
  for (const s of samples) {
    const m = Math.floor(s.t / 60);
    let o = by.get(m); if (!o) { o = { m, hs: 0, hc: 0, rr: [] }; by.set(m, o); }
    if (s.hr) { o.hs += s.hr; o.hc++; }
    if (s.rr && s.rr.length) o.rr.push(...s.rr);
  }
  const d = await db();
  await new Promise((ok, bad) => {
    const tx = d.transaction('min', 'readwrite'), st = tx.objectStore('min');
    for (const o of by.values()) {
      const g = st.get(o.m);
      g.onsuccess = () => {
        const e = g.result;
        if (e) { e.hs += o.hs; e.hc += o.hc; if (o.rr.length) e.rr = (e.rr || []).concat(o.rr).slice(-240); st.put(e); }
        else { o.rr = o.rr.slice(-240); st.put(o); }
      };
    }
    tx.oncomplete = ok; tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error);
  });
  return [...by.keys()];
}
export async function readMinutes(fromS, toS) {
  const d = await db();
  return new Promise((ok, bad) => {
    const out = [], tx = d.transaction('min'), rq = tx.objectStore('min').openCursor(IDBKeyRange.bound(Math.floor(fromS / 60), Math.floor(toS / 60)));
    rq.onsuccess = () => { const c = rq.result; if (c) { const v = c.value; if (v.hc) out.push({ m: v.m, hr: v.hs / v.hc, rr: v.rr || [] }); c.continue(); } else ok(out); };
    rq.onerror = () => bad(rq.error);
  });
}
export async function prune(keepRrDays = 21, keepDays = 120) {
  const d = await db(), now = Date.now() / 60000, rrCut = now - keepRrDays * 1440, cut = now - keepDays * 1440;
  return new Promise((ok) => {
    const tx = d.transaction('min', 'readwrite'), rq = tx.objectStore('min').openCursor(IDBKeyRange.upperBound(rrCut));
    rq.onsuccess = () => { const c = rq.result; if (!c) return; if (c.value.m < cut) c.delete(); else if (c.value.rr && c.value.rr.length) { const v = c.value; delete v.rr; c.update(v); } c.continue(); };
    tx.oncomplete = ok; tx.onerror = ok;
  });
}
export async function minuteCount() {
  const d = await db();
  return new Promise((ok) => { const r = d.transaction('min').objectStore('min').count(); r.onsuccess = () => ok(r.result); r.onerror = () => ok(0); });
}
export async function wipe() { const d = await db(); return new Promise((ok) => { const tx = d.transaction('min', 'readwrite'); tx.objectStore('min').clear(); tx.oncomplete = ok; }); }

/* ---------------- Bluetooth-Verbindung ---------------- */
const listeners = {};
export const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
const emit = (ev, x) => (listeners[ev] || []).forEach(f => { try { f(x); } catch (e) { console.error(e); } });

class Queue { constructor() { this.i = []; this.w = []; }
  push(x) { const w = this.w.shift(); if (w) w.ok(x); else this.i.push(x); }
  pop(ms) { if (this.i.length) return Promise.resolve(this.i.shift());
    return new Promise((ok, bad) => { const e = { ok, bad }; this.w.push(e); setTimeout(() => { const k = this.w.indexOf(e); if (k >= 0) { this.w.splice(k, 1); bad(new Error('Zeitüberschreitung – Band antwortet nicht')); } }, ms); }); }
  fail(err) { this.i = []; this.w.splice(0).forEach(w => w.bad(err)); } }

export const state = { connected: false, battery: null, charging: null, worn: null, serial: null, live: null, syncing: false, name: null };
let clockWait = null, dev = null, cCmd = null, seq = 0, meta = new Queue(), buf = [], touched = new Set(), liveBuf = [];

export const supported = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

async function send(cmd, payload = new Uint8Array([0])) {
  if (!SAFE.has(cmd)) throw new Error('Befehl gesperrt');
  if (!cCmd) throw new Error('Nicht verbunden');
  const f = buildCommandFrame(cmd, payload, seq); seq = (seq + 1) & 0xff;
  await cCmd.writeValue(f);
}
const bytes = dv => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
function pkt(e) { try { return WhoopPacket.fromData(bytes(e.target.value)); } catch { return null; } }

function onData(e) {
  const p = pkt(e); if (!p) return;
  if (p.type === PacketType.HISTORICAL_DATA) {
    try { const r = parseHistorical(p.data); if (r.unix > 1.5e9) buf.push({ t: r.unix, hr: r.heartRateBpm, rr: r.rrIntervalsMs }); } catch {}
  } else if (p.type === PacketType.METADATA) {
    meta.push(parseMetadata(p.cmd, p.data));
  } else if (p.type === PacketType.REALTIME_DATA) {
    const r = parseRealtime(p.data); if (r.heartRateBpm) { state.live = r.heartRateBpm; emit('live', r.heartRateBpm);
      liveBuf.push({ t: Math.floor(Date.now() / 1000), hr: r.heartRateBpm, rr: r.rrIntervalsMs || [] });
      if (liveBuf.length >= 60) { const b = liveBuf.splice(0); storeSamples(b).catch(() => {}); } }
  }
}
function onResp(e) {
  const p = pkt(e); if (!p) return;
  if (p.cmd === CommandNumber.GET_BATTERY_LEVEL) { const v = parseBatteryResponse(p.data); if (v != null) { state.battery = Math.round(v); emit('status'); } }
  else if (p.cmd === CommandNumber.GET_CLOCK) { const v = parseClockResponse(p.data); if (v != null && clockWait) clockWait(v); }
  else if (p.cmd === CommandNumber.GET_HELLO_HARVARD) { const h = parseHelloResponse(p.data); if (h && !h.partial) { state.charging = h.charging; state.worn = h.isWorn; state.serial = h.serial; emit('status'); } }
}
function onEvent(e) {
  const p = pkt(e); if (!p) return;
  if (p.cmd === EventNumber.WRIST_ON) state.worn = true; else if (p.cmd === EventNumber.WRIST_OFF) state.worn = false;
  else if (p.cmd === EventNumber.CHARGING_ON) state.charging = true; else if (p.cmd === EventNumber.CHARGING_OFF) state.charging = false;
  emit('status');
}
function onGone() {
  state.connected = false; state.live = null; cCmd = null; meta.fail(new Error('Verbindung getrennt'));
  if (liveBuf.length) storeSamples(liveBuf.splice(0)).catch(() => {});
  emit('status');
}

// Ohne Auswahlfenster wieder verbinden (wenn der Browser das Band schon kennt)
export async function autoConnect() {
  if (state.connected) return true;
  if (!supported() || !navigator.bluetooth.getDevices) return false;
  try {
    const list = await navigator.bluetooth.getDevices();
    const d = list.find(x => /whoop/i.test(x.name || '')) || list[0];
    if (!d) return false;
    if (dev !== d) { dev = d; dev.addEventListener('gattserverdisconnected', onGone); }
    await connect(); return true;
  } catch { return false; }
}

export async function connect() {
  if (!supported()) throw new Error('Dieser Browser kann kein Bluetooth – Pulse in Bluefy öffnen');
  if (!dev || !dev.gatt) {
    dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [F.service] }, { namePrefix: 'WHOOP' }, { namePrefix: 'Whoop' }], optionalServices: [F.service] });
    dev.addEventListener('gattserverdisconnected', onGone);
  }
  emit('step', 'Verbinde …');
  const server = await dev.gatt.connect(), svc = await server.getPrimaryService(F.service);
  cCmd = await svc.getCharacteristic(F.command);
  const cResp = await svc.getCharacteristic(F.response), cData = await svc.getCharacteristic(F.data), cEvt = await svc.getCharacteristic(F.event);
  cData.addEventListener('characteristicvaluechanged', onData); await cData.startNotifications();
  cResp.addEventListener('characteristicvaluechanged', onResp); await cResp.startNotifications();
  cEvt.addEventListener('characteristicvaluechanged', onEvent); await cEvt.startNotifications();
  state.connected = true; state.name = dev.name || 'WHOOP'; emit('status');
  try { await send(CommandNumber.GET_HELLO_HARVARD); } catch {}
  try { await send(CommandNumber.GET_BATTERY_LEVEL); } catch {}
  // Uhr stellen, falls nötig
  try {
    const t = await new Promise((ok) => { clockWait = ok; send(CommandNumber.GET_CLOCK).catch(() => ok(null)); setTimeout(() => ok(null), 3000); }); clockWait = null;
    if (t == null || Math.abs(t - Date.now() / 1000) > 5) { const p = new Uint8Array(4), u = Math.floor(Date.now() / 1000); p[0] = u & 255; p[1] = (u >>> 8) & 255; p[2] = (u >>> 16) & 255; p[3] = (u >>> 24) & 255; await send(CommandNumber.SET_CLOCK, p); }
  } catch {}
}

// Verlauf vom Band holen. Jeder Block wird ERST gespeichert, dann bestätigt (sonst gingen Daten verloren).
export async function sync() {
  if (!state.connected) await connect();
  if (state.syncing) return { minutes: 0, days: [] };
  state.syncing = true; emit('status'); buf = []; touched = new Set(); meta = new Queue();
  let n = 0, hf = false;
  try {
    try { await send(CommandNumber.ABORT_HISTORICAL_TRANSMITS); } catch {}
    try { await send(CommandNumber.ENTER_HIGH_FREQ_SYNC, new Uint8Array([0])); hf = true; } catch {}
    await send(CommandNumber.SEND_HISTORICAL_DATA, new Uint8Array([0]));
    for (;;) {
      let m; do { m = await meta.pop(30000); } while (m.kind !== 'historyEnd' && m.kind !== 'historyComplete');
      const b = buf.splice(0);
      const mins = await storeSamples(b); mins.forEach(x => touched.add(x)); n += b.length;
      if (b.length) emit('progress', { samples: n, last: b[b.length - 1].t });
      if (m.kind === 'historyComplete') break;
      const ack = new Uint8Array(9); ack[0] = 1; ack[1] = m.trim & 255; ack[2] = (m.trim >>> 8) & 255; ack[3] = (m.trim >>> 16) & 255; ack[4] = (m.trim >>> 24) & 255;
      await send(CommandNumber.HISTORICAL_DATA_RESULT, ack);
    }
  } finally {
    if (hf) { try { await send(CommandNumber.EXIT_HIGH_FREQ_SYNC, new Uint8Array([0])); } catch {} }
    state.syncing = false; emit('status');
  }
  try { await send(CommandNumber.GET_BATTERY_LEVEL); } catch {}
  try { await send(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([1])); } catch {}
  prune().catch(() => {});
  const days = new Set(); touched.forEach(m => { const d = new Date(m * 60000); days.add(isoL(d)); });
  return { samples: n, days: [...days].sort() };
}
// Wecker auf dem Band (vibriert auch ohne Verbindung zum Handy)
export async function setAlarm(unix) {
  if (!state.connected) await connect();
  const p = new Uint8Array(4); p[0] = unix & 255; p[1] = (unix >>> 8) & 255; p[2] = (unix >>> 16) & 255; p[3] = (unix >>> 24) & 255;
  await send(CommandNumber.SET_ALARM_TIME, p); state.alarm = unix; emit('status');
}
export async function disableAlarm() { if (!state.connected) await connect(); await send(CommandNumber.DISABLE_ALARM); state.alarm = null; emit('status'); }
export async function buzz() { if (!state.connected) await connect(); await send(CommandNumber.RUN_ALARM); }
export async function live(on) { if (!state.connected) await connect(); await send(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([on ? 1 : 0])); }

export async function disconnect() {
  try { await send(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0])); } catch {}
  try { dev && dev.gatt && dev.gatt.connected && dev.gatt.disconnect(); } catch {}
  onGone();
}

/* ---------------- Auswertung ---------------- */
const pad = n => String(n).padStart(2, '0');
const isoL = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (iso, h) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, h).getTime() / 1000; };
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function rmssd(rr) {
  const f = rr.filter(x => x >= 300 && x <= 2000), d = [];
  for (let i = 1; i < f.length; i++) { const x = f[i] - f[i - 1]; if (Math.abs(x) < f[i - 1] * 0.2) d.push(x * x); }
  return d.length >= 15 ? Math.sqrt(mean(d)) : null;
}

// Schlaf der Nacht, die am Morgen von `iso` endet.
function analyzeNight(mins) {
  if (mins.length < 120) return null;
  const by = new Map(mins.map(x => [x.m, x])), m0 = mins[0].m, m1 = mins[mins.length - 1].m;
  const sm = new Map();
  for (let m = m0; m <= m1; m++) { const w = []; for (let k = -2; k <= 2; k++) { const v = by.get(m + k); if (v) w.push(v.hr); } if (by.get(m) && w.length) sm.set(m, q(w, 0.5)); }
  const p10 = q([...sm.values()], 0.1), thr = p10 + 14;
  // Läufe mit Schlaf (Lücken bis 30 min werden als Wachphase mitgenommen)
  const runs = []; let cur = null, gap = 0;
  for (let m = m0; m <= m1; m++) {
    const v = sm.get(m), sl = v != null && v < thr;
    if (sl) { if (!cur) cur = { a: m, b: m }; cur.b = m; gap = 0; }
    else if (cur) { gap++; if (gap > 30 || (v == null && gap > 15)) { runs.push(cur); cur = null; gap = 0; } }
  }
  if (cur) runs.push(cur);
  const main = runs.filter(r => r.b - r.a >= 90).sort((x, y) => (y.b - y.a) - (x.b - x.a))[0];
  if (!main) return null;
  // 5-Minuten-Epochen
  const ep = [];
  for (let m = main.a; m <= main.b; m += 5) {
    const hs = [], rr = []; let wake = 0;
    for (let k = m; k < m + 5 && k <= main.b; k++) { const v = by.get(k), s = sm.get(k); if (!v || s == null || s >= thr) wake++; if (v) { hs.push(v.hr); rr.push(...v.rr); } }
    const sd = hs.length > 1 ? Math.sqrt(mean(hs.map(h => (h - mean(hs)) ** 2))) : 0;
    ep.push({ m, hr: hs.length ? mean(hs) : null, sd, rv: rmssd(rr), wake: wake >= 3 || !hs.length });
  }
  const sleepEp = ep.filter(e => !e.wake), hrs = sleepEp.map(e => e.hr), sds = sleepEp.map(e => e.sd);
  const qHr25 = q(hrs, 0.25), qHr60 = q(hrs, 0.6), qSd50 = q(sds, 0.5), qSd60 = q(sds, 0.6);
  ep.forEach((e, i) => {
    if (e.wake) e.st = 'wake';
    else if (e.hr <= qHr25 && e.sd <= qSd50 && i < ep.length * 0.75) e.st = 'deep';
    else if (e.hr >= qHr60 && e.sd >= qSd60 && (e.m - main.a) > 60) e.st = 'rem';
    else e.st = 'light';
  });
  const tot = { wake: 0, light: 0, deep: 0, rem: 0 }; ep.forEach(e => tot[e.st] += 5);
  const hyp = []; ep.forEach(e => { const a = e.m * 60000, b = a + 300000, l = hyp[hyp.length - 1]; if (l && l[2] === e.st && l[1] === a) l[1] = b; else hyp.push([a, b, e.st]); });
  // Ruhepuls: niedrigster 30-Minuten-Schnitt im Schlaf
  let rhr = null; const sv = []; for (let m = main.a; m <= main.b; m++) { const v = by.get(m); if (v) sv.push(v.hr); }
  for (let i = 0; i + 30 <= sv.length; i += 5) { const v = mean(sv.slice(i, i + 30)); if (rhr == null || v < rhr) rhr = v; }
  // HRV: Median-RMSSD der Tiefschlaf-Epochen in der 2. Nachthälfte (wie Whoop: letzter Tiefschlaf), sonst alle Schlaf-Epochen
  const half = main.a + (main.b - main.a) / 2;
  let rv = ep.filter(e => e.st === 'deep' && e.m >= half && e.rv).map(e => e.rv);
  if (rv.length < 3) rv = ep.filter(e => e.st !== 'wake' && e.rv).map(e => e.rv);
  const sleep = tot.light + tot.deep + tot.rem;
  return { sleep, deep: tot.deep, rem: tot.rem, light: tot.light, wake: tot.wake, eff: Math.round(sleep / (sleep + tot.wake) * 100),
    rhr: rhr ? Math.round(rhr) : null, hrv: rv.length ? Math.round(q(rv, 0.5)) : null, hyp, a: main.a, b: main.b };
}

// Liefert für jeden Tag: Schlaf, HRV, Ruhe-HF, Belastung (aus Puls), Stressverlauf.
export async function analyze(days, { maxHr = 195, rhrFallback = 60 } = {}) {
  const out = {};
  for (const d of days) {
    const r = {};
    const night = analyzeNight(await readMinutes(at(d, -6), at(d, 14)));
    if (night) Object.assign(r, night);
    const rhr = r.rhr || rhrFallback, day = await readMinutes(at(d, 0), at(d, 24));
    if (day.length >= 60) {
      let trimp = 0; const pts = [];
      for (const v of day) {
        if (night && v.m >= night.a && v.m <= night.b) continue;
        const x = (v.hr - rhr) / (maxHr - rhr);
        if (x >= 0.25) trimp += x * 0.64 * Math.exp(1.92 * Math.min(1, x));
        if (x < 0.35 && new Date(v.m * 60000).getHours() >= 6) pts.push([v.m * 60000, Math.max(0, Math.min(3, (v.hr - rhr - 5) / ((maxHr - rhr) * 0.25) * 3))]);
      }
      r.strain = Math.round(21 * (1 - Math.exp(-trimp / 86)) * 10) / 10;
      const b = new Map(); pts.forEach(([t, v]) => { const k = Math.floor(t / 300000); (b.get(k) || b.set(k, []).get(k)).push(v); });
      r.curve = [...b.entries()].map(([k, a]) => [k * 300000, Math.round(mean(a) * 10) / 10]);
      if (r.curve.length) r.stress = Math.round(mean(r.curve.map(p => p[1])) * 10) / 10;
      r.worn = day.length;
    }
    if (Object.keys(r).length) out[d] = r;
  }
  return out;
}
export const _store = storeSamples;
