// sw.js - NFLSHC Chat Service Worker
// 版本号：每次更新代码时修改此版本号，浏览器会自动更新缓存
// v2.5.2: 预缓存改为「逐个添加、互不牵连」——以前任何一个资源失败都会让整个 install 被拒，
//         SW 卡在 installing（页面因此停留在旧版本，看起来像"应用坏了"）；现在失败只记日志。
// v2.5.1: 站点图标改为本地文件（favicon/PWA 图标）并纳入预缓存；bump 版本号让已安装的
//         旧客户端强制重建缓存（旧缓存 nflshc-chat-v2.5.0 会在 activate 时被删除）
// v2.5.0: 新增 Web Push 离线通知（会议邀请 / 消息提醒 / 日程提醒）
// v2.4.0: 主题/资源引用带版本号（theme.js?v=4），配合网络优先导航彻底解决旧缓存卡页面问题

const CACHE_VERSION = 'v2.5.2';
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
  '/offline.html',
  // 站点图标（PWA 安装图标 + favicon）：本地文件，断网时也能正常显示
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png'
];

// ===== 安装事件：缓存资源 =====
// 关键改动：不再用 cache.addAll —— 它要求清单里**每一个**资源都 200，
// 只要有一个请求失败（网络抖动、Cloudflare 挑战、公告性资源被删）整个 install 就被拒，
// SW 永远停在 installing，页面一直用旧缓存 → 用户看到的就是「应用打不开 / 内容不更新」。
// 现在逐个 add 并各自兜错，最差情况只是少缓存几个文件，SW 一定能装上并接管。
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(urlsToCache.map(url =>
        cache.add(new Request(url, { cache: 'reload' }))
          .catch(err => {
            console.warn('[SW] 预缓存失败（已跳过）：', url, err && err.message);
            return null;
          })
      )))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[SW] 安装阶段异常，仍然继续接管：', err && err.message);
        return self.skipWaiting();
      })
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

  // 0) 非 GET 请求（POST/PATCH/DELETE 等）一律不拦截，直接走网络
  //    （cache.put 不支持非 GET，拦截会导致请求失败并抛错）
  if (event.request.method !== 'GET') {
    return;
  }

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

  // 3) 静态资源（GET）：缓存优先 + 后台刷新（stale-while-revalidate），
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

// ===== Web Push：离线通知（页面关闭也能收到）=====
// 服务端用 VAPID + aes128gcm 加密推送，负载形如 { title, body, url, ts }
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
  }
  const title = data.title || 'NFLSHC Chat';
  const options = {
    body: data.body || '',
    icon: 'https://cdn.luogu.com.cn/upload/image_hosting/5rdb3c08.png',
    badge: 'https://cdn.luogu.com.cn/upload/image_hosting/5rdb3c08.png',
    tag: data.tag || ('nflshc-' + (data.ts || Date.now())),
    renotify: true,
    data: { url: data.url || '/chat.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 点击通知：聚焦已有窗口（并导航到目标页面），否则新开一个
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/chat.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0) {
          try { c.navigate(target); } catch (e) { /* 忽略 */ }
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
