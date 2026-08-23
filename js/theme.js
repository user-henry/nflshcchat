/**
 * NFLSHC Chat - 共享主题管理器
 * 所有页面引入此脚本后自动应用主题，localStorage 持久化
 */
(function() {
    'use strict';

    var THEME_KEY = 'nflshc_theme';
    var DEFAULT_THEME = 'dark';

    var themes = {
        dark:   { id: 'dark',   name: '暗夜黑金', icon: '🌙', accent: '#ffd700' },
        light:  { id: 'light',  name: '晨曦白光', icon: '☀️', accent: '#ffd700' },
        blue:   { id: 'blue',   name: '深海蓝调', icon: '🌊', accent: '#3498db' },
        purple: { id: 'purple', name: '紫罗兰夜', icon: '🔮', accent: '#9b59b6' },
        green:  { id: 'green',  name: '翡翠绿意', icon: '🌿', accent: '#2ecc71' }
    };

    function getStoredTheme() {
        try {
            return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
        } catch (e) {
            return DEFAULT_THEME;
        }
    }

    function applyTheme(themeId) {
        var html = document.documentElement;
        if (!html) return;
        var theme = themes[themeId];
        if (!theme) {
            themeId = DEFAULT_THEME;
            theme = themes[DEFAULT_THEME];
        }
        if (themeId === DEFAULT_THEME) {
            html.removeAttribute('data-theme');
        } else {
            html.setAttribute('data-theme', themeId);
        }
        // 更新 meta theme-color
        try {
            var meta = document.querySelector('meta[name="theme-color"]');
            if (meta && theme) {
                meta.setAttribute('content', theme.accent || '#ffd700');
            }
        } catch (e) {}
    }

    function setTheme(themeId) {
        if (!themes[themeId]) return false;
        try {
            localStorage.setItem(THEME_KEY, themeId);
        } catch (e) {}
        applyTheme(themeId);
        try {
            window.dispatchEvent(new CustomEvent('themechange', {
                detail: { theme: themeId, info: themes[themeId] },
                bubbles: false
            }));
        } catch (e) {}
        return true;
    }

    function getTheme() {
        var id = getStoredTheme();
        return themes[id] ? id : DEFAULT_THEME;
    }

    function getThemeInfo(themeId) {
        if (!themeId) themeId = getTheme();
        return themes[themeId] || themes[DEFAULT_THEME];
    }

    function getThemes() {
        return themes;
    }

    // ========== 页面加载时自动应用主题 ==========
    applyTheme(getStoredTheme());

    // ========== 暴露 API ==========
    window.ThemeManager = {
        setTheme: setTheme,
        getTheme: getTheme,
        getThemeInfo: getThemeInfo,
        getThemes: getThemes
    };

})();

/**
 * NFLSHC Chat - 统一 Bearer Token 鉴权
 * Worker 写操作需要 Authorization: Bearer <token>；
 * 登录成功后由各页面调用 AuthToken.set() 存储，这里自动附加到对 Worker 的写请求上。
 */
(function() {
    'use strict';

    var TOKEN_KEY = 'nflshc_auth_token';
    var API_ORIGIN = 'https://worker.nflshcchat.cc.cd';

    window.AuthToken = {
        get: function() {
            try {
                return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
            } catch (e) { return ''; }
        },
        set: function(token) {
            if (!token) return;
            try {
                localStorage.setItem(TOKEN_KEY, token);
                sessionStorage.setItem(TOKEN_KEY, token);
            } catch (e) {}
        },
        clear: function() {
            try {
                localStorage.removeItem(TOKEN_KEY);
                sessionStorage.removeItem(TOKEN_KEY);
            } catch (e) {}
        }
    };

    // 包装 fetch：只对 worker.nflshcchat.cc.cd 的写请求附加 Authorization 头
    // （不对第三方 API 附加，避免触发不必要的 CORS 预检）
    if (!window.__authFetchPatched) {
        window.__authFetchPatched = true;
        var origFetch = window.fetch;
        window.fetch = function(url, opts) {
            opts = opts || {};
            var u = (typeof url === 'string') ? url : (url && url.url) || '';
            var isWrite = !!opts.method && opts.method.toUpperCase() !== 'GET' && opts.method.toUpperCase() !== 'HEAD';
            if (isWrite && u.indexOf(API_ORIGIN) === 0) {
                var token = window.AuthToken ? window.AuthToken.get() : '';
                if (token) {
                    try {
                        var headers = new Headers(opts.headers || {});
                        if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
                        opts.headers = headers;
                    } catch (e) {}
                }
            }
            return origFetch.call(this, url, opts).then(function(resp) {
                // Worker 写操作返回 401（token 无效/过期）时自动清除本地 token，提示重新登录
                if (resp && resp.status === 401 && isWrite && u.indexOf(API_ORIGIN) === 0) {
                    if (window.AuthToken) window.AuthToken.clear();
                }
                return resp;
            });
        };
    }

    // 全局登出清理：任何页面移除登录态时，一并清除 Bearer Token。
    // 覆盖所有页面的 logout（有的直接 removeItem、有的调用 clearLoginState）
    if (!window.__storageAuthPatched) {
        window.__storageAuthPatched = true;
        var origRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(key) {
            origRemoveItem.call(this, key);
            if (key === 'nflshc_currentUser' || key === 'currentUser' || key === 'nflshc_user') {
                try {
                    origRemoveItem.call(localStorage, TOKEN_KEY);
                    origRemoveItem.call(sessionStorage, TOKEN_KEY);
                } catch (e) {}
            }
        };
    }
    if (!window.clearLoginState) {
        window.clearLoginState = function() {
            try {
                localStorage.removeItem('nflshc_currentUser');
                sessionStorage.removeItem('currentUser');
                sessionStorage.removeItem('nflshc_user');
            } catch (e) {}
            if (window.AuthToken) window.AuthToken.clear();
        };
    }
})();
