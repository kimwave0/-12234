// /api/prices
// Vercel Serverless Function
// 업비트(국내가) + CoinGecko(글로벌 시세, USD) + 환율을 가져와
// 브라우저의 CORS/지역차단 문제 없이 프론트엔드에 전달하는 프록시입니다.
// (바이낸스 공개 API는 서버 실행 지역에 따라 접속이 차단될 수 있어 CoinGecko로 대체)

const COIN_MAP = {
  BTC:'bitcoin', ETH:'ethereum', XRP:'ripple', SOL:'solana', DOGE:'dogecoin',
  ADA:'cardano', TRX:'tron', AVAX:'avalanche-2', DOT:'polkadot', LINK:'chainlink',
  MATIC:'matic-network', SHIB:'shiba-inu', LTC:'litecoin', BCH:'bitcoin-cash',
  ATOM:'cosmos', UNI:'uniswap', ETC:'ethereum-classic', NEAR:'near',
  APT:'aptos', ARB:'arbitrum', SUI:'sui', SEI:'sei-network'
};
const COINS = Object.keys(COIN_MAP);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');

  const [upbitData, globalData, fx] = await Promise.all([
    fetchUpbit().catch(e => ({ __error: String(e) })),
    fetchGlobal().catch(e => ({ __error: String(e) })),
    fetchFx().catch(() => 1380)
  ]);

  const coins = {};
  for (const t of COINS) {
    coins[t] = {
      domestic: (upbitData && !upbitData.__error) ? (upbitData[t] ?? null) : null,
      binanceUsd: (globalData && !globalData.__error) ? (globalData[t] ?? null) : null
    };
  }

  res.status(200).json({
    fx,
    coins,
    updatedAt: Date.now(),
    debug: {
      upbitError: upbitData && upbitData.__error ? upbitData.__error : null,
      globalError: globalData && globalData.__error ? globalData.__error : null
    }
  });
}

async function fetchUpbit() {
  const markets = COINS.map(t => `KRW-${t}`).join(',');
  const r = await fetch(`https://api.upbit.com/v1/ticker?markets=${markets}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error('upbit status ' + r.status);
  const data = await r.json();
  const out = {};
  for (const item of data) {
    const t = item.market.replace('KRW-', '');
    out[t] = item.trade_price;
  }
  return out;
}

async function fetchGlobal() {
  const ids = Object.values(COIN_MAP).join(',');
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error('coingecko status ' + r.status);
  const data = await r.json();
  const out = {};
  for (const t of COINS) {
    const id = COIN_MAP[t];
    if (data[id] && typeof data[id].usd === 'number') {
      out[t] = data[id].usd;
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
