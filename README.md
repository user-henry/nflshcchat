# NFLSHC Chat

> 基于 GitHub Issues 的学生聊天平台 — 零服务器、零数据库，纯前端 + GitHub API 驱动

🌐 **体验地址**: [user-henry.github.io/nflshcchat](https://user-henry.github.io/nflshcchat)

---

## ✨ 功能一览

### 💬 核心聊天
- **实时消息** — 基于 GitHub Issues 存储聊天记录，支持文字、图片、语音消息
- **引用回复** — 消息引用/回复功能，支持预览栏显示
- **消息置顶** — 管理员可置顶重要消息，横幅显示在消息列表顶部
- **代码高亮** — 集成 highlight.js，代码块一键复制
- **键盘快捷键** — 常用操作快捷键支持

### 👤 用户系统
- **注册/登录** — GitHub Issues 驱动的用户系统
- **自定义头像** — 支持 URL 输入自定义头像
- **用户等级** — 基于活跃度的等级积分系统（Lv.1~10+，四级样式）
- **好友系统** — 添加/管理好友，独立好友页面
- **个人资料** — 完整的个人资料页面

### 📊 数据与搜索
- **数据仪表盘** — 统计卡片 + Chart.js 图表（趋势/分布/词云/Top10）
- **搜索功能** — 关键词搜索，高亮匹配，多条件过滤
- **数据导出** — 支持 JSON/HTML 格式导出
- **收藏功能** — 收藏重要消息，独立收藏管理页

### 🎨 界面与体验
- **5 套主题** — Default / Light / Blue / Purple / Green 一键切换
- **展示页** — 炫酷动画展示页（showcase）
- **校园文化** — 校歌播放、校园宣传片

### 🛠 管理功能
- **公告管理** — 通知/公告发布系统
- **建议反馈** — 用户建议提交与管理
- **AI 天气查询** — 内置天气查询功能

---

## 🏗️ 技术架构

```
前端 (纯 HTML/CSS/JS)
    ↓ GitHub REST API
GitHub Issues (数据存储)
    ├── label: chatmessage  → 聊天消息
    ├── label: chatroom     → 聊天室
    ├── label: user         → 用户数据
    ├── label: favorite     → 收藏记录
    ├── label: friend       → 好友关系
    └── label: media        → 媒体文件
```

**核心理念**: 利用 GitHub Issues 的 Label 系统作为"数据表"，每个 Label 对应一种数据类型，Issue Body 存储 JSON 格式数据。零后端、零服务器成本。

---

## 📁 项目结构

```
├── index.html          # 登录/入口页
├── register.html       # 注册页
├── chat.html           # 聊天主页面（核心）
├── profile.html        # 个人资料页
├── friends.html        # 好友系统
├── dashboard.html      # 数据仪表盘
├── search.html         # 搜索页
├── favorites.html      # 收藏管理
├── export.html         # 数据导出
├── about.html          # 关于页面
├── notice.html         # 公告页
├── suggestions.html    # 建议反馈
├── showcase.html       # 展示页
├── stats.html          # 统计页
├── hzyai.html          # AI 天气查询
├── admin.html          # 管理面板
├── admin-profile.html  # 管理员资料
├── admin-suggestions.html  # 建议管理
├── ai-profile.html     # AI 个人资料
├── css/themes.css      # 5 套主题样式
├── shortcuts.js        # 键盘快捷键
└── .github/workflows/deploy.yml  # 部署工作流
```

---

## 🚀 部署

项目通过 GitHub Pages 部署，配合 GitHub Actions 自动构建：

1. Fork 本仓库
2. 在仓库 Settings → Secrets 中添加 `TOKEN`（GitHub Personal Access Token，需要 `repo` 权限）
3. 启用 GitHub Pages，Source 选择 GitHub Actions
4. 推送代码即可自动部署

---

## ⚠️ 注意事项

- 本项目使用 GitHub Issues 作为数据库，**消息等数据公开可见**，请勿分享敏感信息
- GitHub API 有速率限制（未认证 60 次/小时，认证后 5000 次/小时）
- 语音消息采用 base64 编码存储在 Issue Body 中，有约 50KB 大小限制
- `friends.html` 使用独立暗色主题，与 `themes.css` 不一致（已知问题）

---

## 📄 License

MIT
