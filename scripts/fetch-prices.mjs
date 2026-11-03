// Fetches current sticker prices from Pricempire and appends them to data/prices.json.
// Runs inside GitHub Actions. The API key comes from the PRICEMPIRE_KEY repository secret.
import fs from 'node:fs';
import { STICKERS } from './stickers.mjs';

const KEY  = process.env.PRICEMPIRE_KEY;
const BASE = process.env.PRICEMPIRE_BASE || 'https://api.pricempire.com';
if (!KEY) { console.error('Missing PRICEMPIRE_KEY. Add it under Settings > Secrets and variables > Actions.'); process.exit(1); }

/* ---------- things you may want to edit ---------- */
const PRICE_DIVISOR = 100;      // Pricempire returns cents. Change to 1 if the first run shows prices 100x too big.
const MAX_POINTS = 1000;        // history kept per market (about 125 days at one run every 3 hours)

// Pricempire provider_key -> name and link shown on the page.
// `item` (optional) is a link straight to the sticker on that site; {name} becomes the sticker name. Sites without it link to the homepage.
// Keys Pricempire doesn't recognise will make the run fail with a clear error: just delete that line.
const PROVIDERS = {
  steam:    { name: 'Steam Market', url: 'https://steamcommunity.com/market/', item: 'https://steamcommunity.com/market/listings/730/{name}' },
  buff163:  { name: 'BUFF163',      url: 'https://buff.163.com/' },
  skinport: { name: 'Skinport',     url: 'https://skinport.com/',     item: 'https://skinport.com/market?search={name}' },
  csfloat:  { name: 'CSFloat',      url: 'https://csfloat.com/',      item: 'https://csfloat.com/search?market_hash_name={name}' },
  dmarket:  { name: 'DMarket',      url: 'https://dmarket.com/' },
  waxpeer:  { name: 'Waxpeer',      url: 'https://waxpeer.com/' },
  bitskins: { name: 'BitSkins',     url: 'https://bitskins.com/' },
};

/* -------------------------------------------------- */

const FILE = 'data/prices.json';
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { updated: 0, items: {} };
db.items ||= {};

const url = new URL('/v4/paid/items/prices', BASE);
url.searchParams.set('app_id', '730');
url.searchParams.set('currency', 'USD');
url.searchParams.set('sources', Object.keys(PROVIDERS).join(','));

const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, accept: 'application/json' } });
const body = await res.text();
if (!res.ok) {
  console.error(`Pricempire answered ${res.status}:\n${body.slice(0, 800)}`);
  if (res.status === 401 || res.status === 403) console.error('\nThe key was refused. Your plan may not include this endpoint (/v4/paid/items/prices).');
  process.exit(1);
}
const all = JSON.parse(body);
if (!Array.isArray(all)) { console.error('Unexpected response shape:', body.slice(0, 500)); process.exit(1); }

const byName = new Map(all.map(i => [i.market_hash_name, i]));
const now = Math.floor(Date.now() / 1000);

function thin(m) {
  while (m.t.length > MAX_POINTS) {          // drop every other point in the older half
    const half = Math.floor(m.t.length / 2), t = [], p = [];
    for (let i = 0; i < m.t.length; i++) if (i >= half || i % 2 === 0) { t.push(m.t[i]); p.push(m.p[i]); }
    m.t = t; m.p = p;
  }
}

let found = 0;
for (const { hash } of STICKERS) {
  const src = byName.get(hash);
  if (!src) { console.warn('Not in response:', hash); continue; }
  found++;
  const item = (db.items[hash] ||= { markets: {} });
  for (const pr of src.prices || []) {
    if (pr.price == null || pr.price <= 0) continue;
    const key = pr.provider_key;
    const info = PROVIDERS[key] || { name: key, url: '' };
    const link = info.item ? info.item.replace('{name}', encodeURIComponent(hash)) : info.url;
    const m = (item.markets[key] ||= { name: info.name, url: link, count: 0, t: [], p: [] });
    m.name = info.name; m.url = link;
    m.count = pr.count ?? m.count;
    m.t.push(now);
    m.p.push(Math.round((pr.price / PRICE_DIVISOR) * 100) / 100);
    thin(m);
  }
  // Keep the all-time "lowest overall" line going: the cheapest price across markets right now.
  const fresh = Object.values(item.markets).filter(m => m.t[m.t.length - 1] === now).map(m => m.p[m.p.length - 1]);
  const lowest = fresh.length ? Math.min(...fresh) : null;
  if (lowest != null) {
    const h = (item.history ||= { t: [], p: [] });
    if (!h.t.length || now - h.t[h.t.length - 1] > 2.5 * 3600) { h.t.push(now); h.p.push(lowest); }
    while (h.t.length > 20000) { h.t.splice(1, 1); h.p.splice(1, 1); }
  }
  console.log(`${hash}: ${fresh.length} markets, lowest ${lowest == null ? 'n/a' : '$' + lowest.toFixed(2)}`);
}
if (!found) { console.error('None of the stickers were found in the response. The names may differ.'); process.exit(1); }

db.updated = Date.now();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(db));
console.log(`Saved ${FILE} (${(fs.statSync(FILE).size / 1024).toFixed(0)} KB)`);
