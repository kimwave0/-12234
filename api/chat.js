// /api/chat.js
// 김프리즘 커뮤니티 채팅 저장소
//
// Upstash Redis 환경변수가 설정되어 있으면 영구 저장,
// 없으면 함수 메모리에 임시 저장한다(서버가 잠들면 초기화됨).
//
// 영구 저장을 켜려면 Vercel 프로젝트 설정 > Environment Variables 에
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// 두 개를 추가하면 된다.

const KEY = 'kimprism:chat';
const MAX = 120;

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = Boolean(URL_BASE && TOKEN);

// 메모리 폴백 (인스턴스 단위)
let memory = [];

async function redis(command) {
  const r = await fetch(`${URL_BASE}/${command.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`redis HTTP ${r.status}`);
  const d = await r.json();
  return d.result;
}

async function readAll() {
  if (!hasRedis) return memory;
  const rows = await redis(['lrange', KEY, '0', String(MAX - 1)]);
  return (rows || []).map((s) => JSON.parse(s)).reverse();
}

async function push(msg) {
  if (!hasRedis) {
    memory.push(msg);
    if (memory.length > MAX) memory = memory.slice(-MAX);
    return;
  }
  await redis(['lpush', KEY, JSON.stringify(msg)]);
  await redis(['ltrim', KEY, '0', String(MAX - 1)]);
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const messages = await readAll();
      return res.status(200).json({ ok: true, persistent: hasRedis, messages });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const text = clean(body.text, 300);
      if (!text) return res.status(400).json({ ok: false, error: '내용을 입력해 주세요.' });

      const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        nick: clean(body.nick, 16) || '익명',
        badge: clean(body.badge, 12),
        text,
        ts: Date.now(),
      };
      await push(msg);
      return res.status(200).json({ ok: true, persistent: hasRedis, message: msg });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'GET 또는 POST만 지원합니다.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
