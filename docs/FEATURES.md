# NFLSHC 功能与接入文档

面向开发者：本文件描述**主站 `nflshcchat`** 的功能清单、接口契约与接入要点。
部署步骤见文末「部署与运维」。最近更新：2026-09。

> 后端实现位于 Cloudflare Worker（`worker.js` + `wrangler.toml`）。
> 按本项目约定，**Worker 源码与部署配置不进仓库**，只在本机工作副本中维护并通过 `wrangler deploy` 发布；
> 本文件描述其对外接口契约，供前端与第三方接入使用。

| # | 功能 | 前端入口 | 后端接口 |
|---|------|-----------|----------|
| 1 | Google 账号登录 | `index.html`、`chatai/index.html`、`chatai/share.html` | `/api/auth/google/{config,start,callback,exchange}` |
| 2 | 管理员健康看板 | `health.html`（`admin.html` 导航入口） | `/api/admin/health`、`/api/admin/health/errors` |
| 3 | 登录设备列表 + 一键下线 | `security.html` | `/api/auth/sessions`、`/api/auth/sessions/<id>`、`/api/auth/sessions/revoke-others` |
| 4 | 隐私政策 / 用户协议 / 数据导出 / 注销 | `privacy.html`、`terms.html`、`security.html` | `/api/account/{export,status,delete,delete/cancel}` |
| 5 | 消息附件（统一到文件托管） | `chat.html`（📎 按钮 / 粘贴 / 拖拽） | `/api/files/upload`（Worker 中转）→ 文件站 `api.php?a=sso_upload` |
| 6 | 扫码登录（手机端扫） | `index.html`（二维码弹窗 + `?qr=<id>` 确认页） | `/api/auth/qr/{create,info,confirm,poll,cancel}` |
| 7 | 会议（快速/预定/编号/邀请/会中聊天/音视频/屏幕共享/共享白板） | `meeting.html`、`meeting-room.html` | `/api/meeting/*`、`/api/rtc/ice` |
| 8 | 笔记（独立笔记 + 会议笔记：逐字稿 / 讨论区 / 纪要） | `notes.html`、`meeting-room.html` 笔记面板 | `/api/notes/*` |
| 9 | 离线通知（Web Push）与日程到期提醒 | `security.html`（开启通知）、`sw.js` | `/api/push/*`、Cron 定时任务 |
| 10 | 会议语音转文字 + AI 会议纪要 | `meeting-room.html` 笔记面板 | 浏览器语音识别 + HZYAI 网关 `POST /chat` |
| 11 | HZYAI 学习：AI 讲题 + 错题本 | `study.html`（`hzyai.html` 入口） | `/api/study/*` |
| 12 | Passkey / WebAuthn 登录 | `index.html`、`security.html` | `/api/auth/webauthn/*` |
| 13 | 开放 API + JS/Python SDK | `sdk/js/nflshc.js`、`sdk/python/nflshc.py` | 见 `docs/API.md` |
| 14 | 全站功能导航（可搜索） | `pages.html`（`chat.html` 导航入口） | 纯前端 |

所有需要登录的接口统一使用 `Authorization: Bearer <token>`；令牌 30 天有效，可按设备吊销。

---

## 1. Google 账号登录

- Worker 通过 `GOOGLE_CLIENT_ID`（`wrangler.toml` 的 `[vars]`）与 `GOOGLE_CLIENT_SECRET`（`wrangler secret put`）实现标准 OAuth 2.0 授权码流程。
- 免 DNS 校验的回跳方案：`start → Google → Worker 回调 → 一次性 ticket → 前端 #google_login=<ticket> → exchange`，
  长期令牌不出现在 URL 中。
- 前端按钮自动探测：`GET /api/auth/google/config` 返回 `enabled:false` 时按钮保持隐藏，配置缺失不会报错。
- `redirect` 参数受 `GOOGLE_REDIRECT_HOSTS` 白名单限制，防止开放重定向。
- 完整配置步骤与账号关联规则见 [`GOOGLE-LOGIN.md`](./GOOGLE-LOGIN.md)。

## 2. 管理员健康看板

- 页面：`health.html`，仅管理员可用。权限以接口返回为准：`403` → 弹窗提示「无权访问」，`401` → 弹窗提示先登录；
  弹窗可跳转登录页或聊天页。
- 指标（`counts`）：总用户数、24h 新增用户、活跃/过期会话、消息总数与 24h 消息、HZYAI 对话数、
  开放平台授权数与应用数、24h 错误数与慢请求数、待确认扫码、进行中/预定会议、待处理注销申请。
- 服务连通性探测（`services`）：AI 网关（hzyai-worker）、文件托管源站、文件托管 HTTPS 入口、
  Google 公钥。每项返回 `{name, ok, status, ms, detail}`。
- 错误明细：`GET /api/admin/health/errors?limit=80` → `{events:[{kind,name,detail,status,ms,username,ip,created_at}]}`，
  `kind` 为 `error`（5xx/异常）或 `slow`（慢请求）。
- 数据来源为 `metrics_events` 表，由 `recordMetric(env, {...})` 异步写入（写失败静默，不影响主流程）。
  已接入：登录成功、Worker 未捕获异常；扩展只需在目标位置加一行 `await recordMetric(env, {...})`。

## 3. 登录设备（会话）管理

- 会话模型：一次登录登记一条独立会话，**不再作废其他设备的令牌**。
  会话信息落在 `auth_tokens`（`session_id` / `device_label` / `user_agent` / `ip` / `last_seen_at` / `via`）。
- 每账号最多保留 `MAX_SESSIONS_PER_USER = 10` 个有效会话，超出时清理最久未活跃的；过期会话自动删除。
- `touchSession()` 维护最近活跃时间，5 分钟节流，避免每个请求都写库。
- `GET /api/auth/sessions` → `{sessions:[{id, device, ip, via, createdAt, lastSeenAt, expiresAt, current}]}`；
  `via` ∈ `password` / `google` / `qr` / `reset`。
- `DELETE /api/auth/sessions/<session_id>` 下线指定设备；`POST /api/auth/sessions/revoke-others` 下线其他所有设备。
- 重置密码属于敏感操作：作废该账号全部旧会话，只保留本次登录设备。

## 4. 隐私合规：政策页面 / 数据导出 / 注销

- `privacy.html`：收集范围、用途、Cookie 与本地存储、存储与安全、第三方服务
  （Google / Cloudflare / EmailJS / WebRTC-STUN / AI 模型）、信息共享、用户权利、保留期限、未成年人、联系方式。
- `terms.html`：服务内容、账号安全、行为规范、知识产权、文件托管额度、会议与实时音视频、
  开放平台、违规处理与申诉、变更终止、免责与责任限制、争议解决。
- 数据导出：`GET /api/account/export` 直接下载 JSON（账号资料、消息、好友、收藏、HZYAI 对话、
  开放平台授权、登录设备、会议记录）。**不含**可用令牌与密码哈希。
- 注销：`POST /api/account/delete {confirm:"<用户名>", reason?}` 进入 **7 天冷静期**（`account_deletions`），
  期间可 `POST /api/account/delete/cancel` 撤销；`GET /api/account/status` 查询状态。
  用户名为空或不匹配时返回 `400 {code:'need_confirm'}`。

## 5. 消息附件（统一到文件托管）

前端（`chat.html`）：

- 三个入口：📎 按钮、粘贴图片、拖拽文件，统一走同一个上传流程；
- 上传成功后把内容填入消息输入框（图片为 Markdown 内嵌 `![标题](直链)`，音视频为带图标链接，
  其它为 `📎 [文件名](下载页) · 大小`），由用户确认后发送；
- 渲染历史消息时会把旧的源站地址改写为 HTTPS 公开入口。

后端（`POST /api/files/upload`，multipart，单项 ≤20MB）：

- Worker 用 `FILES_SSO_SECRET` 以 HMAC-SHA256 签发 5 分钟票据：`base64(username)|exp|hmac(username|exp)`，
  通过请求头 `X-Files-Ticket` 传给文件站 `api.php?a=sso_upload`；
- 文件站校验签名与有效期，首次调用自动建号（`users.sso_only = 1`，密码为随机不可用值），
  并沿用既有的个人配额 / 站点总量限制；
- **返回地址必须是 HTTPS 公开入口**：Worker 发送 `X-Media-Host: file.nflshcchat.cc.cd` + `X-Media-Proto: https`
  让文件站按该域名生成链接，并额外做一次 `toPublicFileUrl()` 兜底改写。
  源站 `http://nflshcfile.l.cd` 在 HTTPS 页面中属于混合内容，会被浏览器拦截，因此对外链接不得出现源站地址；
- **直链走 media 入口**：`toPublicFileUrl()` 会把文件站的静态直链
  `http://nflshcfile.l.cd/storage/pub/<分片>/<id>.<扩展名>` 改写成
  `https://media.nflshcchat.cc.cd/pub/<分片>/<id>?e=<扩展名>&n=<原文件名>`。
  页面地址（`url` / `viewUrl`）仍留在 `file.nflshcchat.cc.cd`。原因与缓存清理见 `docs/FILE-HOST.md`；
- 配额：新用户默认 1GB，站长账号 5GB，站点软上限 4.5GB，超限返回 `413`；
- 超过 20MB 的文件请引导用户到文件托管站（`https://file.nflshcchat.cc.cd/`）分片上传，业务上限 512MB。
- 删除：`POST /api/files/delete { id, urls? }`（`urls` 传该文件的公开直链，服务端删完立即清缓存）。
  文件在文件站已不存在时按成功返回 `{ok:true, alreadyGone:true}`，前端据此清理本地记录而不是报错。

## 6. 扫码登录

- 取码（PC）：`POST /api/auth/qr/create` → `{id, secret, expiresAt}`（3 分钟有效）。
  前端把 `https://<站点>/index.html?qr=<id>` 渲染成二维码（`js/qrcode.js`，零依赖实现），
  每 2 秒 `POST /api/auth/qr/poll {id, secret}` 轮询。
- 确认（手机）：扫码打开 `?qr=<id>` → 若已登录则 `GET /api/auth/qr/info?id=` 展示设备与 IP，
  用户确认后 `POST /api/auth/qr/confirm {id}`；未登录则先登录，再自动进入确认流程。
- 安全设计：一次性（取到 token 即删除记录）、轮询必须携带 `secret`（防止猜 id 窃取）、
  支持 `POST /api/auth/qr/cancel` 取消；确认成功后由服务端签发新会话（`via='qr'`）。

## 7. 会议

`meeting.html`（会议中心）：

- 快速会议（立即开会）与预定会议（开始时间 / 时长 / 可选会议密码 / 邀请人）；
- 会议编号形如 `ABC-123-XYZ`（剔除易混字符），全局唯一；`meeting.html?code=XXX` 可直接加入；
- 我的会议（全部 / 即将开始 / 进行中 / 已结束），支持复制编号与入会链接、主持人结束会议；
- 邀请写入 `notifications`（类型 `meeting`），被邀请人站内收到「📅 会议邀请」通知。

`meeting-room.html`（会中）：

- 参与者列表（主持人标记、加入状态）、会议编号复制、会中聊天（落库 `meeting_messages`，会后可回看）；
- 语音/视频为 WebRTC 点对点（mesh），信令经 `meeting_signals` 表轮询中转，使用公共 STUN，
  媒体流不经服务器、不录制；
- 页面内置诊断条：入会状态、信令状态、每个对端的 `connectionState`，以及「🔄 重新连接」（ICE 重启）。

**接入约定（改动前请先读，否则很容易出现「能听见但看不到」这类问题）**：

1. **进房间必须先入会**：`meeting-room.html` 打开时先调 `POST /api/meeting/join`（`{code}` 支持会议编号或会议 id）。
   未入会直接进房间会让聊天与信令接口全部 `403`，表现为成员列表为空、完全无声音画面。
2. **媒体轨道用 `replaceTrack` 挂载**：建连接时就 `pc.addTransceiver('audio'|'video', {direction:'sendrecv'})`，
   之后开启麦克风/摄像头只对 transceiver 的 `sender` 调 `replaceTrack`——不需要重新协商，媒体立即开始发送。
   若改为「先 offer 再 `addTrack`」，协商出的 video m-line 会是 `recvonly`/`inactive`，对方无法把画面送过来。
3. **协商由一方发起**：用户名较大的一方负责发 offer；另一方需要重新协商时，
   发送 `kind:'ice'` + `payload:{__renegotiate:true}` 请求对方发新 offer（避免双方同时 offer 造成 glare）。
   需要 ICE 重启时带 `payload:{__renegotiate:true, iceRestart:true}`。
4. **离开要通知服务端**：用 `fetch(..., {keepalive:true})` 携带 `Authorization` 头调用 `/api/meeting/leave`
   （`navigator.sendBeacon` 无法携带鉴权头，会造成「幽灵成员」一直显示在线）。
5. **同一账号在多个标签页无法互通**（对端按用户名区分），测试请用两个账号或两台设备。

---


## 8. 笔记（独立笔记 + 会议笔记）

- 数据：`notes`（`owner` / `title` / `content` / `kind` / `meeting_id`）+ `note_shares`（`can_edit`）。
- 权限模型：`owner`（可改可删可共享）> `edit`（可改）> `view`（只读）；
  `kind='meeting'` 的笔记额外对该会议**所有成员**开放只读。
- 接口：
  - `POST /api/notes/create {title?, content?, kind?, meetingId?}`
  - `GET  /api/notes/list`（我的 + 共享给我的 + 我所在会议的会议笔记）
  - `GET  /api/notes/get?id=` → `{ note, shares, role, canEdit }`
  - `POST /api/notes/update {id, title?, content?}`（需 owner/edit）
  - `POST /api/notes/delete {id}`（仅 owner）
  - `POST /api/notes/share {id, username, canEdit}` / `POST /api/notes/unshare {id, username}`（仅 owner，
    共享时会给对方写一条站内通知）
  - `GET  /api/notes/meeting?meetingId=&create=1`（会议成员可读；会议笔记由主持人拥有）
- 页面：`notes.html`（列表 + 搜索 + Markdown 编辑/预览 + 自动保存 + 共享管理），
  支持 `notes.html?id=<noteId>` 直达某篇。

## 9. 离线通知（Web Push）与日程提醒

- 订阅：`GET /api/push/key` 取 VAPID 公钥 → `POST /api/push/subscribe {subscription}`；
  `POST /api/push/unsubscribe`、`POST /api/push/test` 分别为退订与自测。
- 发送端：Worker 用 VAPID（ES256 JWT）+ RFC 8291 `aes128gcm` 加密推给各浏览器订阅；
  订阅失效（404/410）时自动清理。前端 `sw.js` 负责 `push` 与 `notificationclick`。
- 定时任务：`wrangler.toml` 的 `[triggers] crons = ["*/5 * * * *"]`，
  `scheduled()` 扫描 `misc_issues` 中 `calendar_<用户名>` 的事件（字段 `start` / `remindMinutes`），
  到点写站内通知并推送，已发送的记入 `calendar_reminders`（不重复提醒）。
  时间按**北京时间（UTC+8）**解释。
- 用户侧入口：`security.html` → 「🔔 离线通知」卡片（开启 / 测试 / 关闭）。

## 10. 会议语音转文字与 AI 会议纪要

- 语音转文字用浏览器 `SpeechRecognition`（zh-CN，连续识别），每段最终结果以
  `- [时间] **发言人**：内容` 追加到会议笔记的「## 语音逐字稿」小节。
- 生成纪要：把笔记内容 + 讨论区消息拼成提示词，调用 HZYAI 网关
  `POST https://hzyai-worker.nflshcchat.cc.cd/chat`（`{messages, max_tokens}` → `{response}`），
  结果以「## 会议纪要（AI 生成于 …）」写入同一篇笔记。
- 讨论区消息可用「📥 导入讨论区」一次性写入「## 讨论区记录」小节。
- 逐字稿、讨论区记录、纪要**全部保存在同一篇会议笔记**中，会后可在 `notes.html` 查看、修改、共享。

## 11. 会议 / 通话的网络穿透（只用 STUN）

- `GET /api/rtc/ice` 下发 ICE 配置，**只含公共 STUN**（`stun.l.google.com:19302`、
  `stun1.l.google.com:19302`、`stun.cloudflare.com:3478`），返回 `source: "stun-only"`；
  不再下发 TURN，也不需要 `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` 之类的配置。
- 会议页（`meeting-room.html`）与 1 对 1 通话（`chat.html`）使用同一套策略：
  把内置的 STUN 列表直接交给 `RTCPeerConnection`，双方发现各自公网地址后点对点直连，
  媒体不经服务器；会议页启动时仍会取一次 `/api/rtc/ice`，仅用于诊断条展示，
  取不到就用内置列表，保证会议一定能开始。
- 为什么不再用 TURN：此前在未配置自有 TURN 时会回退到公共中继（Open Relay），
  公共中继不稳定/凭据失效时 ICE 会长时间收集不到可用的 relay 候选甚至卡住协商，
  表现为「能进会议但连不上、没有声音画面」，而 STUN 直连路径简单、延迟最低。
- 代价：双方都处于对称 NAT 时点对点可能打不通（此时会显示「连接不稳定」并自动做 ICE 重启）。
  若将来需要覆盖这种网络，建议接入自建 TURN 并在 `createPeer()` 的 `RTC_CONFIG` 里按需增加。

## 12. 会议屏幕共享与共享白板

- 屏幕共享：`getDisplayMedia()` 取屏幕轨道后，对已协商好的 video transceiver 做 `replaceTrack`
  ——无需重新协商；停止共享时恢复原摄像头轨道。对方画面自动切换，本地预览也会切到共享内容。
- 共享白板：固定虚拟画布 1600×900，各端按容器缩放，坐标一致。
  - `POST /api/meeting/board {meetingId, stroke:{tool,color,width,points}}` 提交一笔
  - `GET  /api/meeting/board?meetingId=&since=` 增量拉取（会议页每 700ms 轮询）
  - `POST /api/meeting/board/clear {meetingId}` 清空（仅主持人）
  - 坐标在服务端裁剪到 0..1600 / 0..900，单笔最多 800 点、序列化后不超过 20KB
  - 支持画笔/橡皮/颜色/粗细、保存为 PNG 图片

## 13. HZYAI 学习：AI 讲题与错题本

- 页面：`study.html`（入口：`hzyai.html` 与 HZYAI 侧边栏「📚 学习」）。
- AI 讲题：`POST /api/study/solve { question?, imageUrl?, subject?, save? }`
  - 传图片时走 HZYAI 网关 `POST /vision`（识别图片中的题目），传文字时走 `POST /chat`；
  - 固定输出结构：学科与知识点 → 解题思路（分步） → 完整解答 → 易错点提醒；
  - `save:true` 时讲解结果直接写入错题本，返回 `savedId`。
- 错题本：
  - `GET  /api/study/mistakes?subject=&status=&q=` → `{ mistakes, subjects, stats }`
  - `POST /api/study/mistakes { question, answer?, explanation?, subject?, imageUrl?, tags?, source? }`
  - `POST /api/study/mistakes/update { id, status?, subject?, tags?, answer?, explanation?, reviewed? }`
    （`reviewed:true` 使复习次数 +1 并记录最近复习时间）
  - `POST /api/study/mistakes/delete { id }`
  - `status` ∈ `open`（未掌握）/ `reviewing`（复习中）/ `mastered`（已掌握）
  - 数据按 `username` 隔离，他人无法读改
- 同类练习：`POST /api/study/practice { id? | question?, count? }` → 让 AI 出同知识点、同难度的题目（含答案与解析）。

---

## 14. Passkey / WebAuthn 登录

- 流程：浏览器 `navigator.credentials.create/get`，服务端完整校验 `challenge`（一次性、5 分钟）、
  `origin`（白名单：`*.nflshcchat.cc.cd`、`*.chatai.bot.cd`）、`rpIdHash`、UP 标志与 **ES256 签名**。
- 接口：
  - `POST /api/auth/webauthn/register/begin`（需登录，`{origin}`）→ `{ challengeKey, options }`
  - `POST /api/auth/webauthn/register/finish`（需登录，`{challengeKey, origin, clientDataJSON, attestationObject}`）
  - `POST /api/auth/webauthn/login/begin`（匿名，`{username?, origin}`）→ 无 username 时返回可发现凭据选项
  - `POST /api/auth/webauthn/login/finish`（匿名）→ 校验通过后签发会话（`via='passkey'`）
  - `GET  /api/auth/webauthn/credentials`、`POST /api/auth/webauthn/credentials/delete {id}`
- 服务端内含最小 CBOR 解码器（解析 `attestationObject` / `authData` / COSE 公钥），
  不校验 attestation 证书链（平台通行密钥普遍为 `none`）。
- 前端入口：登录页「🔑 用通行密钥登录」、`security.html` 的「🔑 通行密钥」卡片（添加 / 列表 / 删除）。

## 15. 开放 API 与 SDK

- 完整接口清单与接入说明见 [`API.md`](./API.md)。
- SDK：[`../sdk/js/nflshc.js`](../sdk/js/nflshc.js)（`NFLSHC` 客户端 + `NFLSHCOAuth` 授权码流程）、
  [`../sdk/python/nflshc.py`](../sdk/python/nflshc.py)（同等能力，仅标准库）。
- 覆盖能力：账号与会话、消息、好友收藏、会议（含信令/白板）、笔记、学习、文件上传、OAuth、机器人。

## 16. 全站功能导航页

- `pages.html`：按分类（核心 / 沟通协作 / 学习与创作 / 账号与安全 / 数据与统计 / 管理 / 趣味 / 外部站点）
  列出**全部页面与外部站点**，含功能说明、直达链接、管理员标记，支持关键词搜索（名称/说明/网址）
  与分类筛选；入口在 `chat.html` 顶部导航的「🧭 功能导航」。

## 数据库对象

```
oauth_identities      Google / 第三方身份绑定
google_login_tickets  Google 回跳一次性票据
qr_login_sessions     扫码登录会话（id, secret, status, expires_at, username, token）
account_deletions     注销申请（requested_at, effective_at, cancelled_at, reason）
metrics_events        健康看板运行指标（kind, name, detail, status, ms, username, ip）
meetings              会议（id, code, title, host, kind, status, scheduled_at, duration_min, password, note）
meeting_members       会议成员（role: host/guest；state: invited/joined/left）
meeting_messages      会中聊天
meeting_signals       WebRTC 信令（from_user, to_user, kind: offer/answer/ice, payload）
meeting_board         会议共享白板笔画（meeting_id, username, stroke, created_at）
notes                 笔记（owner, title, content, kind: note/meeting, meeting_id）
note_shares           笔记共享（note_id, username, can_edit）
calendar_reminders    日程提醒发送记录（event_id, username, notified_at）
push_subscriptions    Web Push 订阅（endpoint, username, p256dh, auth）
mistake_book          错题本（username, subject, question, answer, explanation, image_url, tags,
                      status: open/reviewing/mastered, review_count, last_review_at）
webauthn_credentials  Passkey 凭据（id, username, public_key(COSE), sign_count, rp_id, label）
webauthn_challenges   WebAuthn 一次性挑战（key, challenge, type, username, expires_at）
auth_tokens 新增列    session_id, device_label, user_agent, ip, last_seen_at, via
users（文件站）新增列  sso_only
```

## 部署与运维

```bash
# 主站 Worker
npx wrangler deploy

# 密钥（仅首次需要）
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put FILES_SSO_SECRET     # 必须与文件站配置项 sso_secret 一致
```

- **本仓库只包含前端与文档**：主站后端（Cloudflare Worker：`worker.js` + `wrangler.toml`）与
  自建文件托管站（byethost 上的 PHP 站点）的源码、部署脚本与凭据都**不在本仓库**，
  只由维护者在本地工作副本中部署。前端接入所需的接口契约已完整写在本文件中。
- 前端资源改动后请同步更新引用处的 `?v=` 版本号（`js/theme.js?v=4`、`css/themes.css` 等），避免 CDN/浏览器缓存。

## 安全注意事项

- 凭据文件（`Token.txt`、`deepseek-api-key.txt`、`nva-api-key.txt`、文件站 `.sso_secret.txt`）
  已在 `.gitignore` 中排除，切勿提交。
- 文件站的 `config.php`（数据库口令 + `sso_secret`）同样不入库，只通过 FTP 上传。
- 所有跨站写操作都要求 `Authorization: Bearer <token>`。
