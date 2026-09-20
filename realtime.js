/* =====================================================================
   Kimprism Realtime Engine
   Browser ─┬─ Upbit  Public WebSocket  (KRW 현물 티커)
            └─ Binance Public WebSocket (USDT 무기한/현물 티커)
                     ↓
            브라우저에서 직접 계산
            · 김프(프리미엄 %)   · 스프레드(원 단위 차이)
            · 환율 환산          · 등락률
            · 차익(100만원 기준 기대 차익)

   서버(api/prices.js) 호출 없음. 환율만 외부 API에서 주기적으로 갱신.
   ===================================================================== */

const KimprismRealtime = (() => {
  'use strict';

  // ── 추적할 코인. upbit는 KRW-XXX, binance는 XXXUSDT 로 자동 생성 ──────
  const DEFAULT_SYMBOLS = [
    'BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'ADA', 'AVAX', 'LINK',
    'DOT', 'TRX', 'MATIC', 'SHIB', 'UNI', 'ATOM', 'ETC', 'BCH',
    'NEAR', 'APT', 'ARB', 'SAND', 'SUI', 'STX'
  ];

  const UPBIT_WS = 'wss://api.upbit.com/websocket/v1';
  // data-stream.binance.vision 은 바이낸스가 제공하는 공개 마켓데이터 전용
  // 엔드포인트. 본 도메인이 지역 차단될 때를 대비한 1순위 선택.
  const BINANCE_HOSTS = [
    'wss://data-stream.binance.vision/stream',
    'wss://stream.binance.com:9443/stream'
  ];

  // 환율 소스. 앞에서부터 시도하고 실패하면 다음으로 넘어감.
  const FX_SOURCES = [
    {
      name: 'dunamu',
      url: 'https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD',
      parse: (j) => Array.isArray(j) && j[0] && Number(j[0].basePrice)
    },
    {
      name: 'er-api',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (j) => j && j.rates && Number(j.rates.KRW)
    },
    {
      name: 'frankfurter',
      url: 'https://api.frankfurter.app/latest?from=USD&to=KRW',
      parse: (j) => j && j.rates && Number(j.rates.KRW)
    }
  ];

  const FX_REFRESH_MS = 5 * 60 * 1000;   // 환율 5분마다 갱신 (원달러는 급변하지 않음)
  const UPBIT_PING_MS = 50 * 1000;       // 업비트는 120초 무응답 시 끊음
  const EMIT_THROTTLE_MS = 250;          // 렌더 폭주 방지

  // ── 내부 상태 ────────────────────────────────────────────────────────
  const state = {
    symbols: DEFAULT_SYMBOLS.slice(),
    // 1달러에 고정된 종목(USDT 등). 바이낸스에 USDTUSDT 스트림이 없으므로
    // 구독에서 빼고, 해외가를 1달러로 두고 계산한다.
    pegged: new Set(),
    upbit: new Map(),    // SYMBOL -> { price, changeRate, volume, ts }
    binance: new Map(),  // SYMBOL -> { price, changeRate, ts }
    fx: { rate: null, source: null, ts: 0 },
    status: { upbit: 'idle', binance: 'idle', fx: 'idle' },
    onUpdate: null,
    onStatus: null
  };

  let upbitWs = null;
  let binanceWs = null;
  let upbitPingTimer = null;
  let fxTimer = null;
  let emitTimer = null;
  let upbitRetry = 0;
  let binanceRetry = 0;
  let binanceHostIndex = 0;
  let stopped = false;

  // ── 유틸 ─────────────────────────────────────────────────────────────
  const backoff = (n) => Math.min(30000, 1000 * Math.pow(2, n)) + Math.random() * 500;

  function setStatus(key, value) {
    if (state.status[key] === value) return;
    state.status[key] = value;
    if (state.onStatus) state.onStatus({ ...state.status }, { ...state.fx });
  }

  function scheduleEmit() {
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      if (state.onUpdate) state.onUpdate(compute());
    }, EMIT_THROTTLE_MS);
  }

  // ── 계산부: 여기가 핵심 ──────────────────────────────────────────────
  function compute() {
    const rate = state.fx.rate;
    const rows = [];

    for (const sym of state.symbols) {
      const u = state.upbit.get(sym);
      // 1달러 고정 종목은 해외가를 1달러로 본다 → 김프가 곧 환율 대비 괴리
      const b = state.pegged.has(sym)
        ? { price: 1, changeRate: null, ts: Date.now() }
        : state.binance.get(sym);

      const row = {
        symbol: sym,
        pegged: state.pegged.has(sym),
        upbitPrice: u ? u.price : null,              // 원
        upbitChangeRate: u ? u.changeRate : null,    // %
        upbitVolume24h: u ? u.volume : null,         // 원
        binanceUsd: b ? b.price : null,              // USDT
        binanceChangeRate: b ? b.changeRate : null,  // %
        binanceKrw: null,                            // 환율 환산 원화
        premium: null,                               // 김프 %
        spread: null,                                // 원 단위 차이
        arbitragePerMillion: null,                   // 100만원당 기대 차익(원)
        direction: null,                             // 'kimp' | 'reverse' | 'flat'
        stale: !u || !b || !rate
      };

      if (u && b && rate) {
        // 환율 환산: 바이낸스 USDT 가격 → 원화
        row.binanceKrw = b.price * rate;

        // 김프: 업비트가가 환산가보다 얼마나 비싼가
        row.premium = (u.price / row.binanceKrw - 1) * 100;

        // 스프레드: 1개당 절대 가격차
        row.spread = u.price - row.binanceKrw;

        // 차익: 100만원 투입 시 이론적 가격차 (수수료·출금비 제외)
        row.arbitragePerMillion = 1_000_000 * (row.premium / 100);

        row.direction =
          row.premium > 0.05 ? 'kimp' :
          row.premium < -0.05 ? 'reverse' : 'flat';
      }

      rows.push(row);
    }

    // 김프 높은 순으로 정렬하되, 데이터 없는 행은 뒤로
    rows.sort((a, b) => {
      if (a.premium === null && b.premium === null) return 0;
      if (a.premium === null) return 1;
      if (b.premium === null) return -1;
      return b.premium - a.premium;
    });

    const valid = rows.filter(r => r.premium !== null);
    const avg = valid.length
      ? valid.reduce((s, r) => s + r.premium, 0) / valid.length
      : null;

    return {
      rows,
      fx: { ...state.fx },
      averagePremium: avg,
      status: { ...state.status },
      updatedAt: Date.now()
    };
  }

  // ── 환율 ─────────────────────────────────────────────────────────────
  async function fetchFx() {
    for (const src of FX_SOURCES) {
      try {
        const res = await fetch(src.url, { cache: 'no-store' });
        if (!res.ok) continue;
        const json = await res.json();
        const rate = src.parse(json);
        if (rate && rate > 500 && rate < 3000) {   // 상식적 범위 검증
          state.fx = { rate, source: src.name, ts: Date.now() };
          setStatus('fx', 'live');
          scheduleEmit();
          return;
        }
      } catch (_) {
        // 다음 소스로
      }
    }
    setStatus('fx', state.fx.rate ? 'stale' : 'error');
  }

  // ── 업비트 웹소켓 ────────────────────────────────────────────────────
  function connectUpbit() {
    if (stopped) return;
    setStatus('upbit', 'connecting');

    const ws = new WebSocket(UPBIT_WS);
    ws.binaryType = 'arraybuffer';   // 업비트는 바이너리 프레임으로 보냄
    upbitWs = ws;

    ws.onopen = () => {
      upbitRetry = 0;
      setStatus('upbit', 'live');

      const codes = state.symbols.map(s => `KRW-${s}`);
      ws.send(JSON.stringify([
        { ticket: `kimprism-${Date.now()}` },
        { type: 'ticker', codes, isOnlyRealtime: false },
        { format: 'DEFAULT' }
      ]));

      clearInterval(upbitPingTimer);
      upbitPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, UPBIT_PING_MS);
    };

    ws.onmessage = (event) => {
      let text;
      if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder('utf-8').decode(new Uint8Array(event.data));
      } else if (typeof event.data === 'string') {
        text = event.data;
      } else {
        return;
      }

      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.status === 'UP') return;        // PONG 응답
      if (msg.type !== 'ticker' || !msg.code) return;

      const sym = msg.code.replace('KRW-', '');
      state.upbit.set(sym, {
        price: Number(msg.trade_price),
        changeRate: Number(msg.signed_change_rate) * 100,
        volume: Number(msg.acc_trade_price_24h),
        ts: Number(msg.timestamp) || Date.now()
      });
      scheduleEmit();
    };

    ws.onclose = () => {
      clearInterval(upbitPingTimer);
      if (stopped) return;
      setStatus('upbit', 'reconnecting');
      setTimeout(connectUpbit, backoff(upbitRetry++));
    };

    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  // ── 바이낸스 웹소켓 ──────────────────────────────────────────────────
  function connectBinance() {
    if (stopped) return;
    setStatus('binance', 'connecting');

    const tradable = state.symbols.filter(s => !state.pegged.has(s));
    if (!tradable.length) { setStatus('binance', 'idle'); return; }

    const streams = tradable
      .map(s => `${s.toLowerCase()}usdt@ticker`)
      .join('/');
    const host = BINANCE_HOSTS[binanceHostIndex % BINANCE_HOSTS.length];
    const ws = new WebSocket(`${host}?streams=${streams}`);
    binanceWs = ws;

    let gotData = false;

    ws.onopen = () => {
      binanceRetry = 0;
      setStatus('binance', 'live');
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const d = msg.data || msg;
      if (!d || !d.s || d.e !== '24hrTicker') return;

      gotData = true;
      const sym = d.s.replace(/USDT$/, '');
      state.binance.set(sym, {
        price: Number(d.c),            // 최종 체결가
        changeRate: Number(d.P),       // 24h 등락률 %
        ts: Number(d.E) || Date.now()
      });
      scheduleEmit();
    };

    ws.onclose = () => {
      if (stopped) return;
      // 한 번도 데이터를 못 받았으면 다른 호스트로 교체 시도
      if (!gotData) binanceHostIndex++;
      setStatus('binance', 'reconnecting');
      setTimeout(connectBinance, backoff(binanceRetry++));
    };

    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  // ── 탭 절전 대응: 백그라운드 복귀 시 끊긴 소켓 즉시 복구 ──────────────
  function handleVisibility() {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (!upbitWs || upbitWs.readyState > WebSocket.OPEN) connectUpbit();
    if (!binanceWs || binanceWs.readyState > WebSocket.OPEN) connectBinance();
    if (Date.now() - state.fx.ts > FX_REFRESH_MS) fetchFx();
  }

  // ── 공개 API ─────────────────────────────────────────────────────────
  function init(options = {}) {
    stopped = false;
    if (Array.isArray(options.symbols) && options.symbols.length) {
      state.symbols = options.symbols.map(s => s.toUpperCase());
    }
    if (Array.isArray(options.pegged)) {
      state.pegged = new Set(options.pegged.map(s => s.toUpperCase()));
    }
    state.onUpdate = options.onUpdate || null;
    state.onStatus = options.onStatus || null;

    fetchFx();
    clearInterval(fxTimer);
    fxTimer = setInterval(fetchFx, FX_REFRESH_MS);

    connectUpbit();
    connectBinance();

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleVisibility);

    return api;
  }

  function stop() {
    stopped = true;
    clearInterval(fxTimer);
    clearInterval(upbitPingTimer);
    clearTimeout(emitTimer);
    emitTimer = null;
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('online', handleVisibility);
    try { upbitWs && upbitWs.close(); } catch (_) {}
    try { binanceWs && binanceWs.close(); } catch (_) {}
    setStatus('upbit', 'idle');
    setStatus('binance', 'idle');
  }

  const api = {
    init,
    stop,
    snapshot: compute,
    getRate: () => state.fx.rate,
    setSymbols(list) {
      state.symbols = list.map(s => s.toUpperCase());
      try { upbitWs && upbitWs.close(); } catch (_) {}
      try { binanceWs && binanceWs.close(); } catch (_) {}
    }
  };

  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KimprismRealtime;
}
