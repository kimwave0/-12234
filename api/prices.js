// /api/prices.js
// 김프리즘 - 실시간 김치프리미엄 계산 API
//
// 브라우저에서 거래소 API를 직접 부르면 CORS로 막히므로
// 모든 시세 조회를 이 서버리스 함수 한 곳에서 처리한다.
//
// 규칙: 데이터를 못 가져오면 절대 가짜 숫자를 만들지 않는다.
//       실패한 항목은 응답에서 빼고 errors 배열에 이유를 남긴다.

const COINS = [
  ['BTC', '비트코인'],
  ['ETH', '이더리움'],
  ['XRP', '리플'],
  ['SOL', '솔라나'],
  ['DOGE', '도지코인'],
  ['ADA', '에이다'],
  ['TRX', '트론'],
  ['AVAX', '아발란체'],
  ['LINK', '체인링크'],
  ['DOT', '폴카닷'],
  ['BCH', '비트코인캐시'],
  ['LTC', '라이트코인'],
  ['ETC', '이더리움클래식'],
  ['XLM', '스텔라루멘'],
  ['ATOM', '코스모스'],
  ['HBAR', '헤데라'],
  ['SUI', '수이'],
  ['APT', '앱토스'],
  ['NEAR', '니어프로토콜'],
  ['SHIB', '시바이누'],
  ['AAVE', '에이브'],
  ['SAND', '샌드박스'],
];

const NAME_BY_SYMBOL = Object.fromEntries(COINS);
const SYMBOLS = COINS.map(([s]) => s);

// 바이낸스는 일부 데이터센터 IP를 차단(HTTP 451)하므로 호스트를 순서대로 시도한다.
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];

async function getJSON(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'kimprism/1.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 국내 거래소 ---------- */

// 업비트는 없는 마켓 코드가 하나라도 섞이면 요청 전체를 404로 거절한다.
// 그래서 먼저 실제 원화마켓 목록을 받아 교집합만 조회한다. (상장·폐지에 자동 대응)
let upbitMarketCache = { at: 0, set: null };

async function upbitKrwMarkets() {
  if (upbitMarketCache.set && Date.now() - upbitMarketCache.at < 10 * 60e3) {
    return upbitMarketCache.set;
  }
  const rows = await getJSON('https://api.upbit.com/v1/market/all?isDetails=false');
  const set = new Set(
    rows
      .map((r) => String(r.market))
      .filter((m) => m.startsWith('KRW-'))
      .map((m) => m.replace('KRW-', ''))
  );
  upbitMarketCache = { at: Date.now(), set };
  return set;
}

async function fetchUpbit() {
  const available = await upbitKrwMarkets();
  const wanted = [...SYMBOLS, 'USDT'].filter((s) => available.has(s));
  if (!wanted.length) throw new Error('업비트 원화마켓에 해당 코인이 없습니다');

  const markets = wanted.map((s) => `KRW-${s}`).join(',');
  const rows = await getJSON(`https://api.upbit.com/v1/ticker?markets=${markets}`);
  const out = {};
  for (const row of rows) {
    const sym = String(row.market).replace('KRW-', '');
    out[sym] = {
      price: Number(row.trade_price),
      change24h: Number(row.signed_change_rate) * 100,
    };
  }
  return out;
}

async function fetchBithumb() {
  const data = await getJSON('https://api.bithumb.com/public/ticker/ALL_KRW');
  if (data.status !== '0000') throw new Error(`bithumb status ${data.status}`);
  const out = {};
  for (const [sym, v] of Object.entries(data.data)) {
    if (!v || typeof v !== 'object' || !v.closing_price) continue;
    out[sym] = {
      price: Number(v.closing_price),
      change24h: Number(v.fluctate_rate_24H),
    };
  }
  return out;
}

/* ---------- 해외 거래소 ---------- */

async function fetchBinance() {
  const want = [...SYMBOLS.map((s) => `${s}USDT`), 'BTCUSDT'];
  const qs = `symbols=${encodeURIComponent(JSON.stringify([...new Set(want)]))}`;
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const rows = await getJSON(`${host}/api/v3/ticker/24hr?${qs}`);
      const out = {};
      for (const row of rows) {
        const sym = String(row.symbol).replace(/USDT$/, '');
        out[sym] = {
          price: Number(row.lastPrice),
          change24h: Number(row.priceChangePercent),
        };
      }
      return { data: out, host };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`binance unreachable: ${lastErr && lastErr.message}`);
}

/* ---------- 환율 (달러/원) ---------- */

async function fetchFx() {
  try {
    const d = await getJSON('https://open.er-api.com/v6/latest/USD');
    const rate = Number(d && d.rates && d.rates.KRW);
    if (rate > 0) return { rate, source: 'er-api' };
  } catch (_) {}
  try {
    const d = await getJSON('https://api.frankfurter.app/latest?from=USD&to=KRW');
    const rate = Number(d && d.rates && d.rates.KRW);
    if (rate > 0) return { rate, source: 'frankfurter' };
  } catch (_) {}
  return null;
}

/* ---------- 핸들러 ---------- */

module.exports = async (req, res) => {
  const exchange = String((req.query && req.query.exchange) || 'upbit').toLowerCase();
  const errors = [];

  const [domesticRes, binanceRes, fxRes] = await Promise.allSettled([
    exchange === 'bithumb' ? fetchBithumb() : fetchUpbit(),
    fetchBinance(),
    fetchFx(),
  ]);

  const domestic = domesticRes.status === 'fulfilled' ? domesticRes.value : null;
  const binance = binanceRes.status === 'fulfilled' ? binanceRes.value.data : null;
  const binanceHost = binanceRes.status === 'fulfilled' ? binanceRes.value.host : null;
  const fx = fxRes.status === 'fulfilled' ? fxRes.value : null;

  if (!domestic) errors.push(`${exchange}: ${domesticRes.reason && domesticRes.reason.message}`);
  if (!binance) errors.push(`binance: ${binanceRes.reason && binanceRes.reason.message}`);
  if (!fx) errors.push('환율 조회 실패');

  // 김프 계산에는 국내가 + 해외가 + 환율이 모두 필요하다.
  const canComputePremium = Boolean(domestic && binance && fx);

  // 해외 시세나 환율이 빠져도 국내 가격은 보여준다. 김프 칸만 비워 둔다.
  const coins = [];
  if (domestic) {
    for (const sym of SYMBOLS) {
      const d = domestic[sym];
      if (!d || !(d.price > 0)) continue;

      const b = binance && binance[sym];
      const hasGlobal = Boolean(b && b.price > 0);
      const globalKrw = hasGlobal && fx ? b.price * fx.rate : null;
      const premium = globalKrw ? (d.price / globalKrw - 1) * 100 : null;

      coins.push({
        symbol: sym,
        name: NAME_BY_SYMBOL[sym] || sym,
        krw: d.price,
        change24h: Number.isFinite(d.change24h) ? d.change24h : null,
        usdt: hasGlobal ? b.price : null,
        globalKrw,
        premium,
      });
    }
    coins.sort((a, b) => (b.krw || 0) * 0 + (a.symbol === 'BTC' ? -1 : b.symbol === 'BTC' ? 1 : 0));
  }

  // 테더(USDT) 기준행 — 업비트에만 KRW-USDT 마켓이 있다.
  let tether = null;
  const usdt = domestic && domestic.USDT;
  if (usdt && usdt.price > 0 && fx) {
    tether = {
      krw: usdt.price,
      fxRate: fx.rate,
      premium: (usdt.price / fx.rate - 1) * 100,
      change24h: Number.isFinite(usdt.change24h) ? usdt.change24h : null,
    };
  }

  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=20');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  return res.status(coins.length ? 200 : 503).json({
    ok: coins.length > 0,
    canComputePremium,
    ts: Date.now(),
    exchange,
    fx,
    binanceHost,
    tether,
    coins,
    errors,
  });
};
