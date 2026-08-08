// sw.js - NFLSHC Chat Service Worker
// 版本号：每次更新代码时修改此版本号，浏览器会自动更新缓存

const CACHE_VERSION = 'v2.2.0';
const CACHE_NAME = `nflshc-chat-${CACHE_VERSION}`;

// 需要缓存的资源列表
// 注意：站点部署在根路径（nflshcchat.cc.cd），不是 /nflshcchat/ 子路径，
// 因此所有资源一律用根路径 "/..."，否则 cache.addAll 会因 404 全部失败、SW 安装崩溃。
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
  '/arena.html',
  '/admin.html',
  '/admin-suggestions.html',
  '/ai-profile.html',
  '/showcase.html',
  '/config.js',
  '/shortcuts.js',
  '/css/themes.css',
  '/manifest.json',
  '/offline.html',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css'
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

// ===== 获取事件：拦截网络请求 =====
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果缓存中有，直接返回缓存
        if (response) {
          return response;
        }
        // 否则从网络获取
        return fetch(event.request)
          .then(response => {
            // 检查是否是有效响应
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            // 克隆响应并存入缓存
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });
            return response;
          })
          .catch(() => {
            // 离线时的备用页面
            if (event.request.mode === 'navigate') {
              return caches.match('/offline.html');
            }
          });
      })
  );
});
