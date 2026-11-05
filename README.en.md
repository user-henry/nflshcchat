**English** | [简体中文](README.md)

# NFLSHC Chat 🎓💬

> A student chat platform for Nanjing Foreign Language School Huai'an Campus — pure frontend + Cloudflare D1, zero servers, zero databases

🌐 **Live demo**: [user-henry.github.io/nflshcchat](https://user-henry.github.io/nflshcchat)

---

## 📖 Overview

NFLSHC Chat is an online chat platform built for students of Nanjing Foreign Language School Huai'an Campus (NFLSHC). Its defining trait is that it **does not rely on any backend server at all**; instead it cleverly uses Cloudflare D1 as a serverless data layer — each business type (label) maps to a "table", each record is one "row", and business data is stored as JSON.

This design makes deployment free (GitHub Pages hosts the frontend for free; Cloudflare Workers + D1 provide backend capabilities for free), while Cloudflare Workers APIs deliver complete chat, user management and data statistics features. It is no longer limited by GitHub API rate limits, and is more than enough for small-scale campus use.

---

## ✨ Features

### 💬 Chat core

| Feature | Description |
|------|------|
| **Multiple chat rooms** | Create multiple chat rooms; each room is backed by a label (`chatroom`) in Cloudflare D1 |
| **Text messages** | Send and receive real-time text messages backed by Cloudflare D1 (label: `chatmessage`) |
| **Quote replies** | Messages support quote replies; a preview bar of the quoted message is shown while replying |
| **Pinned messages** | Admins can pin important messages; the pinned banner always stays at the top of the message list |
| **Code highlighting** | Integrated highlight.js (atom-one-dark theme); code blocks support one-click copy |
| **Voice messages** | Built-in MediaRecorder recording, stored as base64 (about a 50 KB limit) |
| **Image sending** | Send images in chat |
| **Keyboard shortcuts** | Common actions have shortcuts; see `shortcuts.js` |

### 👤 User system

| Feature | Description |
|------|------|
| **Register / login** | User authentication backed by Cloudflare D1 (label: `user`), no third-party accounts required |
| **Profile** | A complete profile page (`profile.html`) for changing nickname, bio and more |
| **Custom avatars** | Custom avatar URLs; avatars are fetched in batches via `loadUserAvatars()` and cached |
| **User levels** | A level/XP system based on message activity: `level = Math.floor(Math.sqrt(xp/10)) + 1` |
| | Four tiers of level styling: Lv.1-3 green → Lv.4-6 blue → Lv.7-9 purple → Lv.10+ gold |
| **Friends** | A dedicated friends page (`friends.html`) storing relationships under label: `friend` |

### 📊 Data and search

| Feature | Description |
|------|------|
| **Dashboard** | Stat cards (total messages / active members / daily average / active days) + Chart.js charts |
| | Includes: a 30-day message trend line chart, a 24-hour message distribution chart, a word cloud and a Top 10 posters ranking |
| **Global search** | Keyword search over message content with highlighted matches and multi-condition filtering |
| | Paginated loading (20 per page), covering all chat rooms |
| **Data export** | Export chat data as JSON or HTML (`export.html`) |
| **Favorites** | Favorite important messages; a dedicated management page (label: `favorite`) |

### 🎨 Interface and themes

| Feature | Description |
|------|------|
| **5 themes** | Default (dark) / Light / Blue / Purple / Green |
| | Themes are defined in `css/themes.css`; one-click switching, effective immediately |
| **Showcase page** | `showcase.html` — a flashy animated page for project introductions and demos |
| **Campus culture** | `about.html` embeds the school song (MP3) and a campus promo video |
| **Announcements** | Admins publish notices (`notice.html`) |
| **Feedback** | Users submit suggestions (`suggestions.html`); admins review them (`admin-suggestions.html`) |

### 🐂 Benben (a casual rant board)

| Feature | Description |
|------|------|
| **Post anything** | `benben.html` — any signed-in user can post a "Benben" rant; one screen at a time, new posts appear on top |
| **Markdown rendering** | Supports headings, bold, lists, quotes, code blocks and links; output goes through the allowlist filter (`js/sanitize.js`) |
| **@ mentions** | Typing `@` opens username completion (`GET /api/benben/users`); mentioned users receive an in-app "📢 Someone mentioned you" notification |
| **Replies** | Every Benben can be replied to inside its thread, with quote styling; the author receives a "💬 Someone replied to your Benben" notification |
| **Length limits** | Posts and replies are limited to 500 characters, with a live counter; over-limit sending is blocked. Each account may post at most 40 per hour to prevent spam |
| **No attachments** | Intentionally no upload entry — text only (use an image host or chat attachments for images) |
| **Delete anytime** | Authors can delete their own posts or replies (admins can delete any); deleting the original also removes its replies |

### 🛠️ Admin and AI

| Feature | Description |
|------|------|
| **Admin panel** | `admin.html` — admin-only console for users, messages, announcements, etc. |
| **AI weather** | `hzyai.html` — built-in weather lookup; enter a city name for real-time weather |
| **Statistics** | `stats.html` — a standalone data statistics page |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│     Pure HTML / CSS / JavaScript (no framework)   │
│         Chart.js · highlight.js · MediaRecorder  │
└────────────────────┬────────────────────────────┘
                     │ Cloudflare Workers API
                     ▼
┌─────────────────────────────────────────────────┐
│              Cloudflare D1 data layer             │
│                                                   │
│  label: chatmessage  →  chat messages (JSON body) │
│  label: chatroom     →  chat room metadata        │
│  label: user         →  user information          │
│  label: favorite     →  favorites                 │
│  label: friend       →  friendships               │
│  label: media        →  media files               │
│  label: notice       →  announcements             │
│  label: suggestion   →  feedback                  │
│  benben_posts        →  Benben / rants (with replies) │
└─────────────────────────────────────────────────┘
```

### Core design principles

1. **Cloudflare D1 as the database** — each business type (label) maps to a "table"; each record is one row storing JSON
2. **Zero backend cost** — free Cloudflare Pages / Workers hosting + serverless Cloudflare D1
3. **Pure frontend architecture** — no Node.js / Python backend; the browser calls Cloudflare Workers APIs directly
4. **Token authentication** — access tokens are used for user authentication and API writes

### Data format examples

```json
// A chat message (label: chatmessage record in D1)
{
  "username": "Zhang San",
  "content": "Hello everyone!",
  "roomName": "Grade 10 (1)",
  "timestamp": 1714492800000,
  "replyTo": null,
  "isPinned": false
}

// A user (label: user record in D1)
{
  "username": "Zhang San",
  "password": "stored encrypted",
  "nickname": "San",
  "avatarUrl": "https://example.com/avatar.png",
  "xp": 150,
  "level": 4,
  "bio": "Loves programming"
}
```

---

## 📁 Project structure

The repository currently contains **167 files**: 46 pages in the root directory (plus 4 StarOffice HTML pages, 50 in total); the rest are styles, scripts, documentation and assets. Everything is static, with no build step.

```
nflshcchat/
├── 【Login & entry】
│   ├── index.html              Login page (sign-up entry / QR login / WebAuthn)
│   ├── register.html           Registration page
│   ├── oauth-callback.html     OAuth open-platform callback
│   └── pages.html              Searchable navigation of all features
├── 【Chat & collaboration】
│   ├── chat.html               Main chat UI (180 KB, the core)
│   │     ├── Messages / Markdown / quote replies / recall
│   │     ├── Pinning / emoji reactions / favorites / notification panel
│   │     ├── Voice (MediaRecorder) / attachment upload, paste and drag-drop
│   │     ├── Code highlighting (highlight.js) / live preview
│   │     └── User levels / avatar cache / 1-to-1 audio-video calls
│   ├── meeting.html            Meeting center (quick meeting / schedule / join by ID)
│   ├── meeting-room.html       In-meeting (audio-video / screen share / whiteboard / chat / notes)
│   ├── notes.html              Notes (Markdown edit + preview + sharing, including meeting notes)
│   ├── benben.html             🐂 Benben board (@mentions / threaded replies / merged table cells)
│   ├── calendar.html           Calendar / class schedule (with reminders)
│   ├── polls.html              Poll center
│   ├── posts.html              Posts (Markdown + replies + emoji reactions)
│   ├── articles.html           Articles (visibility settings + Markdown + replies)
│   ├── notice.html             Announcements (admin-edited, Markdown)
│   ├── suggestions.html        Feedback
│   └── report.html             Report center
├── 【Account & personal】
│   ├── profile.html            Profile (nickname / bio / avatar)
│   ├── admin-profile.html      Admin center
│   ├── ai-profile.html         AI assistant profile
│   ├── security.html           Account security (password / passkeys / devices / deletion)
│   ├── theme.html              Theme settings (5 themes + dawn white)
│   └── friends.html            Friends / favorites.html favorites / search.html message search
├── 【Data & operations】
│   ├── dashboard.html          Personal dashboard (Chart.js)
│   ├── stats.html              Group chat statistics
│   ├── health.html             Service health board
│   ├── export.html             Data export (JSON / HTML)
│   └── image-host.html         Image host (upload / direct links / file-host connectivity check)
├── 【Fun & creation】
│   ├── music.html              Music library
│   ├── music-play.html         🎵 Music studio (real-time multi-player jam)
│   ├── music-make.html         Sound canvas (click to improvise)
│   ├── word-game.html          Word game
│   ├── hzyai.html              Redirect to HZYAI (chatai.bot.cd)
│   ├── hzyai-share.html        HZYAI conversation-share redirect
│   └── study.html              HZYAI study (tutoring + mistake notebook)
├── 【Showcase & admin】
│   ├── showcase.html           Welcome page (animated showcase)
│   ├── about.html              Promo video / about (logo animation, school song, tech stack)
│   ├── presentation.html       Tech talk deck (Cloudflare D1 Serverless Chat)
│   ├── admin.html              Admin console
│   ├── admin-suggestions.html  Suggestion review
│   └── privacy.html / terms.html
├── 【Fallbacks】
│   ├── 404.html                404
│   ├── offline.html            Offline page (PWA)
│   └── pwa-reset.html          Repair app (clear cache / unregister Service Worker)
├── css/
│   └── themes.css              Variables for the 5 themes (table borders, code block colors)
├── js/
│   ├── theme.js                Theme switching + auto Authorization for Worker requests
│   ├── sanitize.js             Markdown HTML allowlist (v2: includes merged table cells)
│   ├── marked.min.js           Markdown renderer
│   └── qrcode.js               QR codes (login / contact card sharing)
├── docs/                       Developer documentation
│   ├── API.md                  Open API and SDK integration
│   ├── FEATURES.md             All features and implementation details (security, merged cells)
│   ├── FILE-HOST.md            File host (protocol / caching / rate-limit handling)
│   ├── GOOGLE-LOGIN.md         Google sign-in integration
│   ├── MIRROR-NODE.md          Mirror / backup nodes
│   └── STAR_OFFICE_UI_OVERVIEW.md
├── sdk/                        Open-platform SDK: js/nflshc.js, python/nflshc.py
├── scripts/                    Python ops scripts: security_check.py, smoke_test.py, gemini_image_generate.py
├── backend/                    StarOffice backend (app.py, memo_utils.py, store_utils.py, security_utils.py, requirements.txt, run.sh)
├── frontend/                   StarOffice pixel office frontend (index.html, game.js, layout.js, sprites / fonts / Phaser)
├── desktop-pet/                Desktop pet (Electron): package.json, README.md, STATE_API.md
├── assets/room-reference.png   Room reference image
├── sw.js                       Service Worker (PWA offline cache, pre-cached allowlist)
├── manifest.json               PWA manifest
├── shortcuts.js                Keyboard shortcuts
├── patches.css                 Global style patches
├── favicon.ico / favicon.svg / icon-192.png / icon-512.png / apple-touch-icon.png
├── CNAME / .nojekyll / sitemap.xml
├── .env.example / package.json / pyproject.toml / railway.json / Dockerfile     Config and deployment samples
├── join-keys.sample.json / state.sample.json / runtime-config.sample.json      Config samples
├── asset-defaults.json / asset-positions.json                                  StarOffice asset defaults and coordinates
├── README.md / README-staroffice.md / INTEGRATION.md / SKILL.md
└── Assets: LOGO.png, NFLSHC.png, NFLSHC school song.mp3, group chat.png, WeChat official account.png,
         NFLSHC Chat.apk / NFLSHC Chat pro.apk (Android builds),
         survey screenshots, Be a Website Developer.pptx
```

> **Not in this repository (kept locally by project convention, never committed)**
> Main-site backend `worker.js` + `wrangler.toml`, file host `byethost/`, proxy Worker `nflshcfile-proxy/`,
> mirror Worker `nflshc-mirror/`, AI gateway `hzyai-worker/`, dev and test tooling `dev/`,
> data migration snapshots `issues_raw.json` / `issues_normalized.json`, and local secret files.
> Reason: they contain secrets or are deployment artifacts; the repository only holds **frontend pages + docs + SDK**.
> API contracts: [`docs/FEATURES.md`](docs/FEATURES.md) and [`docs/API.md`](docs/API.md);
> file hosting (media direct links, caching and deletion semantics): [`docs/FILE-HOST.md`](docs/FILE-HOST.md).

---

## 🚀 Deployment guide

### Option 1: GitHub Pages (recommended)

1. **Fork this repository** to your GitHub account
2. **Create a Token**: GitHub Settings → Developer settings → Personal access tokens → generate a token with `repo` scope
3. **Configure a Secret**: repository Settings → Secrets and variables → Actions → add `TOKEN` with the token from the previous step
4. **Enable Pages**: repository Settings → Pages → Source → choose "GitHub Actions"
5. **Push code** and it deploys automatically

### Option 2: local development

```bash
# Clone the repository
git clone https://github.com/user-henry/nflshcchat.git
cd nflshcchat

# Local configuration (edit the GitHub settings in config.js)
# Then open it with any HTTP server
npx serve .
# or
python3 -m http.server 8080
```

---

## ⚠️ Notes

| Point | Description |
|--------|------|
| **Data is publicly visible** | Cloudflare D1 data is hosted server-side; do not share sensitive personal information in chat |
| **Data access** | Data is hosted on Cloudflare D1 and synced across devices in real time, so local loss is not a concern |
| **Voice message size** | Stored as base64 inside the Issue body, with a limit of about 50 KB per message |
| **Friends page theme** | `friends.html` uses a hard-coded dark theme and does not follow `themes.css` switching (known issue) |
| **Avatars** | Currently URL input only; local upload is not supported (earlier attempts with Imgur/Catbox and similar were unreliable) |

---

## 🔧 Tech stack

| Technology | Purpose |
|------|------|
| HTML / CSS / JavaScript | Frontend (no framework, vanilla implementation) |
| Cloudflare Workers API | Data storage and user authentication |
| Chart.js | Data visualization (trends / distribution / word cloud) |
| highlight.js | Code syntax highlighting (atom-one-dark theme) |
| MediaRecorder API | In-browser recording |
| GitHub Pages | Static site hosting |
| GitHub Actions | Automated deployment |

---

## 📄 License

MIT License — learning and reference are welcome, but note that this project is intended for education and learning purposes only and is not recommended for production use.
