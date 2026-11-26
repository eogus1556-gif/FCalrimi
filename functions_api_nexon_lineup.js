// Deploy as Cloudflare Pages Function: functions/api/nexon-lineup.js
// Set NEXON_API_KEY as a Pages secret. Never put the key in the browser.
const API = 'https://open.api.nexon.com';
const ALLOWED = new Set(['fcalrimi.com', 'www.fcalrimi.com', 'fcalrimi.pages.dev']);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function nexon(path, params, key) {
  const url = new URL(path, API);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetch(url, { headers: { 'x-nxopen-api-key': key } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Nexon API HTTP ${response.status}`);
  return response.json();
}

export async function onRequestGet({ request, env }) {
  const site = new URL(request.url);
  const referer = request.headers.get('referer');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site' || (!fetchSite && !referer)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  if (referer) {
    try { if (!ALLOWED.has(new URL(referer).hostname)) return json({ error: '허용되지 않은 요청입니다.' }, 403); }
    catch (_) { return json({ error: '허용되지 않은 요청입니다.' }, 403); }
  }
  const nickname = (site.searchParams.get('nickname') || '').trim();
  const mode = site.searchParams.get('mode') || 'official';
  if (!nickname || nickname.length > 16 || /[\u0000-\u001f]/.test(nickname)) return json({ error: '닉네임을 확인해 주세요.' }, 400);
  if (!['official', 'manager'].includes(mode)) return json({ error: '경기 종류를 확인해 주세요.' }, 400);
  if (!env.NEXON_API_KEY) return json({ error: '넥슨 API 연결 설정이 아직 완료되지 않았습니다.' }, 503);
  try {
    const account = await nexon('/fconline/v1/id', { nickname }, env.NEXON_API_KEY);
    if (!account?.ouid) return json({ error: '해당 넥슨 닉네임을 찾지 못했습니다.' }, 404);
    const matchtype = mode === 'manager' ? 52 : 50;
    const ids = await nexon('/fconline/v1/user/match', { ouid: account.ouid, matchtype, offset: 0, limit: 5 }, env.NEXON_API_KEY);
    if (!Array.isArray(ids) || !ids.length) return json({ error: '최근 경기가 없습니다. 경기 종류를 바꿔 보세요.' }, 404);
    let fallback = null;
    for (const matchid of ids) {
      const detail = await nexon('/fconline/v1/match-detail', { matchid }, env.NEXON_API_KEY);
      const mine = detail?.matchInfo?.find(info => info.ouid === account.ouid);
      const players = (mine?.player || []).filter(p => Number.isInteger(p.spId) && Number.isInteger(p.spPosition) && p.spPosition !== 28)
        .map(p => ({ spid: p.spId, position: p.spPosition, grade: Number.isInteger(p.spGrade) ? p.spGrade : 1 }));
      if (players.length < 11) continue;
      const result = { nickname, mode, matchDate: detail.matchDate || null, players: players.slice(0, 11) };
      if (mine.matchDetail?.matchEndType === 0 || mine.matchDetail?.matchEndType == null) return json(result);
      fallback ||= result;
    }
    return fallback ? json(fallback) : json({ error: '최근 경기에서 선발 11명 정보를 찾지 못했습니다.' }, 404);
  } catch (error) {
    console.error('Nexon lineup request failed', error);
    return json({ error: '넥슨 경기 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
  }
}
