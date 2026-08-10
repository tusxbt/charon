// Stub for the signal server and Jupiter market data, so the real bot can be
// driven end to end without touching the network.
//
// Prices are a pure function of absolute bar time, and bar times sit on the
// interval grid — the way a real feed behaves. An earlier version derived price
// from the array index, so every fetch returned different prices on shifted
// timestamps and the bot's cache accumulated a sawtooth.

import http from 'node:http';

const MINT = 'StubMint1111111111111111111111111111111111';
const PORT = Number(process.env.STUB_PORT || 3999);
const PHASE_MS = Number(process.env.STUB_PHASE_MS || 20_000);

const startedSec = Math.floor(Date.now() / 1000);
// 1 = pullback (entry setup), 2 = rally (TP armed), 3 = correction (exit)
const phase = () => {
  const elapsed = Date.now() - startedSec * 1000;
  if (elapsed < PHASE_MS) return 1;
  if (elapsed < PHASE_MS * 2) return 2;
  return 3;
};

export const hits = new Map();

// 15s series: a long, very gentle rise so EMA 50/100/200 converge, then a
// shallow dip into the cluster during phase 1 and a rally in phase 2.
function price15s(t) {
  const barsFromStart = Math.round((t - startedSec) / 15);
  const base = 100 + barsFromStart * 0.01;
  if (barsFromStart <= -8) return base;
  if (phase() === 1) return base - (barsFromStart + 8) * 0.06;   // dip
  if (phase() === 2) return base + (barsFromStart + 8) * 0.45;   // rally
  return base + (barsFromStart + 8) * 0.10;                       // correction
}

// 5m series: steady uptrend keeps Supertrend bullish throughout.
function price5m(t) {
  const barsFromStart = Math.round((t - startedSec) / 300);
  return 100 + barsFromStart * 1.0 + (phase() === 2 ? 30 : phase() === 3 ? 5 : 0);
}

function bars(count, intervalSec, priceAt) {
  const nowSec = Math.floor(Date.now() / 1000);
  const newest = Math.floor(nowSec / intervalSec) * intervalSec;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const time = newest - i * intervalSec;
    const price = priceAt(time);
    out.push({ time, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 1000 });
  }
  return out;
}

const marketCap = () => (phase() === 1 ? 120_000 : phase() === 2 ? 200_000 : 150_000);
const usdPrice = () => (phase() === 1 ? 0.00012 : phase() === 2 ? 0.00020 : 0.00015);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = url.pathname.replace(/\/(v1\/holders|v2\/charts)\/.*/, '/$1/:mint');
  hits.set(key, (hits.get(key) || 0) + 1);

  const send = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/signals') {
    return send({
      signals: [{
        mint: MINT,
        name: 'Stub Token',
        symbol: 'STUB',
        sources: ['trending_5m', 'graduated'],
        sourceCount: 2,
        ageMs: 4 * 60 * 60 * 1000,
        priceUsd: usdPrice(),
        marketCapUsd: marketCap(),
        liquidityUsd: 90_000,
        holders: 900,
        volume24h: 250_000,
        volume5m: 12_000,
        graduated: { graduatedAt: (startedSec - 4 * 3600) * 1000 },
        trending: { buys: 400, sells: 220, rug_ratio: 0.05, bundler_rate: 0.1, is_wash_trading: false },
      }],
    });
  }

  if (url.pathname.startsWith('/v2/charts/')) {
    const interval = url.searchParams.get('interval');
    const want = Number(url.searchParams.get('candles') || 100);
    return interval === '15_SECOND'
      ? send({ candles: bars(Math.min(want, 400), 15, price15s) })
      : send({ candles: bars(Math.min(want, 200), 300, price5m) });
  }

  if (url.pathname === '/v1/assets/search') {
    return send([{
      id: MINT, name: 'Stub Token', symbol: 'STUB',
      usdPrice: usdPrice(), mcap: marketCap(), fdv: marketCap(),
      liquidity: 90_000, holderCount: 900,
    }]);
  }

  if (url.pathname.startsWith('/v1/holders/')) {
    return send({ holders: Array.from({ length: 40 }, (_, i) => ({ address: `H${i}`, amount: 100 - i, tags: [] })) });
  }

  if (url.pathname === '/v1/pnl') return send({});
  if (url.pathname.startsWith('/price/v3')) return send({});

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, () => console.log(`[stub] listening on ${PORT}, mint ${MINT}`));
process.on('SIGTERM', () => {
  console.log('[stub] requests:', JSON.stringify(Object.fromEntries(hits)));
  process.exit(0);
});
