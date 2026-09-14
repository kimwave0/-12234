/* =====================================================================
   /api/chat.js  —  Upstash Redis 기반 채팅 (엣지 캐시 적용)

   핵심: GET 응답을 Vercel CDN에 3초간 캐시한다.
   동시 접속 100명이 1초마다 폴링해도 실제 함수 실행은 3초에 한 번뿐이라
   Redis 커맨드가 접속자 수에 비례하지 않고 시간에만 비례한다.

   캐시 전:  100명 × 60회/분              = 6,000 커맨드/분
   캐시 후:  3초에 1회                    =    20 커맨드/분
   ===================================================================== */

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ROOM_KEY = 'kimprism:chat:main';
const MAX_MESSAGES = 100;      // 보관할 최근 메시지 수
const MAX_TEXT = 300;          // 한 메시지 최대 길이
const MAX_NICK = 20;
const CACHE_SECONDS = 3;       // 읽기 캐시 유지 시간

// ── Upstash REST 호출 (파이프라인으로 여러 명령을 1회 왕복에 처리) ────
async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Upstash 환경변수가 설정되지 않았습니다');
  }
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!res.ok) {
    throw new Error(`Redis ${res.status}`);
  }
  const json = await res.json();
  return json.map(r => (r && 'result' in r ? r.result : null));
}

function sanitize(str, max) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u001f\u007f]/g, '')   // 제어문자 제거
    .replace(/<[^>]*>/g, '')                 // 태그 제거
    .trim()
    .slice(0, max);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── 읽기 ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // 이 헤더가 비용 절감의 전부다.
    // s-maxage: CDN이 3초간 원본 호출 없이 응답
    // stale-while-revalidate: 만료 후에도 30초간은 옛 응답을 주면서 백그라운드 갱신
    res.setHeader(
      'Cache-Control',
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=30`
    );

    try {
      const [raw] = await redis([['LRANGE', ROOM_KEY, '0', String(MAX_MESSAGES - 1)]]);
      const messages = (raw || [])
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .reverse();   // 오래된 것부터

      // 클라이언트가 ?since=<ts> 로 물으면 새 메시지만 돌려준다
      const since = Number(req.query.since || 0);
      const fresh = since ? messages.filter(m => m.ts > since) : messages;

      return res.status(200).json({
        ok: true,
        messages: fresh,
        latest: messages.length ? messages[messages.length - 1].ts : 0,
        count: messages.length
      });
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ ok: false, error: '채팅 서버에 연결할 수 없습니다' });
    }
  }

  // ── 쓰기 ───────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const text = sanitize(body && body.text, MAX_TEXT);
    const nick = sanitize(body && body.nick, MAX_NICK) || '익명';
    const badge = sanitize(body && body.badge, 12);

    if (!text) {
      return res.status(400).json({ ok: false, error: '메시지를 입력하세요' });
    }

    const message = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      nick,
      badge,
      text,
      ts: Date.now()
    };

    try {
      // LPUSH + LTRIM 을 한 번의 왕복으로. 커맨드 2개.
      await redis([
        ['LPUSH', ROOM_KEY, JSON.stringify(message)],
        ['LTRIM', ROOM_KEY, '0', String(MAX_MESSAGES - 1)]
      ]);
      return res.status(200).json({ ok: true, message });
    } catch (err) {
      return res.status(503).json({ ok: false, error: '전송에 실패했습니다' });
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(405).json({ ok: false, error: '지원하지 않는 요청입니다' });
}
