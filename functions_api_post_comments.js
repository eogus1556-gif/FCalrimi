// functions/api/post_comments.js
// 자유게시판 글 1개의 댓글 목록 + 추천/비추천을 엣지 캐시 1건으로 묶어 서빙.
//   post_comments(.eq post_id) + comment_likes(ref_type in (pcomment,pcomment_dis), comment_id in ids)
// 목적: 인기 글이 열릴 때마다 Supabase를 직접 치던 걸 "엣지·캐시주기당 1번"으로 고정.
//  - 전부 공개 데이터(anon이 원래 읽던 것). 게이트(Sec-Fetch/Referer)로 외부 curl·핫링크만 차단.
//  - '내가 추천/비추천했는지'는 응답의 user_id를 클라가 자기 id와 대조해 판정(공개 범위 동일).
//  - 앱은 본인이 댓글을 쓰거나 지운 직후엔 로컬 캐시로 즉시 반영한다(이 엔드포인트 60초 지연과 무관).

const SUPABASE_URL = 'https://gqkkuuvsraimgpctyohy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-iFLiXQ_y4VVKtbeWliMRA_8-XDNErM';

const ALLOW_HOSTS = ['fcalrimi.com', 'www.fcalrimi.com', 'fcalrimi.pages.dev'];

function refererMatches(request) {
  const ref = request.headers.get('Referer') || '';
  const org = request.headers.get('Origin') || '';
  return ALLOW_HOSTS.some(h =>
    ref.includes('//' + h) || ref.includes('.' + h) ||
    org.includes('//' + h) || org.includes('.' + h)
  );
}

function isAllowed(request) {
  const sec = request.headers.get('Sec-Fetch-Site') || '';
  if (sec === 'cross-site') return false;
  if (sec) return true;
  return refererMatches(request);
}

async function sbSelect(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json',
      Range: '0-99999',
    },
  });
  if (!res.ok) throw new Error('supabase ' + res.status);
  return await res.json();
}

const json = (obj, status, cc) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cc,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  },
});

export async function onRequestGet(context) {
  const { request } = context;
  if (!isAllowed(request)) return json({ error: 'forbidden' }, 403, 'no-store');

  const u = new URL(request.url);
  const pid = (u.searchParams.get('post_id') || '').trim();
  if (!/^\d{1,18}$/.test(pid)) return json({ error: 'bad post_id' }, 400, 'no-store');

  // 엣지 캐시 — post_id별로 따로 잡힌다
  const cacheKey = new Request(u.origin + u.pathname + '?post_id=' + pid, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let comments = [];
  try {
    try {
      comments = await sbSelect(
        'post_comments?select=id,author,nick,body,image,parent_id,created_at,edited_at' +
        '&post_id=eq.' + pid + '&order=created_at');
    } catch (_) {
      comments = await sbSelect(
        'post_comments?select=id,author,nick,body,created_at' +
        '&post_id=eq.' + pid + '&order=created_at');
    }
  } catch (e) {
    return json({ error: 'unavailable' }, 502, 'no-store');   // 앱이 Supabase 직통 폴백
  }

  const ids = (comments || []).map(c => c.id).filter(v => v != null);
  let likes = [];
  if (ids.length) {
    const inList = '(' + ids.join(',') + ')';
    try {
      likes = await sbSelect(
        'comment_likes?select=ref_type,comment_id,user_id' +
        '&ref_type=in.(pcomment,pcomment_dis)&comment_id=in.' + inList);
    } catch (_) {
      likes = [];
    }
  }

  const out = json({
    post_id: Number(pid),
    comments: comments || [],
    likes: likes || [],
  }, 200, 'public, max-age=30, s-maxage=60');

  if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
  else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
  return out;
}
