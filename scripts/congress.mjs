// Stocks within 30% above (or below) the average purchase price of at least two tracked politicians, screened for "sentiment dip, not structural decline".
import fs from 'node:fs';
import { prices, fundamentals } from './update.mjs';
const CFG = JSON.parse(fs.readFileSync('config.json', 'utf8')).congress;
const KEY = process.env.CONGRESS_KEY, FMP = process.env.FMP_KEY, OUT = process.env.CG_OUT || 'docs/congress.json';
const TOPIC = process.env.NTFY_TOPIC;
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (o, ...k) => { for (const x of k) if (o[x] != null && o[x] !== '') return o[x]; };
const rd = v => +v.toFixed(2);

async function trades(member) { // field names are matched loosely because the source schema was not verified
  const u = new URL(CFG.url); u.searchParams.set(CFG.memberParam, member);
  u.searchParams.set(CFG.fromParam, new Date(Date.now() - CFG.days * 864e5).toISOString().slice(0, 10)); u.searchParams.set('limit', '1000');
  const r = await fetch(u, { headers: { 'User-Agent': 'value-compass', ...(KEY ? { Authorization: 'Bearer ' + KEY, 'X-API-Key': KEY } : {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json(), rows = Array.isArray(j) ? j : (j.trades || j.data || j.results || []);
  if (!rows.length) console.warn('no rows for', member, 'response keys:', Object.keys(j).join(','));
  const [first, ...rest] = member.toLowerCase().split(' '), last = rest.pop();
  return rows.filter(o => { const n = pick(o, 'member', 'memberName', 'politician', 'politician_name', 'filerName'); return !n || (String(n).toLowerCase().includes(last) && String(n).toLowerCase().split(/[\s.,]+/).some(w => w[0] === first[0])); })
    .map(o => ({ who: member, ticker: String(pick(o, 'ticker', 'symbol', 'assetTicker') || '').toUpperCase(),
      type: String(pick(o, 'transactionType', 'transaction_type', 'type') || '').toLowerCase(), date: String(pick(o, 'transactionDate', 'transaction_date', 'date') || '').slice(0, 10) }));
}
export function screen(sym, who, P, F) { // returns {ok,...} or {reject}
  const { bars, vol } = P, n = bars.length, last = bars[n - 1][4], entries = [];
  for (const [name, dates] of Object.entries(who)) {
    const px = dates.map(d => { const day = Math.floor(Date.parse(d) / 864e5), b = bars.find(x => x[0] >= day); return b ? b[4] : null; }).filter(Boolean);
    if (px.length) entries.push({ who: name, entry: rd(px.reduce((a, b) => a + b) / px.length), buys: dates.length, first: dates.slice().sort()[0] });
  }
  if (entries.length < (CFG.min || 2)) return { reject: 'too few politicians with a price match' };
  const avg = entries.reduce((a, b) => a + b.entry, 0) / entries.length, dist = (last / avg - 1) * 100;
  if (dist > (CFG.maxAbove ?? 30)) return { reject: 'too far above the average entry' };
  const band = dist <= 0 ? 'green' : dist <= 10 ? 'orange' : 'red';
  const hi = Math.max(...bars.slice(-252).map(b => b[2])), dd = (1 - last / hi) * 100;
  if (dd < (CFG.minDrop ?? 0)) return { reject: 'not down enough' }; if (dd > (CFG.maxDrop ?? 45)) return { reject: 'fell too far, likely structural' };
  const dv = vol.slice(-60).reduce((a, b, i) => a + b * bars[n - 60 + i][4], 0) / 60; if (dv < 5e7) return { reject: 'too illiquid' };
  const cagr3 = n > 756 ? ((last / bars[n - 756][4]) ** (1 / 3) - 1) * 100 : null; if (cagr3 != null && cagr3 < -5) return { reject: 'multi-year downtrend' };
  const checked = !!F; if (F && (!(F.fcf > 0) || !(F.roic >= (CFG.minRoic ?? 8)) || !(F.lev <= (CFG.maxLev ?? 3)))) return { reject: 'weak fundamentals' };
  const why = [`${entries.length} tracked politicians (${entries.map(b => b.who).join(', ')}) bought it recently at an average of ${rd(avg)}; it now trades ${Math.abs(dist).toFixed(0)}% ${dist <= 0 ? 'below' : 'above'} that.`,
    dd < 5 ? 'It is close to its 52-week high.' : `It is ${dd.toFixed(0)}% below its 52-week high: a pullback, not a collapse (the screen drops falls above ${CFG.maxDrop ?? 45}%).`,
    checked ? `Fundamentals still look intact: return on invested capital ${F.roic.toFixed(0)}%, free cash flow yield ${F.fcf.toFixed(1)}%, net debt ${F.lev.toFixed(1)}× EBITDA.` : 'Fundamentals could not be checked on the free plan, so this is less certain.',
    cagr3 != null ? `Over three years it still returned ${cagr3.toFixed(1)}% a year, which fits a sentiment dip rather than a long decline.` : 'Less than three years of history.'];
  const key = (band === 'green' ? 3000 : band === 'orange' ? 2000 : 1000) + entries.length * 100 + (30 - Math.max(-30, Math.min(30, dist))) + (checked ? 20 : 0) + (F ? Math.min(F.roic, 30) / 3 : 0);
  return { ok: true, last, entries, avg, dist, band, dd, cagr3, checked, F, why, key };
}
const FC = { ...(prev?.fc || {}) }; let fmpCalls = 0; const MAXF = 120; // FMP free plan: 250 calls a day, shared with the main job
async function fund(sym) { // fundamentals cached for 7 days, with a daily call budget
  const c = FC[sym]; if (c && Date.now() - c.at < 7 * 864e5) return c;
  const t0 = Date.now(), F = await fundamentals(sym); if (F.at >= t0) { fmpCalls += 2; await sleep(300); } FC[sym] = F; return F;
}
export async function main() {
  const rows = [], used = {};
  for (const m of CFG.members) { try { const t = await trades(m), ds = t.map(x => x.date).filter(Boolean).sort(); used[m] = { rows: t.length, from: ds[0], to: ds.at(-1), capHit: t.length >= 1000 }; rows.push(...t); if (t.length >= 1000) console.warn('possible truncation (1000 rows) for', m); } catch (e) { used[m] = 'failed: ' + e.message; console.warn('trades FAILED', m, e.message); } await sleep(300); }
  const by = {};
  for (const t of rows) if (/purchase|buy/.test(t.type) && /^[A-Z]{1,5}(\.[A-Z])?$/.test(t.ticker) && t.date) ((by[t.ticker] ??= {})[t.who] ??= []).push(t.date);
  const all = Object.entries(by).filter(([, w]) => Object.keys(w).length >= (CFG.min || 2)).sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length);
  const cands = all.slice(0, CFG.maxCandidates || 100), out = [], rej = {};
  const starts = Object.values(used).map(u => u.from).filter(Boolean).sort(); console.log(`earliest trade date returned: ${starts[0] || 'none'} (asked for ${CFG.days} days); ${all.length} candidates, checking ${cands.length}`);
  for (const [t, who] of cands) {
    try {
      const P = await prices(t.replace('.', '-')); await sleep(250); let F = null;
      if (FMP) { try { F = await fund(t.replace('.', '-')); if (F && ![F.roic, F.fcf, F.lev].every(Number.isFinite)) F = null; } catch (e) { F = null; } }
      const r = screen(t, who, P, F); if (!r.ok) { rej[r.reject] = (rej[r.reject] || 0) + 1; continue; }
      out.push({ t, n: P.name, cur: P.cur, price: r.last, entries: r.entries, avg: rd(r.avg), dist: +r.dist.toFixed(1), band: r.band, dd: r.dd, cagr3: r.cagr3, checked: r.checked, why: r.why, key: r.key, bars: P.bars.slice(-260) });
    } catch (e) { rej['no price data'] = (rej['no price data'] || 0) + 1; console.warn('price FAILED', t, e.message); }
  }
  out.sort((a, b) => b.key - a.key);
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), days: CFG.days, trades: used, fc: Object.fromEntries(Object.entries(FC).filter(([, v]) => Date.now() - v.at < 30 * 864e5)), candidates: all.length, checked: cands.length, rejected: rej, list: out.slice(0, 20).map(({ key, ...x }) => x) }));
  const top = out.slice(0, 20), seen = new Set((prev?.list || []).map(x => x.t));
  const fresh = prev ? top.filter(x => !seen.has(x.t)) : []; // no alerts on the very first run
  if (TOPIC) for (const x of fresh) await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', headers: { Title: `${x.t} is new on the Congress list`, Tags: 'classical_building' },
    body: `${x.n}: ${x.cur} ${x.price} is ${x.dist <= 0 ? 'at or below' : x.dist.toFixed(0) + '% above'} the average entry of ${x.entries.length} tracked politicians (${x.entries.map(b => b.who).join(', ')}).` });
  console.log(`new on list: ${fresh.map(x => x.t).join(',') || 'none'}`);
  console.log(`congress: ${rows.length} trades, ${cands.length} candidates, ${Math.min(out.length, 20)} listed, rejected`, JSON.stringify(rej));
}
if (import.meta.url === 'file://' + process.argv[1]) await main();
