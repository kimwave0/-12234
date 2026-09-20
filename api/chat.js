/* =====================================================================
   /api/chat.js  —  Upstash Redis 기반 채팅 (엣지 캐시 + 도배·스캠 방어)

   읽기: GET 응답을 Vercel CDN에 3초간 캐시한다.
   동시 접속 100명이 1초마다 폴링해도 실제 함수 실행은 3초에 한 번뿐이라
   Redis 커맨드가 접속자 수가 아니라 시간에만 비례한다.

   쓰기: 모든 검사를 서버에서 한다. 클라이언트 검사는 개발자도구로
   우회되므로 방어로 치지 않는다.
     · 속도 제한   10초 5개 / 60초 20개
     · 연속 도배   직전과 같은 내용 반복 차단
     · 스캠 필터   링크·지갑주소·메신저 아이디 차단
     · 자동 차단   5분 내 위반 5회 → 30분 쓰기 금지
     · 닉 보호     관리자·운영자·알림봇 등 사칭 차단
     · 고유 태그   IP 해시 4자리를 닉 옆에 붙여 사칭을 구분 가능하게
   ===================================================================== */

import crypto from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ROOM_KEY = 'kimprism:chat:main';
const MAX_MESSAGES = 100;      // 보관할 최근 메시지 수
const MAX_TEXT = 300;          // 한 메시지 최대 길이
const MAX_NICK = 20;
const CACHE_SECONDS = 3;       // 읽기 캐시 유지 시간

// ── 속도 제한 기준 ───────────────────────────────────────────────────
const BURST_WINDOW = 10;       // 초
const BURST_LIMIT = 5;         // 그 안에 허용할 메시지 수
const SUSTAIN_WINDOW = 60;     // 초
const SUSTAIN_LIMIT = 20;
const VIOLATION_WINDOW = 300;  // 위반 누적 관찰 구간(초)
const VIOLATION_LIMIT = 5;     // 이만큼 쌓이면 자동 차단
const BAN_SECONDS = 1800;      // 자동 차단 30분

// ── 사칭 차단 닉네임 ─────────────────────────────────────────────────
// 공백·특수문자를 걷어낸 뒤 비교하므로 "관 리 자", "관_리_자"도 걸린다.
const RESERVED_NICKS = [
  '관리자', '관리', '운영자', '운영', '운영진', '운영팀', '매니저',
  '어드민', 'admin', 'administrator', '시스템', 'system',
  '공지', '공지사항', '알림', '알림봇', '시세알림봇', '고래알림봇',
  '김프리즘', 'kimprism', '고객센터', '고객지원', 'bot', '봇',
];

// ── 스캠 패턴 ────────────────────────────────────────────────────────
const SCAM_PATTERNS = [
  // 링크 (프로토콜 있든 없든)
  { re: /https?:\/\//i,                          reason: '링크는 보낼 수 없습니다' },
  { re: /\bwww\./i,                              reason: '링크는 보낼 수 없습니다' },
  { re: /\b[a-z0-9][a-z0-9-]{1,30}\s*\.\s*(com|net|org|io|kr|me|xyz|top|link|vip|cc|tv|shop|site|online|app|co|biz|info|club|live|win|bet)\b/i,
    reason: '링크는 보낼 수 없습니다' },
  // 지갑 주소 — 이더리움 / 비트코인 / 트론
  { re: /0x[a-fA-F0-9]{40}/,                     reason: '지갑 주소는 보낼 수 없습니다' },
  { re: /\b(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
    reason: '지갑 주소는 보낼 수 없습니다' },
  { re: /\bT[A-Za-z1-9]{33}\b/,                  reason: '지갑 주소는 보낼 수 없습니다' },
  // 메신저 아이디 유인 (리딩방·사칭 상담의 주된 경로)
  { re: /@[A-Za-z0-9_]{5,}/,                     reason: '메신저 아이디는 보낼 수 없습니다' },
  { re: /(텔레그램|텔레|telegram|카톡|카카오톡|오픈채팅|오픈카톡)\s*[:：]?\s*[A-Za-z0-9_@.-]{4,}/i,
    reason: '메신저 아이디는 보낼 수 없습니다' },
  // 같은 글자 도배
  { re: /(.)\1{15,}/,                            reason: '같은 글자를 너무 많이 반복했습니다' },
];

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

// ── 접속자 식별 ──────────────────────────────────────────────────────
// 원본 IP는 저장하지 않는다. 날마다 바뀌는 소금을 섞어 해시만 쓴다.
function clientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.CHAT_SALT || REDIS_TOKEN || 'kimprism';
  return crypto.createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex');
}

// 닉 옆에 붙는 4자리 표식. 같은 사람은 하루 동안 같은 값이 나오므로
// 남의 닉을 베껴도 표식이 달라 사칭이 드러난다.
const tagOf = (key) => key.slice(0, 4).toUpperCase();

// 공백·특수문자를 걷어내고 소문자로 — 예약 닉 우회 방지
const normalize = (s) => s.toLowerCase().replace(/[\s\-_.*~`'"|/\\]/g, '');

function checkNick(nick) {
  const n = normalize(nick);
  if (!n) return null;
  for (const reserved of RESERVED_NICKS) {
    if (n === normalize(reserved)) {
      return `"${nick}"는 쓸 수 없는 닉네임입니다`;
    }
  }
  return null;
}

function checkText(text) {
  for (const { re, reason } of SCAM_PATTERNS) {
    if (re.test(text)) return reason;
  }
  return null;
}

// 테스트용으로 내보낸다. Vercel은 default export만 핸들러로 쓴다.
export { checkText, checkNick, RESERVED_NICKS };

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

    const key = clientKey(req);
    const tag = tagOf(key);

    // ── 1. 내용 검사 (Redis 쓰기 전에 걸러 비용을 아낀다) ────────────
    const nickError = checkNick(nick);
    const textError = checkText(text);
    const contentError = nickError || textError;

    try {
      // ── 2. 차단 여부 · 속도 · 중복을 한 번의 왕복으로 확인 ─────────
      const [banned, burst, , sustain, , lastHash] = await redis([
        ['GET',    `kimprism:ban:${key}`],
        ['INCR',   `kimprism:rl:${key}`],
        ['EXPIRE', `kimprism:rl:${key}`, String(BURST_WINDOW)],
        ['INCR',   `kimprism:rlm:${key}`],
        ['EXPIRE', `kimprism:rlm:${key}`, String(SUSTAIN_WINDOW)],
        ['GET',    `kimprism:last:${key}`],
      ]);

      if (banned) {
        return res.status(429).json({
          ok: false,
          error: '도배로 판단되어 30분간 글쓰기가 막혔습니다',
        });
      }

      const textHash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

      let violation = null;
      if (contentError) {
        violation = contentError;
      } else if (Number(burst) > BURST_LIMIT) {
        violation = '너무 빠르게 보내고 있습니다. 잠시 후 다시 시도하세요';
      } else if (Number(sustain) > SUSTAIN_LIMIT) {
        violation = '1분 동안 보낼 수 있는 메시지 수를 넘었습니다';
      } else if (lastHash === textHash) {
        violation = '같은 내용을 연속으로 보낼 수 없습니다';
      }

      // ── 3. 위반이면 누적하고, 쌓이면 자동 차단 ─────────────────────
      if (violation) {
        const [count] = await redis([
          ['INCR',   `kimprism:vio:${key}`],
          ['EXPIRE', `kimprism:vio:${key}`, String(VIOLATION_WINDOW)],
        ]);

        if (Number(count) >= VIOLATION_LIMIT) {
          await redis([['SET', `kimprism:ban:${key}`, '1', 'EX', String(BAN_SECONDS)]]);
          return res.status(429).json({
            ok: false,
            error: '반복 위반으로 30분간 글쓰기가 막혔습니다',
          });
        }

        return res.status(429).json({ ok: false, error: violation });
      }

      // ── 4. 통과 — 저장 ─────────────────────────────────────────────
      const message = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        nick,
        badge,
        tag,          // 사칭 구분용 4자리
        text,
        ts: Date.now()
      };

      // LPUSH + LTRIM + 직전 메시지 기록을 한 번의 왕복으로
      await redis([
        ['LPUSH', ROOM_KEY, JSON.stringify(message)],
        ['LTRIM', ROOM_KEY, '0', String(MAX_MESSAGES - 1)],
        ['SET',   `kimprism:last:${key}`, textHash, 'EX', '60'],
      ]);

      return res.status(200).json({ ok: true, message });
    } catch (err) {
      return res.status(503).json({ ok: false, error: '전송에 실패했습니다' });
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(405).json({ ok: false, error: '지원하지 않는 요청입니다' });
}
