// /api/prices
// Vercel Serverless Function: 업비트/바이낸스 시세 + 환율을 서버에서 대신 받아와
// 브라우저의 CORS 문제 없이 프론트엔드에 전달하는 프록시입니다.

const COINS = [
  'BTC','ETH','XRP','SOL','DOGE','ADA','TRX','AVAX','DOT','LINK',
  'MATIC','SHIB','LTC','BCH','ATOM','UNI','ETC','NEAR','APT','ARB','SUI','SEI'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');

  try {
    const [upbitData, binanceData, fx] = await Promise.all([
      fetchUpbit(),
      fetchBinance(),
      fetchFx()
    ]);

    const coins = {};
    for (const t of COINS) {
      coins[t] = {
        domestic: upbitData[t] ?? null,
        binanceUsd: binanceData[t] ?? null
      };
    }

    res.status(200).json({ fx, coins, updatedAt: Date.now() });
  } catch (err) {
    res.status(200).json({ error: String(err), fx: null, coins: {} });
  }
}

async function fetchUpbit() {
  const markets = COINS.map(t => `KRW-${t}`).join(',');
  const r = await fetch(`https://api.upbit.com/v1/ticker?markets=${markets}`);
  const data = await r.json();
  const out = {};
  for (const item of data) {
    const t = item.market.replace('KRW-', '');
    out[t] = item.trade_price;
  }
  return out;
}

async function fetchBinance() {
  const r = await fetch('https://api.binance.com/api/v3/ticker/price');
  const data = await r.json();
  const wanted = new Set(COINS.map(t => `${t}USDT`));
  const out = {};
  for (const item of data) {
    if (wanted.has(item.symbol)) {
      const t = item.symbol.replace('USDT', '');
      out[t] = parseFloat(item.price);
    }
  }
  return out;
}

async function fetchFx() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await r.json();
    return data.rates?.KRW ?? 1380;
  } catch {
    return 1380;
  }
}
