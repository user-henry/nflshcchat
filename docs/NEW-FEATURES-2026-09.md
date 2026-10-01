# NFLSHC 功能更新与接入说明（2026-09）

面向开发者：本文件描述**主站 `nflshcchat`** 的 7 项新功能、对应接口契约与接入要点。
部署步骤见文末「部署与运维」。

| # | 功能 | 前端入口 | 后端接口 |
|---|------|-----------|----------|
| 1 | Google 账号登录 | `index.html`、`chatai/index.html`、`chatai/share.html` | `/api/auth/google/{config,start,callback,exchange}` |
| 2 | 管理员健康看板 | `health.html`（`admin.html` 导航入口） | `/api/admin/health`、`/api/admin/health/errors` |
| 3 | 登录设备列表 + 一键下线 | `security.html` | `/api/auth/sessions`、`/api/auth/sessions/<id>`、`/api/auth/sessions/revoke-others` |
| 4 | 隐私政策 / 用户协议 / 数据导出 / 注销 | `privacy.html`、`terms.html`、`security.html` | `/api/account/{export,status,delete,delete/cancel}` |
| 5 | 消息附件（统一到文件托管） | `chat.html`（📎 按钮 / 粘贴 / 拖拽） | `/api/files/upload`（Worker 中转）→ 文件站 `api.php?a=sso_upload` |
| 6 | 扫码登录（手机端扫） | `index.html`（二维码弹窗 + `?qr=<id>` 确认页） | `/api/auth/qr/{create,info,confirm,poll,cancel}` |
| 7 | 会议（快速/预定/编号/邀请/会中聊天/音视频） | `meeting.html`、`meeting-room.html` | `/api/meeting/*` |

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
- 配额：新用户默认 1GB，站长账号 5GB，站点软上限 4.5GB，超限返回 `413`；
- 超过 20MB 的文件请引导用户到文件托管站（`https://file.nflshcchat.cc.cd/`）分片上传，业务上限 512MB。

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
auth_tokens 新增列    session_id, device_label, user_agent, ip, last_seen_at, via
users（文件站）新增列  sso_only
```

## 部署与运维

```bash
# 主站 Worker
cd nflshcchat && npx wrangler deploy

# 密钥（仅首次需要）
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put FILES_SSO_SECRET     # 必须与文件站 config.php 的 sso_secret 一致

# 文件站（byethost）全量部署
pwsh byethost/tools/deploy.ps1
```

- 文件站目录约定：`byethost/filehost/` 为站点源码（随仓库发布），
  `byethost/tools/`（部署脚本，含 FTP 口令）与 `byethost/tests/`（回归测试）**不随仓库发布**。
  详见 [`../byethost/README.md`](../byethost/README.md)。
- 前端资源改动后请同步更新引用处的 `?v=` 版本号（`js/theme.js?v=4`、`css/themes.css` 等），避免 CDN/浏览器缓存。

## 安全注意事项

- 凭据文件（`Token.txt`、`deepseek-api-key.txt`、`nva-api-key.txt`、`byethost/.sso_secret.txt`）
  已在 `.gitignore` 中排除，切勿提交。
- 文件站的 `config.php`（数据库口令 + `sso_secret`）不进仓库，只通过 FTP 上传。
- 所有跨站写操作都要求 `Authorization: Bearer <token>`。
