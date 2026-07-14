// FC알리미 서비스워커 — PWA 설치 + 빠른 로딩(오프라인) + 알림(웹 푸시 포함)
// 배포 시 index.html · players.json 과 같은 폴더(루트)에 함께 올려주세요.
const CACHE = 'fcalrimi-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();   // 새 버전 즉시 활성화
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './players.json']).catch(() => {}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 외부(폰트/CDN/이미지)는 건드리지 않음

  const isHTML = req.mode === 'navigate' || url.pathname === '/' ||
                 url.pathname.endsWith('/') || url.pathname.endsWith('.html');

  // index.html: 항상 최신 우선(배포 즉시 반영), 오프라인이면 캐시
  if (isHTML) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // players.json: 캐시 먼저 주고 백그라운드로 갱신(빠른 로딩)
  if (url.pathname.endsWith('players.json')) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }
});

// ── 웹 푸시 수신 → 알림 표시 (앱이 완전히 꺼져 있어도 동작) ──
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { title: 'FC알리미', body: (e.data && e.data.text && e.data.text()) || '' }; }
  const title = d.title || 'FC알리미';
  const opts = {
    body: d.body || '갱신시간 알림이 도착했어요.',
    tag: d.tag || 'fc-push',
    renotify: true,
    silent: false,
    data: { url: d.url || './' },
    // 아이콘/진동은 지원 기기에서만 사용됨 (미지원 시 무시)
    vibrate: [120, 60, 120]
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 알림 클릭 시 앱으로 포커스(없으면 새로 열기)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});