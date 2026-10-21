# 文件托管与媒体直链（开发者文档）

本文说明 NFLSHC 主站与自建文件托管站（byethost PHP）之间的集成方式、对外域名与链接规则、
缓存/删除语义，以及一个已知的 Cloudflare 边缘缓存限制与解决办法。

## 1. 组成

| 角色 | 地址 | 说明 |
| --- | --- | --- |
| 文件站源站 | `http://nflshcfile.l.cd` | byethost 免费主机（PHP + MySQL），**没有有效 TLS 证书**，前端还有 JS 反爬挑战 |
| 文件站 HTTPS 入口 | `https://file.nflshcchat.cc.cd` | Cloudflare Worker `nflshcfile-proxy`，自动解挑战、缓存、转发；文件分享页也在这里 |
| 媒体直链入口 | `https://media.nflshcchat.cc.cd` | 同一个 Worker 的第二个自定义域名，**只用于用户上传文件的直链** |
| 主站 API | `https://worker.nflshcchat.cc.cd` | Cloudflare Worker `nflshcchat`：鉴权、配额、SSO 票据、删除与清缓存 |

浏览器在 HTTPS 页面里直接引用 `http://nflshcfile.l.cd/...` 会被当作混合内容拦截，
所以**任何对外链接都不得出现源站地址**，一律走上面两个 HTTPS 入口。

## 2. 免登录票据（SSO）

主站 Worker 用共享密钥 `FILES_SSO_SECRET`（= 文件站 `config.php` 的 `sso_secret`）签发 5 分钟票据：

```
X-Files-Ticket: base64(username)|exp|hmac_sha256(username|exp, sso_secret)
```

文件站 `api.php` 校验签名与有效期后，按用户名自动建号（`sso_only = 1`）并沿用个人配额。
用户因此不需要在文件站二次登录。

- 上传：`POST /api/files/upload`（multipart，≤20MB）→ Worker 转发到 `api.php?a=sso_upload`
- 删除：`POST /api/files/delete { id, urls? }` → Worker 转发到 `api.php?a=sso_delete`（只能删自己的文件）

Worker 调用文件站时带 `X-Media-Host: file.nflshcchat.cc.cd` + `X-Media-Proto: https`，
让文件站直接生成 HTTPS 链接；同时 `toPublicFileUrl()` 再做一次兜底改写。

## 3. 直链的 URL 规则

文件站的真实存储路径是 `/storage/pub/<分片>/<id>.<扩展名>`（缩略图在 `/storage/tpub/...`）。
主站对外给出的直链会被改写成：

```
https://media.nflshcchat.cc.cd/pub/<分片>/<id>?e=<扩展名>&n=<原文件名>
```

代理 Worker 收到后还原成源站真实路径 `/storage/pub/<分片>/<id>.<扩展名>` 再转发，
并用 `Content-Disposition: inline; filename*=UTF-8''<原文件名>` 让「另存为」保留原文件名。

这样设计的原因：

- 独立主机名 + 不带扩展名的路径，把「缓存该存多久、什么时候清」的控制权交回代理 Worker
  自己的 Cache API（不带扩展名也就不会命中 Cloudflare 默认的「按静态扩展名缓存」）；
- 删除文件时可以按完整 URL 精确清掉（`__purge`），不必等 TTL；
- `n` 参数让「另存为」保留原文件名，而不是一串文件 id。

历史链接（`/storage/pub/…/xx.png`）仍然照旧代理，不受影响。

> 注意：该区域还有一层更强的边缘缓存（见第 5 节），它不在这套控制之内——
> 若要让「删除即失效」百分之百生效，需要按第 5 节把媒体入口的缓存资格设为 Bypass。

## 4. 缓存与删除语义

代理 Worker 的缓存分层：

| 路径 | 缓存位置 | TTL | 清理方式 |
| --- | --- | --- | --- |
| `/assets/*` | Cache API | 1 天 | 过期自然失效 |
| `/pub/*`、`/tpub/*`（含 `/media/`、`/storage/` 前缀形式） | Cache API | 5 分钟 | `POST /__purge` 立即清 |

内部清缓存接口（只在代理 Worker 上，需密钥）：

```
POST https://media.nflshcchat.cc.cd/__purge?url=<完整的公开直链>
X-Purge-Key: <PURGE_KEY>
→ {"ok":true,"purged":[{"url":"…","deleted":true}]}
```

- 代理 Worker 的 secret `PURGE_KEY` 与主站 Worker 的 `FILES_PURGE_KEY` 必须一致
  （本地值存在 `dev/secrets.local.json`，不入仓库）；
- 只允许清本域名下 `/pub/`、`/tpub/`、`/storage/` 的地址，避免被当成通用清缓存接口；
- `DELETE` 语义：`POST /api/files/delete { id, urls: [直链…] }` 会先删文件站的文件，
  再按直链逐个域名调用 `__purge`，成功后返回 `{ok:true, deleted:true, purged:N}`；
- 文件站已不存在该文件时返回 `{ok:true, alreadyGone:true}`（前端据此清理本地记录，不报错）。

## 5. 已知限制：删除后链接仍可访问（边缘缓存）

NFLSHC 所在的 Cloudflare 区域把这两个入口主机上的 **200 响应**都做了边缘缓存。实测结论：

- 响应带 `Cache-Control: no-store, private, max-age=0` → 边缘仍缓存；
- 响应带 `Set-Cookie` → 边缘仍缓存；
- 路径末尾不带扩展名（`/pub/…/<id>?e=png`）→ 边缘仍缓存；
- 换主机名（`media.*`）→ 边缘仍缓存（不是按主机名匹配的规则）；
- 缓存键忽略查询串：同一个路径加不同参数会命中同一份缓存副本；
- 主站 API（带 `Authorization` 的请求、POST 请求）不受影响，因此业务读写一直是实时的。

也就是说，**从 Worker 侧没有任何响应头能关掉这层缓存**，它也不查询缓存键里除路径以外的部分。
所以删除文件后，边缘上那份副本会在它自己的 TTL 到期前继续被返回；
文件站源站与代理 Worker 的缓存都是干净的（删除后源站 404、Cache API 已被 `__purge` 清掉）。

两种解决办法（任一即可，都不需要改代码）：

1. **给媒体入口关掉边缘缓存（推荐）**：Cloudflare 控制台 → Rules → Cache Rules
   （旧版是 Page Rules）新增一条，把用户文件入口的缓存资格设为「Bypass / 绕过」：

   ```
   当 主机名 等于 media.nflshcchat.cc.cd  →  缓存资格：绕过缓存（Bypass）
   ```

   缓存仍由代理 Worker 的 Cache API 承担（`/pub/*` 5 分钟 + 删除时 `__purge` 精确清理），
   源站负载不会因此变大，删除后链接立刻失效。

2. **保留 CDN 长缓存 + 删除时主动清 CDN**：需要一个具备 **Zone → Cache Purge** 权限的
   API Token（wrangler 的登录凭据没有这个权限，实测调用 `purge_cache` 返回 401）。
   拿到后可作为 Worker secret 注入，在 `POST /api/files/delete` 中改为调用
   `POST /zones/{zone_id}/purge_cache {files:[…]}`。

在解决之前，图床/附件页面的删除行为是：**本地记录与源站文件都会立即删除，源站 404；
但已被边缘缓存过的直链在其缓存 TTL 内仍可访问**。因此不要用这套存储放敏感内容。

## 6. 图片自动优化与缓存（Cloudflare 图片转换）

本区域的 Cloudflare **图片转换（Image Resizing）已可用**，并且对 `file.*` / `media.*` 这两个
Worker 自定义域名同样生效（Cloudflare 在处理 `/cdn-cgi/image/…` 时不会把它交给 Worker）。
因此「缩略图 / 压缩图」不需要我们存储，也不需要文件站生成：

```
原图：  https://media.nflshcchat.cc.cd/pub/<分片>/<id>?e=png&n=图.png
列表图：https://media.nflshcchat.cc.cd/cdn-cgi/image/width=480,quality=78,format=auto/pub/<分片>/<id>?e=png
大图：  https://media.nflshcchat.cc.cd/cdn-cgi/image/width=1600,quality=85,format=auto/pub/<分片>/<id>?e=png
```

实测（1200×800 渐变 PNG，经 Cloudflare 转换）：

| 形式 | 返回 | 体积 |
| --- | --- | --- |
| 原始直链 | `image/png` | 119.7 KB |
| `width=400,format=auto` | `image/avif` | **1.6 KB** |
| `width=400`（不指定 format） | `image/jpeg` | 4.7 KB |
| `width=200,quality=60` | `image/jpeg` | 1.6 KB |

实现约定（`image-host.html`）：

- `cfImageUrl(url, {width, quality})` 只对 `file.nflshcchat.cc.cd` / `media.nflshcchat.cc.cd`
  上的图片地址生效（其它域名、非图片原样返回），并且**只使用固定几档宽度**
  （列表 480、查看/分享 1600）——Cloudflare 按「唯一变换」计费，不能让用户随意传尺寸；
- 列表用 480 档并 `onerror` 回退到原图；「🔗 查看」用 1600 档；
- 工具栏新增「✨ 复制优化链接」，复制的是 1600 档、`format=auto` 的地址
  （浏览器支持时自动 AVIF/WebP，贴到聊天里更省流量）。

注意：

- 转换结果是**边缘缓存**的（带 `Vary: accept`），和原图一样受第 5 节的缓存规则影响：
  这点对「删除后旧链接仍可访问」的时间窗没有改善，但转换图是派生资源，删除记录后不会再被引用；
- `/cdn-cgi/image/…` 请求由 Cloudflare 处理，因此代理 Worker 的 `__purge` 清不到它
  （清的是我们自己的 `/pub|tpub|storage` 缓存）。

## 7. 相关测试

```bash
node dev/tests/test-image-host.mjs       # 图床：上传 → 直链可取 → 删除 → 已清理语义 → 权限隔离
node dev/tests/test-attachment-url.mjs   # 聊天附件：HTTPS 入口、直链可下载、私密文件不给直链
node dev/tests/_probe-image-resize.mjs   # Cloudflare 图片转换：原图 vs /cdn-cgi/image 各种参数（含体积对比）
```

测试脚本会创建 `t_img_*` / `t_*` 前缀的临时账号与文件，跑完请清理：

```bash
node dev/tools/cleanup-test-data.mjs     # 清理测试数据并解除测试期间被反滥用封禁的本机 IP
```

## 7. 涉及的服务端改动点（改动前请读）

- 主站 `worker.js`：`/api/files/upload`、`/api/files/delete`、`toPublicFileUrl()`、`FILES_PUBLIC_HOST` /
  `MEDIA_PUBLIC_HOST` 常量，以及 `/__purge` 的调用；
- 代理 `nflshcfile-proxy/worker.js`：`resolvePubTarget()`（URL 还原）、`PUB_CONTENT`（缓存判定）、
  `/__purge` 处理器、`CACHEABLE`（长缓存白名单）；
- 文件站 `byethost/filehost/api.php`：`sso_upload`、`sso_delete`、`file_list` 等动作与配额校验。

`worker.js`、`wrangler.toml`、`byethost/`、`dev/` 都只在本地工作副本中维护，**不进入 GitHub 仓库**。

## 8. 媒体直链的播放与「贴到别处」（2026-10 修复）

### 8.1 为什么「直接打开视频直链」是一片空白

`f.php` 曾经对**所有**响应都加 `Content-Security-Policy: sandbox; default-src none`（初衷是防止上传的文件
被当成脚本执行）。但浏览器打开媒体直链时会创建一个「媒体文档」，内部用真实的 `<video>` / `<audio>` 元素
去加载这个地址 —— 该元素受这个响应**自身**的 CSP 约束，`default-src none` 作为 `media-src` 的兜底把媒体挡掉：

```
Loading media from 'f.php?id=…' violates the following Content Security Policy directive: "default-src none".
Note that 'media-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.
```

图片不受影响（浏览器用图像文档直接渲染，不走子资源加载），所以现象就是「图片能看、视频/音频打不开」；
而 `view.php` 里是用 `<video src>` 当子资源加载的，子资源不看响应自己的 CSP，于是「详情页能播、直链打不开」。

现在 `f.php` 按类型下发：

| 类型 | CSP | 其它头 |
| --- | --- | --- |
| `image` / `video` / `audio` | **不发** sandbox（媒体不能执行脚本，`nosniff` + 正确 `Content-Type` 已足够） | `Content-Disposition: inline`、`Accept-Ranges: bytes`、Range/206 |
| `file`（zip/pdf/txt/md/…） | 仍发 `sandbox; default-src none` | `attachment` |
| `image/svg+xml`、`text/html`、`application/xml`、`application/javascript` 等可执行类型 | 仍发 `sandbox; default-src none` | 视 kind 而定 |

实测（无头 Chrome，2026-10）：视频直链 `readyState=3`、`duration=15`、1920×1080、无 CSP 违规；
音频直链 `readyState=4`、60.6 秒；图片直链正常出图；zip 仍是 `attachment` + sandbox。

### 8.2 分享 / 嵌入链接为什么要换域名

byethost 源站会给**没有 `__test` cookie** 的请求回一段 JS 挑战页（`aes.js`）。浏览器直接打开会自动通过，
但把 `nflshcfile.l.cd` 的直链贴到 Markdown / 站外页面时，子资源请求无法执行挑战脚本，拿到的是一段 HTML
→ 图片/视频/音频全部加载失败。

所以 `config.php` 新增 `share_base`（默认 `https://file.nflshcchat.cc.cd`，即 Cloudflare 前置入口：https、无挑战），
由 `lib.php` 的 `share_base()` / `file_share_url()` 使用：`view.php` 的「文件链接 / Markdown / HTML 嵌入」三处
都生成这个域名；页面内的播放器仍用同源地址（不依赖 CF）。

### 8.3 「贴到 Markdown」的三种写法

| 类型 | 复制出来的片段 |
| --- | --- |
| image | `![标题](https://file.nflshcchat.cc.cd/f.php?id=…)` |
| video | `<video src="https://file.nflshcchat.cc.cd/f.php?id=…" controls style="max-width:100%"></video>` |
| audio | `<audio src="https://file.nflshcchat.cc.cd/f.php?id=…" controls></audio>` |
| file | `[标题](https://file.nflshcchat.cc.cd/f.php?id=…&dl=1)`（带 `dl=1` 直接下载） |

Markdown 本身没有视频/音频语法，用内联 HTML 即可 —— 只要渲染器允许内联 HTML。

### 8.4 回归检查

```bash
node dev/tools/tools-filehost-csp.mjs    # 按类型抽一个公开文件，校验 Content-Type / CSP / Content-Disposition 是否符合上表
```

浏览器侧（直接打开 + 跨站嵌入）用无头 Chrome 复验：判定依据是媒体文档里 `<video>/<audio>` 的 `readyState`
与控制台是否出现 CSP 违规日志；跨站嵌入要用 `file.nflshcchat.cc.cd` 的地址（见 8.2）。

## 9. 上传通道：为什么不再用 multipart（2026-10 修复）

**症状**：文件站自己的上传界面点上传后提示「服务器返回异常（HTTP 403）」；主站发附件提示
「文件托管返回异常 HTTP 403」。但浏览已有图片 / 文件（`f.php`、`/storage/...` 直链）一切正常。

**根因**：byethost 的前端（`openresty`）从 2026-10 起**把所有 `multipart/form-data` 请求一律拦成 403**，
而且是服务器层直接拒绝（返回的是 `openresty` 的 403 页面，连 PHP 都没跑到）。实测对照：

| 请求 | 结果 |
| --- | --- |
| `GET /api.php?a=public` | 200 JSON |
| `POST /api.php?a=public`（JSON body） | 200 JSON |
| `POST /api.php?a=upload_init`（JSON body） | 200 JSON |
| `POST /api.php?a=sso_upload`（multipart + 文件） | **403 openresty** |
| `POST /api.php?a=sso_upload`（multipart 只有文本字段、不带文件） | **403 openresty** |
| `POST /api.php?a=upload_chunk`（`application/octet-stream` 裸字节） | 到 PHP（401/正常） |
| `POST /api.php?a=upload_init`（`x-www-form-urlencoded`） | 到 PHP（401/正常） |

也就是说：**只要 `Content-Type` 是 `multipart/form-data` 就直接 403**，与文件大小、UA、是否带 cookie 都无关；
走源站和走 Cloudflare 前置域名结果一样。所以以前能用的上传（`upload_finish` / `upload_simple` /
`sso_upload` / `api_upload` 用的都是 multipart）在主机改策略后就全断了。

**修复**：上传全部改成「**元数据走 JSON / 请求头，文件内容直接放在 body**」，分片协议本来就是裸字节，因此只动了三处：

| 端点 | 新协议 |
| --- | --- |
| `upload_init` | 不变（本来就是 JSON） |
| `upload_chunk` | 不变（本来就是 `application/octet-stream` 裸字节） |
| `upload_finish` | 改 `application/json`：`{ uid, width?, height?, duration?, poster_b64? }`；
视频首帧（以前 multipart 的 `poster` 字段）改为 base64 放在 `poster_b64` 里 |
| `upload_simple` | 前端不再调用（改为走分片协议）；服务端仍兼容：裸 body + `X-File-*` 头 |
| `sso_upload`（主站 Worker 调用） | 裸 body（文件字节）+ 请求头：`X-File-Name`（URL 编码）、`X-File-Type`、
`X-File-Title`（URL 编码）、`X-File-Visibility`；票据仍是 `X-Files-Ticket` |
| `api_upload`（脚本令牌） | 同上：裸 body + `X-File-*` 头 + `X-Api-Token` |

服务端新增 `raw_upload_receive()`：流式把 `php://input` 落到临时文件（不整块读进内存），
从 `X-File-*` 头里取文件名 / MIME / 标题 / 可见性；`store_file()` 增加 `poster_tmp` 参数，
让 poster 不再依赖 `$_FILES`。**老的 multipart 分支保留**（万一主机以后放开，或有人用老客户端）。

**前端改动**（`assets/app.js`）：`upload_finish` 改成 JSON 提交，视频首帧用 `FileReader` 转 dataURL 放进
`poster_b64`；`uploadSimple()` 直接转走分片协议 —— 现在整个站点**不再有任何 multipart 请求**。

**回归**：`node dev/tests/test-filehost-upload.mjs`（12/12）
- ① 自己签一张 SSO 票据，直连源站与走 Cloudflare 前置各做一次「裸字节上传 → 直链 200 → 删除」；
- ② 真实浏览器里跑站内链路：登录 → `upload_init`(JSON) → `upload_chunk`(裸字节) → `upload_finish`(JSON+poster_b64) → 直链 200 → 删除。
- 另外主站侧用 `POST /api/files/upload`（浏览器→Worker 仍是 multipart，Cloudflare 不拦）验证整条附件链路返回 200。

> 以后如果再遇到「只有上传 403、读文件正常」，先按上面的对照表试 `Content-Type`：主机层拦 multipart 的可能性最大。

