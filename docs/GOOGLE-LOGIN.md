# Google 账号登录 —— 接入说明

主站（nflshcchat.cc.cd）、HZYAI（chatai.bot.cd）、账号中心（accounts.nflshcchat.cc.cd）、
开发者平台（platform.nflshcchat.cc.cd）**共用同一套账号体系**，Google 登录也只需要在 Worker 里配置一次。

## 一、架构

```
用户点击「使用 Google 账号登录」
        │
        ▼
GET https://worker.nflshcchat.cc.cd/api/auth/google/start?redirect=<当前页面地址>
        │  （校验 redirect 域名白名单 → 用 HMAC 签名 state → 302 到 Google）
        ▼
Google 授权页（scope: openid email profile）
        │
        ▼
GET https://worker.nflshcchat.cc.cd/api/auth/google/callback?code=&state=
        │  1) code 换 token（带 client_secret）
        │  2) 校验 id_token：RS256 签名（Google JWKS）+ aud + iss + exp
        │  3) 关联账号：已绑定 → 邮箱匹配 → 新建账号
        │  4) 检查封禁/冻结
        │  5) 签发 Bearer token，并存一条一次性 ticket（5 分钟有效、只能兑换一次）
        ▼
302 回跳 <原页面>#google_login=<ticket>
        │
        ▼
前端 POST /api/auth/google/exchange { ticket } → { token, username, isAdmin }
        │  存 token + 登录态，进入站点
```

**为什么用一次性 ticket**：长期 Bearer token 不出现在 URL 里，即使被截图/日志记录也无法直接复用。

## 二、账号关联规则（按顺序）

1. 该 Google 账号（`sub`）已绑定过 → 直接用原账号登录；
2. 该邮箱之前绑定过 Google → 复用那个账号；
3. 某个账号的资料里填过同一邮箱 → 绑定并登录；
4. 都没有 → **自动创建新账号**：
   - 用户名取邮箱前缀（如 `zhangsan@gmail.com` → `zhangsan`），重名则自动加数字后缀；
   - 随机密码（不可用密码登录，只能继续用 Google；以后可在账号中心设置密码）；
   - 资料里记录 `email`、`name`、`avatar`（Google 头像）、`isGoogle: true`。
5. 被封禁/冻结的账号：拒绝登录并提示可申诉（与密码登录一致）。

## 三、需要配置的两个值

```powershell
# 客户端 ID（不算机密，可放 wrangler.toml 的 [vars]，也可以直接 secret）
npx wrangler secret put GOOGLE_CLIENT_ID
# 客户端密钥（必须用 secret，加密存储，不进仓库）
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

> 两个值缺任意一个：`/api/auth/google/config` 返回 `enabled:false`，四个站点的
> 「使用 Google 账号登录」按钮会**自动隐藏**，不影响原有密码登录。

## 四、Google 控制台操作（一次性，约 5 分钟）

1. 打开 https://console.cloud.google.com/ ，右上角新建项目（名称随意，例如 `NFLSHC`）。
2. 左侧「API 和服务 → OAuth 同意屏幕」：
   - 用户类型选**外部**；应用名称填 `NFLSHC`，支持邮箱填自己的邮箱；
   - 范围只勾 `userinfo.email`、`userinfo.profile`（即 openid/email/profile）；
   - 测试阶段可把「发布状态」保持测试并把自己的 Gmail 加进测试用户；
     正式对外使用则点「发布应用」（未验证应用会显示"Google 未验证此应用"，可后续提交验证）。
3. 左侧「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」：
   - 应用类型：**Web 应用**
   - **已获授权的重定向 URI**（必须完全一致，末尾不要多斜杠）：
     ```
     https://worker.nflshcchat.cc.cd/api/auth/google/callback
     ```
   - 「已获授权的 JavaScript 来源」可留空（我们不使用 Google 的 JS SDK，走服务端重定向）
4. 创建后会弹窗给出 **客户端 ID**（形如 `1234567890-xxxxxxxx.apps.googleusercontent.com`）和
   **客户端密钥**（形如 `GOCSPX-xxxxxxxx`），把这两个值发给维护者配置即可。

## 五、安全说明

- `redirect` 参数只允许回跳到白名单域名（见 worker.js 的 `GOOGLE_REDIRECT_HOSTS`），防止开放重定向。
- `state` 用 HMAC-SHA256 签名并带 15 分钟有效期，防止 CSRF。
- `id_token` 走 Google 公钥验签（RS256），并校验 `aud` 必须等于我们的 client_id、`iss` 必须是 Google、
  `exp` 未过期，`email_verified` 为真才放行。
- 换回来的 Bearer token 与密码登录签发的完全一致：30 天有效、重新登录会使旧 token 失效
  （与现有"跨设备失效"策略保持一致）。
