// functions/api/players.js
// 선수 데이터 보호 게이트 (Cloudflare Pages Function)
// - 우리 사이트(fcalrimi.com) 페이지에서 온 요청만 통과
// - 외부 스크래퍼/핫링크(curl·python·다른 도메인)는 차단
// - 실제 데이터 파일 이름은 브라우저에 절대 노출되지 않음(서버에서만 참조)
//
// 브라우저의 fetch()는 Sec-Fetch-Site 헤더를 자동으로 붙이며,
// 이 헤더는 페이지 자바스크립트가 위조할 수 없습니다(브라우저 전용).
// 따라서 정상 사용자는 항상 통과하고, 헤더 없는 봇은 걸러집니다.

// 실제 데이터가 담긴 정적 파일 이름(추측 불가). 이 문자열은 서버에만 존재합니다.
const DATA_FILE = '/pdb_v3f9k2a7.json';

// 우리 소유 호스트
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
  // 다른 도메인에서 우리 파일을 불러가는 브라우저 핫링크 → 차단
  if (sec === 'cross-site') return false;
  // 우리 페이지에서 온 정상 fetch (same-origin / same-site) 또는 주소창 직접 접근(none) → 허용
  if (sec) return true;
  // Sec-Fetch-Site가 아예 없는 요청(curl·python·node 등 봇) → Referer가 우리 사이트일 때만 허용
  return refererMatches(request);
}

export async function onRequestGet(context) {
  const { request } = context;

  if (!isAllowed(request)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const origin = new URL(request.url).origin;
  let res;
  try {
    res = await fetch(origin + DATA_FILE, { cf: { cacheEverything: true } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (!res || !res.ok) {
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}
