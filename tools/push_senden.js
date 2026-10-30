// Schickt die Erinnerung an das iPhone. Läuft in GitHub Actions.
// Erwartet das Secret PUSH_CONFIG (aus der App kopiert): {"sub":{...},"pub":"...","priv":"..."}
const webpush = require('web-push');

const cfg = JSON.parse(process.env.PUSH_CONFIG || '{}');
if (!cfg.sub || !cfg.pub || !cfg.priv) {
  console.log('PUSH_CONFIG fehlt oder ist unvollständig. Bitte in der App unter Mehr → Benachrichtigungen kopieren und als Secret speichern.');
  process.exit(1);
}

const now = new Date();
const part = t => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', [t]: 'numeric', hour12: false }).format(now);
const hour = parseInt(part('hour'), 10);
const day = parseInt(part('day'), 10);
const mode = process.env.MODE || 'auto';

const MSG = {
  7:  { title: 'Guten Morgen', body: 'Deine Werte der Nacht sind da. Importiere sie und füll dein Logbuch für gestern aus.', url: './#mehr', tag: 'import' },
  14: { title: 'Update am Mittag', body: 'Neue Werte bereit: jetzt importieren.', url: './#mehr', tag: 'import' },
  22: { title: 'Abend-Update', body: 'Deine Tageswerte sind bereit: jetzt importieren.', url: './#mehr', tag: 'import' },
};
const MONTH = { title: 'Neuer Monat', body: 'Zieh deinen Withings-Bericht und importiere ihn unter Gewicht.', url: './#m-weight', tag: 'withings' };
const TEST = { title: 'Test', body: 'Benachrichtigungen funktionieren.', url: './#home', tag: 'test' };

let msg = null;
if (mode === 'test') msg = TEST;
else if (mode === 'monthly') msg = (day === 1 && hour === 10) ? MONTH : null;
else msg = MSG[hour] || null;

if (!msg) { console.log(`Keine Nachricht für ${hour} Uhr (Berlin), Tag ${day}.`); process.exit(0); }

webpush.setVapidDetails('https://benvoemel-a11y.github.io/Whoop/', cfg.pub, cfg.priv);
webpush.sendNotification(cfg.sub, JSON.stringify(msg), { TTL: 3600 })
  .then(r => console.log('Gesendet:', msg.title, r.statusCode))
  .catch(e => { console.error('Fehler:', e.statusCode, e.body || e.message); process.exit(1); });
