// /api/stocks.js
// 김프리즘 - 코스피·코스닥 주요 종목 시세
//
// 네이버 증권 공개 시세를 우선 사용하고, 실패하면 야후 파이낸스로 넘어간다.
// 둘 다 API 키가 필요 없다. 못 받아오면 가짜 숫자를 만들지 않고 비워 둔다.

const KOSPI = [
  ['005930', '삼성전자'],
  ['000660', 'SK하이닉스'],
  ['373220', 'LG에너지솔루션'],
  ['207940', '삼성바이오로직스'],
  ['005380', '현대차'],
];

const KOSDAQ = [
  ['196170', '알테오젠'],
  ['247540', '에코프로비엠'],
  ['086520', '에코프로'],
  ['028300', 'HLB'],
  ['141080', '리가켐바이오'],
];

const KOSDAQ_CODES = new Set(KOSDAQ.map(([c]) => c));

async function getJSON(url, headers, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: Object.assign(
        {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'ko-KR,ko;q=0.9',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        headers || {}
      ),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const toNum = v => Number(String(v == null ? '' : v).replace(/,/g, ''));

/* ── 1순위: 네이버 증권 ── */
async function fromNaver(code) {
  const d = await getJSON(`https://m.stock.naver.com/api/stock/${code}/basic`, {
    referer: `https://m.stock.naver.com/domestic/stock/${code}/total`,
  });
  const price = toNum(d && d.closePrice);
  const rate = toNum(d && d.fluctuationsRatio);
  if (!(price > 0)) throw new Error('가격 없음');
  // riseFall: 2=하락, 5=상승 등. 부호는 등락률에 이미 붙어 나오는 경우가 많으나
  // 안전하게 하락 표시일 때 음수로 맞춘다.
  const down = String(d.compareToPreviousPrice && d.compareToPreviousPrice.code) === '5';
  const change = Number.isFinite(rate) ? (down ? -Math.abs(rate) : rate) : null;
  return { price, change };
}

/* ── 2순위: 야후 파이낸스 ── */
async function fromYahoo(code) {
  const suffix = KOSDAQ_CODES.has(code) ? 'KQ' : 'KS';
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const d = await getJSON(`${host}/v8/finance/chart/${code}.${suffix}?interval=1d&range=2d`);
      const meta = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const price = Number(meta && meta.regularMarketPrice);
      const base = Number(meta && (meta.chartPreviousClose || meta.previousClose));
      if (!(price > 0)) throw new Error('가격 없음');
      return { price, change: base > 0 ? (price / base - 1) * 100 : null };
    } catch (_) {}
  }
  throw new Error('야후 응답 없음');
}

async function quote([code, name]) {
  const tried = [];
  for (const [label, fn] of [['naver', fromNaver], ['yahoo', fromYahoo]]) {
    try {
      const q = await fn(code);
      return { code, name, price: q.price, change: q.change, source: label };
    } catch (e) {
      tried.push(`${label} ${e.message}`);
    }
  }
  throw new Error(`${name}(${code}): ${tried.join(' / ')}`);
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
