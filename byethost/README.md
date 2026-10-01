# NFLSHC 文件托管（nflshcfile.l.cd）部署与维护说明

## 一、整体结构

```
用户浏览器
   │  https://file.nflshcchat.cc.cd      ← Cloudflare 入口（证书由 CF 自动签发/续期）
   ▼
nflshcfile-proxy（Cloudflare Worker，仓库根目录 nflshcfile-proxy/）
   │  以「正常浏览器身份」请求源站；自动解开源站的 slowAES 反爬挑战并缓存 __test Cookie；
   │  对 429/502/503/504 自动退避重试；注入 X-Media-Host / X-Media-Proto 供源站生成链接
   ▼  http://nflshcfile.l.cd             ← byethost 源站（免费主机，无自定义域名 SSL）
PHP 应用（站点根目录 /nflshcfile.l.cd/htdocs）
   ├── 页面：index.php 上传/我的文件、plaza.php 公开广场、view.php 详情/分享、
   │        login.php 登录、register.php 注册、dev.php 开发者 API、_cleanup.php 维护工具
   ├── 接口：api.php（注册/登录/分片上传/列表/改名/可见性/删除/上传令牌）
   ├── 取出：f.php（支持 Range 断点）、thumb.php（私有缩略图直出）
   └── 存储：storage/pub（公开，可直链）storage/prv（私有，.htaccess 拒绝直连）
              storage/tpub、storage/tprv（缩略图）、storage/up（分片临时文件）
MySQL：sql308.byethost11.com / b11_43002442_media（用户 b11_43002442）
```

两个入口都能用，链接按访问入口自动生成：

| 入口 | 地址 | 说明 |
|---|---|---|
| HTTPS（推荐） | https://file.nflshcchat.cc.cd/ | Cloudflare 证书，任何浏览器都受信 |
| HTTP（源站） | http://nflshcfile.l.cd/ | byethost 直连，首次访问会有一次 JS 反爬跳转 |

## 二、部署方法

```powershell
cd byethost

# 1) 部署 PHP 站点（FTP 到附加域名目录）
pwsh .\tools\deploy.ps1                # 默认上传到 /nflshcfile.l.cd/htdocs

# 2) 部署/更新 Cloudflare 入口
cd ..\nflshcfile-proxy
npx wrangler deploy
```

`config.php`（含数据库口令）**不进仓库**（已在 .gitignore 排除），改完用 FTP 单独上传。

## 三、为什么 HTTPS 走 Cloudflare 而不是源站

实测结论（都做过验证）：

1. byethost 免费主机的 TLS 由他们的前端代理终止，**上传到面板的证书不会被真正启用**：
   在 VistaPanel 里上传证书返回 `sucess=1`、页面也能看到证书，但
   `https://nflshcfile.l.cd` 始终返回他们的默认自签证书（`subject=*`）。
   面板 SSL 页每个域名旁都挂着 **Upgrade** 链接，说明自定义域名 SSL 属付费功能。
   试过仅叶证书 / CRLF / 完整链 / 叶+中间证书四种上传格式，结果一致。
2. Let's Encrypt 的 HTTP-01 走不通（他们的反爬会拦掉所有 CA 验证服务器，只放行搜索引擎类 UA）。
3. 改用 DNS-01 时发现 `l.cd` 是 DNSHE 免费域名，**「每注册域名 7 天 50 张证书」的配额被共用者耗尽**
   （实测 `429 rateLimited`，配额窗口滚动释放），因此即便签下来也不稳定。
4. 故最终由 Cloudflare 提供证书（自动续期，无共享配额问题），源站保持 HTTP。

> 结论：源站 SSL 这条路暂时走不通，因此**公开链接一律使用 `https://file.nflshcchat.cc.cd`**
> （HTTPS 页面里引用 `http://nflshcfile.l.cd` 会被浏览器当作混合内容拦截）。
> 当时的 DNS-01 工具链已完成使命，为避免密钥留在本地已删除；若以后换到支持自定义 SSL 的主机，
> 可按本节的实测结论重新评估。

## 四、源站的已知限制（重要）

| 现象 | 原因 | 现有对策 |
|---|---|---|
| 首次访问出现一次跳转 | byethost 的 slowAES 反爬挑战 | 浏览器自动完成；Worker 入口由 Worker 自己解挑战 |
| 偶发 502 / 429 | 免费主机对突发请求限流 | 前端 `fetchWithRetry` + 分片重试；Worker 自动退避重试 |
| 单文件 20MB 限制（PHP） | `upload_max_filesize=20M` | 应用走 4MB 分片上传（服务端追加合并），业务上限 512MB |
| Worker 出口 IP 被 WAF 标记 | 短时间内大量请求被判为「Scanner activity」，`retry-after` 约 1 小时 | 恢复后自动可用；不要用脚本狂刷，测试请放慢 |

## 五、常用维护操作

```powershell
cd byethost

# 清理测试账号（test_ / cli_ / cf_ / t_ 前缀）与残留文件
pwsh .\tools\cleanup-all.ps1

# 单独调整某账号配额（默认站长 5GB）
pwsh .\tools\set-quota.ps1 -User huangzhiyuan -Bytes 5368709120

# 上传并执行一个远端 PHP 脚本（诊断用，跑完记得从服务器删除）
node .\tools\php-run.mjs .\filehost\_lint.php /nflshcfile.l.cd/htdocs/_lint.php

# 端到端自测
node .\tests\test-filehost.mjs        # 源站（HTTP）端到端
node .\tests\test-https-proxy.mjs     # 经 Cloudflare HTTPS 入口
node .\tests\test-pages.mjs           # 页面渲染
node .\tests\test-cli.mjs             # 命令行上传脚本（含分片）
node .\tests\test-final-verify.mjs    # 上线前最终验收

# 命令行上传（给用户/脚本用）
node .\tools\upload-cli.mjs --token=<令牌> --file=.\a.mp4 --visibility=public
```

## 六、账号与权限

- 站点账号独立于主站（自建 `users` 表 + bcrypt + PHP 会话）。
- **主站 SSO**：主站在 `chat.html` 里发消息附件时，由 Worker 用 `FILES_SSO_SECRET` 签发 5 分钟票据
  （`X-Files-Ticket`）调用 `api.php?a=sso_upload`，用户无需在文件站二次登录；
  首次调用会自动建号（`users.sso_only = 1`，密码为随机不可用值）。文件站侧密钥在同名配置项 `sso_secret`。
- **容量规则（三层）**：
  1. 单文件上限 512MB（`config.php` 的 `max_file_bytes`）。
  2. 每账号上限：新用户默认 **1GB**（`default_quota_bytes`）；个别账号可在数据库单独调大，
     例如站长账号 `huangzhiyuan` 已设为 **5GB**（`UPDATE users SET quota_bytes = 5368709120 WHERE username='huangzhiyuan'`）。
  3. 站点总空间软上限 **4.5GB**（`site_max_bytes`，主机共 5GB，留余量给数据库/日志），
     超过即拒绝新上传，避免把主机写满。
  - `upload_init` 按声明大小先查一次，`upload_finish` 再按**真实字节数**查一次，
    防止客户端谎报大小绕过上限；超限返回 413 并提示已用/上限/请删除旧文件。
  - 前端上传前也会用 `used/quota/siteUsed/siteMax` 预检并给出明确提示，上传区显示站点总占用百分比。
- 上传令牌（`dev.php` 页面生成）仅用于脚本上传，不能创建新令牌。
- 私有文件：目录 `.htaccess` 直接 403，只有 `f.php` / `thumb.php` 校验身份后读出。
- `trusted_hosts` 白名单：只有名单内的 Host 会被用于生成分享链接，防止伪造 Host。

## 七、下载文件名的规则

`f.php` 输出 `Content-Disposition` 时：**标题 + 真实扩展名**（标题本身已带同扩展名则不重复），
并过滤掉系统不友好字符与换行；同时给出 ASCII 回退名与 `filename*=UTF-8''` 中文名。
例如标题「我的风景照」的 PNG 会被保存为 `我的风景照.png`，不再出现「下载下来没有后缀」的问题。

## 八、目录结构与脚本清单

```
byethost/
  README.md               本文件（版本控制）
  filehost/               PHP 站点源码（版本控制；config.php / _*.php 维护脚本除外）
  tools/                  本地运维脚本（不入库：含 FTP 口令）
  tests/                  回归测试脚本（不入库）
  .sso_secret.txt         主站 SSO 密钥（不入库，需与 Worker 的 FILES_SSO_SECRET 一致）
```

| 脚本 | 用途 |
|---|---|
| `tools/deploy.ps1` | 把 `filehost/` 全量部署到附加域名目录 |
| `tools/ftp.ps1` | FTP 基础操作（list/put/get/mkdir/del/rmdir） |
| `tools/php-run.mjs` | 上传一个 PHP 文件并用 Googlebot UA 直接执行取回结果（诊断用） |
| `tools/cleanup-all.ps1` | 清理测试账号（test_/cli_/cf_/t_ 前缀）并移除远端临时脚本 |
| `tools/set-quota.ps1` | 单独调整某账号容量上限 |
| `tools/upload-cli.mjs` | 命令行上传工具（支持大于 20MB 的分片上传），可给用户/脚本用 |
| `tests/test-filehost.mjs` | 源站端到端测试（注册/上传/私有控制/Range/删除等） |
| `tests/test-https-proxy.mjs` | 经 Cloudflare HTTPS 入口的端到端验证 |
| `tests/test-https-light.mjs` | HTTPS 入口轻量验证 |
| `tests/test-pages.mjs` | 页面渲染验证 |
| `tests/test-download-link.mjs` | 详情页下载链接（上传者视角）验证 |
| `tests/test-quota-filename.mjs` | 下载扩展名 + 容量上限（含谎报大小）验证 |
| `tests/test-html-escape.mjs` | 标题含引号/尖括号时的 HTML 转义验证 |
| `tests/test-site-cap.mjs` | 站点总容量软上限验证 |
| `tests/test-smoke.mjs` | 冒烟测试（注册→上传→列表→删除） |
| `tests/test-final-verify.mjs` | 上线前最终验收（一次性跑完关键路径） |
| `filehost/_*.php` | 一次性维护脚本（清理账号、探针、配额调整），**用完必须从服务器删除** |

> 注意：`.ps1` 脚本必须保持纯 ASCII（Windows PowerShell 5.1 按 ANSI 读取，中文会导致解析失败）。

