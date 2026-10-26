// functions/api/reports.js
// 제보 요약(report_summary) + 신고 목록(report_flags)을 엣지 캐시로 서빙.
// 목적: 방문마다 Supabase에서 직접 읽던 걸 "엣지·캐시주기당 1번"으로 줄여 Supabase egress 절감.
//  - 데이터는 공개(anon이 원래 읽던 것). 게이트(Sec-Fetch/Referer)로 외부 curl·핫링크만 차단.
//  - 캐시 주기(s-maxage) 동안 PoP당 1번만 Supabase를 읽음 → egress가 방문자 수에 비례하지 않게 됨.
//  - 앱은 force(제보·신고 직후)일 때 이 엔드포인트를 건너뛰고 Supabase 직통으로 읽어 본인 변경을 즉시 봄.

// 공개값(클라이언트 index.html에 이미 노출돼 있는 것과 동일) — 서버 env 설정 불필요.
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
  if (sec === 'cross-site') return false;   // 다른 도메인 핫링크 차단
  if (sec) return true;                      // 우리 페이지 fetch(same-origin/site) 또는 주소창(none)
  return refererMatches(request);            // 헤더 없는 봇 → Referer가 우리 사이트일 때만
}

async function sbSelect(path) {
  // PostgREST REST 조회 (anon 키). Range로 전체 행 확보(기본 상한 회피).
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

export async function onRequestGet(context) {
  const { request } = context;

  if (!isAllowed(request)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // ---- 엣지 캐시 ----
  const u = new URL(request.url);
  const cacheKey = new Request(u.origin + u.pathname, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let summary, flags;
  try {
    [summary, flags] = await Promise.all([
      sbSelect('report_summary?select=*'),
      sbSelect('report_flags?select=spid,nick,created_at'),
    ]);
  } catch (e) {
    // Supabase 실패 → 앱이 직통 폴백하도록 502 (캐시 안 함)
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const out = new Response(JSON.stringify({ summary: summary || [], flags: flags || [] }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 브라우저 60초 / 엣지(공유) 180초 — 기존 localStorage 3분 캐시와 유사한 신선도.
      'Cache-Control': 'public, max-age=60, s-maxage=180',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
  if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
  else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
  return out;
}
