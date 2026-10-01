# 镜像 / 备份节点（my-place.us 主机）

主站的数据安全目前只依赖 Cloudflare D1 本身。为了多一层保险，我们额外使用一台免费主机
（cPanel + PHP 8.4 + 5GB 磁盘 + 无限流量）做**离线备份与镜像**，并用 Cloudflare 给它套一层
HTTPS 入口（免费主机本身没有可用 SSL）。

## 1. 结构

```
https://mirror.nflshcchat.cc.cd          ← Cloudflare 自定义域名（自动签发/续期证书）
        │  Worker: nflshc-mirror（本地 nflshc-mirror/worker.js，不入仓库）
        │  · 解开源站的 slowAES 反爬挑战 + 缓存 __test Cookie
        │  · 对 429/502/503/504 自动退避重试
        │  · 只缓存 /files.php 的普通读取（一周）
        ▼
http://nflshcchat.my-place.us            ← 免费主机（openresty + PHP 8.4.25）
   /htdocs/{index,health,files,backup,lib}.php     ← 本地源码在 byethost/mirror/
   /htdocs/store/                     镜像文件（files.php?path=…，读公开、写需密钥）
   /htdocs/store/backups/             D1 加密备份（读也要密钥）
```

FTP：`ftpupload.net` / 用户 `mp_43062696`，网站根目录是 `/htdocs`
（部署脚本：`byethost/tools/deploy-mirror.ps1`）。

## 2. 接口

| 接口 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health.php` | 公开 | PHP 版本、磁盘余量、store 占用、最近备份列表（JSON） |
| `GET /files.php?path=<相对路径>` | 公开 | 读取镜像文件（长缓存 + CORS）。`backups/` 下的路径**必须带密钥** |
| `GET /files.php?list=1&dir=<目录>` | `X-Mirror-Key` | 列目录（JSON） |
| `POST /files.php?path=<相对路径>` | `X-Mirror-Key` | 写入（请求体为原始字节） |
| `GET /files.php?delete=<相对路径>` | `X-Mirror-Key` | 删除 |
| `POST /backup.php?name=<文件名>` | `X-Mirror-Key` | 备份落盘，保留最近 14 份（`config.php` 的 `keep_backups`） |
| `GET /backup.php?list=1` / `?get=<文件名>` | `X-Mirror-Key` | 列备份 / 下载备份 |

> 免费主机把 `disk_total_space` 等函数放进了 `disable_functions`。**PHP 8 里调用被禁函数是致命错误**，
> 页面只会返回空白 500 —— `lib.php` 里的 `mirror_disk()` 因此先 `function_exists` 再调用。

## 3. 密钥

| 名称 | 存放位置 | 用途 |
| --- | --- | --- |
| `mirror_key` | 主机 `config.php`（本地 `byethost/mirror/config.php`） | 读写文件 / 备份的鉴权 |
| `MIRROR_KEY` | 主站 Worker secret | 与上面保持一致 |
| `BACKUP_KEY` | 主站 Worker secret | 备份加密口令（AES-GCM，**丢了就解不开旧备份**） |
| `MIRROR_BASE` | 主站 Worker secret | 镜像节点地址，默认 `https://mirror.nflshcchat.cc.cd` |

本地取值记录在 `dev/_mirror-secrets.txt`、`byethost/mirror/.mirror_key.txt`、`.backup_key.txt`
（都在 gitignore 范围内）。注入命令：`dev/set-mirror-secrets.ps1`。

## 4. 自动备份（D1 → 镜像节点）

- 触发：Worker 定时任务（`wrangler.toml` 的 `*/5 * * * *`）里调用 `runD1Backup()`
  ——**20 小时内已有备份就跳过**，因此实际是每天一份；
- 也可手动触发：`POST /api/admin/backup-now`（仅管理员）；查询状态：`GET /api/admin/mirror`；
- 流程：核心表快照（`BACKUP_TABLES`，单表上限 2 万～5 万行）→ JSON →
  `gzip`（CompressionStream）→ **AES-GCM 加密**（密钥 = `SHA-256(BACKUP_KEY)`，随机 12 字节 IV 前置）
  → 上传为 `d1-<时间戳>.json.gz.enc`；
- 体积参考（当前数据量）：JSON 585 KB → gzip 205 KB → 加密 205 KB；
- 安全性：备份内容是密文；`backups/` 目录即使被直接请求也要求密钥；
  镜像节点最多保留 14 份（一份约 200 KB，可忽略磁盘占用）。

### 恢复步骤

```bash
# 1) 取回备份（密钥在 dev/_mirror-secrets.txt）
curl -H "X-Mirror-Key: <MIRROR_KEY>" -o d1.json.gz.enc \
  "https://mirror.nflshcchat.cc.cd/backup.php?get=d1-<时间戳>.json.gz.enc"
# 2) 解密 + 解压（Node 一行即可）
node -e "const c=require('crypto'),z=require('zlib'),fs=require('fs');
const b=fs.readFileSync('d1.json.gz.enc');const k=c.createHash('sha256').update(process.argv[1]).digest();
const d=c.createDecipheriv('aes-256-gcm',k,b.subarray(0,12));const ct=b.subarray(12);
d.setAuthTag(ct.subarray(ct.length-16));
fs.writeFileSync('d1.json', z.gunzipSync(Buffer.concat([d.update(ct.subarray(0,ct.length-16)),d.final()])));" <BACKUP_KEY>
# 3) d1.json 里 data.<表名> 就是各表数据，可写脚本导回 D1（或人工挑表恢复）
```

## 5. 相关脚本

| 脚本 | 用途 |
| --- | --- |
| `byethost/tools/deploy-mirror.ps1` | 把 `byethost/mirror/*.php` 部署到主机 `/htdocs` |
| `byethost/tools/ftp.ps1` | 通用 FTP 操作（list/put/get/del/mkdir/rmdir），支持 `-FtpHost/-User/-Pass` |
| `dev/tools/tools-probe-host.mjs` | 探测主机能力（HTTP / cPanel / FTP） |
| `dev/tools/tools-make-mirror-worker.mjs` | 从文件站代理派生出镜像节点代理 Worker |
| `dev/set-mirror-secrets.ps1` | 注入 `MIRROR_KEY` / `BACKUP_KEY` / `MIRROR_BASE` |
| `dev/tests/test-d1-backup.mjs` | 备份链路端到端（含解密校验、无密钥拒绝、权限校验）18 项 |
