// Schickt Erinnerungen an das iPhone. Läuft in GitHub Actions alle 15 Minuten.
// Erwartet das Secret PUSH_CONFIG (aus der App kopiert):
// {"sub":{...},"pub":"...","priv":"...","rem":[{"t":"07:00","title":"...","body":"...","url":"./#mehr","on":true}],"mon":{"day":1,"t":"10:00","on":true}}
const webpush = require('web-push');
const fs = require('fs');
const STATE = 'state/sent.json';
let sent = {};
try { sent = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { sent = {}; }

const cfg = JSON.parse(process.env.PUSH_CONFIG || '{}');
if (!cfg.sub || !cfg.pub || !cfg.priv) {
  console.log('PUSH_CONFIG fehlt oder ist unvollständig.');
  process.exit(1);
}

const DEFAULT_REM = [
  { t: '07:00', title: 'Guten Morgen', body: 'Deine Werte der Nacht sind da. Importiere sie und füll dein Logbuch für gestern aus.', url: './#mehr', on: true },
  { t: '14:00', title: 'Update am Mittag', body: 'Neue Werte bereit: jetzt importieren.', url: './#mehr', on: true },
  { t: '22:00', title: 'Abend-Update', body: 'Deine Tageswerte sind bereit: jetzt importieren.', url: './#mehr', on: true },
];
const rem = Array.isArray(cfg.rem) ? cfg.rem : DEFAULT_REM;
const mon = cfg.mon || { day: 1, t: '10:00', on: true };

const parts = Object.fromEntries(new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
}).formatToParts(new Date()).map(p => [p.type, p.value]));
const nowMin = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
const day = parseInt(parts.day, 10);
const WINDOW = 50; // Minuten Spielraum, weil GitHub Zeitpläne oft verspätet startet
const today = `${parts.year}-${parts.month}-${String(day).padStart(2, '0')}`;

const toMin = t => { const [h, m] = String(t || '').split(':').map(Number); return isFinite(h) && isFinite(m) ? h * 60 + m : null; };
const due = t => { const m = toMin(t); if (m == null) return false; const d = (nowMin - m + 1440) % 1440; return d < WINDOW; };

const mode = process.env.MODE || 'auto';
const out = [];
if (mode === 'test') out.push({ title: 'Test', body: 'Benachrichtigungen funktionieren.', url: './#home', tag: 'test' });
else {
  rem.forEach((r, i) => { const k = today + ' ' + r.t; if (r.on !== false && due(r.t) && !sent[k]) { sent[k] = 1; out.push({ title: r.title || 'Erinnerung', body: r.body || '', url: r.url || './#mehr', tag: 'rem' + i }); } });
  const mk = today + ' mon ' + mon.t;
  if (mon.on !== false && day === Number(mon.day) && due(mon.t) && !sent[mk]) { sent[mk] = 1; out.push({ title: 'Neuer Monat', body: 'Zieh deinen Withings-Bericht und importiere ihn unter Gewicht.', url: './#m-weight', tag: 'withings' }); }
  // nur die letzten Tage behalten
  Object.keys(sent).forEach(k => { if (k.slice(0, 10) < today.slice(0, 8) + '01' && k.slice(0, 10) !== today) delete sent[k]; });
  fs.mkdirSync('state', { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(sent));
}

if (!out.length) { console.log(`Nichts fällig um ${parts.hour}:${parts.minute} (Berlin).`); process.exit(0); }

webpush.setVapidDetails('https://benvoemel-a11y.github.io/Whoop/', cfg.pub, cfg.priv);
Promise.all(out.map(m => webpush.sendNotification(cfg.sub, JSON.stringify(m), { TTL: 3600 })
  .then(r => console.log('Gesendet:', m.title, r.statusCode))))
  .catch(e => { console.error('Fehler:', e.statusCode, e.body || e.message); process.exit(1); });
