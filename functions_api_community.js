// functions/api/community.js
// 공개 커뮤니티 읽기 전용 엣지 캐시.
// 쓰기·개인정보·관리자 데이터는 다루지 않고, 실패 시 클라이언트가 기존 Supabase 조회로 폴백한다.

const SUPABASE_URL = 'https://gqkkuuvsraimgpctyohy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-iFLiXQ_y4VVKtbeWliMRA_8-XDNErM';
const ALLOW_HOSTS = ['fcalrimi.com', 'www.fcalrimi.com', 'fcalrimi.pages.dev'];

const LIST_COLS = 'id,author,nick,category,title,views,likes,liked_by,created_at,edited_at,pinned';
const LIST_COLS_OLD = 'id,author,nick,category,title,views,likes,liked_by,created_at,edited_at';
const POST_COLS = LIST_COLS + ',body,image,images,poll,file_url,file_name';
const POST_COLS_OLD = LIST_COLS_OLD + ',body,image,images,poll,file_url,file_name';

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

async function sbSelect(table, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + qs, {
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

async function selectPosts(params) {
  try {
    return await sbSelect('free_posts', { ...params, select: LIST_COLS });
  } catch (_) {
    return await sbSelect('free_posts', { ...params, select: LIST_COLS_OLD });
  }
}

async function selectPost(id) {
  try {
    return await sbSelect('free_posts', { select: POST_COLS, id: 'eq.' + id, limit: '1' });
  } catch (_) {
    return await sbSelect('free_posts', { select: POST_COLS_OLD, id: 'eq.' + id, limit: '1' });
  }
}

async function commentCounts(postIds) {
  const ids = [...new Set((postIds || []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return {};
  const inFilter = 'in.(' + ids.join(',') + ')';
  const out = {};
  try {
    const rows = await sbSelect('post_comment_counts', {
      select: 'post_id,cnt', post_id: inFilter,
    });
    for (const r of (rows || [])) out[r.post_id] = Number(r.cnt) || 0;
    return out;
  } catch (_) {
    try {
      const rows = await sbSelect('post_comments', { select: 'post_id', post_id: inFilter });
      for (const r of (rows || [])) out[r.post_id] = (out[r.post_id] || 0) + 1;
    } catch (_) {}
    return out;
  }
}

export async function onRequestGet(context) {
  const { request } = context;
  if (!isAllowed(request)) return json({ error: 'forbidden' }, 403, 'no-store');

  const u = new URL(request.url);
  const mode = (u.searchParams.get('mode') || 'list').trim();
  const safe = new URLSearchParams({ mode });
  let id = '', field = '', q = '', before = '';

  if (mode === 'post') {
    id = (u.searchParams.get('id') || '').trim();
    if (!/^\d{1,18}$/.test(id)) return json({ error: 'bad id' }, 400, 'no-store');
    safe.set('id', id);
  } else if (mode === 'search') {
    field = u.searchParams.get('field') === 'nick' ? 'nick' : 'title';
    q = (u.searchParams.get('q') || '').trim().slice(0, 60);
    safe.set('field', field); safe.set('q', q);
  } else if (mode === 'list') {
    before = (u.searchParams.get('before') || '').trim();
    if (before && Number.isNaN(Date.parse(before))) return json({ error: 'bad cursor' }, 400, 'no-store');
    if (before) safe.set('before', before);
  } else {
    return json({ error: 'bad mode' }, 400, 'no-store');
  }

  // Supabase를 호출하기 전에 캐시부터 확인해야 실제 egress가 줄어든다.
  const cacheKey = new Request(u.origin + u.pathname + '?' + safe.toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let payload;

  try {
    if (mode === 'post') {
      const rows = await selectPost(id);
      payload = { post: (rows && rows[0]) || null };
    } else if (mode === 'search') {
      if (!q) return json({ rows: [] }, 200, 'public, max-age=10, s-maxage=60');
      const rows = await selectPosts({
        [field]: 'ilike.%' + q.replace(/[,%*()]/g, ' ') + '%',
        order: 'created_at.desc', limit: '200',
      });
      payload = { rows: rows || [] };
    } else {
      const params = { order: 'created_at.desc', limit: '10' };
      if (before) params.created_at = 'lt.' + before;
      const rows = await selectPosts(params);

      let pinned = [];
      if (!before) {
        try {
          pinned = await selectPosts({
            or: '(pinned.eq.true,category.eq.공지사항)', order: 'created_at.desc',
          });
        } catch (_) {
          pinned = await selectPosts({ category: 'eq.공지사항', order: 'created_at.desc' });
        }
      }
      const ids = [...(rows || []), ...(pinned || [])].map(r => r.id);
      payload = { rows: rows || [], pinned: pinned || [], counts: await commentCounts(ids) };
    }
  } catch (_) {
    return json({ error: 'unavailable' }, 502, 'no-store');
  }

  const out = json(payload, 200, 'public, max-age=10, s-maxage=60');
  if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
  else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
  return out;
}
