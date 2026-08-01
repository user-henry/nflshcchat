/**
 * NFLSHC Chat - 主题管理器
 * 在所有页面引入此脚本即可统一管理主题
 */
(function() {
    'use strict';

    const THEME_KEY = 'nflshc_theme';
    const DEFAULT_THEME = 'dark';

    // 主题定义
    const themes = {
        dark:    { id: 'dark',    name: '暗夜黑金', icon: '🌙', color: '#ffd700', bg: '#1a1a2e', desc: '经典暗色主题，护眼舒适' },
        light:   { id: 'light',   name: '晨曦白光', icon: '☀️', color: '#ffd700', bg: '#f5f5f5', desc: '明亮清新，适合日间使用' },
        blue:    { id: 'blue',    name: '深海蓝调', icon: '🌊', color: '#3498db', bg: '#0d2137', desc: '沉稳蓝色，专注高效' },
        purple:  { id: 'purple',  name: '紫罗兰夜', icon: '🔮', color: '#9b59b6', bg: '#1a0a2e', desc: '优雅紫色，激发灵感' },
        green:   { id: 'green',   name: '翡翠绿意', icon: '🌿', color: '#2ecc71', bg: '#0a2e1a', desc: '自然绿色，舒缓放松' }
    };

    function getStoredTheme() {
        return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
    }

    function applyTheme(themeId) {
        if (themeId === 'dark' || themeId === DEFAULT_THEME) {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', themeId);
        }
        // 更新 PWA theme-color
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta && themes[themeId]) {
            meta.setAttribute('content', themes[themeId].color);
        }
    }

    function setTheme(themeId) {
        if (!themes[themeId]) return false;
        localStorage.setItem(THEME_KEY, themeId);
        applyTheme(themeId);
        // 派发自定义事件，通知同页面其它组件
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: themeId, info: themes[themeId] } }));
        return true;
    }

    // 页面加载时立即应用主题（避免闪烁）
    applyTheme(getStoredTheme());

    // 暴露全局 API
    window.ThemeManager = {
        getTheme: getStoredTheme,
        setTheme: setTheme,
        getThemes: function() { return themes; },
        getCurrentThemeInfo: function() { return themes[getStoredTheme()] || themes[DEFAULT_THEME]; },
        THEME_KEY: THEME_KEY,
        DEFAULT_THEME: DEFAULT_THEME
    };

})();
