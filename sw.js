// sw.js - NFLSHC Chat Service Worker
// 版本号：每次更新代码时修改此版本号，浏览器会自动更新缓存
// v2.3.0: 修复 cache.addAll 因 404 文件（arena.html/config.js）失败导致 SW 无法更新、
//         页面长期停留在旧缓存的问题；页面导航改为网络优先，保证部署后立即拿到新版本；
//         API/跨域请求永不缓存，保证消息、表情回应等数据实时刷新。

const CACHE_VERSION = 'v2.3.0';
const CACHE_NAME = `nflshc-chat-${CACHE_VERSION}`;

// 需要预缓存的资源列表（只放确定存在的文件，任何 404 都会导致安装失败、SW 无法更新）
const urlsToCache = [
  '/',
  '/index.html',
  '/chat.html',
  '/register.html',
  '/profile.html',
  '/friends.html',
  '/dashboard.html',
  '/search.html',
  '/favorites.html',
  '/export.html',
  '/about.html',
  '/notice.html',
  '/suggestions.html',
  '/stats.html',
  '/hzyai.html',
  '/hzyai-share.html',
  '/posts.html',
  '/articles.html',
  '/admin.html',
  '/admin-suggestions.html',
  '/ai-profile.html',
  '/showcase.html',
  '/shortcuts.js',
  '/css/themes.css',
  '/manifest.json',
  '/offline.html'
];

// ===== 安装事件：缓存资源 =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 缓存资源中...');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// ===== 激活事件：清理旧缓存 =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName.startsWith('nflshc-chat-')) {
            console.log('[SW] 删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => self.clients.claim())
  );
});

// ===== 获取事件 =====
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;

  // 1) API 请求（同源 /api/* 或任何跨域请求）：永不缓存，直连网络，
  //    保证消息/表情回应/帖子等数据实时、不读到旧缓存
  if (!isSameOrigin || requestUrl.pathname.startsWith('/api/')) {
    return;
  }

  // 2) 页面导航（HTML 页面）：网络优先 → 失败回退缓存 → 再回退离线页
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(cached => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // 3) 静态资源：缓存优先 + 后台刷新（stale-while-revalidate），
  //    离线可用，同时后台更新保证下次访问拿到新版本
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
