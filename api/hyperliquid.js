/* =====================================================================
   /api/hyperliquid.js  —  하이퍼리퀴드 주식 퍼프 괴리율 (한국 종목 포함)

   두 가지 지표를 계산한다.

   1) 베이시스 = (마크가격 / 오라클가격 - 1) × 100
      퍼프가 참조가격 대비 비싼지 싼지. 24시간 거래되므로
      한국장·미국장이 닫힌 동안의 값이 "예상 개장가" 역할을 한다.

   2) 오라클 이탈 = (오라클가격 / 실제KRX환산가 - 1) × 100
      한국 종목 한정. 오라클 자체가 실제 시장에서 벗어났는지 감시한다.
      2026년 7월 SK하이닉스 사고는 넥스트레이드 프리마켓의 이상 체결이
      오라클에 들어가면서 발생했다. 이 값이 튀면 데이터를 믿으면 안 된다.
   ===================================================================== */

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const CACHE_SECONDS = 30;

// 오라클 이탈이 이 값을 넘으면 경고로 표시
const ORACLE_WARN_PCT = 3;

const EQUITY = {
  // 한국 종목 — KRX 교차검증 대상
  SMSN:    { label: '삼성전자',          market: 'KR', krxCode: '005930' },
  SKHX:    { label: 'SK하이닉스 (ADR)',  market: 'KR', krxCode: '000660' },
  SKHYNIX: { label: 'SK하이닉스 (서울)', market: 'KR', krxCode: '000660' },
  HYUNDAI: { label: '현대차',            market: 'KR', krxCode: '005380' },
  KR200:   { label: '코스피200',         market: 'KR', krxCode: null },
  EWY:     { label: '한국 ETF',          market: 'KR', krxCode: null },

  // 미국 종목
  NVDA:   { label: '엔비디아',        market: 'US' },
  TSLA:   { label: '테슬라',          market: 'US' },
  AAPL:   { label: '애플',            market: 'US' },
  MSFT:   { label: '마이크로소프트',  market: 'US' },
  GOOGL:  { label: '알파벳',          market: 'US' },
  AMZN:   { label: '아마존',          market: 'US' },
  META:   { label: '메타',            market: 'US' },
  AMD:    { label: 'AMD',             market: 'US' },
  TSM:    { label: 'TSMC',            market: 'US' },
  MU:     { label: '마이크론',        market: 'US' },
  COIN:   { label: '코인베이스',      market: 'US' },
  MSTR:   { label: '스트래티지',      market: 'US' },
  XYZ100: { label: '나스닥100 (합성)', market: 'US' },
  SP500:  { label: 'S&P 500',         market: 'US' },
  JP225:  { label: '닛케이225',       market: 'JP' }
};

async function hlPost(body) {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  return res.json();
}

async function listBuilderDexes() {
  try {
    const dexes = await hlPost({ type: 'perpDexs' });
    return (dexes || []).filter(d => d && d.name).map(d => d.name);
  } catch (_) {
    return ['xyz'];
  }
}

// ── 원달러 환율 ──────────────────────────────────────────────────────
async function fetchRate() {
  const sources = [
    { url: 'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD',
      parse: j => Array.isArray(j) && j[0] && Number(j[0].basePrice) },
    { url: 'https://open.er-api.com/v6/latest/USD',
      parse: j => j && j.rates && Number(j.rates.KRW) }
  ];
  for (const s of sources) {
    try {
      const res = await fetch(s.url);
      if (!res.ok) continue;
      const rate = s.parse(await res.json());
      if (rate > 500 && rate < 3000) return rate;
    } catch (_) { /* 다음 소스 */ }
  }
  return null;
}

// ── KRX 실시세 (네이버) ──────────────────────────────────────────────
async function fetchKrx(codes) {
  if (!codes.length) return {};
  try {
    const res = await fetch(
      `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' } }
    );
    if (!res.ok) return {};
    const json = await res.json();
    const out = {};
    for (const d of (json.datas || [])) {
      out[d.itemCode] = Number(String(d.closePrice).replace(/,/g, ''));
    }
    return out;
  } catch (_) {
    return {};
  }
}

// 계약이 원주 1:1인지 ADR 배수인지 오라클에서 역산한다.
// 하드코딩하면 배수가 바뀔 때 틀린 숫자를 그대로 내보내게 된다.
function detectScale(oracleUsd, krxKrw, rate) {
  if (!oracleUsd || !krxKrw || !rate) return null;
  const shareUsd = krxKrw / rate;
  const raw = oracleUsd / shareUsd;
  for (const candidate of [1, 0.1, 0.2, 0.5, 2, 10]) {
    if (Math.abs(raw / candidate - 1) < 0.25) return candidate;
  }
  return null;   // 알려진 배수와 안 맞음 → 교차검증 포기
}

async function loadDex(dex) {
  const [meta, ctxs] = await hlPost({ type: 'metaAndAssetCtxs', dex });
  const universe = (meta && meta.universe) || [];
  const rows = [];

  universe.forEach((asset, i) => {
    const ctx = ctxs && ctxs[i];
    if (!ctx) return;

    const full = String(asset.name);
    const bare = full.includes(':') ? full.split(':').pop() : full;
    const info = EQUITY[bare];
    if (!info) return;

    const mark = Number(ctx.markPx);
    const oracle = Number(ctx.oraclePx);
    if (!mark || !oracle) return;

    const basis = (mark / oracle - 1) * 100;

    rows.push({
      symbol: bare,
      label: info.label,
      market: info.market,
      krxCode: info.krxCode || null,
      dex,
      fullName: full,
      markPrice: mark,
      oraclePrice: oracle,
      basis,
      basisUsd: mark - oracle,
      direction: basis > 0.05 ? 'premium' : basis < -0.05 ? 'discount' : 'flat',
      fundingRate: ctx.funding != null ? Number(ctx.funding) * 100 : null,
      fundingAnnual: ctx.funding != null ? Number(ctx.funding) * 24 * 365 * 100 : null,
      openInterest: ctx.openInterest != null ? Number(ctx.openInterest) : null,
      volume24h: ctx.dayNtlVlm != null ? Number(ctx.dayNtlVlm) : null,
      maxLeverage: asset.maxLeverage ?? null,
      // 아래는 한국 종목에만 채워짐
      krxPrice: null,
      krxPriceUsd: null,
      contractScale: null,
      oracleDrift: null,
      oracleHealthy: null
    });
  });

  return rows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=90`
  );

  try {
    const dexes = await listBuilderDexes();
    const results = await Promise.all(dexes.map(d => loadDex(d).catch(() => [])));

    // 같은 심볼이 여러 빌더에 있으면 거래량 큰 쪽을 남긴다
    const best = new Map();
    for (const row of results.flat()) {
      const prev = best.get(row.symbol);
      if (!prev || (row.volume24h || 0) > (prev.volume24h || 0)) best.set(row.symbol, row);
    }
    const rows = [...best.values()];

    if (!rows.length) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ ok: false, error: '주식 퍼프 시세를 불러올 수 없습니다' });
    }

    // ── 한국 종목 오라클 건전성 검증 ─────────────────────────────────
    const krCodes = [...new Set(rows.filter(r => r.krxCode).map(r => r.krxCode))];
    const [rate, krx] = await Promise.all([fetchRate(), fetchKrx(krCodes)]);

    for (const row of rows) {
      if (!row.krxCode || !rate) continue;
      const krwPrice = krx[row.krxCode];
      if (!krwPrice) continue;

      const scale = detectScale(row.oraclePrice, krwPrice, rate);
      row.krxPrice = krwPrice;
      row.krxPriceUsd = krwPrice / rate;
      row.contractScale = scale;

      if (scale) {
        const referenceUsd = (krwPrice / rate) * scale;
        row.oracleDrift = (row.oraclePrice / referenceUsd - 1) * 100;
        row.oracleHealthy = Math.abs(row.oracleDrift) < ORACLE_WARN_PCT;
      }
    }

    rows.sort((a, b) => Math.abs(b.basis) - Math.abs(a.basis));

    const warnings = rows
      .filter(r => r.oracleHealthy === false)
      .map(r => ({
        symbol: r.symbol,
        label: r.label,
        drift: r.oracleDrift,
        message: `${r.label} 오라클이 실제 KRX 가격에서 ${r.oracleDrift.toFixed(1)}% 벗어나 있습니다`
      }));

    return res.status(200).json({
      ok: true,
      rows,
      korea: rows.filter(r => r.market === 'KR'),
      averageBasis: rows.reduce((s, r) => s + r.basis, 0) / rows.length,
      fxRate: rate,
      warnings,
      dexes,
      updatedAt: Date.now()
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: '주식 퍼프 시세를 불러올 수 없습니다' });
  }
}
