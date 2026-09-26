<?php
/**
 * JSON API —— 所有写操作都在这里
 * 参数通过 ?a=<action> 指定；分片上传的单片直接以原始字节流放在请求体里。
 *
 * action 列表：
 *   register      注册（username, password, email?）
 *   login         登录（username, password）
 *   logout        退出
 *   me            当前用户信息（含容量用量）
 *   upload_init   开始一次分片上传 → { uid, chunkBytes }
 *   upload_chunk  上传第 idx 片（原始字节流）
 *   upload_finish 合并分片、生成缩略图、写库
 *   upload_simple 小文件直传（multipart: file）
 *   list          我的文件（kind/visibility/q/sort/page）
 *   public        公开广场（分页）
 *   update        修改标题 / 可见性
 *   delete        删除文件
 *   token_create  生成上传令牌（给脚本用）
 *   token_list    令牌列表
 *   token_delete  删除令牌
 *   api_upload    使用 X-Api-Token 直传（multipart: file）
 *   sso_upload    主站 SSO 直传（请求头 X-Files-Ticket，见 config.php 的 sso_secret）
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

$action = (string)($_GET['a'] ?? $_POST['a'] ?? '');
$in = $_POST;
if (empty($in) && str_contains((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '[]', true);
    if (is_array($j)) $in = $j;
}

switch ($action) {

// ============================================================ 账号
case 'register': {
    if (!cfg('allow_register')) json_out(['ok' => false, 'error' => '本站已关闭注册'], 403);
    $username = trim((string)($in['username'] ?? ''));
    $password = (string)($in['password'] ?? '');
    $email = trim((string)($in['email'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9_\x{4e00}-\x{9fa5}]{2,20}$/u', $username)) {
        json_out(['ok' => false, 'error' => '用户名需为 2-20 位字母、数字、下划线或中文'], 400);
    }
    if (strlen($password) < 6) json_out(['ok' => false, 'error' => '密码至少 6 位'], 400);
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) json_out(['ok' => false, 'error' => '邮箱格式不正确'], 400);
    $st = db()->prepare('SELECT id FROM users WHERE username = ?');
    $st->execute([$username]);
    if ($st->fetch()) json_out(['ok' => false, 'error' => '该用户名已被注册'], 409);
    $st = db()->prepare('INSERT INTO users (username, pass_hash, email, created_at, quota_bytes) VALUES (?,?,?,?,?)');
    $st->execute([$username, password_hash($password, PASSWORD_DEFAULT), $email ?: null, date('Y-m-d H:i:s'), (int)cfg('default_quota_bytes')]);
    $uid = (int)db()->lastInsertId();
    boot_session();
    $_SESSION['uid'] = $uid;
    json_out(['ok' => true, 'user' => ['id' => $uid, 'username' => $username]]);
}

case 'login': {
    if (login_rate_limited()) json_out(['ok' => false, 'error' => '尝试次数过多，请 15 分钟后再试'], 429);
    $username = trim((string)($in['username'] ?? ''));
    $password = (string)($in['password'] ?? '');
    $st = db()->prepare('SELECT * FROM users WHERE username = ?');
    $st->execute([$username]);
    $u = $st->fetch();
    if (!$u || !password_verify($password, $u['pass_hash'])) {
        login_fail();
        json_out(['ok' => false, 'error' => '用户名或密码错误'], 401);
    }
    if ((int)$u['is_banned'] === 1) json_out(['ok' => false, 'error' => '账号已被封禁'], 403);
    login_ok();
    boot_session();
    session_regenerate_id(true);
    $_SESSION['uid'] = (int)$u['id'];
    db()->prepare('UPDATE users SET last_login = ? WHERE id = ?')->execute([date('Y-m-d H:i:s'), (int)$u['id']]);
    json_out(['ok' => true, 'user' => ['id' => (int)$u['id'], 'username' => $u['username']]]);
}

case 'logout': {
    boot_session();
    $_SESSION = [];
    session_destroy();
    json_out(['ok' => true]);
}

case 'me': {
    $u = require_actor();
    json_out(['ok' => true, 'user' => [
        'id' => (int)$u['id'], 'username' => $u['username'], 'email' => $u['email'],
        'quota' => (int)$u['quota_bytes'], 'used' => used_bytes((int)$u['id']),
    ]]);
}

// ============================================================ 分片上传
case 'upload_init': {
    $u = require_actor();
    $name = trim((string)($in['name'] ?? ''));
    $size = (int)($in['size'] ?? 0);
    if ($name === '' || $size <= 0) json_out(['ok' => false, 'error' => '缺少文件名或大小'], 400);
    if ($size > (int)cfg('max_file_bytes')) {
        json_out(['ok' => false, 'error' => '文件过大，单文件上限 ' . human_size((int)cfg('max_file_bytes')), 'code' => 'too_large'], 413);
    }
    $ext = ext_of($name);
    $kind = kind_of($ext);
    if ($kind === 'blocked') json_out(['ok' => false, 'error' => '不支持的文件类型 .' . $ext], 415);
    // 主机总空间保护（主机一共 5GB）
    $siteErr = site_capacity_error($size);
    if ($siteErr !== null) json_out(['ok' => false, 'error' => $siteErr, 'code' => 'site_full'], 413);
    $used = used_bytes((int)$u['id']);
    if ($used + $size > (int)$u['quota_bytes']) {
        json_out([
            'ok' => false,
            'error' => '容量不足：已用 ' . human_size($used) . '，本文件 ' . human_size($size)
                . '，每人上限 ' . human_size((int)$u['quota_bytes']) . '（可先删除旧文件再上传）',
            'code' => 'quota', 'used' => $used, 'quota' => (int)$u['quota_bytes'],
        ], 413);
    }
    $uid = new_id(12);
    ensure_dir(storage_path('up'));
    $meta = [
        'name' => $name,
        'size' => $size,
        'ext' => $ext,
        'kind' => $kind,
        'mime' => (string)($in['mime'] ?? ''),
        'visibility' => ($in['visibility'] ?? 'private') === 'public' ? 'public' : 'private',
        'title' => mb_substr(trim((string)($in['title'] ?? '')), 0, 120),
        'owner_id' => (int)$u['id'],
        'owner' => $u['username'],
    ];
    file_put_contents(storage_path('up/' . $uid . '.json'), json_encode($meta, JSON_UNESCAPED_UNICODE));
    db()->prepare('INSERT INTO uploads (uid, owner_id, name, size, received, meta, created_at) VALUES (?,?,?,?,0,?,?)')
        ->execute([$uid, (int)$u['id'], $name, $size, json_encode($meta, JSON_UNESCAPED_UNICODE), date('Y-m-d H:i:s')]);
    // 清理 1 天前的残留分片
    foreach (glob(storage_path('up/*.part')) ?: [] as $f) {
        if (filemtime($f) < time() - 86400) @unlink($f);
    }
    foreach (glob(storage_path('up/*.json')) ?: [] as $f) {
        if (filemtime($f) < time() - 86400) @unlink($f);
    }
    json_out(['ok' => true, 'uid' => $uid, 'chunkBytes' => (int)cfg('chunk_bytes')]);
}

case 'upload_chunk': {
    $u = require_actor();
    $uid = preg_replace('/[^a-f0-9]/', '', (string)($_GET['uid'] ?? $in['uid'] ?? ''));
    $idx = (int)($_GET['idx'] ?? $in['idx'] ?? 0);
    if (!$uid) json_out(['ok' => false, 'error' => '缺少上传 id'], 400);
    $metaFile = storage_path('up/' . $uid . '.json');
    if (!is_file($metaFile)) json_out(['ok' => false, 'error' => '上传会话已过期，请重新上传'], 410);
    $meta = json_decode((string)file_get_contents($metaFile), true);
    if ((int)($meta['owner_id'] ?? 0) !== (int)$u['id']) json_out(['ok' => false, 'error' => '无权操作该上传'], 403);
    $partFile = storage_path('up/' . $uid . '.part');
    // 只允许顺序追加，避免越界写入
    $expect = (int)($meta['received'] ?? 0);
    $offset = $idx * (int)cfg('chunk_bytes');
    if ($offset !== $expect) {
        json_out(['ok' => false, 'error' => '分片顺序不正确', 'expect' => $expect], 409);
    }
    $data = file_get_contents('php://input');
    if ($data === false || $data === '') json_out(['ok' => false, 'error' => '空分片'], 400);
    if (strlen($data) > (int)cfg('chunk_bytes') + 1024 * 1024) json_out(['ok' => false, 'error' => '分片过大'], 413);
    if (file_put_contents($partFile, $data, FILE_APPEND) === false) json_out(['ok' => false, 'error' => '写入失败（磁盘或权限）'], 500);
    $meta['received'] = $expect + strlen($data);
    file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE));
    db()->prepare('UPDATE uploads SET received = ? WHERE uid = ?')->execute([(int)$meta['received'], $uid]);
    json_out(['ok' => true, 'received' => (int)$meta['received'], 'total' => (int)$meta['size']]);
}

case 'upload_finish': {
    $u = require_actor();
    $uid = preg_replace('/[^a-f0-9]/', '', (string)($in['uid'] ?? $_GET['uid'] ?? ''));
    if (!$uid) json_out(['ok' => false, 'error' => '缺少上传 id'], 400);
    $metaFile = storage_path('up/' . $uid . '.json');
    if (!is_file($metaFile)) json_out(['ok' => false, 'error' => '上传会话已过期'], 410);
    $meta = json_decode((string)file_get_contents($metaFile), true);
    if ((int)($meta['owner_id'] ?? 0) !== (int)$u['id']) json_out(['ok' => false, 'error' => '无权操作该上传'], 403);
    $partFile = storage_path('up/' . $uid . '.part');
    if (!is_file($partFile)) json_out(['ok' => false, 'error' => '没有收到任何分片'], 400);
    $realSize = (int)filesize($partFile);
    if ($realSize <= 0) json_out(['ok' => false, 'error' => '文件内容为空'], 400);
    if ($realSize > (int)cfg('max_file_bytes')) json_out(['ok' => false, 'error' => '文件超过单文件上限'], 413);
    // 容量复核：init 时按声明的 size 检查过一次，这里按**真实字节数**再查一次，
    // 防止客户端谎报大小（先报 1KB 再传几百 MB）绕过每人 1GB 的上限
    $usedNow = used_bytes((int)$u['id']);
    $quota = (int)$u['quota_bytes'];
    $siteErr = site_capacity_error($realSize);
    if ($usedNow + $realSize > $quota || $siteErr !== null) {
        @unlink($partFile);
        @unlink($metaFile);
        db()->prepare('DELETE FROM uploads WHERE uid = ?')->execute([$uid]);
        json_out([
            'ok' => false,
            'error' => $siteErr !== null ? $siteErr
                : '容量不足：已用 ' . human_size($usedNow) . '，本文件 ' . human_size($realSize)
                  . '，你的上限 ' . human_size($quota) . '（可先删除旧文件再上传）',
            'code' => $siteErr !== null ? 'site_full' : 'quota', 'used' => $usedNow, 'quota' => $quota,
        ], 413);
    }

    $rec = store_file($partFile, $meta, $u, [
        'width' => isset($in['width']) ? (int)$in['width'] : null,
        'height' => isset($in['height']) ? (int)$in['height'] : null,
        'duration' => isset($in['duration']) ? (float)$in['duration'] : null,
    ]);
    @unlink($partFile);
    @unlink($metaFile);
    db()->prepare('DELETE FROM uploads WHERE uid = ?')->execute([$uid]);
    json_out(['ok' => true, 'file' => fmt_row($rec)]);
}

case 'upload_simple': {
    $u = require_actor();
    if (empty($_FILES['file'])) json_out(['ok' => false, 'error' => '没有收到文件'], 400);
    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) json_out(['ok' => false, 'error' => '上传失败（错误码 ' . $file['error'] . '）'], 400);
    $name = (string)($in['name'] ?? $file['name']);
    $ext = ext_of($name);
    $kind = kind_of($ext);
    if ($kind === 'blocked') json_out(['ok' => false, 'error' => '不支持的文件类型 .' . $ext], 415);
    $siteErr = site_capacity_error((int)$file['size']);
    if ($siteErr !== null) json_out(['ok' => false, 'error' => $siteErr, 'code' => 'site_full'], 413);
    $used = used_bytes((int)$u['id']);
    if ($used + (int)$file['size'] > (int)$u['quota_bytes']) {
        json_out(['ok' => false, 'error' => '容量不足：已用 ' . human_size($used) . '，本文件 ' . human_size((int)$file['size'])
            . '，你的上限 ' . human_size((int)$u['quota_bytes']), 'code' => 'quota'], 413);
    }
    $meta = [
        'name' => $name, 'size' => (int)$file['size'], 'ext' => $ext, 'kind' => $kind,
        'mime' => (string)($file['type'] ?? ''),
        'visibility' => ($in['visibility'] ?? 'private') === 'public' ? 'public' : 'private',
        'title' => mb_substr(trim((string)($in['title'] ?? '')), 0, 120),
        'owner_id' => (int)$u['id'], 'owner' => $u['username'],
    ];
    $rec = store_file($file['tmp_name'], $meta, $u, [
        'width' => isset($in['width']) ? (int)$in['width'] : null,
        'height' => isset($in['height']) ? (int)$in['height'] : null,
        'duration' => isset($in['duration']) ? (float)$in['duration'] : null,
    ]);
    json_out(['ok' => true, 'file' => fmt_row($rec)]);
}

// ============================================================ 列表 / 修改 / 删除
case 'list': {
    $u = require_actor();
    $kind = (string)($in['kind'] ?? $_GET['kind'] ?? '');
    $vis = (string)($in['visibility'] ?? $_GET['visibility'] ?? '');
    $q = trim((string)($in['q'] ?? $_GET['q'] ?? ''));
    $sort = (string)($in['sort'] ?? $_GET['sort'] ?? 'new');
    $page = max(1, (int)($in['page'] ?? $_GET['page'] ?? 1));
    $per = 60;
    $where = ['owner_id = ?'];
    $args = [(int)$u['id']];
    if (in_array($kind, ['image', 'audio', 'video', 'file'], true)) { $where[] = 'kind = ?'; $args[] = $kind; }
    if (in_array($vis, ['public', 'private'], true)) { $where[] = 'visibility = ?'; $args[] = $vis; }
    if ($q !== '') { $where[] = '(title LIKE ? OR name LIKE ?)'; $args[] = "%$q%"; $args[] = "%$q%"; }
    $order = ['new' => 'created_at DESC', 'old' => 'created_at ASC', 'big' => 'size DESC', 'small' => 'size ASC', 'name' => 'title ASC'][$sort] ?? 'created_at DESC';
    $sql = 'SELECT * FROM files WHERE ' . implode(' AND ', $where) . " ORDER BY $order LIMIT " . (($page - 1) * $per) . ", $per";
    $st = db()->prepare($sql);
    $st->execute($args);
    $rows = array_map('fmt_row', $st->fetchAll());
    $cnt = db()->prepare('SELECT COUNT(*) c FROM files WHERE ' . implode(' AND ', $where));
    $cnt->execute($args);
    json_out(['ok' => true, 'files' => $rows, 'total' => (int)$cnt->fetch()['c'], 'page' => $page,
        'used' => used_bytes((int)$u['id']), 'quota' => (int)$u['quota_bytes'],
        'siteUsed' => total_used_bytes(), 'siteMax' => (int)cfg('site_max_bytes')]);
}

case 'public': {
    $kind = (string)($in['kind'] ?? $_GET['kind'] ?? '');
    $q = trim((string)($in['q'] ?? $_GET['q'] ?? ''));
    $page = max(1, (int)($in['page'] ?? $_GET['page'] ?? 1));
    $per = 48;
    $where = ["visibility = 'public'"];
    $args = [];
    if (in_array($kind, ['image', 'audio', 'video', 'file'], true)) { $where[] = 'kind = ?'; $args[] = $kind; }
    if ($q !== '') { $where[] = '(title LIKE ? OR name LIKE ?)'; $args[] = "%$q%"; $args[] = "%$q%"; }
    $sql = 'SELECT * FROM files WHERE ' . implode(' AND ', $where) . ' ORDER BY created_at DESC LIMIT ' . (($page - 1) * $per) . ", $per";
    $st = db()->prepare($sql);
    $st->execute($args);
    $cnt = db()->prepare('SELECT COUNT(*) c FROM files WHERE ' . implode(' AND ', $where));
    $cnt->execute($args);
    json_out(['ok' => true, 'files' => array_map('fmt_row', $st->fetchAll()), 'total' => (int)$cnt->fetch()['c'], 'page' => $page]);
}

case 'update': {
    $u = require_actor();
    $id = clean_id($in['id'] ?? '');
    $f = find_file($id);
    if (!$f) json_out(['ok' => false, 'error' => '文件不存在'], 404);
    if ((int)$f['owner_id'] !== (int)$u['id']) json_out(['ok' => false, 'error' => '无权修改该文件'], 403);
    $sets = [];
    $args = [];
    if (isset($in['title'])) { $sets[] = 'title = ?'; $args[] = mb_substr(trim((string)$in['title']), 0, 120); }
    if (isset($in['visibility'])) {
        $vis = ((string)$in['visibility'] === 'public') ? 'public' : 'private';
        if ($vis !== $f['visibility']) {
            $newPath = move_for_visibility($f, $vis);
            $sets[] = 'visibility = ?'; $args[] = $vis;
            $sets[] = 'path = ?'; $args[] = $newPath['path'];
            $sets[] = 'thumb = ?'; $args[] = $newPath['thumb'];
        }
    }
    if ($sets) {
        $args[] = $id;
        db()->prepare('UPDATE files SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }
    json_out(['ok' => true, 'file' => fmt_row(find_file($id))]);
}

case 'delete': {
    $u = require_actor();
    $id = clean_id($in['id'] ?? '');
    $f = find_file($id);
    if (!$f) json_out(['ok' => false, 'error' => '文件不存在'], 404);
    if ((int)$f['owner_id'] !== (int)$u['id']) json_out(['ok' => false, 'error' => '无权删除该文件'], 403);
    foreach ([$f['path'], $f['thumb']] as $p) {
        if ($p) { $abs = storage_path($p); if (is_file($abs)) @unlink($abs); }
    }
    db()->prepare('DELETE FROM files WHERE id = ?')->execute([$id]);
    json_out(['ok' => true]);
}

case 'sso_upload': {
    // 供 NFLSHC 主站 Worker 中转调用：请求头 X-Files-Ticket = base64(username)|exp|hmac(username|exp)
    // 用户无需在文件站二次登录；票据由 Worker 用 FILES_SSO_SECRET 签发，5 分钟有效。
    $secret = (string)cfg('sso_secret');
    if ($secret === '' || strpos($secret, 'REPLACE_WITH') === 0) {
        json_out(['ok' => false, 'error' => '文件站未配置 sso_secret，SSO 上传不可用'], 503);
    }
    $ticket = (string)($_SERVER['HTTP_X_FILES_TICKET'] ?? ($_GET['ticket'] ?? ''));
    if ($ticket === '') json_out(['ok' => false, 'error' => '缺少 X-Files-Ticket'], 401);
    $parts = explode('|', $ticket);
    if (count($parts) !== 3) json_out(['ok' => false, 'error' => '票据格式不正确'], 401);
    [$b64user, $exp, $sig] = $parts;
    $username = (string)base64_decode(strtr($b64user, '-_', '+/'), true);
    if ($username === '') json_out(['ok' => false, 'error' => '票据用户名无效'], 401);
    if (!ctype_digit((string)$exp) || (int)$exp < (int)(microtime(true) * 1000)) {
        json_out(['ok' => false, 'error' => '票据已过期，请重试'], 401);
    }
    $expect = hash_hmac('sha256', $username . '|' . $exp, $secret);
    if (!hash_equals($expect, (string)$sig)) json_out(['ok' => false, 'error' => '票据签名校验失败'], 401);
    if (empty($_FILES['file'])) json_out(['ok' => false, 'error' => '没有收到文件（字段名应为 file）'], 400);
    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) json_out(['ok' => false, 'error' => '上传失败（错误码 ' . $file['error'] . '）'], 400);
    // 首次 SSO 登录时自动建号，密码置为不可用的随机值（用户只能通过主站使用该账号）
    $st = db()->prepare('SELECT * FROM users WHERE username = ?');
    $st->execute([$username]);
    $u = $st->fetch();
    if (!$u) {
        db()->prepare('INSERT INTO users (username, pass_hash, created_at, quota_bytes, sso_only) VALUES (?,?,?,?,1)')
            ->execute([$username, password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT),
                date('Y-m-d H:i:s'), (int)cfg('default_quota_bytes')]);
        $st->execute([$username]);
        $u = $st->fetch();
    }
    if ((int)($u['is_banned'] ?? 0) === 1) json_out(['ok' => false, 'error' => '该账号已被封禁'], 403);
    $name = (string)($in['name'] ?? $file['name']);
    $ext = ext_of($name);
    $kind = kind_of($ext);
    if ($kind === 'blocked') json_out(['ok' => false, 'error' => '不支持的文件类型 .' . $ext], 415);
    $siteErr = site_capacity_error((int)$file['size']);
    if ($siteErr !== null) json_out(['ok' => false, 'error' => $siteErr, 'code' => 'site_full'], 413);
    $used = used_bytes((int)$u['id']);
    if ($used + (int)$file['size'] > (int)$u['quota_bytes']) {
        json_out(['ok' => false, 'error' => '容量不足：已用 ' . human_size($used) . '，本文件 ' . human_size((int)$file['size'])
            . '，账号上限 ' . human_size((int)$u['quota_bytes']), 'code' => 'quota'], 413);
    }
    $meta = [
        'name' => $name, 'size' => (int)$file['size'], 'ext' => $ext, 'kind' => $kind,
        'mime' => (string)($file['type'] ?? ''),
        'visibility' => ($in['visibility'] ?? 'public') === 'private' ? 'private' : 'public',
        'title' => mb_substr(trim((string)($in['title'] ?? '')), 0, 120),
        'owner_id' => (int)$u['id'], 'owner' => $u['username'],
    ];
    $rec = store_file($file['tmp_name'], $meta, ['id' => (int)$u['id'], 'username' => $u['username']], []);
    json_out(['ok' => true, 'file' => fmt_row($rec), 'sso' => true, 'owner' => $u['username']]);
}

// ============================================================ 上传令牌（脚本用）
case 'token_create': {
    $u = require_login();
    $label = mb_substr(trim((string)($in['label'] ?? '')), 0, 60);
    $token = new_id(24);
    db()->prepare('INSERT INTO tokens (owner_id, token, label, created_at) VALUES (?,?,?,?)')
        ->execute([(int)$u['id'], $token, $label, date('Y-m-d H:i:s')]);
    json_out(['ok' => true, 'token' => $token]);
}

case 'token_list': {
    $u = require_login();
    $st = db()->prepare('SELECT id, label, LEFT(token, 8) AS prefix, created_at, last_used, uses FROM tokens WHERE owner_id = ? ORDER BY id DESC');
    $st->execute([(int)$u['id']]);
    json_out(['ok' => true, 'tokens' => $st->fetchAll()]);
}

case 'token_delete': {
    $u = require_login();
    db()->prepare('DELETE FROM tokens WHERE id = ? AND owner_id = ?')->execute([(int)($in['id'] ?? 0), (int)$u['id']]);
    json_out(['ok' => true]);
}

case 'api_upload': {
    // 供脚本使用：请求头 X-Api-Token 鉴权，multipart 上传（≤20MB，受 PHP 限制）
    $token = (string)($_SERVER['HTTP_X_API_TOKEN'] ?? $_GET['token'] ?? '');
    $st = db()->prepare('SELECT t.*, u.username, u.id AS uid, u.is_banned, u.quota_bytes FROM tokens t JOIN users u ON u.id = t.owner_id WHERE t.token = ?');
    $st->execute([$token]);
    $t = $st->fetch();
    if (!$t || (int)$t['is_banned'] === 1) json_out(['ok' => false, 'error' => '令牌无效'], 401);
    if (empty($_FILES['file'])) json_out(['ok' => false, 'error' => '没有收到文件（字段名应为 file）'], 400);
    $file = $_FILES['file'];
    $name = (string)($in['name'] ?? $file['name']);
    $ext = ext_of($name);
    $kind = kind_of($ext);
    if ($kind === 'blocked') json_out(['ok' => false, 'error' => '不支持的文件类型 .' . $ext], 415);
    $siteErr = site_capacity_error((int)$file['size']);
    if ($siteErr !== null) json_out(['ok' => false, 'error' => $siteErr, 'code' => 'site_full'], 413);
    $used = used_bytes((int)$t['uid']);
    if ($used + (int)$file['size'] > (int)$t['quota_bytes']) {
        json_out(['ok' => false, 'error' => '容量不足：已用 ' . human_size($used) . '，本文件 ' . human_size((int)$file['size'])
            . '，账号上限 ' . human_size((int)$t['quota_bytes']), 'code' => 'quota'], 413);
    }
    $meta = [
        'name' => $name, 'size' => (int)$file['size'], 'ext' => $ext, 'kind' => $kind,
        'mime' => (string)($file['type'] ?? ''),
        'visibility' => ($in['visibility'] ?? 'private') === 'public' ? 'public' : 'private',
        'title' => mb_substr(trim((string)($in['title'] ?? '')), 0, 120),
        'owner_id' => (int)$t['uid'], 'owner' => $t['username'],
    ];
    $rec = store_file($file['tmp_name'], $meta, ['id' => (int)$t['uid'], 'username' => $t['username']], []);
    db()->prepare('UPDATE tokens SET last_used = ?, uses = uses + 1 WHERE id = ?')->execute([date('Y-m-d H:i:s'), (int)$t['id']]);
    json_out(['ok' => true, 'file' => fmt_row($rec)]);
}

default:
    json_out(['ok' => false, 'error' => '未知的 action: ' . $action], 400);
}

// ================================================================ 内部函数

function clean_id($v): string
{
    return preg_replace('/[^a-f0-9]/', '', (string)$v) ?? '';
}

function find_file(string $id): ?array
{
    if ($id === '') return null;
    $st = db()->prepare('SELECT * FROM files WHERE id = ?');
    $st->execute([$id]);
    return $st->fetch() ?: null;
}

/**
 * 把临时文件落到正式目录并入库
 * @param array $meta name/size/ext/kind/mime/visibility/title/owner_id/owner
 * @param array $extra width/height/duration
 */
function store_file(string $tmpFile, array $meta, array $user, array $extra): array
{
    $uid = new_id(12);
    $uh = user_hash((string)$meta['owner']);
    $isPublic = ($meta['visibility'] === 'public');
    $relPath = ($isPublic ? 'pub/' : 'prv/') . $uh . '/' . $uid . '.' . $meta['ext'];
    $absPath = storage_path($relPath);
    ensure_dir(dirname($absPath));
    if (!move_uploaded_file_safe($tmpFile, $absPath)) {
        json_out(['ok' => false, 'error' => '保存文件失败'], 500);
    }
    // 图片尺寸
    $width = $extra['width'] ?? null;
    $height = $extra['height'] ?? null;
    $mime = mime_of($meta['ext'], (string)$meta['mime']);
    if ($meta['kind'] === 'image') {
        $info = @getimagesize($absPath);
        if ($info) { $width = $info[0]; $height = $info[1]; $mime = $info['mime'] ?: $mime; }
    }
    // 缩略图：图片自动生成；视频用客户端上传的首帧（poster 字段）
    $thumbRel = null;
    $thumbRelPath = ($isPublic ? 'tpub/' : 'tprv/') . $uh . '/' . $uid . '.jpg';
    $thumbAbs = storage_path($thumbRelPath);
    if ($meta['kind'] === 'image' && make_thumb($absPath, $meta['ext'], $thumbAbs)) {
        $thumbRel = $thumbRelPath;
    } elseif (!empty($_FILES['poster']['tmp_name']) && save_poster($_FILES['poster']['tmp_name'], $thumbAbs)) {
        $thumbRel = $thumbRelPath;
    }
    $rec = [
        'id' => $uid, 'owner_id' => (int)$meta['owner_id'], 'owner' => (string)$meta['owner'],
        'kind' => $meta['kind'], 'name' => (string)$meta['name'],
        'title' => (string)($meta['title'] ?? ''), 'mime' => $mime, 'ext' => $meta['ext'],
        'size' => (int)filesize($absPath), 'width' => $width, 'height' => $height,
        'duration' => $extra['duration'] ?? null, 'visibility' => $isPublic ? 'public' : 'private',
        'path' => $relPath, 'thumb' => $thumbRel, 'downloads' => 0, 'created_at' => date('Y-m-d H:i:s'),
    ];
    db()->prepare('INSERT INTO files (id, owner_id, owner, kind, name, title, mime, ext, size, width, height, duration, visibility, path, thumb, created_at)
                   VALUES (:id,:owner_id,:owner,:kind,:name,:title,:mime,:ext,:size,:width,:height,:duration,:visibility,:path,:thumb,:created_at)')
        ->execute([
            ':id' => $rec['id'], ':owner_id' => $rec['owner_id'], ':owner' => $rec['owner'], ':kind' => $rec['kind'],
            ':name' => $rec['name'], ':title' => $rec['title'], ':mime' => $rec['mime'], ':ext' => $rec['ext'],
            ':size' => $rec['size'], ':width' => $rec['width'], ':height' => $rec['height'],
            ':duration' => $rec['duration'], ':visibility' => $rec['visibility'], ':path' => $rec['path'],
            ':thumb' => $rec['thumb'], ':created_at' => $rec['created_at'],
        ]);
    return $rec;
}

// 分片合并用的是普通文件（不是 PHP 上传临时文件），需要区分处理
function move_uploaded_file_safe(string $tmpFile, string $dest): bool
{
    if (is_uploaded_file($tmpFile)) return move_uploaded_file($tmpFile, $dest);
    return @rename($tmpFile, $dest) || (bool)@copy($tmpFile, $dest);
}

// 切换可见性时把文件搬到对应目录（公开目录可直链，私有目录有 .htaccess 保护）
function move_for_visibility(array $f, string $vis): array
{
    $uh = user_hash((string)$f['owner']);
    $targetDir = ($vis === 'public' ? 'pub/' : 'prv/') . $uh;
    $newRel = $targetDir . '/' . $f['id'] . '.' . $f['ext'];
    $newAbs = storage_path($newRel);
    ensure_dir(dirname($newAbs));
    $oldAbs = storage_path($f['path']);
    if (is_file($oldAbs) && $oldAbs !== $newAbs) @rename($oldAbs, $newAbs);
    $thumbRel = $f['thumb'];
    if (!empty($f['thumb'])) {
        $thumbRel = ($vis === 'public' ? 'tpub/' : 'tprv/') . $uh . '/' . $f['id'] . '.jpg';
        $oldThumb = storage_path($f['thumb']);
        $newThumb = storage_path($thumbRel);
        ensure_dir(dirname($newThumb));
        if (is_file($oldThumb) && $oldThumb !== $newThumb) @rename($oldThumb, $newThumb);
    }
    return ['path' => $newRel, 'thumb' => $thumbRel];
}

