// One-time import of an all-time price history into data/prices.json.
// Put each sticker's saved csgoskins.gg page into import/ and name it after the sticker id,
// e.g. import/titan-holo.html. Then run this (the "Import history" workflow does it for you).
import fs from 'node:fs';
import path from 'node:path';
import { STICKERS } from './stickers.mjs';

const DIR = 'import', FILE = 'data/prices.json';
if (!fs.existsSync(DIR)) { console.log('No import/ folder, nothing to do.'); process.exit(0); }
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { updated: 0, items: {} };
db.items ||= {};

let done = 0, failed = 0;
for (const f of fs.readdirSync(DIR)) {
  const id = path.parse(f).name.toLowerCase();
  if (f.startsWith('.') || id === 'readme') continue;
  const st = STICKERS.find(s => s.id === id);
  if (!st) { console.error(`Skipping ${f}: the name must be one of ${STICKERS.map(s => s.id).join(', ')}`); failed++; continue; }

  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const m = text.match(/const\s+priceHistory\s*=\s*(\[\[[\s\S]*?\]\])\s*;/);
  if (!m) { console.error(`${f}: could not find the price history in this file. Save the page again (see the instructions).`); failed++; continue; }
  let rows;
  try { rows = JSON.parse(m[1]); } catch (e) { console.error(`${f}: history is not valid JSON (${e.message})`); failed++; continue; }

  // each row: [ "YYYY-MM-DD", price in cents, offers available, offers sold ]
  const imp = rows
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(r[1]) && r[1] > 0)
    .map(r => [Math.floor(Date.parse(r[0] + 'T00:00:00Z') / 1000), Math.round(r[1]) / 100])
    .sort((a, b) => a[0] - b[0]);
  if (imp.length < 10) { console.error(`${f}: only ${imp.length} usable rows, skipping`); failed++; continue; }

  const item = (db.items[st.hash] ||= { markets: {} });
  const cutoff = imp[imp.length - 1][0];
  const old = item.history ? item.history.t.map((t, i) => [t, item.history.p[i]]).filter(([t]) => t > cutoff) : [];
  const all = [...imp, ...old];
  item.history = { t: all.map(r => r[0]), p: all.map(r => r[1]) };
  console.log(`${st.id}: ${imp.length} daily points (${new Date(imp[0][0] * 1000).toISOString().slice(0, 10)} to ${new Date(cutoff * 1000).toISOString().slice(0, 10)}), kept ${old.length} newer collected points`);
  done++;
}
if (!done && failed) process.exit(1);
db.updated = db.updated || Date.now();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(db));
console.log(`Saved ${FILE} (${(fs.statSync(FILE).size / 1024).toFixed(0)} KB)`);
