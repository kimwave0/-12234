/* =====================================================================
   /api/stocks.js  —  코스피·코스닥 시세 (네이버 1순위, 야후 폴백)

   GET 응답을 CDN에 60초 캐시한다. 접속자가 몇 명이든 실제 외부 API 호출은
   1분에 한 번뿐이라, 함수 호출 수가 접속자 수와 무관해진다.
   ===================================================================== */

const CACHE_SECONDS = 60;

const KOSPI = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '373220', name: 'LG에너지솔루션' },
  { code: '207940', name: '삼성바이오로직스' },
  { code: '005380', name: '현대차' }
];

const KOSDAQ = [
  { code: '247540', name: '에코프로비엠' },
  { code: '086520', name: '에코프로' },
  { code: '028300', name: 'HLB' },
  { code: '196170', name: '알테오젠' },
  { code: '068270', name: '셀트리온제약' }
];

// ── 네이버 증권 (비공식 모바일 API, 키 불필요) ───────────────────────
async function fromNaver(items) {
  const codes = items.map(i => i.code).join(',');
  const res = await fetch(
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/'
      }
    }
  );
  if (!res.ok) throw new Error(`naver ${res.status}`);
  const json = await res.json();
  const list = (json && json.datas) || [];

  return items.map(item => {
    const d = list.find(x => x.itemCode === item.code);
    if (!d) return { ...item, price: null, change: null, changeRate: null };
    return {
      ...item,
      price: Number(d.closePrice.replace(/,/g, '')),
      change: Number(String(d.compareToPreviousClosePrice).replace(/,/g, '')),
      changeRate: Number(d.fluctuationsRatio)
    };
  });
}

// ── 야후 파이낸스 폴백 ───────────────────────────────────────────────
async function fromYahoo(items, suffix) {
  const symbols = items.map(i => `${i.code}.${suffix}`).join(',');
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const json = await res.json();
  const list = (json.quoteResponse && json.quoteResponse.result) || [];

  return items.map(item => {
    const d = list.find(x => x.symbol === `${item.code}.${suffix}`);
    if (!d) return { ...item, price: null, change: null, changeRate: null };
    return {
      ...item,
      price: d.regularMarketPrice ?? null,
      change: d.regularMarketChange ?? null,
      changeRate: d.regularMarketChangePercent ?? null
    };
  });
}

async function load(items, yahooSuffix) {
  try {
    return await fromNaver(items);
  } catch (_) {
    try {
      return await fromYahoo(items, yahooSuffix);
    } catch (_) {
      return items.map(i => ({ ...i, price: null, change: null, changeRate: null }));
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 캐시 헤더가 비용을 결정한다.
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=120`
  );

  try {
    const [kospi, kosdaq] = await Promise.all([
      load(KOSPI, 'KS'),
      load(KOSDAQ, 'KQ')
    ]);

    const hasData = [...kospi, ...kosdaq].some(s => s.price != null);
    if (!hasData) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ ok: false, error: '시세를 불러올 수 없습니다' });
    }

    return res.status(200).json({
      ok: true,
      kospi,
      kosdaq,
      updatedAt: Date.now()
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: '시세를 불러올 수 없습니다' });
  }
}
