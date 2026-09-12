// /api/stocks.js
// 김프리즘 - 코스피·코스닥 주요 종목 시세
//
// 증권사 API 키 없이 공개 시세 엔드포인트에서 가져온다.
// 여기도 같은 규칙: 못 받아오면 가짜 숫자를 만들지 않고 비워 둔다.

const KOSPI = [
  ['005930.KS', '삼성전자'],
  ['000660.KS', 'SK하이닉스'],
  ['373220.KS', 'LG에너지솔루션'],
  ['207940.KS', '삼성바이오로직스'],
  ['005380.KS', '현대차'],
];

const KOSDAQ = [
  ['196170.KQ', '알테오젠'],
  ['247540.KQ', '에코프로비엠'],
  ['086520.KQ', '에코프로'],
  ['028300.KQ', 'HLB'],
  ['141080.KQ', '리가켐바이오'],
];

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function getJSON(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; kimprism/1.0)',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function quote([ticker, name]) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const d = await getJSON(`${host}/v8/finance/chart/${ticker}?interval=1d&range=2d`);
      const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const price = Number(meta && meta.regularMarketPrice);
      const base = Number(meta && (meta.chartPreviousClose || meta.previousClose));
      if (!(price > 0)) throw new Error('가격 없음');
      return {
        ticker,
        name,
        price,
        change: base > 0 ? (price / base - 1) * 100 : null,
        currency: (meta && meta.currency) || 'KRW',
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${name}: ${lastErr && lastErr.message}`);
}

async function board(list) {
  const settled = await Promise.allSettled(list.map(quote));
  const rows = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') rows.push(s.value);
    else errors.push(`${list[i][1]}: ${s.reason && s.reason.message}`);
  });
  return { rows, errors };
}

module.exports = async (req, res) => {
  const [kospi, kosdaq] = await Promise.all([board(KOSPI), board(KOSDAQ)]);
  const errors = [...kospi.errors, ...kosdaq.errors];

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const ok = kospi.rows.length > 0 || kosdaq.rows.length > 0;
  return res.status(ok ? 200 : 503).json({
    ok,
    ts: Date.now(),
    kospi: kospi.rows,
    kosdaq: kosdaq.rows,
    errors,
  });
};
