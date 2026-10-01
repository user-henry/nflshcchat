# NFLSHC 开放 API 与 SDK 接入文档

面向第三方开发者：本文档描述 NFLSHC Chat 对外可用的 HTTP 接口、鉴权方式与官方 SDK 用法。

- 接口基址：`https://worker.nflshcchat.cc.cd`
- 所有接口返回 JSON；需要身份的接口用 `Authorization: Bearer <token>`
- 官方 SDK：[`sdk/js/nflshc.js`](../sdk/js/nflshc.js)（零依赖，浏览器 + Node 18+）、
  [`sdk/python/nflshc.py`](../sdk/python/nflshc.py)（仅标准库，Python 3.8+）
- 开放平台（创建 OAuth 应用、查看调用量）：https://platform.nflshcchat.cc.cd

---

## 一、两种身份

| 身份 | 令牌来源 | 适用场景 |
|---|---|---|
| **用户登录令牌** | `POST /api/auth/login`（密码）、Google 登录、扫码登录、通行密钥登录 | 你代表某个用户操作（本人授权、脚本自动化） |
| **OAuth 访问令牌** | 走 OAuth 2.0 授权码流程（见第五节） | 第三方应用代表用户访问，权限受 scope 限制 |

登录令牌有效期 30 天，可在「账号与安全」页按设备吊销。

```bash
# 密码登录（先在前端做 SHA-256 哈希，不要传输明文）
curl -X POST https://worker.nflshcchat.cc.cd/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"<sha256hex 密码>"}'
# → { "ok": true, "token": "...", "username": "alice", "isAdmin": false, "expiresAt": "..." }
```

---

## 二、账号与安全

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 校验令牌并返回当前用户 |
| GET | `/api/auth/sessions` | 我的登录设备（`device` / `ip` / `via` / `current`） |
| DELETE | `/api/auth/sessions/<sessionId>` | 下线指定设备 |
| POST | `/api/auth/sessions/revoke-others` | 下线除本机外的所有设备 |
| POST | `/api/auth/logout` | 吊销当前令牌 |
| GET | `/api/account/export` | 导出我的全部数据（JSON，**不含**令牌与密码哈希） |
| POST | `/api/account/delete` | 申请注销（`{confirm:"<用户名>", reason?}`，7 天冷静期） |
| POST | `/api/account/delete/cancel` | 撤销注销申请 |
| GET | `/api/account/status` | 查询注销申请状态 |

`via` 取值：`password` / `google` / `qr` / `reset` / `passkey`。

---

## 三、消息 / 好友 / 收藏

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/messages?room_id=&limit=` | 聊天室消息（老数据是 ```` ```json ```` 围栏，SDK 会自动解析为 `data` 字段） |
| POST | `/api/messages` | 发送消息（`id, room_id, sender, content, mentions, reply_to, timestamp`） |
| GET | `/api/friends` | 好友关系 |
| GET | `/api/favorites` | 我的收藏 |
| GET | `/api/rooms` | 聊天室列表 |

---

## 四、会议 / 笔记 / 学习 / 文件

### 会议

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/rtc/ice` | WebRTC ICE 配置：只含公共 STUN（`source: "stun-only"`，不含 TURN） |
| POST | `/api/meeting/create` | 建会（`kind='instant'|'scheduled'`、`invitees[]`、`password?`） |
| GET | `/api/meeting/list` | 我的会议 |
| POST | `/api/meeting/join` | 用会议编号加入（`{code, password?}`） |
| GET | `/api/meeting/detail?id=` | 会议详情 + 成员 + 最近聊天 |
| POST | `/api/meeting/chat` / GET 同路径 | 会中聊天（发送 / 增量拉取） |
| POST | `/api/meeting/signal` / GET 同路径 | WebRTC 信令（`offer`/`answer`/`ice`） |
| POST | `/api/meeting/board` / GET 同路径 | 共享白板笔画（增量同步） |
| POST | `/api/meeting/board/clear` | 清空白板（主持人） |
| POST | `/api/meeting/end` | 结束会议（主持人） |

### 笔记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notes/list` | 我的 + 共享给我的 + 我所在会议的笔记 |
| POST | `/api/notes/create` | 新建（`title` / `content` / `kind='note'|'meeting'` / `meetingId`） |
| GET | `/api/notes/get?id=` | 详情（含 `shares`、`role`、`canEdit`） |
| POST | `/api/notes/update` | 修改（需 `owner`/`edit` 权限） |
| POST | `/api/notes/delete` | 删除（仅拥有者） |
| POST | `/api/notes/share` | 共享（`{id, username, canEdit}`，仅拥有者） |
| POST | `/api/notes/unshare` | 取消共享 |
| GET | `/api/notes/meeting?meetingId=&create=1` | 会议笔记（会议成员可读） |

### 学习（AI 讲题 / 错题本）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/study/solve` | AI 讲题（`question` 或 `imageUrl`，`save=true` 直接入错题本） |
| GET | `/api/study/mistakes?subject=&status=&q=` | 错题列表 + 学科/状态统计 |
| POST | `/api/study/mistakes` | 添加错题 |
| POST | `/api/study/mistakes/update` | 更新（`status` / `tags` / `reviewed:true` 复习计数 +1） |
| POST | `/api/study/mistakes/delete` | 删除 |
| POST | `/api/study/practice` | 生成同类练习 |

### 文件

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/files/upload` | 上传附件（multipart：`file`、`title?`、`visibility?`），≤20MB，返回 HTTPS 直链 |

---

## 五、OAuth 2.0 授权码流程（第三方应用）

1. 在开放平台创建应用，拿到 `client_id` 与 `client_secret`，登记回调地址。
2. 把用户送到授权页：

```
https://worker.nflshcchat.cc.cd/api/oauth/authorize
  ?client_id=<你的 client_id>
  &redirect_uri=<登记过的回调地址>
  &response_type=code
  &scope=profile%20friends
  &state=<随机串，用于防 CSRF>
```

3. 用户同意后回调 `redirect_uri?code=...&state=...`；用 `code` 换令牌（**服务端调用**）：

```bash
curl -X POST https://worker.nflshcchat.cc.cd/api/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"authorization_code","code":"<code>","client_id":"...","client_secret":"...","redirect_uri":"..."}'
```

4. 用访问令牌读用户信息（按 scope 过滤，永不返回密码）：

```bash
curl "https://worker.nflshcchat.cc.cd/api/oauth/userinfo?access_token=<access_token>"
```

> **注意**：`/api/oauth/userinfo` 只接受 OAuth 访问令牌；用用户登录令牌调用会返回
> `401 {"error":"invalid_token"}`。

5. 刷新与吊销：`POST /api/oauth/token`（`grant_type=refresh_token`）、`POST /api/oauth/revoke`。

其他相关接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/oauth/scopes` | 全部可用权限说明（公开） |
| GET | `/api/oauth/authorize-info` | 授权页展示用的应用信息 |
| GET | `/api/oauth/grants` | 我授权过的应用（用户视角，可撤销） |
| POST | `/api/oauth/check` | 开发者校验某用户在自己项目内的状态（封禁/授权） |

### 机器人接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/bot/send` | 以机器人身份发消息（`client_id`/`client_secret`/`room_id`/`content`） |
| GET | `/api/bot/messages` | 拉取聊天室消息 |
| POST | `/api/bot/join` | 加入聊天室 |

---

## 六、SDK 用法

### JavaScript

```js
import { NFLSHC, NFLSHCOAuth } from './sdk/js/nflshc.js';

// 1) 用户身份
const api = new NFLSHC({ token: '<登录令牌>' });
console.log(await api.me());
await api.sendMessage({ roomId: 'room_x', sender: 'alice', content: '你好' });

// 2) 第三方应用
const oauth = new NFLSHCOAuth({ clientId, clientSecret, redirectUri });
location.href = oauth.authorizeUrl({ scope: 'profile friends', state: 'xyz' });
const tokens = await oauth.exchangeCode(code);          // 服务端执行
const app = new NFLSHC({ token: tokens.access_token });
```

SDK 覆盖：账号与会话、消息、好友收藏、会议（含信令与白板）、笔记、学习、文件上传、OAuth、机器人。

### Python

```python
from nflshc import NFLSHC, NFLSHCOAuth

api = NFLSHC(token="<登录令牌>")
print(api.me())
api.send_message(room_id="room_x", sender="alice", content="你好")

oauth = NFLSHCOAuth(client_id="...", client_secret="...", redirect_uri="https://your.app/cb")
print(oauth.authorize_url(scope="profile friends", state="xyz"))
tokens = oauth.exchange_code(code)
```

---

## 七、错误约定

| HTTP | 含义 |
|---|---|
| 400 | 参数缺失或格式错误（`{ok:false,error:"..."}`，部分带 `code`，如 `need_confirm` / `need_password`） |
| 401 | 未登录、令牌无效/过期（OAuth 接口为 `{error:"invalid_token"}`） |
| 403 | 无权限（如非管理员访问 `/api/admin/*`、非会议成员访问会议数据） |
| 404 | 资源不存在 |
| 409 | 冲突（如用户名已存在） |
| 410 | 已失效（二维码过期、会议已结束） |
| 413 | 超出配额或体积限制 |
| 429 | 触发限流（登录失败过多会临时锁定） |
| 502 | 上游服务异常（AI 网关、文件托管） |

建议所有调用都检查 `res.ok` 与响应体里的 `ok` 字段；SDK 已把错误封装成
`NFLSHCError`（含 `status` 与 `body`，Python 侧为 `NFLSHCError` 异常）。

---

## 八、开发建议与限制

- **不要在前端放 `client_secret`**；`/api/oauth/token` 必须服务端调用。
- 轮询类接口（会议聊天、白板、信令）都有增量参数（`since` / `lastId`），请按返回值推进游标，
  不要全量拉取。
- 附件上传单文件上限 20MB（更大文件请引导用户到文件托管站分片上传）。
- 同一 IP 恶意批量注册、刷接口会被自动封禁；测试请节流。
- 用户数据按 `username` 隔离：错题本、笔记、会话列表等只能读写自己的数据；
  会议/笔记的共享权限由接口内的角色判断控制。
