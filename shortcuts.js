/* NFLSHC Chat - 全局键盘快捷键 */
(function() {
    'use strict';
    
    document.addEventListener('keydown', function(e) {
        // Ctrl+K: 搜索
        if (e.ctrlKey && e.key === 'k') {
            e.preventDefault();
            var searchLink = document.querySelector('a[href="search.html"]');
            if (searchLink) searchLink.click();
            else window.location.href = 'search.html';
        }
        // Ctrl+N: 新聊天（仅在聊天页面）
        if (e.ctrlKey && e.key === 'n') {
            var chatLink = document.querySelector('a[href="chat.html"]');
            if (chatLink) { e.preventDefault(); chatLink.click(); }
        }
        // Esc: 关闭所有模态框
        if (e.key === 'Escape') {
            var modals = document.querySelectorAll('.modal');
            modals.forEach(function(modal) {
                if (modal.style.display === 'flex') {
                    modal.style.display = 'none';
                }
            });
        }
        // Ctrl+Shift+P: 个人资料
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            e.preventDefault();
            var profileLink = document.querySelector('a[href="profile.html"]');
            if (profileLink) profileLink.click();
            else window.location.href = 'profile.html';
        }
        // Ctrl+Shift+F: 好友列表
        if (e.ctrlKey && e.shiftKey && e.key === 'F') {
            e.preventDefault();
            var friendsLink = document.querySelector('a[href="friends.html"]');
            if (friendsLink) friendsLink.click();
            else window.location.href = 'friends.html';
        }
        // Ctrl+Shift+S: 统计
        if (e.ctrlKey && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            var statsLink = document.querySelector('a[href="stats.html"]');
            if (statsLink) statsLink.click();
            else window.location.href = 'stats.html';
        }
        // Ctrl+Shift+E: 导出
        if (e.ctrlKey && e.shiftKey && e.key === 'E') {
            e.preventDefault();
            var exportLink = document.querySelector('a[href="export.html"]');
            if (exportLink) exportLink.click();
            else window.location.href = 'export.html';
        }
        // Ctrl+Shift+N: 公告
        if (e.ctrlKey && e.shiftKey && e.key === 'N') {
            e.preventDefault();
            var noticeLink = document.querySelector('a[href="notice.html"]');
            if (noticeLink) noticeLink.click();
            else window.location.href = 'notice.html';
        }
        // ? 键: 显示快捷键帮助（不在输入框中时）
        if (e.key === '?' && !isInputFocused()) {
            e.preventDefault();
            showShortcutsHelp();
        }
    });
    
    function isInputFocused() {
        var tag = document.activeElement.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement.isContentEditable;
    }
    
    function showShortcutsHelp() {
        // 移除已有的帮助面板
        var existing = document.getElementById('shortcuts-help-panel');
        if (existing) { existing.remove(); return; }
        
        var shortcuts = [
            ['Ctrl + K', '打开搜索'],
            ['Ctrl + N', '新建聊天'],
            ['Ctrl + Shift + P', '个人资料'],
            ['Ctrl + Shift + F', '好友列表'],
            ['Ctrl + Shift + S', '群聊统计'],
            ['Ctrl + Shift + E', '数据导出'],
            ['Ctrl + Shift + N', '查看公告'],
            ['Esc', '关闭弹窗'],
            ['?', '显示此帮助']
        ];
        
        var panel = document.createElement('div');
        panel.id = 'shortcuts-help-panel';
        panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:1px solid #ffd700;border-radius:16px;padding:30px;z-index:9999;min-width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.5);color:white;font-family:Segoe UI,Tahoma,Geneva,Verdana,sans-serif;';
        panel.innerHTML = '<h3 style="color:#ffd700;margin-bottom:20px;text-align:center;">⌨️ 键盘快捷键</h3>' +
            shortcuts.map(function(s) {
                return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3e;">' +
                    '<kbd style="background:#0f0f1a;padding:4px 10px;border-radius:6px;font-family:monospace;color:#ffd700;font-size:12px;">' + s[0] + '</kbd>' +
                    '<span style="color:#aaa;font-size:13px;">' + s[1] + '</span></div>';
            }).join('') +
            '<div style="text-align:center;margin-top:15px;color:#666;font-size:12px;">点击面板外或按 Esc 关闭</div>';
        
        var overlay = document.createElement('div');
        overlay.id = 'shortcuts-help-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9998;';
        overlay.onclick = function() { panel.remove(); overlay.remove(); };
        
        document.body.appendChild(overlay);
        document.body.appendChild(panel);
    }
    
    console.log('⌨️ 键盘快捷键已加载');
})();
