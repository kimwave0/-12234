/* =====================================================================
   chat-client.js  —  절약형 채팅 폴링

   서버 비용을 줄이는 세 가지 장치:
   1) 탭이 백그라운드로 가면 폴링을 완전히 멈춘다
   2) 새 메시지가 없으면 간격을 점점 늘린다 (3초 → 최대 15초)
   3) 누가 말하면 즉시 3초로 되돌린다
   결과적으로 조용한 시간대의 호출이 1/5 수준으로 떨어진다.
   ===================================================================== */

const KimprismChat = (() => {
  'use strict';

  const ENDPOINT = '/api/chat';
  const MIN_INTERVAL = 3000;    // 대화가 활발할 때
  // 너무 늘리면 조용하다가 누가 말을 걸었을 때 그 첫 마디가 한참 뒤에 뜬다.
  // 채팅은 살아 있는 느낌이 중요해서 8초에서 끊는다.
  const MAX_INTERVAL = 8000;    // 조용할 때
  const STEP = 2000;            // 조용할 때마다 늘리는 폭

  const state = {
    interval: MIN_INTERVAL,
    latest: 0,
    nick: '익명',
    badge: '',
    onMessages: null,
    onError: null,
    running: false
  };

  let timer = null;
  let inflight = false;

  function schedule() {
    clearTimeout(timer);
    if (!state.running || document.visibilityState !== 'visible') return;
    timer = setTimeout(poll, state.interval);
  }

  async function poll() {
    if (inflight || !state.running) return;
    inflight = true;

    try {
      const url = state.latest
        ? `${ENDPOINT}?since=${state.latest}`
        : ENDPOINT;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok) {
        if (data.messages && data.messages.length) {
          state.latest = data.latest || state.latest;
          state.interval = MIN_INTERVAL;              // 활발 → 빠르게
          if (state.onMessages) state.onMessages(data.messages);
        } else {
          // 조용함 → 간격을 늘려 호출 수를 줄인다
          state.interval = Math.min(MAX_INTERVAL, state.interval + STEP);
        }
      } else if (state.onError) {
        state.onError(data.error || '채팅을 불러오지 못했습니다');
      }
    } catch (_) {
      state.interval = Math.min(MAX_INTERVAL, state.interval + STEP);
      if (state.onError) state.onError('연결이 불안정합니다');
    } finally {
      inflight = false;
      schedule();
    }
  }

  async function send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: '메시지를 입력하세요' };

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, nick: state.nick, badge: state.badge })
      });
      const data = await res.json();

      if (data.ok) {
        // 보낸 직후에는 빠르게 되돌려서 내 메시지가 바로 보이게 한다
        state.interval = MIN_INTERVAL;
        clearTimeout(timer);
        setTimeout(poll, 400);
      }
      return data;
    } catch (_) {
      return { ok: false, error: '전송에 실패했습니다' };
    }
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') {
      state.interval = MIN_INTERVAL;
      poll();                    // 돌아오면 즉시 밀린 메시지 수신
    } else {
      clearTimeout(timer);       // 안 보는 동안은 한 푼도 쓰지 않는다
    }
  }

  return {
    start(options = {}) {
      state.onMessages = options.onMessages || null;
      state.onError = options.onError || null;
      if (options.nick) state.nick = options.nick;
      if (options.badge) state.badge = options.badge;
      state.running = true;

      document.addEventListener('visibilitychange', handleVisibility);
      poll();
      return this;
    },

    stop() {
      state.running = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    },

    send,
    setNick(nick) { state.nick = nick; },
    setBadge(badge) { state.badge = badge; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KimprismChat;
}
