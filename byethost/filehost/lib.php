<?php
/**
 * 公共库：配置读取、数据库、鉴权、文件校验、缩略图、工具函数
 * 站点：https://nflshcfile.l.cd
 */

declare(strict_types=1);

define('APP_ROOT', __DIR__);
define('STORAGE_DIR', APP_ROOT . '/storage');

function cfg(?string $key = null)
{
    static $cfg = null;
    if ($cfg === null) {
        $f = APP_ROOT . '/config.php';
        $cfg = is_file($f) ? require $f : require APP_ROOT . '/config.sample.php';
    }
    return $key === null ? $cfg : ($cfg[$key] ?? null);
}

// ---------------- 数据库 ----------------
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    $c = cfg('db');
    $dsn = sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $c['host'], $c['name']);
    $pdo = new PDO($dsn, $c['user'], $c['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    ensure_schema($pdo);
    return $pdo;
}

function ensure_schema(PDO $pdo): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(32) NOT NULL UNIQUE,
        pass_hash VARCHAR(255) NOT NULL,
        email VARCHAR(120) NULL,
        created_at DATETIME NOT NULL,
        last_login DATETIME NULL,
        is_banned TINYINT NOT NULL DEFAULT 0,
        quota_bytes BIGINT NOT NULL DEFAULT 1073741824   -- 默认每人 1GB
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS files (
        id CHAR(24) NOT NULL PRIMARY KEY,
        owner_id INT NOT NULL,
        owner VARCHAR(32) NOT NULL,
        kind VARCHAR(10) NOT NULL,
        name VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        mime VARCHAR(120) NOT NULL DEFAULT '',
        ext VARCHAR(12) NOT NULL DEFAULT '',
        size BIGINT NOT NULL,
        width INT NULL,
        height INT NULL,
        duration FLOAT NULL,
        visibility VARCHAR(8) NOT NULL DEFAULT 'private',
        path VARCHAR(255) NOT NULL,
        thumb VARCHAR(255) NULL,
        downloads INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        INDEX idx_owner (owner_id, created_at),
        INDEX idx_public (visibility, created_at),
        INDEX idx_kind (kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS uploads (
        uid CHAR(24) NOT NULL PRIMARY KEY,
        owner_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        size BIGINT NOT NULL,
        received BIGINT NOT NULL DEFAULT 0,
        meta TEXT NULL,
        created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        token CHAR(48) NOT NULL UNIQUE,
        label VARCHAR(60) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL,
        last_used DATETIME NULL,
        uses INT NOT NULL DEFAULT 0,
        INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        ip VARCHAR(45) NOT NULL PRIMARY KEY,
        fails INT NOT NULL DEFAULT 0,
        last_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 单点登录（主站 Worker → 文件站）相关补列：老库升级用，已存在则忽略
    sso_add_column($pdo, 'users', 'sso_only', "TINYINT NOT NULL DEFAULT 0");
    sso_add_column($pdo, 'files', 'shared_from', "VARCHAR(40) NULL");
}

// 幂等加列：MySQL 4.x/5.x 不支持 ADD COLUMN IF NOT EXISTS，先查 information_schema
function sso_add_column(PDO $pdo, string $table, string $column, string $definition): void
{
    try {
        $dbName = (string)$pdo->query('SELECT DATABASE()')->fetchColumn();
        $st = $pdo->prepare('SELECT COUNT(*) c FROM information_schema.COLUMNS
                             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?');
        $st->execute([$dbName, $table, $column]);
        if ((int)$st->fetch()['c'] === 0) {
            $pdo->exec("ALTER TABLE `$table` ADD COLUMN `$column` $definition");
        }
    } catch (Throwable $e) {
        // 加列失败不影响其它功能（例如权限受限）
    }
}

// ---------------- 会话 ----------------
function boot_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    // 经 Cloudflare HTTPS 入口时也要把 Cookie 标记为 Secure
    $secure = function_exists('request_is_https') ? request_is_https() : (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => $secure,
    ]);
    session_name('NFLSHCFILE');
    session_start();
}

function current_user(): ?array
{
    boot_session();
    if (empty($_SESSION['uid'])) return null;
    static $u = null;
    if ($u && (int)$u['id'] === (int)$_SESSION['uid']) return $u;
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([(int)$_SESSION['uid']]);
    $u = $st->fetch() ?: null;
    if ($u && (int)$u['is_banned'] === 1) { $_SESSION = []; return null; }
    return $u;
}

function require_login(): array
{
    $u = current_user();
    if (!$u) {
        if (is_api()) json_out(['ok' => false, 'error' => '请先登录', 'need_login' => true], 401);
        header('Location: /login.php?next=' . urlencode($_SERVER['REQUEST_URI'] ?? '/'));
        exit;
    }
    return $u;
}

/**
 * 上传令牌鉴权（供脚本使用：请求头 X-Api-Token 或 ?token=）
 * 返回与 users 表同结构的行（额外带 token_id），无效则返回 null
 */
function token_user(): ?array
{
    $tok = (string)($_SERVER['HTTP_X_API_TOKEN'] ?? $_GET['token'] ?? $_POST['token'] ?? '');
    if ($tok === '' || strlen($tok) < 16) return null;
    try {
        $st = db()->prepare('SELECT t.id AS token_id, u.* FROM tokens t JOIN users u ON u.id = t.owner_id WHERE t.token = ?');
        $st->execute([$tok]);
        $row = $st->fetch();
    } catch (Throwable $e) {
        return null;
    }
    if (!$row || (int)$row['is_banned'] === 1) return null;
    try {
        db()->prepare('UPDATE tokens SET last_used = ?, uses = uses + 1 WHERE id = ?')
            ->execute([date('Y-m-d H:i:s'), (int)$row['token_id']]);
    } catch (Throwable $e) { /* 统计失败不影响使用 */ }
    return $row;
}

/** 会话或令牌都可以：返回当前操作者 */
function auth_actor(): ?array
{
    return current_user() ?: token_user();
}

/** 需要操作者（会话或令牌），否则 401 / 跳登录 */
function require_actor(): array
{
    $u = auth_actor();
    if (!$u) {
        if (is_api()) json_out(['ok' => false, 'error' => '请先登录，或提供有效上传令牌（X-Api-Token）', 'need_login' => true], 401);
        header('Location: /login.php?next=' . urlencode($_SERVER['REQUEST_URI'] ?? '/'));
        exit;
    }
    return $u;
}

function is_api(): bool
{
    return basename($_SERVER['SCRIPT_NAME'] ?? '') === 'api.php';
}

// ---------------- 输出 ----------------
function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function client_ip(): string
{
    return (string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

// ---------------- 登录限流 ----------------
function login_rate_limited(): bool
{
    $st = db()->prepare('SELECT fails, last_at FROM login_attempts WHERE ip = ?');
    $st->execute([client_ip()]);
    $r = $st->fetch();
    if (!$r) return false;
    if (strtotime($r['last_at']) < time() - 900) return false;   // 15 分钟窗口
    return (int)$r['fails'] >= 20;
}

function login_fail(): void
{
    db()->prepare('INSERT INTO login_attempts (ip, fails, last_at) VALUES (?,1,?)
                   ON DUPLICATE KEY UPDATE fails = IF(last_at < NOW() - INTERVAL 15 MINUTE, 1, fails + 1), last_at = NOW()')
        ->execute([client_ip(), date('Y-m-d H:i:s')]);
}

function login_ok(): void
{
    db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([client_ip()]);
}

// ---------------- 文件类型 ----------------
function kind_map(): array
{
    return [
        'image' => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'ico'],
        'audio' => ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'weba'],
        'video' => ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts'],
        'file'  => ['pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'txt', 'md', 'csv', 'json', 'xml', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'apk'],
    ];
}

function ext_of(string $name): string
{
    $e = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return preg_replace('/[^a-z0-9]/', '', $e) ?? '';
}

function kind_of(string $ext): string
{
    foreach (kind_map() as $kind => $list) {
        if (in_array($ext, $list, true)) return $kind;
    }
    return 'blocked';
}

function mime_of(string $ext, string $fallback = ''): string
{
    static $map = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif',
        'webp' => 'image/webp', 'bmp' => 'image/bmp', 'avif' => 'image/avif', 'ico' => 'image/x-icon',
        'heic' => 'image/heic',
        'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg', 'oga' => 'audio/ogg',
        'm4a' => 'audio/mp4', 'aac' => 'audio/aac', 'flac' => 'audio/flac', 'opus' => 'audio/opus',
        'weba' => 'audio/webm', 'wma' => 'audio/x-ms-wma',
        'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mov' => 'video/quicktime', 'm4v' => 'video/x-m4v',
        'mkv' => 'video/x-matroska', 'avi' => 'video/x-msvideo', 'wmv' => 'video/x-ms-wmv',
        'flv' => 'video/x-flv', 'mpg' => 'video/mpeg', 'mpeg' => 'video/mpeg', 'ts' => 'video/mp2t',
        'pdf' => 'application/pdf', 'zip' => 'application/zip', 'rar' => 'application/vnd.rar',
        '7z' => 'application/x-7z-compressed', 'gz' => 'application/gzip', 'tar' => 'application/x-tar',
        'txt' => 'text/plain', 'md' => 'text/markdown', 'csv' => 'text/csv', 'json' => 'application/json',
        'xml' => 'application/xml', 'apk' => 'application/vnd.android.package-archive',
    ];
    return $map[$ext] ?? ($fallback ?: 'application/octet-stream');
}

function human_size($bytes): string
{
    $bytes = (float)$bytes;
    $u = ['B', 'KB', 'MB', 'GB', 'TB'];
    $i = 0;
    while ($bytes >= 1024 && $i < count($u) - 1) { $bytes /= 1024; $i++; }
    return ($i === 0 ? (string)(int)$bytes : number_format($bytes, $bytes < 10 ? 2 : 1)) . ' ' . $u[$i];
}

// ---------------- 路径 ----------------
function user_hash(string $username): string
{
    return substr(sha1('nflshcfile:' . $username), 0, 12);
}

function storage_path(string $rel): string
{
    return STORAGE_DIR . '/' . ltrim($rel, '/');
}

function ensure_dir(string $dir): void
{
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
}

function new_id(int $bytes = 12): string
{
    return bin2hex(random_bytes($bytes));
}

// ---------------- 缩略图 ----------------
function make_thumb(string $srcFile, string $ext, string $destFile, int $max = 640): bool
{
    if (!extension_loaded('gd')) return false;
    $img = null;
    switch ($ext) {
        case 'jpg': case 'jpeg': $img = @imagecreatefromjpeg($srcFile); break;
        case 'png': $img = @imagecreatefrompng($srcFile); break;
        case 'gif': $img = @imagecreatefromgif($srcFile); break;
        case 'webp': $img = function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($srcFile) : null; break;
        case 'bmp': $img = function_exists('imagecreatefrombmp') ? @imagecreatefrombmp($srcFile) : null; break;
        case 'avif': $img = function_exists('imagecreatefromavif') ? @imagecreatefromavif($srcFile) : null; break;
        default: $img = null;
    }
    if (!$img) return false;
    $w = imagesx($img); $h = imagesy($img);
    if ($w <= 0 || $h <= 0) { imagedestroy($img); return false; }
    $scale = min(1, $max / max($w, $h));
    $nw = max(1, (int)round($w * $scale));
    $nh = max(1, (int)round($h * $scale));
    $dst = imagecreatetruecolor($nw, $nh);
    // 透明通道保留
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    $white = imagecolorallocatealpha($dst, 255, 255, 255, 127);
    imagefilledrectangle($dst, 0, 0, $nw, $nh, $white);
    imagealphablending($dst, true);
    imagecopyresampled($dst, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
    ensure_dir(dirname($destFile));
    $ok = imagejpeg($dst, $destFile, 82);
    imagedestroy($dst);
    imagedestroy($img);
    return (bool)$ok;
}

// 由客户端上传的封面（视频首帧）保存为缩略图
function save_poster(string $tmpFile, string $destFile, int $max = 640): bool
{
    if (!is_file($tmpFile)) return false;
    $info = @getimagesize($tmpFile);
    if (!$info) return false;
    ensure_dir(dirname($destFile));
    return make_thumb($tmpFile, image_type_to_extension($info[2], false), $destFile, $max);
}

// ---------------- 容量 ----------------
function used_bytes(int $ownerId): int
{
    $st = db()->prepare('SELECT COALESCE(SUM(size),0) AS s FROM files WHERE owner_id = ?');
    $st->execute([$ownerId]);
    return (int)($st->fetch()['s'] ?? 0);
}

// 全站已用容量（所有用户合计），用于主机总空间保护
function total_used_bytes(): int
{
    static $cached = null;
    if ($cached !== null) return $cached;
    try {
        $cached = (int)(db()->query('SELECT COALESCE(SUM(size),0) AS s FROM files')->fetch()['s'] ?? 0);
    } catch (Throwable $e) {
        $cached = 0;
    }
    return $cached;
}

/**
 * 站点总容量检查：主机只有 5GB，写满会导致各种异常，
 * 因此接近 site_max_bytes 时直接拒绝新上传（返回错误信息，前端会提示删除旧文件）
 * @return string|null 超出时返回提示文案
 */
function site_capacity_error(int $incoming): ?string
{
    $max = (int)cfg('site_max_bytes');
    if ($max <= 0) return null;
    $used = total_used_bytes();
    if ($used + $incoming <= $max) return null;
    return '站点总空间接近上限：已用 ' . human_size($used) . ' / ' . human_size($max)
        . '（主机总 5GB），本次需要 ' . human_size($incoming) . '，请先删除一些文件再上传。';
}

/**
 * 当前请求是否为 HTTPS（考虑反向代理：byethost 会改写 X-Forwarded-Proto，
 * 因此优先看我们自己注入的 X-Media-Proto，兼容 Cloudflare Worker 入口）
 */
function request_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
    $p = strtolower((string)($_SERVER['HTTP_X_MEDIA_PROTO'] ?? $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
    return $p === 'https';
}

/**
 * 站点基础地址：config.php 里 base_url 留空时自动按当前请求推断。
 * byethost 前端代理会剥掉 X-Forwarded-Host，所以经 Cloudflare Worker 访问时
 * 由 Worker 注入 X-Media-Host / X-Media-Proto，这里只信任 config 里列出的域名，
 * 防止别人伪造 Host 让分享链接指向奇怪的地方。
 */
function site_base(): string
{
    $fixed = trim((string)cfg('base_url'));
    if ($fixed !== '') return rtrim($fixed, '/');

    $trusted = cfg('trusted_hosts');
    $trusted = is_array($trusted) ? array_map('strtolower', $trusted) : [];

    $cand = trim((string)($_SERVER['HTTP_X_MEDIA_HOST'] ?? $_SERVER['HTTP_X_FORWARDED_HOST'] ?? ''));
    $cand = strtolower((string)preg_replace('/[^A-Za-z0-9\.\-:\[\]]/', '', $cand));

    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? 'nflshcfile.l.cd'));
    if ($cand !== '' && (empty($trusted) || in_array($cand, $trusted, true))) {
        $host = $cand;
    }
    if ($host === '') $host = 'nflshcfile.l.cd';

    return (request_is_https() ? 'https://' : 'http://') . $host;
}

function public_url(string $relPath): string
{
    return site_base() . '/' . ltrim($relPath, '/');
}

function file_public_url(array $f): string
{
    return public_url('f.php?id=' . $f['id']);
}

// 公开文件的静态直链（storage/pub/... ，图片可直接外链到其它网站）
function file_direct_url(array $f): string
{
    if ($f['visibility'] !== 'public') return '';
    return public_url('storage/' . ltrim((string)$f['path'], '/'));
}

function thumb_url(array $f): ?string
{
    if (empty($f['thumb'])) return null;
    if ($f['visibility'] === 'public') return public_url('storage/' . ltrim((string)$f['thumb'], '/'));
    return public_url('thumb.php?id=' . $f['id']);
}

function file_view_url(array $f): string
{
    return public_url('view.php?id=' . $f['id']);
}

function fmt_row(array $f): array
{
    return [
        'id' => $f['id'],
        'owner' => $f['owner'],
        'kind' => $f['kind'],
        'name' => $f['name'],
        'title' => $f['title'] !== '' ? $f['title'] : $f['name'],
        'mime' => $f['mime'],
        'ext' => $f['ext'],
        'size' => (int)$f['size'],
        'sizeText' => human_size($f['size']),
        'width' => $f['width'] !== null ? (int)$f['width'] : null,
        'height' => $f['height'] !== null ? (int)$f['height'] : null,
        'duration' => $f['duration'] !== null ? (float)$f['duration'] : null,
        'visibility' => $f['visibility'],
        'downloads' => (int)$f['downloads'],
        'createdAt' => $f['created_at'],
        'url' => file_public_url($f),
        'directUrl' => $f['visibility'] === 'public' ? file_direct_url($f) : null,
        'viewUrl' => file_view_url($f),
        'thumb' => thumb_url($f),
    ];
}
