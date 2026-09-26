# NFLSHC 新功能说明（2026-09-26）

本轮为**主站 `nflshcchat`** 新增 7 项能力，全部已部署并跑通端到端自测（`node test-new-features.mjs`，29/29 通过）。

| # | 功能 | 页面/入口 | 后端接口 |
|---|------|-----------|----------|
| 1 | Google 账号登录 | `index.html`、`chatai/index.html`、`chatai/share.html` | `/api/auth/google/{config,start,callback,exchange}` |
| 2 | 管理员健康看板 | `health.html`（`admin.html` 导航入口） | `/api/admin/health`、`/api/admin/health/errors` |
| 3 | 登录设备列表 + 一键下线 | `security.html` | `/api/auth/sessions`、`/api/auth/sessions/<id>`、`/api/auth/sessions/revoke-others` |
| 4 | 隐私政策 / 用户协议 / 数据导出 / 注销 | `privacy.html`、`terms.html`、`security.html` | `/api/account/{export,delete,delete/cancel,status}` |
| 5 | 消息附件（统一到文件托管） | `chat.html`（📎 / 粘贴 / 拖拽） | `/api/files/upload`（Worker 中转）+ 文件站 `api.php?a=sso_upload` |
| 6 | 扫码登录（手机端扫） | `index.html`（二维码弹窗 + `?qr=<id>` 确认页） | `/api/auth/qr/{create,info,confirm,poll,cancel}` |
| 7 | 会议（快速/预定/编号/邀请/会中聊天/音视频） | `meeting.html`、`meeting-room.html` | `/api/meeting/*` |

---

## 1. Google 账号登录

- Worker 用 `GOOGLE_CLIENT_ID`（`wrangler.toml` 的 `[vars]`）+ `GOOGLE_CLIENT_SECRET`（`wrangler secret put`）实现完整的 OAuth 2.0 授权码流程。
- 免 DNS 校验的回跳方案：`start → Google → Worker 回调 → 一次性 ticket → 前端 #google_login=<ticket> → exchange`。
- 前端按钮自动探测：`GET /api/auth/google/config` 返回 `enabled:false` 时按钮隐藏，配置缺失不会报错。
- `redirect` 参数受 `GOOGLE_REDIRECT_HOSTS` 白名单限制，防止开放重定向。
- 详细配置步骤见 `docs/GOOGLE-LOGIN.md`。

## 2. 管理员健康看板（限管理员）

- 页面：`health.html`。非管理员访问后端返回 403，前端显示「仅管理员可访问」。
- 指标：总用户数、24h 新增用户、活跃/过期会话、消息总数与 24h 消息、HZYAI 对话数、开放平台授权/应用数、24h 错误与慢请求、待确认扫码、进行中/预定会议、待处理注销申请。
- 服务连通性探测：AI 网关、文件托管（源站 + HTTPS 入口）、Google 公钥、BigModel（智谱），逐项显示 HTTP 状态与耗时。
- 错误明细：`/api/admin/health/errors?limit=80`，支持按 `error` / `slow` 前端过滤。
- 数据来源为 `metrics_events` 表，由 `recordMetric()` 异步写入（写入失败静默，不影响主流程）；当前已接入：登录成功、Worker 未捕获异常。后续可在任意位置加一行 `await recordMetric(env, {...})` 扩展。

## 3. 登录设备（会话）列表 + 一键下线

- 行为变更：**登录不再作废其他设备的令牌**，改为登记独立会话（`auth_tokens.session_id`）。
- 每账号最多保留 `MAX_SESSIONS_PER_USER = 10` 个有效会话，超出的最旧会话被清理；过期会话自动删除。
- `last_seen_at` 由 `touchSession()` 维护，5 分钟节流，避免每个请求都写库。
- 页面可查看设备标签（浏览器 · 系统）、IP、登录方式（`password` / `google` / `qr` / `reset`）、首次登录、最近活跃、到期时间，并支持：
  - 单个下线：`DELETE /api/auth/sessions/<session_id>`
  - 下线其他所有设备：`POST /api/auth/sessions/revoke-others`
  - 退出本机（下线的若是当前会话，前端自动清 token 并跳登录页）
- 重置密码仍会作废该账号全部旧会话，只保留本次登录设备（安全敏感操作）。

## 4. 隐私政策 / 用户协议 / 数据导出 / 注销（GDPR 风格）

- `privacy.html`：收集范围、用途、Cookie 与本地存储、存储与安全、第三方服务（Google/Cloudflare/EmailJS/WebRTC-STUN/AI 模型）、共享、用户权利、保留期限、未成年人、更新与联系方式。
- `terms.html`：服务内容、账号安全、行为规范（违法内容清单）、知识产权、**文件托管额度**、会议与音视频、开放平台、违规处理与申诉、变更终止、免责与责任限制、争议解决。
- 数据导出：`GET /api/account/export` → 直接下载 JSON（账号资料、消息、好友、收藏、HZYAI 对话、开放平台授权、登录设备、会议记录；**不含** token 与密码哈希）。
- 注销：`POST /api/account/delete {confirm:<用户名>, reason?}` → 7 天冷静期（`account_deletions` 表），期间可 `POST /api/account/delete/cancel` 撤销；`GET /api/account/status` 查询状态。前端要求用户手动输入自己的用户名做二次确认。

## 5. 消息附件（统一到文件托管）

- 前端：`chat.html` 输入区新增 📎 按钮，并支持**粘贴图片**与**拖拽文件**；上传成功后自动作为一条消息发出：
  - 图片 → Markdown 内嵌 `![标题](直链)`
  - 音视频 → 带图标的链接
  - 其他 → `📎 [文件名](下载页) · 大小`
- 后端：`POST /api/files/upload`（multipart，≤20MB）由 Worker **中转**到文件托管站，无需用户二次登录：
  - Worker 用 `FILES_SSO_SECRET` 以 HMAC-SHA256 签发 5 分钟票据：`base64(username)|exp|hmac(username|exp)`
  - 请求头 `X-Files-Ticket` 传给文件站 `api.php?a=sso_upload`
  - 文件站校验签名与有效期，首次调用自动建号（`users.sso_only = 1`，密码为随机不可用值），并沿用既有的**个人配额 / 站点总量**限制
  - **返回地址统一为 HTTPS 公开入口**：Worker 用 `X-Media-Host: file.nflshcchat.cc.cd` + `X-Media-Proto: https`
    让文件站按该域名生成链接，并额外做一次 `toPublicFileUrl()` 兜底改写。源站 `http://nflshcfile.l.cd`
    在 HTTPS 页面里属于混合内容，浏览器会直接拦截导致图片不显示，因此**任何对外链接都不允许出现源站地址**。
    `chat.html` 渲染历史消息时也会把旧地址改写为 HTTPS 入口。
- 配额：新用户默认 1GB，站长账号 5GB，站点软上限 4.5GB；超限返回 413 与中文提示。
- 更小的附件走此通道；更大文件引导到文件托管站分片上传（`https://file.nflshcchat.cc.cd/`）。

## 6. 扫码登录（手机端扫）

- PC 端：`index.html` →「📱 使用手机扫码登录」→ `POST /api/auth/qr/create` 得到 `{id, secret}`，把 `https://<站点>/index.html?qr=<id>` 渲染成二维码（`js/qrcode.js`，纯前端实现、无 CDN 依赖），每 2 秒 `POST /api/auth/qr/poll {id, secret}` 轮询。
- 手机端：扫码打开链接 → 若已登录直接弹确认框（显示请求设备与 IP）→ `POST /api/auth/qr/confirm {id}`；未登录则先登录再自动进入确认流程。
- 安全设计：二维码 3 分钟有效、**一次性**（取到 token 即删除）、轮询必须携带 `secret`（防他人猜 id 窃取）、可 `POST /api/auth/qr/cancel` 取消。
- `js/qrcode.js` 的正确性已用参考实现逐模块比对验证：`node tools-qr-verify.mjs`（需先 `npm i --no-save qrcode`），6/6 完全一致（含中文 UTF-8）。

## 7. 会议

- `meeting.html`：创建**快速会议**（立即开会）或**预定会议**（时间/时长/密码/邀请人），用**会议编号**加入，查看「我的会议」（全部 / 即将开始 / 进行中 / 已结束），复制编号与邀请链接、主持人结束会议；可从好友列表快速勾选邀请对象。
- 会议编号形如 `ABC-123-XYZ`（去掉易混字符），全局唯一；可设会议密码；也可 `meeting.html?code=XXX` 直接通过邀请链接进入。
- 邀请会写入 `notifications` 表，被邀请人在站内收到「📅 会议邀请」通知（含会议编号）。
- `meeting-room.html`：会中页面
  - 参与者列表（含主持人 👑、加入状态）、会议编号一键复制
  - **会中聊天**（2.5 秒轮询，消息落库 `meeting_messages`，会后可回看）
  - **语音 / 视频**：WebRTC 网状（mesh）点对点连接，信令通过 `meeting_signals` 表轮询中转；使用公共 STUN；媒体流不经服务器、不录制
  - 主持人可结束会议；离开会议会更新成员状态
- 技术细节：用户名较大的一方主动发起 offer（避免 glare）；ICE candidate 在远端描述未就绪时排队，随后冲刷；双方镜像：谁先开麦/摄像都会补轨道并重新协商。

---

## 数据库新增对象

```
oauth_identities      Google/第三方身份绑定
google_login_tickets  Google 回跳一次性票据
qr_login_sessions     扫码登录会话（id, secret, status, ...）
account_deletions     注销申请（7 天冷静期）
metrics_events        健康看板运行指标
meetings              会议（id, code, title, host, kind, status, scheduled_at, duration_min, password, note）
meeting_members       会议成员（role: host/guest；state: invited/joined/left）
meeting_messages      会中聊天
meeting_signals       WebRTC 信令（offer/answer/ice）
auth_tokens 新增列    session_id, device_label, user_agent, ip, last_seen_at, via
users 新增列（文件站） sso_only
```

## 部署与运维

```bash
# Worker（主站后端）
cd nflshcchat && npx wrangler deploy

# 密钥（只需设置一次）
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put FILES_SSO_SECRET     # 需与文件站 config.php 的 sso_secret 一致

# 文件站（byethost）上传改动文件到 /nflshcfile.l.cd/htdocs/
powershell -File byethost/ftp.ps1 put -Path /nflshcfile.l.cd/htdocs/api.php -Local byethost/filehost/api.php
powershell -File byethost/ftp.ps1 put -Path /nflshcfile.l.cd/htdocs/lib.php -Local byethost/filehost/lib.php
powershell -File byethost/ftp.ps1 put -Path /nflshcfile.l.cd/htdocs/config.php -Local byethost/filehost/config.php
```

自检脚本：

```bash
node test-new-features.mjs     # 会话/扫码/导出注销/健康/会议/附件 全链路（29 项）
node test-security-flows.mjs   # 安全回归：吊销是否真失效、扫码 token 是否可用、导出是否泄露（31 项）
node test-attachment-url.mjs   # 附件地址是否为 HTTPS 公开入口、图片能否真正取到（12 项）
node tools-check-html.mjs *.html   # 内联脚本语法检查
node tools-check-links.mjs *.html  # 本地引用完整性检查
node tools-qr-verify.mjs       # 二维码生成器与参考实现逐模块比对
```

> 网络受限时（`github.com:443` 不可达但 `api.github.com` 可用）可用 `tools-gh-batch.mjs`
> 通过 Contents API 上传文件：先 `$env:GH_TOKEN='<token>'`，再
> `node tools-gh-batch.mjs put user-henry/nflshcchat main "提交说明" list.json`。

## 安全注意

- **切勿把 `Token.txt`、`deepseek-api-key.txt`、`nva-api-key.txt`、`byethost/.sso_secret.txt` 提交到仓库**（已加入 `.gitignore`）。其中 GitHub Token 曾存在于公开仓库历史中，建议到 GitHub 吊销并重新签发。
- 文件站的 `config.php`（含数据库口令与 `sso_secret`）已被 `.gitignore` 排除，只会通过 FTP 上传。
- 所有跨站写操作都要求 `Authorization: Bearer <token>`，令牌 30 天有效且可按设备吊销。
