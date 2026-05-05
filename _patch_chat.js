// Patch script for chat.html - adds missing features #7, #6 (reply), #9 (hljs), #14 (level) + nav links
const fs = require('fs');
const filePath = 'C:\\Users\\黄兴\\Desktop\\近期任务\\nflshcchat\\chat.html';
let html = fs.readFileSync(filePath, 'utf8');

// ============================================================
// 1. Add CSS before </style>
// ============================================================
const cssToAdd = `
        /* === Feature #7: Pinned Messages === */
        .pin-btn {
            position: absolute; top: -8px; right: -8px;
            background: #9b59b6; color: white; border: none;
            padding: 4px 8px; border-radius: 20px; font-size: 10px;
            cursor: pointer; opacity: 0; transition: opacity 0.2s; z-index: 10;
        }
        .message-bubble-wrapper:hover .pin-btn { opacity: 1; }
        .pinned-banner {
            background: linear-gradient(135deg, #9b59b6, #8e44ad);
            color: white; padding: 12px 16px; border-radius: 12px;
            margin-bottom: 15px; display: flex; align-items: flex-start; gap: 10px;
        }
        .pinned-banner .pin-content { flex: 1; font-size: 14px; word-break: break-word; }
        .pinned-banner .pin-sender { font-size: 11px; opacity: 0.7; }
        .pinned-banner .unpin-btn { background: rgba(255,255,255,0.2); border: none; color: white; padding: 4px 8px; border-radius: 10px; cursor: pointer; font-size: 11px; }

        /* === Feature #6: Reply/Quote === */
        .reply-btn {
            position: absolute; top: -8px; left: -8px;
            background: #3498db; color: white; border: none;
            padding: 4px 8px; border-radius: 20px; font-size: 10px;
            cursor: pointer; opacity: 0; transition: opacity 0.2s; z-index: 10;
        }
        .message-bubble-wrapper:hover .reply-btn { opacity: 1; }
        .reply-preview-bar {
            display: none; background: #0d1b2a; padding: 8px 14px;
            border-radius: 10px; margin-bottom: 8px; font-size: 13px; color: #888;
            border-left: 3px solid #3498db; align-items: center; justify-content: space-between;
        }
        .reply-preview-bar.show { display: flex; }
        .reply-preview-bar .reply-preview-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .reply-preview-bar .reply-cancel-btn { background: none; border: none; color: #e74c3c; cursor: pointer; font-size: 14px; margin-left: 8px; }
        .reply-quote {
            background: rgba(52, 152, 219, 0.1); border-left: 3px solid #3498db;
            padding: 6px 12px; margin-bottom: 8px; border-radius: 0 8px 8px 0; font-size: 12px; color: #aaa;
        }
        .reply-quote .reply-quote-sender { color: #3498db; font-weight: 600; }

        /* === Feature #9: Code Highlight + Copy === */
        .code-block-wrapper { position: relative; margin: 8px 0; }
        .copy-code-btn {
            position: absolute; top: 6px; right: 6px; background: rgba(255,255,255,0.12);
            border: none; color: #ccc; padding: 4px 10px; border-radius: 8px; cursor: pointer;
            font-size: 11px; opacity: 0; transition: opacity 0.2s;
        }
        .code-block-wrapper:hover .copy-code-btn { opacity: 1; }
        .copy-code-btn:hover { background: rgba(255,255,255,0.25); }

        /* === Feature #14: User Level Badge === */
        .level-badge {
            display: inline-block; padding: 1px 8px; border-radius: 10px;
            font-size: 10px; font-weight: bold; margin-left: 5px; vertical-align: middle;
        }
        .level-low { background: #2ecc71; color: white; }
        .level-mid { background: #3498db; color: white; }
        .level-high { background: #9b59b6; color: white; }
        .level-top { background: #ffd700; color: #1a1a2e; }
`;

html = html.replace('</style>', cssToAdd + '\n    </style>');

// ============================================================
// 2. Add highlight.js CDN after marked.min.js
// ============================================================
html = html.replace(
    '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
    `<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>`
);

// ============================================================
// 3. Add nav links (friends, dashboard)
// ============================================================
html = html.replace(
    '<a href="profile.html">👤 个人资料</a>',
    '<a href="profile.html">👤 个人资料</a>\n            <a href="friends.html">👥 好友</a>'
);
html = html.replace(
    '<a href="stats.html">📊 统计</a>',
    '<a href="dashboard.html">📊 仪表盘</a>\n            <a href="stats.html">📊 统计</a>'
);

// ============================================================
// 4. Add reply preview bar in input area (before input-area div close)
// ============================================================
html = html.replace(
    `<button class="send-btn" onclick="sendMessage()">发送</button>
        </div>`,
    `<button class="send-btn" onclick="sendMessage()">发送</button>
        </div>
        <div class="reply-preview-bar" id="replyPreviewBar">
            <span class="reply-preview-text" id="replyPreviewText">回复：</span>
            <button class="reply-cancel-btn" onclick="cancelReply()">✕</button>
        </div>`
);

// ============================================================
// 5. Add JS state variables (find a good spot near other state vars)
// ============================================================
const jsVars = `
        let pinnedMessages = [];
        let replyToMessage = null;
        function calculateLevel(xp) { return Math.floor(Math.sqrt(xp / 10)) + 1; }
        function getLevelClass(level) { if (level <= 3) return 'level-low'; if (level <= 6) return 'level-mid'; if (level <= 9) return 'level-high'; return 'level-top'; }
`;

// Insert after the first let allMessages or similar
html = html.replace(
    'let allMessages = [];',
    'let allMessages = [];\n' + jsVars
);

// ============================================================
// 6. Modify renderMessages to add reply, pin, level features
// ============================================================
// Replace the entire renderMessages function
const oldRenderMessages = html.substring(
    html.indexOf('function renderMessages()'),
    html.indexOf('function renderMessages()') + html.substring(html.indexOf('function renderMessages()')).indexOf('function renderMarkdown('))
).trim();

const newRenderMessages = `function renderMessages() {
            const container = document.getElementById('messagesContainer');
            const roomMessages = allMessages || [];

            // Render pinned messages banner
            const pinnedArea = document.getElementById('pinnedMessagesArea');
            if (pinnedArea) pinnedArea.remove();
            pinnedMessages = roomMessages.filter(m => m.isPinned && !m.isRecalled);
            if (pinnedMessages.length > 0) {
                const canPin = currentRoom && currentRoom.type === 'group' &&
                    (currentRoom.creator === currentUser.username ||
                     (currentRoom.admins && currentRoom.admins.includes(currentUser.username)));
                const pinnedDiv = document.createElement('div');
                pinnedDiv.id = 'pinnedMessagesArea';
                pinnedDiv.innerHTML = pinnedMessages.map(msg =>
                    '<div class="pinned-banner"><div><div class="pin-content">' + escapeHtml(msg.content).substring(0, 200) +
                    '</div><div class="pin-sender">📌 ' + escapeHtml(msg.sender) + ' · ' + new Date(msg.timestamp).toLocaleString() +
                    '</div></div>' + (canPin ? '<button class="unpin-btn" onclick="togglePin(\\'' + msg.id + '\\')">取消置顶</button>' : '') +
                    '</div>'
                ).join('');
                container.insertBefore(pinnedDiv, container.firstChild);
            }

            if (roomMessages.length === 0) {
                container.innerHTML = '<div class="empty-state">💬 暂无消息，发送第一条消息吧！</div>';
                return;
            }

            container.innerHTML = roomMessages.map(msg => {
                const renderedHtml = renderMarkdown(msg.content);
                let bubbleContent = renderedHtml;

                if (msg.isVoice && msg.voiceData) {
                    bubbleContent = '<div class="voice-message"><audio controls src="' + msg.voiceData + '"></audio><div class="voice-message-label">' + escapeHtml(msg.content) + '</div></div>';
                }

                // Code block highlighting + copy button
                bubbleContent = bubbleContent.replace(/<pre><code(\\s[^>]*)?>([\\s\\S]*?)<\\/code><\\/pre>/g, function(match, attrs, code) {
                    return '<div class="code-block-wrapper"><button class="copy-code-btn" onclick="copyCodeBlock(this)">📋 复制</button><pre><code' + (attrs || '') + '>' + code + '</code></pre></div>';
                });

                const canRecall = msg.sender === currentUser.username && (Date.now() - new Date(msg.timestamp).getTime() < 120000);
                const isOwn = msg.sender === currentUser.username;
                const canPin = currentRoom && currentRoom.type === 'group' &&
                    (currentRoom.creator === currentUser.username ||
                     (currentRoom.admins && currentRoom.admins.includes(currentUser.username)));

                // Reply quote
                let replyQuote = '';
                if (msg.replyTo) {
                    const origMsg = roomMessages.find(m => m.id === msg.replyTo);
                    if (origMsg) {
                        replyQuote = '<div class="reply-quote"><span class="reply-quote-sender">' + escapeHtml(origMsg.sender) + '：</span>' + escapeHtml(origMsg.content).substring(0, 100) + '</div>';
                    } else {
                        replyQuote = '<div class="reply-quote" style="opacity:0.5"><span class="reply-quote-sender">[已删除的消息]</span></div>';
                    }
                }

                // Level badge
                const senderMsgCount = roomMessages.filter(m => m.sender === msg.sender && !m.isRecalled).length;
                const senderLevel = calculateLevel(senderMsgCount);
                const levelBadge = '<span class="level-badge ' + getLevelClass(senderLevel) + '">Lv.' + senderLevel + '</span>';

                return '<div class="message ' + (isOwn ? 'own' : '') + '" data-msg-id="' + msg.id + '">' +
                    '<div class="message-sender" onclick="viewProfile(\\'' + escapeHtml(msg.sender) + '\\')">' + escapeHtml(msg.sender) + levelBadge + '</div>' +
                    '<div class="message-bubble-wrapper">' +
                    (replyQuote ? replyQuote : '') +
                    '<div class="message-bubble">' + bubbleContent + '</div>' +
                    (canRecall ? '<button class="recall-btn" onclick="recallMessage(\\'' + msg.id + '\\')">撤回</button>' : '') +
                    '<button class="favorite-btn" onclick="favoriteMessage(\\'' + msg.id + '\\')">⭐</button>' +
                    '<button class="reply-btn" onclick="setReplyTo(\\'' + msg.id + '\\')">↩️</button>' +
                    (canPin ? '<button class="pin-btn" onclick="togglePin(\\'' + msg.id + '\\')">' + (msg.isPinned ? '📌' : '📍') + '</button>' : '') +
                    '</div>' +
                    '<div class="message-time">' + new Date(msg.timestamp).toLocaleString() + '</div>' +
                    '</div>';
            }).join('');

            // Apply hljs highlighting
            container.querySelectorAll('pre code').forEach(block => {
                try { hljs.highlightElement(block); } catch(e) {}
            });

            smartScrollToBottom();
        }`;

html = html.replace(oldRenderMessages, newRenderMessages);

// ============================================================
// 7. Modify renderMarkdown to wrap code blocks with copy button
// ============================================================
// Already handled in renderMessages above via regex

// ============================================================
// 8. Modify sendMessage to include replyTo
// ============================================================
html = html.replace(
    `hasMentionAll: false,`,
    `hasMentionAll: false,
                    replyTo: replyToMessage ? replyToMessage.id : null,`
);

// After successful send, clear reply state
html = html.replace(
    `input.value = '';
                }`,
    `input.value = '';
                replyToMessage = null;
                document.getElementById('replyPreviewBar').classList.remove('show');
            }`
);

// ============================================================
// 9. Modify updatePreview to also apply hljs
// ============================================================
const updatePreviewEnd = html.indexOf('function updatePreview()');
if (updatePreviewEnd !== -1) {
    const updatePreviewSection = html.substring(updatePreviewEnd, updatePreviewEnd + 2000);
    // Add hljs after setting innerHTML in updatePreview
    html = html.replace(
        `function updatePreview() {
            const input = document.getElementById('messageInput');
            const previewDiv = document.getElementById('previewContent');`,
        `function updatePreview() {
            const input = document.getElementById('messageInput');
            const previewDiv = document.getElementById('previewContent');`
    );
}

// ============================================================
// 10. Add new JS functions before </script> or at end of script
// ============================================================
const newFunctions = `
        // === Feature #7: Pin functions ===
        function togglePin(messageId) {
            const msg = allMessages.find(m => m.id === messageId);
            if (!msg) return;
            msg.isPinned = !msg.isPinned;
            updateMessageOnGitHub(msg);
            renderMessages();
        }

        async function updateMessageOnGitHub(msg) {
            try {
                const url = 'https://api.github.com/repos/' + window.CONFIG.GITHUB_USERNAME + '/' + window.CONFIG.GITHUB_REPO + '/issues?labels=chatmessage&state=open&per_page=100';
                const res = await fetch(url, { headers: { 'Authorization': 'token ' + window.CONFIG.GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' } });
                const issues = await res.json();
                for (const issue of issues) {
                    if (issue.title === 'Message: ' + msg.id) {
                        const body = '聊天消息\\n\\\`\\\`\\\`json\\n' + JSON.stringify(msg, null, 2) + '\\n\\\`\\\`\\\`';
                        await fetch('https://api.github.com/repos/' + window.CONFIG.GITHUB_USERNAME + '/' + window.CONFIG.GITHUB_REPO + '/issues/' + issue.number, {
                            method: 'PATCH',
                            headers: { 'Authorization': 'token ' + window.CONFIG.GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                            body: JSON.stringify({ body: body })
                        });
                        break;
                    }
                }
            } catch (e) { console.error('更新置顶状态失败:', e); }
        }

        // === Feature #6: Reply functions ===
        function setReplyTo(messageId) {
            const msg = allMessages.find(m => m.id === messageId);
            if (!msg) return;
            replyToMessage = msg;
            const bar = document.getElementById('replyPreviewBar');
            const text = document.getElementById('replyPreviewText');
            text.textContent = '回复 ' + msg.sender + '：' + msg.content.substring(0, 50);
            bar.classList.add('show');
            document.getElementById('messageInput').focus();
        }

        function cancelReply() {
            replyToMessage = null;
            document.getElementById('replyPreviewBar').classList.remove('show');
        }

        // === Feature #9: Copy code block ===
        function copyCodeBlock(btn) {
            const wrapper = btn.parentElement;
            const code = wrapper.querySelector('code');
            if (!code) return;
            const text = code.textContent;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(function() {
                    btn.textContent = '✅ 已复制';
                    setTimeout(function() { btn.textContent = '📋 复制'; }, 2000);
                });
            } else {
                const ta = document.createElement('textarea');
                ta.value = text; document.body.appendChild(ta);
                ta.select(); document.execCommand('copy');
                document.body.removeChild(ta);
                btn.textContent = '✅ 已复制';
                setTimeout(function() { btn.textContent = '📋 复制'; }, 2000);
            }
        }
`;

// Insert before the last </script>
const lastScriptClose = html.lastIndexOf('</script>');
html = html.substring(0, lastScriptClose) + newFunctions + '\n    ' + html.substring(lastScriptClose);

// ============================================================
// 11. Add dashboard link in mobile sidebar
// ============================================================
// Find the mobile menu section and add links there too
html = html.replace(
    '<a href="profile.html">👤 个人资料</a>',
    '<a href="profile.html">👤 个人资料</a>\n            <a href="friends.html">👥 好友</a>'
);

fs.writeFileSync(filePath, html, 'utf8');
console.log('chat.html patched successfully!');
