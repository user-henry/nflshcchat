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
