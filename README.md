# NFLSHC Chat 🎓💬

> 南外仙林分校学生聊天平台 — 纯前端 + GitHub Issues 驱动，零服务器、零数据库

🌐 **在线体验**: [user-henry.github.io/nflshcchat](https://user-henry.github.io/nflshcchat)

---

## 📖 项目简介

NFLSHC Chat 是一个为南京外国语学校仙林分校（NFLSHC）学生打造的在线聊天平台。项目最大的特点是**完全不依赖任何后端服务器和数据库**，而是巧妙地利用 GitHub Issues 作为数据存储层——每个 GitHub Label 相当于一张"数据表"，每条 Issue 相当于一条"记录"，Issue Body 中存储 JSON 格式的业务数据。

这种设计让项目部署成本为零（GitHub Pages 免费托管），同时通过 GitHub REST API 实现了完整的聊天、用户管理、数据统计等功能。虽然受限于 GitHub API 的速率限制（认证后 5000 次/小时），但对于校园场景的小规模使用完全够用。

---

## ✨ 功能详情

### 💬 聊天核心

| 功能 | 说明 |
|------|------|
| **多聊天室** | 支持创建多个聊天室，每个聊天室对应一个 GitHub Issue（label: `chatroom`） |
| **文字消息** | 基于 GitHub Issues（label: `chatmessage`）实时发送和接收文字消息 |
| **引用回复** | 消息支持引用回复功能，回复时显示被引用消息的预览栏 |
| **消息置顶** | 管理员可置顶重要消息，置顶横幅始终显示在消息列表最顶部 |
| **代码高亮** | 集成 highlight.js（atom-one-dark 主题），代码块支持一键复制 |
| **语音消息** | 内置 MediaRecorder 录音，base64 编码存储（约 50KB 限制） |
| **图片发送** | 支持在聊天中发送图片 |
| **键盘快捷键** | 常用操作支持快捷键，详见 `shortcuts.js` |

### 👤 用户系统

| 功能 | 说明 |
|------|------|
| **注册 / 登录** | 基于 GitHub Issues（label: `user`）的用户认证系统，无需第三方账号 |
| **个人资料** | 完整的个人资料页面（`profile.html`），可修改昵称、个性签名等 |
| **自定义头像** | 支持 URL 输入自定义头像，头像通过 `loadUserAvatars()` 批量获取并缓存 |
| **用户等级** | 基于消息活跃度的等级积分系统：`等级 = Math.floor(Math.sqrt(经验值/10)) + 1` |
| | 等级样式分四档：Lv.1-3 绿色 → Lv.4-6 蓝色 → Lv.7-9 紫色 → Lv.10+ 金色 |
| **好友系统** | 独立的好友管理页面（`friends.html`），基于 label: `friend` 存储好友关系 |

### 📊 数据与搜索

| 功能 | 说明 |
|------|------|
| **数据仪表盘** | 统计卡片（总消息/活跃成员/日均/活跃天数）+ Chart.js 图表 |
| | 包含：30天消息趋势折线图、24小时消息分布图、词云、Top10 发言排行 |
| **全局搜索** | 关键词搜索消息内容，搜索结果高亮匹配，支持多条件过滤 |
| | 分页加载（每页20条），覆盖所有聊天室 |
| **数据导出** | 支持 JSON / HTML 两种格式导出聊天数据（`export.html`） |
| **收藏功能** | 收藏重要消息，独立收藏管理页（label: `favorite`） |

### 🎨 界面与主题

| 功能 | 说明 |
|------|------|
| **5 套主题** | Default（暗色）/ Light（浅色）/ Blue（蓝色）/ Purple（紫色）/ Green（绿色） |
| | 主题定义在 `css/themes.css`，一键切换，即时生效 |
| **展示页** | `showcase.html` — 炫酷动画展示页，用于项目介绍和效果演示 |
| **校园文化** | `about.html` 中嵌入校歌播放（MP3）和校园宣传片视频 |
| **公告系统** | 管理员发布通知公告（`notice.html`） |
| **建议反馈** | 用户可提交建议（`suggestions.html`），管理员可查看管理（`admin-suggestions.html`） |

### 🛠️ 管理与 AI

| 功能 | 说明 |
|------|------|
| **管理面板** | `admin.html` — 管理员专属控制面板，管理用户、消息、公告等 |
| **AI 天气查询** | `hzyai.html` — 内置天气查询功能，输入城市名即可获取实时天气 |
| **统计页面** | `stats.html` — 独立的数据统计页面 |

---

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────┐
│                    浏览器                        │
│    纯 HTML / CSS / JavaScript（零框架）           │
│         Chart.js · highlight.js · MediaRecorder  │
└────────────────────┬────────────────────────────┘
                     │ GitHub REST API
                     ▼
┌─────────────────────────────────────────────────┐
│              GitHub Issues 数据层                 │
│                                                   │
│  label: chatmessage  →  聊天消息（JSON body）     │
│  label: chatroom     →  聊天室元数据              │
│  label: user         →  用户信息                  │
│  label: favorite     →  收藏记录                  │
│  label: friend       →  好友关系                  │
│  label: media        →  媒体文件                  │
│  label: notice       →  公告通知                  │
│  label: suggestion   →  建议反馈                  │
└─────────────────────────────────────────────────┘
```

### 核心设计理念

1. **GitHub Issues 即数据库** — 每个 Label 是一张"表"，每条 Issue 是一条"记录"，Body 存 JSON
2. **零后端成本** — GitHub Pages 免费托管 + GitHub API 免费额度
3. **纯前端架构** — 无需 Node.js / Python 后端，浏览器直接调用 GitHub REST API
4. **Token 认证** — 通过 Personal Access Token 实现用户认证和 API 写入

### 数据存储格式示例

```json
// 一条聊天消息（Issue with label: chatmessage）
{
  "username": "张三",
  "content": "大家好！",
  "roomName": "高一(1)班",
  "timestamp": 1714492800000,
  "replyTo": null,
  "isPinned": false
}

// 一个用户（Issue with label: user）
{
  "username": "张三",
  "password": "加密存储",
  "nickname": "小三",
  "avatarUrl": "https://example.com/avatar.png",
  "xp": 150,
  "level": 4,
  "bio": "热爱编程"
}
```

---

## 📁 项目结构

```
nflshcchat/
├── index.html              # 入口 / 登录页
├── register.html           # 注册页
├── chat.html               # 聊天主页面（核心，108KB）
│   ├── 消息收发与渲染
│   ├── 引用回复 / 消息置顶
│   ├── 代码高亮（highlight.js）
│   ├── 语音消息（MediaRecorder）
│   └── 用户等级 / 头像缓存
├── profile.html            # 个人资料编辑
├── friends.html            # 好友系统
├── dashboard.html          # 数据仪表盘（Chart.js）
├── search.html             # 全局搜索
├── favorites.html          # 收藏管理
├── export.html             # 数据导出
├── about.html              # 关于页面（校歌 / 宣传片）
├── notice.html             # 公告系统
├── suggestions.html        # 建议反馈
├── showcase.html           # 动画展示页
├── stats.html              # 数据统计
├── hzyai.html              # AI 天气查询
├── admin.html              # 管理面板
├── admin-profile.html      # 管理员资料
├── admin-suggestions.html  # 建议管理
├── ai-profile.html         # AI 个人资料
├── presentation.html       # 演示页
├── css/
│   └── themes.css          # 5 套主题样式
├── shortcuts.js            # 键盘快捷键
├── patches.css             # 样式补丁
├── LOGO.png                # 项目 Logo
├── HZYAI LOGO.png          # AI 功能 Logo
├── NFLSHC 校歌.mp3          # 校歌音频
├── NFLSHC Chat.apk         # Android 客户端
└── .github/workflows/
    └── deploy.yml          # GitHub Pages 部署工作流
```

---

## 🚀 部署指南

### 方式一：GitHub Pages（推荐）

1. **Fork 本仓库** 到你的 GitHub 账号
2. **创建 Token**：GitHub Settings → Developer settings → Personal access tokens → 生成一个有 `repo` 权限的 Token
3. **配置 Secret**：仓库 Settings → Secrets and variables → Actions → 添加 `TOKEN`，值为上一步生成的 Token
4. **启用 Pages**：仓库 Settings → Pages → Source 选择 "GitHub Actions"
5. **推送代码** 即可自动部署

### 方式二：本地开发

```bash
# 克隆仓库
git clone https://github.com/user-henry/nflshcchat.git
cd nflshcchat

# 本地配置（修改 config.js 中的 GitHub 信息）
# 然后用任意 HTTP 服务器打开
npx serve .
# 或
python3 -m http.server 8080
```

---

## ⚠️ 注意事项

| 注意点 | 说明 |
|--------|------|
| **数据公开可见** | GitHub Issues 是公开的，请勿在聊天中分享敏感个人信息 |
| **API 速率限制** | 未认证 60 次/小时，认证后 5000 次/小时，多人同时使用可能触发限制 |
| **语音消息大小** | base64 编码存储在 Issue Body 中，单条约 50KB 上限 |
| **好友页主题** | `friends.html` 使用硬编码暗色主题，与 `themes.css` 的主题切换不联动（已知问题） |
| **头像功能** | 当前仅支持 URL 输入方式，不支持本地上传（之前尝试了 Imgur/Catbox 等上传方案均不可靠） |

---

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| HTML / CSS / JavaScript | 前端（零框架，原生实现） |
| GitHub REST API v3 | 数据存储与用户认证 |
| Chart.js | 数据可视化（趋势图 / 分布图 / 词云） |
| highlight.js | 代码语法高亮（atom-one-dark 主题） |
| MediaRecorder API | 浏览器端录音 |
| GitHub Pages | 静态网站托管 |
| GitHub Actions | 自动部署 |

---

## 📄 开源协议

MIT License — 欢迎学习和参考，但请注意本项目仅适用于教育和学习目的，不建议用于生产环境。
