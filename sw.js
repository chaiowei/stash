// 最小 Service Worker：讓 App 可安裝到主畫面、出現在 Android 分享選單
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', e => {
  // 只快取 App 本身的檔案；API 請求一律走網路
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
