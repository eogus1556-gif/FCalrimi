// ============================================================
// FC알리미 푸시 스케줄러 — Cloudflare Worker
// 매 1분마다 실행 → 갱신 시간이 다가온 유저에게 웹 푸시 전송
// 앱이 꺼져 있어도 서버가 대신 알림을 보냄
// ============================================================

const SITE = 'https://fcalrimi.pages.dev';
const SUPABASE = 'https://gqkkuuvsraimgpctyohy.supabase.co';
const KST = 9 * 3600 * 1000;

// ─── Base64url ───
function b64enc(bytes) {
  let b = '';
  for (const c of bytes) b += String.fromCharCode(c);
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64dec(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const b = atob(s);
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

// ─── HMAC-SHA256 ───
async function hmac(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}

// ─── HKDF (RFC 5869) ───
async function hkdfExtract(salt, ikm) { return hmac(salt, ikm); }
async function hkdfExpand(prk, info, len) {
  const H = 32, n = Math.ceil(len / H);
  const out = new Uint8Array(n * H);
  const inf = info instanceof Uint8Array ? info : new TextEncoder().encode(info);
  let prev = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    const inp = new Uint8Array(prev.length + inf.length + 1);
    inp.set(prev); inp.set(inf, prev.length); inp[inp.length - 1] = i;
    prev = await hmac(prk, inp);
    out.set(prev, (i - 1) * H);
  }
  return out.slice(0, len);
}

// ─── VAPID JWT 서명 (ES256) ───
async function vapidAuth(endpoint, env) {
  const enc = new TextEncoder();
  const hdr = b64enc(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })));
  const pld = b64enc(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: env.VAPID_SUBJECT
  })));
  const input = enc.encode(`${hdr}.${pld}`);

  const pubBytes = b64dec(env.VAPID_PUBLIC_KEY);
  const privBytes = b64dec(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: b64enc(privBytes),
    x: b64enc(pubBytes.slice(1, 33)),
    y: b64enc(pubBytes.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, input));

  return `vapid t=${hdr}.${pld}.${b64enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ─── Web Push 암호화 (RFC 8291 — aes128gcm) ───
async function encryptPayload(plaintext, sub) {
  const uaPub = b64dec(sub.p256dh);
  const auth = b64dec(sub.auth);

  // ephemeral ECDH 키 쌍
  const ekp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epPub = new Uint8Array(await crypto.subtle.exportKey('raw', ekp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  // ECDH → shared secret → IKM = HMAC(auth, shared)
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, ekp.privateKey, 256));
  const ikm = await hmac(auth, shared);

  // HKDF
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);

  const keyInfo = new Uint8Array(15 + 65 + 65);
  keyInfo.set(new TextEncoder().encode('WebPush: info'));
  keyInfo[14] = 0;
  keyInfo.set(uaPub, 15);
  keyInfo.set(epPub, 80);

  const key = await hkdfExpand(prk, keyInfo, 16);
  const nonce = await hkdfExpand(prk, keyInfo, 12);

  // AES-128-GCM
  const aesKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const pt = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const padded = new Uint8Array(pt.length + 1);
  padded.set(pt); padded[pt.length] = 0x02;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  // aes128gcm 바디: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const body = new Uint8Array(86 + ct.length);
  body.set(salt, 0);
  body[16] = 0; body[17] = 0; body[18] = 0x10; body[19] = 0x00; // rs=4096
  body[20] = 65;
  body.set(epPub, 21);
  body.set(ct, 86);
  return body;
}

// ─── 푸시 전송 ───
async function sendPush(sub, title, body, url, env) {
  const payload = JSON.stringify({ title, body, url: url || './', tag: 'fc-refresh' });
  const enc = await encryptPayload(payload, sub);
  const auth = await vapidAuth(sub.endpoint, env);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Authorization': auth, 'TTL': '86400' },
    body: enc,
  });

  if (res.status === 404 || res.status === 410) throw new Error('expired');
  if (!res.ok) throw new Error(`push ${res.status}`);
  return true;
}

// ─── Supabase REST API ───
async function sbQuery(table, query, env) {
  const res = await fetch(`${SUPABASE}/rest/v1/${table}?${query}`, {
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status}`);
  return res.json();
}

async function sbPatch(table, filter, body, env) {
  await fetch(`${SUPABASE}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

// ─── 갱신까지 남은 분 계산 (서버 시간 기반) ───
function nextInMin(hj, min, now) {
  if ((hj !== '홀' && hj !== '짝') || min < 0) return -1;
  for (let add = 0; add <= 25; add++) {
    const h = (now.getHours() + add) % 24;
    const ok = hj === '홀' ? h % 2 === 1 : h % 2 === 0;
    if (!ok) continue;
    const diff = add * 60 + (min - now.getMinutes());
    if (diff >= 0) return diff;
  }
  return -1;
}

function cycleKey(hj, min, now) {
  for (let add = 0; add <= 25; add++) {
    const h = (now.getHours() + add) % 24;
    const ok = hj === '홀' ? h % 2 === 1 : h % 2 === 0;
    if (!ok) continue;
    const diff = add * 60 + (min - now.getMinutes());
    if (diff >= 0) return `${h}:${min}`;
  }
  return '';
}

// ─── players.json 로드 (KV 캐시 5분) ───
async function loadPlayers(env) {
  try {
    const c = await env.PUSH_KV.get('players_v2', { type: 'json' });
    if (c) return c;
  } catch (_) {}
  const res = await fetch(`${SITE}/players.json`);
  if (!res.ok) throw new Error('players.json fetch failed');
  const raw = await res.json();
  // compact: [id, name, season, hj, min, pos, ovr] → 갱신시간 등록분만
  const confirmed = raw
    .filter(r => r[3] && r[4] >= 0)
    .map(r => ({ id: r[0], name: r[1], hj: r[3], min: r[4] }));
  try { await env.PUSH_KV.put('players_v2', JSON.stringify(confirmed), { expirationTtl: 300 }); } catch (_) {}
  return confirmed;
}

// ─── 메인 푸시 사이클 ───
async function runPushCycle(env) {
  const now = new Date(Date.now() + KST);
  const stats = { sent: 0, skipped: 0, disabled: 0, errors: 0, ts: now.toISOString() };

  // 1. 데이터 로드
  let players, subs, favRows;
  try { players = await loadPlayers(env); } catch (e) { stats.errors++; return stats; }
  try { subs = await sbQuery('push_subs', 'select=id,user_id,endpoint,lead_min,enabled,last_seen&enabled=eq.true&order=last_seen.desc', env); }
  catch (e) { stats.errors++; return stats; }
  try { favRows = await sbQuery('favorites', 'select=user_id,spid', env); }
  catch (e) { stats.errors++; return stats; }

  if (!subs.length) return stats;

  // 2. 유저별 즐겨찾기 맵
  const favMap = {};
  favRows.forEach(r => { (favMap[r.user_id] = favMap[r.user_id] || []).push(r.spid); });

  // 3. players map (id → {hj, min})
  const pMap = {};
  players.forEach(p => { pMap[p.id] = p; });

  // 4. last_seen 기준 필터: 3분 이내 활성 유저는 스킵 (클라이언트가 처리 중)
  const THREE_MIN = 3 * 60 * 1000;

  for (const sub of subs) {
    const userFavs = favMap[sub.user_id];
    if (!userFavs || !userFavs.length) continue;

    // 최근 활성 유저는 건너뜀 (클라이언트가 알림 처리)
    if (sub.last_seen) {
      const seen = new Date(sub.last_seen).getTime();
      if (Date.now() - seen < THREE_MIN) { stats.skipped++; continue; }
    }

    const lead = sub.lead_min || 5;

    // 이 유저에게 보낼 알림 수집
    const alerts = [];
    for (const spid of userFavs) {
      const p = pMap[spid];
      if (!p) continue;
      const n = nextInMin(p.hj, p.min, now);
      if (n < 0 || n > lead) continue;

      const ck = cycleKey(p.hj, p.min, now);
      const dk = `${sub.user_id}:${spid}:${ck}`;
      try {
        const exists = await env.PUSH_KV.get(dk);
        if (exists) continue;
      } catch (_) {}

      alerts.push({ spid, name: p.name, n, dk });
    }

    if (!alerts.length) continue;

    // 메시지 구성 (여러 선수면 묶어서)
    alerts.sort((a, b) => a.n - b.n);
    const title = 'FC알리미 갱신 알림';
    const body = alerts.length === 1
      ? `${alerts[0].name} 갱신 ${alerts[0].n}분 전`
      : `${alerts.map(a => a.name).join(', ')} 갱신 ${alerts[0].n}분 전`;

    try {
      await sendPush(sub, title, body, './', env);
      stats.sent++;
      // 전송 완료 → dedup 마크 (2시간 TTL)
      for (const a of alerts) {
        try { await env.PUSH_KV.put(a.dk, '1', { expirationTtl: 7200 }); } catch (_) {}
      }
    } catch (e) {
      stats.errors++;
      if (e.message === 'expired') {
        try { await sbPatch('push_subs', `id=eq.${sub.id}`, { enabled: false }, env); stats.disabled++; } catch (_) {}
      }
    }
  }

  // 실행 결과 기록
  try { await env.PUSH_KV.put('last_run', JSON.stringify(stats), { expirationTtl: 86400 }); } catch (_) {}
  return stats;
}

// ─── Worker 핸들러 ───
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPushCycle(env).catch(() => {}));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const stats = await runPushCycle(env);
      return Response.json(stats);
    }
    if (url.pathname === '/status') {
      try {
        const last = await env.PUSH_KV.get('last_run', { type: 'json' });
        return Response.json({ lastRun: last || 'never' });
      } catch (_) {
        return Response.json({ lastRun: 'KV unavailable' });
      }
    }
    return new Response('FC알리미 Push Scheduler — /run 또는 /status');
  },
};
