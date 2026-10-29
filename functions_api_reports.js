// functions/api/reports.js  (v2 — KV 스냅샷 우선 + 컬럼 트림 + 엣지 10분)
// 제보 요약(report_summary) + 신고 목록(report_flags)을 서빙하되, Supabase egress를 최소화한다.
//
//  읽기 우선순위
//   1) KV 스냅샷 'reports:snapshot'  ← Worker 크론이 ~10분마다 미리 만들어 둔 것 (Supabase 왕복 0)
//   2) 엣지 캐시(caches.default)      ← s-maxage 600 (PoP당 10분에 1번)
//   3) Supabase 직접 조회(트림된 컬럼) ← 위 둘 다 없을 때만. 조회 후 KV에도 적어 둔다(폴백 자립).
//
//  - 데이터는 공개(anon이 원래 읽던 것). 게이트(Sec-Fetch/Referer)로 외부 curl·핫링크만 차단.
//  - 앱은 force(제보·신고 직후)일 때 이 엔드포인트를 건너뛰고 Supabase 직통으로 읽어 본인 변경을 즉시 봄.
//
//  KV 바인딩: Pages 프로젝트 Settings → Functions → KV namespace bindings 에
//            변수명 REPORTS_KV (또는 PUSH_KV) 로 기존 네임스페이스를 연결하면 1)·폴백쓰기가 켜진다.
//            바인딩이 없어도 2)·3)으로 정상 동작한다(안전한 점진 적용).

const SUPABASE_URL = 'https://gqkkuuvsraimgpctyohy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-iFLiXQ_y4VVKtbeWliMRA_8-XDNErM';

const ALLOW_HOSTS = ['fcalrimi.com', 'www.fcalrimi.com', 'fcalrimi.pages.dev'];

// 클라이언트(index.html buildReportCachesFromSummary)가 실제로 쓰는 컬럼만.
const SUMMARY_COLS =
  'spid,best_hj,best_min,latest_nick,latest_at,cnt_total,agree,best_flags,cnt_join,cnt_report';

const KV_KEY = 'reports:snapshot';
const CC_KV   = 'public, max-age=120, s-maxage=600';   // KV 히트: 브라우저 2분 / 엣지 10분
const CC_LIVE = 'public, max-age=60,  s-maxage=600';    // 직접 조회: 브라우저 1분 / 엣지 10분

function kvOf(env) { return (env && (env.REPORTS_KV || env.PUSH_KV)) || null; }

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

const json = (body, status, cc) => new Response(body, {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cc,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  },
});

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!isAllowed(request)) return json(JSON.stringify({ error: 'forbidden' }), 403, 'no-store');

  const u = new URL(request.url);
  const cacheKey = new Request(u.origin + u.pathname, { method: 'GET' });
  const cache = caches.default;

  // 2) 엣지 캐시 먼저
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // 1) KV 스냅샷 (Worker가 미리 만들어 둔 것) — Supabase 왕복 0
  const kv = kvOf(env);
  if (kv) {
    try {
      const snap = await kv.get(KV_KEY);   // 문자열(이미 {summary,flags} JSON)
      if (snap) {
        const out = json(snap, 200, CC_KV);
        if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
        else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
        return out;
      }
    } catch (_) { /* KV 실패 → 아래 직접 조회 */ }
  }

  // 3) Supabase 직접 조회(트림된 컬럼)
  let summary, flags;
  try {
    [summary, flags] = await Promise.all([
      sbSelect('report_summary?select=' + SUMMARY_COLS),
      sbSelect('report_flags?select=spid,nick,created_at'),
    ]);
  } catch (e) {
    return json(JSON.stringify({ error: 'unavailable' }), 502, 'no-store');  // 앱이 직통 폴백
  }

  const payload = JSON.stringify({ summary: summary || [], flags: flags || [] });

  // 폴백 자립: 워커가 아직 KV를 안 채웠어도 다음 PoP/요청이 KV를 타도록 적어 둔다(10분 TTL).
  if (kv) {
    try {
      const put = kv.put(KV_KEY, payload, { expirationTtl: 900 });
      if (context.waitUntil) context.waitUntil(put); else await put;
    } catch (_) {}
  }

  const out = json(payload, 200, CC_LIVE);
  if (context.waitUntil) context.waitUntil(cache.put(cacheKey, out.clone()));
  else { try { await cache.put(cacheKey, out.clone()); } catch (_) {} }
  return out;
}
