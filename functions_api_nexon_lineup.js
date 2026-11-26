// FC Online 공식 스쿼드메이커의 공개 구단주 스쿼드를 가져온다.
const ENDPOINT = 'https://fconline.nexon.com/squadmakerapi/SquadMakerProc';
const ALLOWED = new Set(['fcalrimi.com', 'www.fcalrimi.com', 'fcalrimi.pages.dev']);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function official(method, values) {
  const body = new URLSearchParams({ strMethod: method, ...values });
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'referer': 'https://fconline.nexon.com/SquadMaker'
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Official SquadMaker HTTP ${response.status}`);
  const data = await response.json();
  if (data?.ResultCode !== 1) throw new Error(data?.ResultMsg || '스쿼드 조회 실패');
  return data.ResultData || {};
}

export async function onRequestGet({ request }) {
  const site = new URL(request.url);
  const referer = request.headers.get('referer');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site' || (!fetchSite && !referer)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  if (referer) {
    try { if (!ALLOWED.has(new URL(referer).hostname)) return json({ error: '허용되지 않은 요청입니다.' }, 403); }
    catch (_) { return json({ error: '허용되지 않은 요청입니다.' }, 403); }
  }
  const nickname = (site.searchParams.get('nickname') || '').trim();
  if (!nickname || nickname.length > 16 || /[\u0000-\u001f]/.test(nickname)) return json({ error: '닉네임을 확인해 주세요.' }, 400);
  try {
    const owner = await official('getownerinfo', { strCharacterName: nickname });
    const sn = Number(owner.sn);
    if (!Number.isSafeInteger(sn) || sn <= 0) return json({ error: '해당 닉네임을 찾지 못했습니다.' }, 404);
    const result = await official('getingameinfo', {
      n1TeamType: 0, n1TeamPart: 0, n4TeamSeq: 0, n8TargetNexonSN: sn
    });
    const squad = result.Squadinfo || {};
    const players = (Array.isArray(squad.players) ? squad.players : []).map(player => ({
      spid: Number(player.spid),
      position: String(player.role || player.position || '').toUpperCase(),
      grade: Number(player.buildUp) || 1,
      starter: Number(player.state) === 1,
      x: player.x == null ? null : Number(player.x),
      y: player.y == null ? null : Number(player.y),
      name: String(player.name || ''),
      season: String(player.season || ''),
      ovr: Number(player.eachOvr?.[0]) || Number(player.ovr) || 0,
      pay: Number(player.pay) || 0,
      prices: Array.isArray(player.eachPrice) ? player.eachPrice.map(value => Number(value) || 0).slice(0, 13) : []
    })).filter(player => Number.isSafeInteger(player.spid) && player.spid > 0);
    if (players.filter(player => player.starter).length !== 11) return json({ error: '게임 내 저장된 선발 스쿼드를 찾지 못했습니다.' }, 404);
    return json({ nickname: result.strCharacterName || nickname, formation: squad.formation || '', players });
  } catch (error) {
    console.error('Official SquadMaker request failed', error);
    return json({ error: '스쿼드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
  }
}
