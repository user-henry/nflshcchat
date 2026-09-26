<?php
/**
 * 配置示例 —— 复制为 config.php 并填入真实数据库信息后上传。
 * 数据库需在主机控制面板（VistaPanel → MySQL Databases）创建，库名形如 <账号>_media。
 */
return [
    'db' => [
        'host' => 'sql308.byethost11.com',   // 面板「MySQL Host Name」列所示
        'name' => 'b11_XXXXXXXX_media',
        'user' => 'b11_XXXXXXXX',
        'pass' => '数据库密码（与面板登录密码相同）',
    ],
    'base_url' => 'https://nflshcfile.l.cd',
    'site_name' => 'NFLSHC 文件托管',
    'max_file_bytes' => 512 * 1024 * 1024,
    'default_quota_bytes' => 1024 * 1024 * 1024,   // 每个用户总容量：1GB
    'site_max_bytes' => 4608 * 1024 * 1024,        // 站点总容量软上限：4.5GB（主机共 5GB）
    'chunk_bytes' => 4 * 1024 * 1024,
    'allow_register' => true,
    'trusted_hosts' => ['nflshcfile.l.cd', 'file.nflshcchat.cc.cd'],
    // 单点登录密钥：与 Cloudflare Worker 的 FILES_SSO_SECRET 保持一致（随机 32 位以上字符串）
    'sso_secret' => '把这里换成随机长字符串',
];
