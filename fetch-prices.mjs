// Fetches the cheapest price of every sticker straight from each marketplace and appends it to data/prices.json.
// Runs inside GitHub Actions every hour. Each site is fetched on its own: if one fails, the others still update.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { STICKERS } from './stickers.mjs';

const MAX_POINTS = 2000;   // history kept per market (about 80 days at one run per hour); older points get thinned out
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- tiny HTTP helper (handles gzip / deflate / brotli, timeouts, status errors) ---------- */
function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'http:' ? http : https).get(u, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; titan-holo-price-bot)', 'accept': 'application/json', 'accept-encoding': 'br, gzip, deflate', ...headers },
      timeout: 30000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          let buf = Buffer.concat(chunks);
          const ce = res.headers['content-encoding'];
          if (ce === 'br') buf = zlib.brotliDecompressSync(buf);
          else if (ce === 'gzip') buf = zlib.gunzipSync(buf);
          else if (ce === 'deflate') buf = zlib.inflateSync(buf);
          const text = buf.toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          resolve(JSON.parse(text));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/* ---------- the sites ----------
   Each fetcher returns a Map: sticker name -> { price (USD), count (number or null), url }.
   A sticker with no listing on that site is simply left out. */
const SITES = [
  {
    id: 'steam', name: 'Steam Market', home: 'https://steamcommunity.com/market/',
    async fetch(names) {
      const base = process.env.STEAM_BASE || 'https://steamcommunity.com';
      const out = new Map();
      for (const n of names) {
        try {
          const j = await getJson(`${base}/market/priceoverview/?appid=730&currency=1&market_hash_name=${enc(n)}`);
          const raw = j && j.success && j.lowest_price;
          const price = raw ? parseFloat(String(raw).replace(/[^0-9.]/g, '')) : NaN;
          if (price > 0) out.set(n, { price, count: null, url: `${base}/market/listings/730/${enc(n)}` });
        } catch (e) { console.log(`  steam: ${n}: ${e.message}`); }
        await sleep(process.env.STEAM_BASE ? 0 : 3500);   // Steam rate-limits quickly
      }
      return out;
    },
  },
  {
    id: 'skinport', name: 'Skinport', home: 'https://skinport.com/',
    async fetch(names) {
      const base = process.env.SKINPORT_BASE || 'https://api.skinport.com';
      const all = await getJson(`${base}/v1/items?app_id=730&currency=USD`);
      if (!Array.isArray(all)) throw new Error('unexpected response');
      const want = new Set(names), out = new Map();
      for (const it of all) {
        if (!want.has(it.market_hash_name) || !(it.min_price > 0)) continue;
        out.set(it.market_hash_name, { price: it.min_price, count: it.quantity ?? null, url: it.item_page || `https://skinport.com/market?search=${enc(it.market_hash_name)}` });
      }
      return out;
    },
  },
  {
    id: 'dmarket', name: 'DMarket', home: 'https://dmarket.com/',
    disabled: 'DMarket retired the endpoint this used (HTTP 410) and the replacement needs a signed API key',
    async fetch(names) {
      const base = process.env.DMARKET_BASE || 'https://api.dmarket.com';
      const out = new Map();
      for (const n of names) {
        try {
          const j = await getJson(`${base}/exchange/v1/market/items?side=market&orderBy=price&orderDir=asc&title=${enc(n)}&gameId=a8db&currency=USD&limit=100`);
          const exact = (j.objects || []).filter(o => o.title === n && o.price && Number(o.price.USD) > 0);
          if (exact.length) out.set(n, { price: Number(exact[0].price.USD) / 100, count: exact.length, url: `https://dmarket.com/ingame-items/item-list/csgo-skins?title=${enc(n)}` });
        } catch (e) { console.log(`  dmarket: ${n}: ${e.message}`); }
        await sleep(process.env.DMARKET_BASE ? 0 : 600);
      }
      return out;
    },
  },
  {
    id: 'csfloat', name: 'CSFloat', home: 'https://csfloat.com/',
    needsKey: 'CSFLOAT_KEY',
    async fetch(names) {
      const base = process.env.CSFLOAT_BASE || 'https://csfloat.com';
      const out = new Map();
      for (const n of names) {
        try {
          const j = await getJson(`${base}/api/v1/listings?market_hash_name=${enc(n)}&sort_by=lowest_price&limit=50&type=buy_now`, { authorization: process.env.CSFLOAT_KEY });
          const list = (Array.isArray(j) ? j : j.data || []).filter(l => l.price > 0 && (!l.item || !l.item.market_hash_name || l.item.market_hash_name === n));
          if (list.length) out.set(n, { price: list[0].price / 100, count: list.length, url: list[0].id ? `https://csfloat.com/item/${list[0].id}` : `https://csfloat.com/search?market_hash_name=${enc(n)}` });
        } catch (e) { console.log(`  csfloat: ${n}: ${e.message}`); }
        await sleep(process.env.CSFLOAT_BASE ? 0 : 500);
      }
      return out;
    },
  },
];

/* ---------- run every site on its own ---------- */
const names = STICKERS.map(s => s.hash);
const active = SITES.filter(s => {
  if (s.disabled && !process.env.FORCE_ALL_SITES) { console.log(`${s.name}: skipped (${s.disabled})`); return false; }
  if (s.needsKey && !process.env[s.needsKey]) { console.log(`${s.name}: skipped (no ${s.needsKey} secret set)`); return false; }
  return true;
});
const results = await Promise.all(active.map(async s => {
  try {
    const map = await s.fetch(names);
    console.log(`${s.name}: ${map.size}/${names.length} stickers priced`);
    return { site: s, map };
  } catch (e) {
    console.log(`${s.name}: FAILED, ${e.message}`);
    return { site: s, map: new Map(), failed: true };
  }
}));
if (!results.some(r => r.map.size)) { console.error('No site returned any price. Nothing saved.'); process.exit(1); }

/* ---------- save ---------- */
const FILE = 'data/prices.json';
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { updated: 0, items: {} };
db.items ||= {};
const now = Math.floor(Date.now() / 1000);

function thin(m) {
  while (m.t.length > MAX_POINTS) {          // drop every other point in the older half
    const half = Math.floor(m.t.length / 2), t = [], p = [];
    for (let i = 0; i < m.t.length; i++) if (i >= half || i % 2 === 0) { t.push(m.t[i]); p.push(m.p[i]); }
    m.t = t; m.p = p;
  }
}

console.log('');
for (const { hash } of STICKERS) {
  const item = (db.items[hash] ||= { markets: {} });
  const row = [];
  for (const { site, map } of results) {
    const got = map.get(hash);
    if (!got) continue;
    const m = (item.markets[site.id] ||= { name: site.name, url: site.home, count: 0, t: [], p: [] });
    m.name = site.name; m.url = got.url; m.count = got.count ?? m.count;
    m.t.push(now); m.p.push(Math.round(got.price * 100) / 100);
    thin(m);
    row.push(`${site.name} $${got.price.toFixed(2)}`);
  }
  // keep the all-time "lowest overall" line going with the cheapest price found this run
  const fresh = Object.values(item.markets).filter(m => m.t[m.t.length - 1] === now).map(m => m.p[m.p.length - 1]);
  if (fresh.length) {
    const h = (item.history ||= { t: [], p: [] });
    if (!h.t.length || now - h.t[h.t.length - 1] > 0.75 * 3600) { h.t.push(now); h.p.push(Math.min(...fresh)); }
    while (h.t.length > 20000) { h.t.splice(1, 1); h.p.splice(1, 1); }
  }
  console.log(`${hash.replace('Sticker | ', '').replace(' | Katowice 2014', '')}: ${row.length ? row.join(' | ') : 'no prices this run'}`);
}
db.updated = Date.now();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(db));
console.log(`\nSaved ${FILE} (${(fs.statSync(FILE).size / 1024).toFixed(0)} KB)`);
