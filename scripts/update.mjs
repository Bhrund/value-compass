// Daily job: prices (Yahoo chart), US fundamentals (FMP free plan), macro (FRED CSV) -> docs/data.json, then ntfy alerts.
import fs from 'node:fs';
const KEY = process.env.FMP_KEY, TOPIC = process.env.NTFY_TOPIC, OUT = process.env.OUT || 'docs/data.json';
const U = JSON.parse(fs.readFileSync('universe.json', 'utf8'));
const CFG = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { assets: [], macro: {} };
const old = Object.fromEntries(prev.assets.map(a => [a.t, a]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cl = x => Math.max(0, Math.min(1, x));
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; value-compass)' };
async function get(url, text) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url.split('?')[0]); return text ? r.text() : r.json(); }
const rd = v => +(v == null ? NaN : v).toFixed(v > 10 ? 2 : 4);

export async function prices(sym) {
  const d = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`);
  const r = d.chart.result[0], q = r.indicators.quote[0];
  let cur = r.meta.currency, k = 1; if (cur === 'GBp') { cur = 'GBP'; k = .01; }
  const bars = [], vol = [];
  r.timestamp.forEach((t, i) => { const c = q.close[i]; if (c == null) return; const o = q.open[i] ?? c, h = q.high[i] ?? Math.max(o, c), l = q.low[i] ?? Math.min(o, c);
    bars.push([Math.floor(t / 86400), rd(o * k), rd(h * k), rd(l * k), rd(c * k)]); vol.push(q.volume?.[i] || 0); });
  if (bars.length < 250) throw new Error('too little history for ' + sym);
  return { bars, cur, vol, name: r.meta.longName || r.meta.shortName || sym };
}
const FH = process.env.FINNHUB_KEY; let fmpCalls = 0, fmpDown = false;
const num = (...v) => { for (const x of v) if (Number.isFinite(x)) return x; return NaN; };
async function viaFmp(sym) {
  const u = e => `https://financialmodelingprep.com/stable/${e}?symbol=${sym}&apikey=${KEY}`;
  fmpCalls += 2; const [k] = await get(u('key-metrics-ttm')), [r] = await get(u('ratios-ttm'));
  return { at: Date.now(), src: 'fmp', lt: 'Net debt / EBITDA', roic: num(k.returnOnInvestedCapitalTTM) * 100, fcf: num(k.freeCashFlowYieldTTM) * 100, ey: num(k.earningsYieldTTM) * 100,
    lev: num(k.netDebtToEBITDATTM, k.netDebtToEbitdaTTM), dy: num(r.dividendYieldTTM, 0) * 100 };
}
async function viaFinnhub(sym) { // second free source: 60 calls a minute, no daily cap (US stocks)
  const d = await get(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${FH}`); await sleep(1100);
  const m = d.metric || {}; if (!Object.keys(m).length) throw new Error('no data for ' + sym);
  const pe = num(m.peTTM, m.peNormalizedAnnual), pf = num(m.pfcfShareTTM, m.pfcfShareAnnual);
  return { at: Date.now(), src: 'finnhub', lt: 'Debt / equity (stand-in)', roic: num(m.roiTTM, m.roiAnnual, m.roicTTM), fcf: pf > 0 ? 100 / pf : NaN, ey: pe > 0 ? 100 / pe : NaN,
    lev: num(m['totalDebt/totalEquityQuarterly'], m['totalDebt/totalEquityAnnual']), dy: num(m.dividendYieldIndicatedAnnual, 0) };
}
export async function fundamentals(sym) {
  const a = old[sym]?.f; if (a && Date.now() - a.at < 20 * 36e5) return a; // cache
  if (KEY && !fmpDown && fmpCalls < 236) {
    try { const f = await viaFmp(sym); if ([f.roic, f.fcf, f.ey, f.lev].every(Number.isFinite)) return f; console.warn('FMP incomplete for', sym); }
    catch (e) { if (/429/.test(e.message)) fmpDown = true; console.warn('FMP', sym, e.message, FH ? '-> trying Finnhub' : ''); }
  }
  if (FH) return viaFinnhub(sym);
  throw new Error('no fundamentals source available for ' + sym);
}
function scoreStock(f, price) {
  if (![f.roic, f.fcf, f.ey, f.lev].every(Number.isFinite) || f.fcf <= 0 || f.ey <= 0) return null;
  const pe = 100 / f.ey, eg = Math.max(2, Math.min(f.roic > 25 ? 10 : 8, f.roic * .35)); // growth assumed: 35% reinvestment x ROIC, capped 2-8%
  let f0 = price * f.fcf / 100, iv = 0; for (let y = 1; y <= 10; y++) iv += f0 * (1 + eg / 100) ** y / 1.08 ** y;
  iv += f0 * (1 + eg / 100) ** 10 * 1.025 / (.08 - .025) / 1.08 ** 10;
  const mt = f.roic >= 20 && f.lev <= 1.5 ? .12 : f.roic >= 12 ? .20 : .25; // margin of safety scaled to business quality
  return { pe, roic: f.roic, fcf: f.fcf, lev: f.lev, lt: f.lt || 'Net debt / EBITDA', eg, q: cl((f.roic - 8) / 20), v: cl((f.fcf - 2) / 7) * .5 + cl((30 - pe) / 22) * .5, s: cl(1 - f.lev / 4), g: cl((eg - 2) / 12), exp: f.fcf + eg * .8, iv, mt };
}
function scoreEtf(bars, sec) {
  const c = bars.map(b => b[4]), n = c.length, cagr = ((c[n - 1] / c[0]) ** (252 / n) - 1) * 100;
  let pk = 0, dd = 0; for (const x of c) { pk = Math.max(pk, x); dd = Math.max(dd, (pk - x) / pk * 100); }
  const w = c.slice(-504), vp = w.filter(x => x <= c[n - 1]).length / w.length * 100;
  let sx = 0, sy = 0, sxy = 0, sxx = 0; c.forEach((x, i) => { const y = Math.log(x); sx += i; sy += y; sxy += i * y; sxx += i * i; });
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n, iv = Math.exp(a0 + b * (n - 1)); // fair value = 5y log-linear trend
  return { cagr, dd, vp, q: cl((cagr - 3) / 9), v: 1 - vp / 100, s: cl(1 - dd / 50), g: cl((cagr - 3) / 9), exp: cagr * .8, iv, mt: sec === 'Equity broad' ? 0 : .10 };
}
async function fred(id) { const t = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, true);
  return t.trim().split('\n').slice(1).map(l => l.split(',')).filter(x => x[1] && x[1] !== '.').map(x => ({ d: x[0], v: +x[1] })); }
const yoy = (s, m = 12) => (s[s.length - 1].v / s[s.length - 1 - m].v - 1) * 100;
async function macro() {
  const m = { ...prev.macro };
  const tryit = async (k, fn) => { try { Object.assign(m, await fn()); } catch (e) { console.warn('macro FAILED', k, e.message); } };
  await tryit('M2', async () => { const s = await fred('M2SL'); return { m2yoy: yoy(s), m2asof: s.at(-1).d, m2level: s.at(-1).v }; });
  await tryit('CPI', async () => { const s = await fred('CPIAUCSL'); return { cpiyoy: yoy(s), cpiasof: s.at(-1).d }; });
  await tryit('HOME', async () => { const s = await fred('CSUSHPINSA'); return { homeyoy: yoy(s), homeasof: s.at(-1).d }; });
  await tryit('Y10', async () => { const s = await fred('DGS10'); return { y10: s.at(-1).v, y10asof: s.at(-1).d }; });
  await tryit('SPX', async () => { const { bars } = await prices('^GSPC'); const y = (bars.at(-1)[0] - bars[0][0]) / 365.25; return { spx5y: ((bars.at(-1)[4] / bars[0][4]) ** (1 / y) - 1) * 100 }; });
  return m;
}
export async function main() {
  const assets = [], failed = [];
  for (const u of U) {
    try {
      const { bars, cur } = await prices(u.y); await sleep(250);
      const a = { t: u.t, n: u.n, sec: u.sec, etf: !!u.etf, cur, bars, bond: !!u.bond, scored: false };
      const price = bars.at(-1)[4];
      let m = null;
      if (u.etf) { m = scoreEtf(bars, u.sec); a.acc = u.acc; a.dy = u.dy; }
      else if (u.fmp && KEY) { try { const f = await fundamentals(u.fmp); a.f = f; m = scoreStock(f, price); a.dy = Number.isFinite(f.dy) ? f.dy : null; a.acc = a.dy === 0; if (!old[u.fmp]?.f || old[u.fmp].f.at !== f.at) await sleep(300); } catch (e) { console.warn('fundamentals FAILED', u.t, e.message); } }
      if (m) { Object.assign(a, m, { scored: true, buy: m.iv * (1 - m.mt) }); a.entry = price <= a.buy; }
      assets.push(a);
    } catch (e) { failed.push(u.t); console.warn('prices FAILED', u.t, e.message); if (old[u.t]) assets.push({ ...old[u.t], stale: true }); }
  }
  const data = { updated: new Date().toISOString(), macro: await macro(), failed, assets };
  fs.writeFileSync(OUT, JSON.stringify(data));
  // alerts: assets that newly crossed below their entry price (and pass the dividend rule)
  const fresh = assets.filter(a => a.scored && a.entry && !old[a.t]?.entry && !CFG.mute.includes(a.t) && (a.acc || a.dy <= CFG.divMax));
  if (TOPIC && prev.assets.length) for (const a of fresh) await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', headers: { Title: `${a.t} reached its entry price`, Tags: 'chart_with_downwards_trend' },
    body: `${a.n}: ${a.cur} ${a.bars.at(-1)[4]} is at or below your entry level ${a.cur} ${a.buy.toFixed(2)}` });
  console.log(`ok: ${assets.length} assets, ${assets.filter(a => a.scored).length} scored, ${fresh.length} alerts, failed: ${failed.join(',') || 'none'}`);
}
if (import.meta.url === 'file://' + process.argv[1]) await main();
