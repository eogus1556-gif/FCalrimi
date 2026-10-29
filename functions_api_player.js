// functions/api/player.js
// 선수 상세 1건에 필요한 Supabase 조회 4건을 엣지 캐시 1건으로 묶어 서빙.
//   reports(.eq spid) + report_content_flags(.in ids) + comment_likes(report/report_dis, .in ids)
// 목적: 선수 상세 '열람 수'에 비례하던 Supabase egress를 "엣지·캐시주기당 1번"으로 고정.
//  - 전부 공개 데이터(anon 이 원래 읽던 것). 게이트(Sec-Fetch/Referer)로 외부 curl·핫링크만 차단.
//  - '내가 신고/추천했는지'는 응답에 담긴 voter·user_id 를 클라가 자기 id 와 대조해 판정한다
//    (기존에도 클라가 같은 행들을 그대로 받아 보고 있었으므로 공개 범위는 동일).
//  - 앱은 제보·신고·추천 직후엔 이 엔드포인트를 건너뛰고 Supabase 직통으로 읽어 본인 변경을 즉시 본다.

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
  const spid = (u.searchParams.get('spid') || '').trim();
  if (!/^\d{1,12}$/.test(spid)) return json({ error: 'bad spid' }, 400, 'no-store');

  // 엣지 캐시 — spid 별로 따로 잡힌다
  const cacheKey = new Request(u.origin + u.pathname + '?spid=' + spid, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let reports = [];
  try {
    // 컬럼 구성이 환경마다 조금 달라서 index.html 과 같은 순서로 폴백한다
    try {
      reports = await sbSelect(
        'reports?select=id,spid,hj,min,nick,created_at,source,author&spid=eq.' + spid);
    } catch (_) {
      reports = await sbSelect(
        'reports?select=id,spid,hj,min,nick,created_at,author&spid=eq.' + spid);
    }
  } catch (e) {
    return json({ error: 'unavailable' }, 502, 'no-store');   // 앱이 Supabase 직통 폴백
  }

  const ids = (reports || []).map(r => r.id).filter(v => v != null);
  let flags = [], likes = [];
  if (ids.length) {
    const inList = '(' + ids.join(',') + ')';
    try {
      [flags, likes] = await Promise.all([
        sbSelect('report_content_flags?select=report_id,voter&report_id=in.' + inList),
        sbSelect('comment_likes?select=ref_type,comment_id,user_id' +
                 '&ref_type=in.(report,report_dis)&comment_id=in.' + inList),
      ]);
    } catch (_) {
      // 부가 테이블이 없거나 실패해도 제보 목록은 내보낸다 (앱이 빈 값으로 처리)
      flags = flags || []; likes = likes || [];
    }
  }

  const out = json({
    spid: Number(spid),
    reports: reports || [],
    flags: flags || [],
    likes: likes || [],
  }, 200, 'public, max-age=60, s-maxage=180');

  if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
  else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
  return out;
}