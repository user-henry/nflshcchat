// NFLSHC Chat D1 Worker
// Backs the migrated GitHub-Issues data with a D1 database.
// Provides a "legacy issues" compatibility layer so existing front-end
// code (which parses issue bodies as fenced JSON) keeps working unchanged.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DB;
    const method = request.method;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const t0 = Date.now();
    try {
      await ensureHzColumns(db);
      await ensureAuthTable(db);
      await ensureOAuthTables(db);
      await ensureCallTables(db);
      const p = url.pathname.split('/').filter(Boolean);

      // ================= 认证端点（无需 token） =================
      // POST /api/auth/login  { username, password: <SHA-256 哈希> }
      //   服务端校验 users 表中的密码哈希（不再依赖公开读取用户表），签发 Bearer Token。
      //   安全策略：
      //     - 同一账号连续失败 20 次 → 锁定 5 分钟
      //     - 同一账号累计失败 50 次 → 冻结该用户 + 封禁登录 IP + 通知管理员
      //     - 被封禁 IP 禁止登录/注册
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'login' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || '').trim();
        const passwordHash = String(b.password || '');
        if (!username || !passwordHash) {
          return json({ ok: false, error: 'missing username/password' }, 400, cors);
        }
        const clientIp = (request.headers.get('CF-Connecting-IP') || '').trim();

        // 0) IP 黑名单检查
        if (clientIp && await isIpBanned(db, clientIp)) {
          return json({ ok: false, error: '您的 IP 已被封禁，请联系管理员', code: 'ip_banned' }, 403, cors);
        }

        // 1) 账号锁定检查（连续失败 20 次锁 5 分钟）
        const lockInfo = await db.prepare('SELECT fail_count, locked_until FROM login_security WHERE key = ?').bind('user:' + username).first();
        if (lockInfo && lockInfo.locked_until && new Date(lockInfo.locked_until).getTime() > Date.now()) {
          const mins = Math.ceil((new Date(lockInfo.locked_until).getTime() - Date.now()) / 60000);
          return json({ ok: false, error: `登录尝试次数过多，请 ${mins} 分钟后再试`, code: 'locked' }, 429, cors);
        }

        // 2) 校验凭据
        const user = await db.prepare('SELECT username, password, raw_json, is_banned FROM users WHERE username = ?').bind(username).first();
        const payload = user ? parsePayload(user.raw_json) : null;
        const storedHash = user ? (user.password || (payload && payload.password) || null) : null;
        const isHashed = user ? !!(payload && (payload.passwordHashed || user.password_hashed)) : false;
        const credOk = !!user && !!storedHash && isHashed && storedHash === passwordHash;

        if (!credOk) {
          // 3) 记录失败，触发锁定/冻结/封禁
          await recordLoginFailure(db, username, clientIp);
          const cur = await db.prepare('SELECT fail_count FROM login_security WHERE key = ?').bind('user:' + username).first();
          const failCount = cur ? (cur.fail_count || 0) : 0;
          if (failCount >= LOGIN_FREEZE_THRESHOLD) {
            // 冻结用户（is_banned + isFrozen 双标记，区别于管理员主动封禁）+ 封禁 IP + 通知管理员
            await db.prepare('UPDATE users SET is_banned = 1 WHERE username = ?').bind(username).run();
            await db.prepare(`UPDATE users SET raw_json = ? WHERE username = ?`).bind(
              '```json\n' + JSON.stringify({ ...payload, isBanned: true, isFrozen: true }) + '\n```', username).run();
            if (clientIp) await db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason, banned_at) VALUES (?,?,?)')
              .bind(clientIp, '登录失败达 50 次（用户名: ' + username + '）', new Date().toISOString()).run();
            await notifyAdmin(db, '⚠️ 账号已冻结并封禁 IP',
              '用户 ' + username + '（IP: ' + (clientIp || '未知') + '）因连续登录失败达 ' + LOGIN_FREEZE_THRESHOLD + ' 次，已被冻结并封禁 IP，请到管理后台处理。');
            return json({ ok: false, error: '登录失败次数过多，账号已冻结，请联系管理员', code: 'frozen' }, 403, cors);
          }
          if (failCount >= LOGIN_LOCK_THRESHOLD) {
            const lockUntil = new Date(Date.now() + LOGIN_LOCK_MS);
            await db.prepare('UPDATE login_security SET locked_until = ? WHERE key = ?').bind(lockUntil.toISOString(), 'user:' + username).run();
            return json({ ok: false, error: '登录尝试次数过多，已锁定 5 分钟，请稍后再试', code: 'locked' }, 429, cors);
          }
          return json({ ok: false, error: '用户名或密码错误' }, 401, cors);
        }

        // 封禁校验：数据库列 is_banned 为准（raw_json 可能因历史写入未同步），
        // 返回明确的中文提示，前端据此显示「申诉」入口
        const bannedByColumn = user && (user.is_banned === 1 || user.is_banned === true);
        if (bannedByColumn || (payload && payload.isBanned)) {
          const reason = (payload && (payload.banReason || payload.frozenReason)) || '';
          return json({
            ok: false,
            error: '账号已被封禁' + (reason ? ('：' + reason) : '') + '，如有疑问可提交申诉',
            code: 'banned',
            canAppeal: true,
          }, 403, cors);
        }
        // 冻结（系统自动）：提示可申诉
        if (payload && payload.isFrozen) {
          return json({
            ok: false,
            error: '账号已被冻结，如有疑问可提交申诉',
            code: 'frozen',
            canAppeal: true,
          }, 403, cors);
        }

        // 4) 登录成功：重置失败计数，签发 token
        await db.prepare('DELETE FROM login_security WHERE key = ?').bind('user:' + username).run();
        if (clientIp) await db.prepare('DELETE FROM login_security WHERE key = ?').bind('ip:' + clientIp).run();
        const token = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tok_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_MS);
        // 多设备会话：不再作废其他端，改为登记本次会话（保留"账户中心可一键下线任意设备"）
        await createSession(db, {
          token, username, expiresAt,
          via: 'password',
          userAgent: request.headers.get('User-Agent') || '',
          ip: clientIp,
        });
        const isAdmin = (username === 'huangzhiyuan') || !!(payload && payload.isAdmin);
        await recordMetric(env, { kind: 'login', name: 'password', status: 200, username, request });
        return json({ ok: true, token, username, isAdmin, expiresAt: expiresAt.toISOString() }, 200, cors);
      }

      // POST /api/auth/appeal —— 被冻结/封禁的用户向管理员申诉（匿名，10 分钟限频 1 次）
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'appeal' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || '').trim();
        const reason = String(b.reason || '').trim();
        if (!username || !reason) return json({ ok: false, error: '请填写用户名和申诉理由' }, 400, cors);
        if (reason.length > 500) return json({ ok: false, error: '申诉理由过长（500 字以内）' }, 400, cors);
        const clientIp = (request.headers.get('CF-Connecting-IP') || '').trim();
        const lastRow = await db.prepare('SELECT updated_at FROM login_security WHERE key = ?').bind('appeal:' + username).first();
        if (lastRow && lastRow.updated_at && (Date.now() - new Date(lastRow.updated_at).getTime()) < 10 * 60 * 1000) {
          return json({ ok: false, error: '申诉已提交，请 10 分钟后再试' }, 429, cors);
        }
        await db.prepare('INSERT OR REPLACE INTO login_security (key, fail_count, locked_until, updated_at) VALUES (?, 0, NULL, ?)')
          .bind('appeal:' + username, new Date().toISOString()).run();
        await notifyAdmin(db, '🙋 用户申诉说明',
          '用户 ' + username + '（IP: ' + (clientIp || '未知') + '）提交申诉：' + reason);
        return json({ ok: true, message: '申诉已提交，管理员会尽快处理' }, 200, cors);
      }

      // GET /api/auth/banned-ips —— 管理员查看被封禁 IP 列表
      // DELETE /api/auth/banned-ips/<ip> —— 管理员解封 IP
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'banned-ips') {
        const auth = await authUser(request, db);
        if (!auth) return json({ ok: false, error: 'unauthorized' }, 401, cors);
        if (!auth.isAdmin) return jsonForbidden();
        if (method === 'GET') {
          const { results } = await db.prepare('SELECT ip, reason, banned_at FROM banned_ips ORDER BY banned_at DESC').all();
          return json({ ok: true, list: results }, 200, cors);
        }
        if (method === 'DELETE' && p[3]) {
          const ip = decodeURIComponent(p[3]);
          await db.prepare('DELETE FROM banned_ips WHERE ip = ?').bind(ip).run();
          return json({ ok: true, ip, unbanned: true }, 200, cors);
        }
        return json({ ok: false, error: 'unsupported' }, 400, cors);
      }

      // POST /api/auth/logout —— 吊销当前 token（Authorization: Bearer <token>）
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'logout' && method === 'POST') {
        const token = bearerToken(request);
        if (token) await db.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(token).run();
        return json({ ok: true }, 200, cors);
      }

      // ============================================================
      //  登录设备 / 会话管理（账号中心使用）
      //    GET    /api/auth/sessions                 列出我的登录设备
      //    DELETE /api/auth/sessions/<sessionId>     下线某一台设备
      //    POST   /api/auth/sessions/revoke-others   下线除当前设备外的所有设备
      // ============================================================
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'sessions') {
        const sAuth = await authUser(request, db);
        if (!sAuth) return json({ ok: false, error: '请先登录' }, 401, cors);
        const myToken = bearerToken(request) || '';
        const nowIso = new Date().toISOString();

        if (method === 'GET') {
          const { results } = await db.prepare(
            `SELECT session_id, device_label, ip, created_at, last_seen_at, expires_at, via, token
             FROM auth_tokens WHERE username = ? ORDER BY COALESCE(last_seen_at, created_at) DESC`
          ).bind(sAuth.username).all();
          const sessions = (results || []).map(r => ({
            id: r.session_id || (r.token || '').slice(0, 8),
            device: r.device_label || '未知设备',
            ip: r.ip || '',
            via: r.via || 'password',
            createdAt: r.created_at,
            lastSeenAt: r.last_seen_at || r.created_at,
            expiresAt: r.expires_at,
            current: r.token === myToken,
            expired: r.expires_at ? new Date(r.expires_at).getTime() < Date.now() : false,
          }));
          return json({ ok: true, sessions, current: sessions.find(s => s.current)?.id || null, max: MAX_SESSIONS_PER_USER }, 200, cors);
        }

        if (method === 'DELETE' && p[3]) {
          const sid = String(p[3]);
          const row = await db.prepare('SELECT token, session_id, username FROM auth_tokens WHERE username = ?')
            .bind(sAuth.username).all();
          const hit = (row.results || []).find(r => (r.session_id || (r.token || '').slice(0, 8)) === sid);
          if (!hit) return json({ ok: false, error: '找不到该设备会话' }, 404, cors);
          await db.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(hit.token).run();
          return json({ ok: true, removed: sid, wasCurrent: hit.token === myToken }, 200, cors);
        }

        if (method === 'POST' && p[3] === 'revoke-others') {
          await db.prepare('DELETE FROM auth_tokens WHERE username = ? AND token != ?')
            .bind(sAuth.username, myToken).run();
          return json({ ok: true }, 200, cors);
        }

        return json({ ok: false, error: 'unsupported sessions action' }, 400, cors);
      }

      // ============================================================
      //  扫码登录（PC 出码 → 手机已登录状态下确认 → PC 换取 token）
      //    POST /api/auth/qr/create                     PC 建码（无需登录）
      //    GET  /api/auth/qr/info?id=                   查询二维码内容（手机扫码页用）
      //    POST /api/auth/qr/confirm { id, secret? }    手机确认（需已登录）
      //    POST /api/auth/qr/poll    { id, secret }     PC 轮询取 token（一次性）
      //    POST /api/auth/qr/cancel  { id, secret }     PC 取消
      // ============================================================
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'qr') {
        const qa = p[3] || '';
        const nowIso = new Date().toISOString();

        if (qa === 'create' && method === 'POST') {
          const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, '').slice(0, 20);
          const secret = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, '').slice(0, 24);
          const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();   // 3 分钟有效
          await db.prepare(
            `INSERT INTO qr_login_sessions (id, secret, status, created_at, expires_at, ip, user_agent)
             VALUES (?,?, 'pending', ?,?,?,?)`
          ).bind(id, secret, nowIso, expiresAt, (request.headers.get('CF-Connecting-IP') || ''), (request.headers.get('User-Agent') || '').slice(0, 300)).run();
          // 顺手清理过期会话
          await db.prepare('DELETE FROM qr_login_sessions WHERE expires_at < ?').bind(nowIso).run();
          return json({ ok: true, id, secret, expiresAt }, 201, cors);
        }

        if (qa === 'info' && method === 'GET') {
          const id = url.searchParams.get('id') || '';
          const row = await db.prepare('SELECT * FROM qr_login_sessions WHERE id = ?').bind(id).first();
          if (!row) return json({ ok: false, error: '二维码不存在或已过期' }, 404, cors);
          const expired = new Date(row.expires_at).getTime() < Date.now();
          return json({
            ok: true,
            status: expired ? 'expired' : row.status,
            id: row.id,
            device: describeDevice(row.user_agent),
            ip: row.ip || '',
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            confirmedBy: row.username || null,
          }, 200, cors);
        }

        if (qa === 'confirm' && method === 'POST') {
          const qAuth = await authUser(request, db);
          if (!qAuth) return json({ ok: false, error: '请先在手机上登录账号', need_login: true }, 401, cors);
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || '');
          const row = await db.prepare('SELECT * FROM qr_login_sessions WHERE id = ?').bind(id).first();
          if (!row) return json({ ok: false, error: '二维码不存在' }, 404, cors);
          if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, error: '二维码已过期，请在电脑上刷新', code: 'expired' }, 410, cors);
          if (row.status === 'confirmed') return json({ ok: false, error: '该二维码已被使用' }, 409, cors);

          // 为电脑端签发新会话
          const token = (crypto.randomUUID ? crypto.randomUUID() : ('tok_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)));
          const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_MS);
          await createSession(db, {
            token, username: qAuth.username, expiresAt, via: 'qr',
            userAgent: row.user_agent || '', ip: row.ip || '',
          });
          await db.prepare(
            `UPDATE qr_login_sessions SET status = 'confirmed', username = ?, token = ?, confirmed_at = ? WHERE id = ?`
          ).bind(qAuth.username, token, nowIso, id).run();
          return json({ ok: true, username: qAuth.username, status: 'confirmed' }, 200, cors);
        }

        if (qa === 'poll' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || '');
          const secret = String(b.secret || '');
          const row = await db.prepare('SELECT * FROM qr_login_sessions WHERE id = ?').bind(id).first();
          if (!row || row.secret !== secret) return json({ ok: false, error: '登录会话无效' }, 401, cors);
          if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, status: 'expired', error: '二维码已过期' }, 410, cors);
          if (row.status === 'cancelled') return json({ ok: false, status: 'cancelled', error: '已取消' }, 410, cors);
          if (row.status !== 'confirmed') return json({ ok: true, status: row.status }, 200, cors);
          // 确认成功：下发 token，并立即作废二维码（一次性）
          await db.prepare('DELETE FROM qr_login_sessions WHERE id = ?').bind(id).run();
          const urow = await db.prepare('SELECT username, raw_json, is_banned FROM users WHERE username = ?').bind(row.username).first();
          const payload = urow ? (parsePayload(urow.raw_json) || {}) : {};
          if (urow && (urow.is_banned === 1 || urow.is_banned === true || payload.isBanned)) {
            return json({ ok: false, error: '账号已被封禁，如有疑问可提交申诉', code: 'banned' }, 403, cors);
          }
          return json({
            ok: true, status: 'confirmed', token: row.token, username: row.username,
            isAdmin: isAdminUser(row.username), expiresAt: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString(), via: 'qr',
          }, 200, cors);
        }

        if (qa === 'cancel' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || '');
          const secret = String(b.secret || '');
          const row = await db.prepare('SELECT * FROM qr_login_sessions WHERE id = ?').bind(id).first();
          if (row && row.secret === secret) {
            await db.prepare('UPDATE qr_login_sessions SET status = ? WHERE id = ?').bind('cancelled', id).run();
          }
          return json({ ok: true }, 200, cors);
        }

        return json({ ok: false, error: 'unknown qr action' }, 404, cors);
      }

      // ============================================================
      //  账号数据（GDPR 风格）
      //    GET    /api/account/export      导出我的全部数据（JSON 下载）
      //    POST   /api/account/delete      申请注销（7 天冷静期，可撤销）
      //    POST   /api/account/delete/cancel  撤销注销申请
      //    GET    /api/account/status      查询注销申请状态
      // ============================================================
      if (p[0] === 'api' && p[1] === 'account') {
        const aAuth = await authUser(request, db);
        if (!aAuth) return json({ ok: false, error: '请先登录' }, 401, cors);
        const me = aAuth.username;
        const act = p[2] || '';

        if (act === 'export' && method === 'GET') {
          const dump = { exportedAt: new Date().toISOString(), account: {}, data: {} };
          const urow = await db.prepare('SELECT username, raw_json, created_at FROM users WHERE username = ?').bind(me).first();
          const upayload = urow ? (parsePayload(urow.raw_json) || {}) : {};
          delete upayload.password;
          dump.account = { username: me, createdAt: urow ? urow.created_at : null, profile: upayload };

          // 该用户在各表中的数据（能查到的都导出）
          const collect = async (table, where, bind) => {
            try {
              const { results } = await db.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...bind).all();
              return (results || []).map(r => { const o = { ...r }; delete o.password; return o; });
            } catch (e) { return { error: String(e.message || e) }; }
          };
          dump.data.messages = await collect('messages', 'sender = ?', [me]);
          dump.data.hzyai_conversations = await collect('hzyai_conversations', 'user = ?', [me]);
          dump.data.hzyai_gen = await collect('hzyai_gen', 'user = ?', [me]);
          dump.data.friends = await collect('friends', 'owner = ? OR friend = ?', [me, me]);
          dump.data.favorites = await collect('favorites', 'username = ?', [me]);
          dump.data.oauth_grants = await collect('oauth_grants', 'username = ?', [me]);
          dump.data.oauth_identities = await collect('oauth_identities', 'username = ?', [me]);
          dump.data.sessions = (await collect('auth_tokens', 'username = ?', [me])).map(s => {
            const o = { ...s }; delete o.token; return o;   // 不导出可用 token
          });
          dump.data.meetings = await collect('meeting_members', 'username = ?', [me]);

          return new Response(JSON.stringify(dump, null, 2), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="nflshc-export-${me}-${Date.now()}.json"`,
              ...cors,
            },
          });
        }

        if (act === 'status' && method === 'GET') {
          const row = await db.prepare('SELECT * FROM account_deletions WHERE username = ?').bind(me).first();
          return json({ ok: true, deletion: row || null }, 200, cors);
        }

        if (act === 'delete' && p[3] === 'cancel' && method === 'POST') {
          await db.prepare('UPDATE account_deletions SET cancelled_at = ? WHERE username = ?')
            .bind(new Date().toISOString(), me).run();
          return json({ ok: true, cancelled: true }, 200, cors);
        }

        if (act === 'delete' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          if (String(b.confirm || '') !== me) {
            return json({ ok: false, error: '请输入你的用户名以确认注销', code: 'need_confirm' }, 400, cors);
          }
          // 一次性删除全部数据的风险太大，采用 7 天冷静期（期间登录可撤销）
          const requestedAt = new Date();
          const effectiveAt = new Date(requestedAt.getTime() + 7 * 24 * 3600 * 1000);
          await db.prepare(
            `INSERT OR REPLACE INTO account_deletions (username, requested_at, effective_at, reason, cancelled_at)
             VALUES (?,?,?,?,NULL)`
          ).bind(me, requestedAt.toISOString(), effectiveAt.toISOString(), String(b.reason || '').slice(0, 300)).run();
          await notifyAdmin(db, '⚠️ 用户申请注销账号',
            `用户 ${me} 于 ${requestedAt.toISOString()} 申请注销账号，将于 ${effectiveAt.toISOString()} 生效（7 天冷静期，可撤销）。`);
          return json({
            ok: true,
            requestedAt: requestedAt.toISOString(),
            effectiveAt: effectiveAt.toISOString(),
            message: '注销申请已提交，将在 7 天后生效；期间你仍可登录并撤销申请。',
          }, 200, cors);
        }

        return json({ ok: false, error: 'unknown account action' }, 404, cors);
      }

      // ============================================================
      //  管理员健康看板
      //    GET /api/admin/health         汇总：会话/用户/数据量/额度/错误/服务连通性
      //    GET /api/admin/health/errors  最近的错误与慢请求明细
      // ============================================================
      if (p[0] === 'api' && p[1] === 'admin' && p[2] === 'health') {
        const hAuth = await authUser(request, db);
        if (!hAuth || !hAuth.isAdmin) return json({ ok: false, error: '仅管理员可访问' }, 403, cors);
        const nowIso = new Date().toISOString();
        const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

        if (p[3] === 'errors' && method === 'GET') {
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '80'), 300);
          const { results } = await db.prepare(
            `SELECT kind, name, detail, status, ms, username, ip, created_at FROM metrics_events
             WHERE kind IN ('error','slow') ORDER BY id DESC LIMIT ?`
          ).bind(limit).all();
          return json({ ok: true, events: results || [] }, 200, cors);
        }

        const count = async (sql, ...args) => {
          try {
            const r = await db.prepare(sql).bind(...args).first();
            return r ? Object.values(r)[0] : 0;
          } catch (e) { return null; }
        };

        const [usersTotal, users24h, sessionsActive, sessionsExpired, messagesTotal, messages24h,
          convTotal, grantsTotal, clientsTotal, err24h, slow24h, qrPending, meetingsActive, deletionsPending] = await Promise.all([
          count('SELECT COUNT(*) AS c FROM users'),
          count('SELECT COUNT(*) AS c FROM users WHERE created_at > ?', dayAgo),
          count('SELECT COUNT(*) AS c FROM auth_tokens WHERE expires_at > ?', nowIso),
          count('SELECT COUNT(*) AS c FROM auth_tokens WHERE expires_at <= ?', nowIso),
          count('SELECT COUNT(*) AS c FROM messages'),
          count('SELECT COUNT(*) AS c FROM messages WHERE timestamp > ?', dayAgo),
          count('SELECT COUNT(*) AS c FROM hzyai_conversations'),
          count('SELECT COUNT(*) AS c FROM oauth_grants'),
          count('SELECT COUNT(*) AS c FROM oauth_clients'),
          count(`SELECT COUNT(*) AS c FROM metrics_events WHERE kind = 'error' AND created_at > ?`, dayAgo),
          count(`SELECT COUNT(*) AS c FROM metrics_events WHERE kind = 'slow' AND created_at > ?`, dayAgo),
          count(`SELECT COUNT(*) AS c FROM qr_login_sessions WHERE status = 'pending' AND expires_at > ?`, nowIso),
          count(`SELECT COUNT(*) AS c FROM meetings WHERE status IN ('scheduled','live')`),
          count('SELECT COUNT(*) AS c FROM account_deletions WHERE cancelled_at IS NULL'),
        ]);

        // 下游服务连通性（逐个探测，失败不影响整体）
        const probe = async (name, target, expectJson) => {
          const t0 = Date.now();
          try {
            const r = await fetch(target, { signal: AbortSignal.timeout(6000), cf: { cacheTtl: 0 } });
            const ms = Date.now() - t0;
            let ok = r.ok;
            let detail = '';
            if (expectJson) {
              const j = await r.json().catch(() => null);
              ok = ok && !!j;
              detail = j ? JSON.stringify(j).slice(0, 120) : '非 JSON';
            }
            return { name, ok, status: r.status, ms, detail };
          } catch (e) {
            return { name, ok: false, status: 0, ms: Date.now() - t0, detail: String(e.message || e).slice(0, 120) };
          }
        };
        const services = await Promise.all([
          probe('AI 网关 hzyai-worker', 'https://hzyai-worker.nflshcchat.cc.cd/health', true),
          probe('文件托管（源站）', 'http://nflshcfile.l.cd/api.php?a=public', false),
          probe('文件托管（HTTPS 入口）', 'https://file.nflshcchat.cc.cd/assets/style.css', false),
          probe('Google 公钥（登录依赖）', 'https://www.googleapis.com/oauth2/v3/certs', true),
          probe('BigModel（智谱）', 'https://open.bigmodel.cn/api/paas/v4/models', false),
        ]);

        const recentErrors = await (async () => {
          try {
            const { results } = await db.prepare(
              `SELECT name, detail, status, ms, created_at FROM metrics_events
               WHERE kind = 'error' ORDER BY id DESC LIMIT 10`
            ).all();
            return results || [];
          } catch (e) { return []; }
        })();

        return json({
          ok: true,
          now: nowIso,
          workerVersion: 'nflshcchat',
          counts: {
            usersTotal, users24h, sessionsActive, sessionsExpired,
            messagesTotal, messages24h, convTotal, grantsTotal, clientsTotal,
            errors24h: err24h, slow24h, qrPending, meetingsActive, deletionsPending,
          },
          services,
          recentErrors,
          googleLogin: googleConfig(env).enabled,
        }, 200, cors);
      }


      // ============================================================
      //  Google 账号登录（主站 / HZYAI / accounts / platform 共用）
      //
      //  配置（缺任一则功能自动关闭，前端按钮不显示）：
      //    GOOGLE_CLIENT_ID      例如 1234567890-xxxx.apps.googleusercontent.com
      //    GOOGLE_CLIENT_SECRET  wrangler secret put GOOGLE_CLIENT_SECRET
      //  Google 控制台里要登记的「已获授权的重定向 URI」：
      //    https://worker.nflshcchat.cc.cd/api/auth/google/callback
      //
      //  流程：前端跳 /api/auth/google/start?redirect=<前端地址>
      //        → Google 授权 → 回到 /api/auth/google/callback
      //        → 校验 id_token、关联或创建账号、签发一次性 ticket
      //        → 回跳前端 #google_login=<ticket>
      //        → 前端 POST /api/auth/google/exchange 换取 Bearer token
      // ============================================================
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'google') {
        const gcfg = googleConfig(env);
        const action = p[3] || '';

        // GET /api/auth/google/config —— 前端据此决定是否显示"使用 Google 登录"
        if ((action === 'config' || action === '') && method === 'GET') {
          return json({
            ok: true,
            enabled: gcfg.enabled,
            clientId: gcfg.enabled ? gcfg.clientId : null,
            callback: new URL(request.url).origin + '/api/auth/google/callback',
          }, 200, cors);
        }

        if (!gcfg.enabled && action !== 'exchange' && action !== 'config') {
          return json({ ok: false, error: 'Google 登录尚未配置（缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）', code: 'not_configured' }, 503, cors);
        }

        // GET /api/auth/google/start?redirect=<前端地址>[&json=1]
        if (action === 'start' && method === 'GET') {
          const ret = url.searchParams.get('redirect') || 'https://nflshcchat.cc.cd/';
          const safeRet = googleSafeRedirect(ret);
          if (!safeRet) return json({ ok: false, error: 'redirect 不在允许的域名白名单内' }, 400, cors);
          const state = await googleSignState({ r: safeRet, n: crypto.randomUUID() }, gcfg.secret);
          const authUrl = GOOGLE_AUTH_URL + '?' + new URLSearchParams({
            client_id: gcfg.clientId,
            redirect_uri: new URL(request.url).origin + '/api/auth/google/callback',
            response_type: 'code',
            scope: 'openid email profile',
            state,
            prompt: 'select_account',
            access_type: 'online',
          }).toString();
          if (url.searchParams.get('json') === '1') return json({ ok: true, url: authUrl }, 200, cors);
          return Response.redirect(authUrl, 302);
        }

        // GET /api/auth/google/callback?code=&state=
        if (action === 'callback' && method === 'GET') {
          const stateRaw = url.searchParams.get('state') || '';
          const state = await googleVerifyState(stateRaw, gcfg.secret);
          const fallback = 'https://nflshcchat.cc.cd/';
          const backTo = (state && state.r) || fallback;
          const fail = (msg) => Response.redirect(backTo + '#google_error=' + encodeURIComponent(msg), 302);

          if (url.searchParams.get('error')) {
            return fail('Google 授权被取消（' + String(url.searchParams.get('error')).slice(0, 40) + '）');
          }
          if (!state) return fail('登录会话已过期，请重新点击「使用 Google 登录」');
          const code = url.searchParams.get('code') || '';
          if (!code) return fail('缺少授权码');

          try {
            // 1) code 换 token
            const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                code,
                client_id: gcfg.clientId,
                client_secret: gcfg.clientSecret,
                redirect_uri: new URL(request.url).origin + '/api/auth/google/callback',
                grant_type: 'authorization_code',
              }).toString(),
            });
            const tokenJson = await tokenRes.json().catch(() => ({}));
            if (!tokenRes.ok || !tokenJson.id_token) {
              return fail('换取 Google 令牌失败：' + String(tokenJson.error_description || tokenJson.error || tokenRes.status).slice(0, 80));
            }
            // 2) 校验 id_token（签名 + aud + iss + exp）
            const prof = await googleVerifyIdToken(tokenJson.id_token, gcfg.clientId);
            if (!prof) return fail('Google 返回的身份信息校验失败');
            if (prof.email_verified === false) return fail('该 Google 账号邮箱未验证，无法登录');

            // 3) 关联已有账号或创建新账号
            const who = await googleResolveUser(db, prof);

            // 封禁检查（与密码登录一致）
            if (who.banned) {
              const reason = who.banReason ? ('：' + who.banReason) : '';
              return Response.redirect(backTo + '#google_error=' + encodeURIComponent('账号已被' + (who.frozen ? '冻结' : '封禁') + reason + '，如有疑问可提交申诉'), 302);
            }

            // 4) 签发 Bearer token + 一次性 ticket
            const token = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tok_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
            const now = new Date();
            const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_MS);
            await db.prepare('DELETE FROM auth_tokens WHERE username = ?').bind(who.username).run();
            await db.prepare('INSERT INTO auth_tokens (token, username, created_at, expires_at) VALUES (?,?,?,?)')
              .bind(token, who.username, now.toISOString(), expiresAt.toISOString()).run();

            const ticket = crypto.randomUUID().replace(/-/g, '');
            await db.prepare(`INSERT INTO google_login_tickets (ticket, username, token, created_at, expires_at, used)
                              VALUES (?,?,?,?,?,0)`)
              .bind(ticket, who.username, token, now.toISOString(), new Date(now.getTime() + 5 * 60 * 1000).toISOString()).run();

            return Response.redirect(backTo + '#google_login=' + ticket, 302);
          } catch (e) {
            return fail('Google 登录失败：' + String((e && e.message) || e).slice(0, 100));
          }
        }

        // POST /api/auth/google/exchange  { ticket }
        if (action === 'exchange' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const ticket = String(b.ticket || '').trim();
          if (!ticket) return json({ ok: false, error: '缺少 ticket' }, 400, cors);
          const row = await db.prepare('SELECT * FROM google_login_tickets WHERE ticket = ?').bind(ticket).first();
          if (!row) return json({ ok: false, error: '登录凭据无效，请重新登录' }, 401, cors);
          if (row.used) return json({ ok: false, error: '该登录凭据已被使用，请重新登录' }, 401, cors);
          if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, error: '登录凭据已过期，请重新登录' }, 401, cors);
          await db.prepare('UPDATE google_login_tickets SET used = 1 WHERE ticket = ?').bind(ticket).run();
          const urow = await db.prepare('SELECT username, raw_json, is_banned FROM users WHERE username = ?').bind(row.username).first();
          if (!urow) return json({ ok: false, error: '账号不存在' }, 404, cors);
          const payload = parsePayload(urow.raw_json) || {};
          if (urow.is_banned === 1 || urow.is_banned === true || payload.isBanned) {
            return json({ ok: false, error: '账号已被封禁，如有疑问可提交申诉', code: 'banned', canAppeal: true }, 403, cors);
          }
          return json({
            ok: true,
            token: row.token,
            username: row.username,
            isAdmin: isAdminUser(row.username),
            expiresAt: new Date(Date.now() + AUTH_TOKEN_TTL_MS).toISOString(),
            via: 'google',
            isNewUser: !!payload.isGoogleNew,
          }, 200, cors);
        }

        return json({ ok: false, error: 'unknown google auth endpoint' }, 404, cors);
      }

      // ===== 机器人 Bot API =====
      // 说明：开发者可在 platform 把自己的应用登记为机器人（botUsername），
      // 然后用 client_id + client_secret 调用以下接口收发消息（服务端到服务端）。
      //   POST /api/bot/send     { client_id, client_secret, room_id, content }
      //   GET  /api/bot/messages?client_id=&client_secret=&room_id=&limit=
      //   POST /api/bot/join     { client_id, client_secret, room_id }
      if (p[0] === 'api' && p[1] === 'bot' && p[2]) {
        const b = method === 'POST' ? await request.json().catch(() => ({})) : {};
        const clientId = String((method === 'POST' ? b.client_id || b.clientId : url.searchParams.get('client_id')) || '');
        const clientSecret = String((method === 'POST' ? b.client_secret || b.clientSecret : url.searchParams.get('client_secret')) || '');
        if (!clientId || !clientSecret) return json({ ok: false, error: '缺少 client_id 或 client_secret' }, 401, cors);
        const crow = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
        if (!crow) return json({ ok: false, error: '应用不存在' }, 404, cors);
        if (crow.status !== 'active') return json({ ok: false, error: '应用已被停用' }, 403, cors);
        if (crow.client_secret_hash !== await sha256Hex(clientSecret)) {
          return json({ ok: false, error: 'client_secret 不正确' }, 401, cors);
        }
        const botUser = crow.bot_username || crow.name || ('bot_' + clientId.slice(-6));

        if (p[2] === 'send' && method === 'POST') {
          const roomId = String(b.room_id || b.roomId || '');
          const content = String(b.content || '').trim();
          if (!roomId || !content) return json({ ok: false, error: '缺少 room_id 或 content' }, 400, cors);
          if (content.length > 4000) return json({ ok: false, error: '消息过长（4000 字以内）' }, 400, cors);
          const room = await db.prepare('SELECT id, members FROM rooms WHERE id = ?').bind(roomId).first();
          if (!room) return json({ ok: false, error: '聊天室不存在' }, 404, cors);
          const msgId = 'msg_bot_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const payload = {
            id: msgId, roomId, sender: botUser, content,
            timestamp: new Date().toISOString(), isBot: true, botClientId: clientId,
          };
          const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
          await db.prepare(
            `INSERT INTO messages (id, room_id, sender, content, mentions, has_mention_all, reply_to, is_recalled, is_pinned, timestamp, raw_json)
             VALUES (?,?,?,?,?,0,NULL,0,0,?,?)`
          ).bind(msgId, roomId, botUser, content, JSON.stringify([]), payload.timestamp, JSON.stringify(payload)).run();
          // 触发 Webhook（其他订阅了 message.created 的应用）
          await fanoutWebhookToAuthorizedApps(db, 'message.created', botUser, { roomId, messageId: msgId, content, byBot: true, clientId });
          return json({ ok: true, id: msgId, sender: botUser, roomId }, 200, cors);
        }

        if (p[2] === 'messages' && method === 'GET') {
          const roomId = url.searchParams.get('room_id') || '';
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
          let q;
          if (roomId) {
            q = await db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp DESC LIMIT ?').bind(roomId, limit).all();
          } else {
            q = await db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?').bind(limit).all();
          }
          const msgs = (q.results || []).map(r => {
            const p2 = parsePayload(r.raw_json) || {};
            return { id: r.id, roomId: r.room_id, sender: r.sender, content: r.content, timestamp: r.timestamp, isRecalled: !!r.is_recalled };
          }).filter(m => !m.isRecalled);
          return json({ ok: true, messages: msgs.reverse() }, 200, cors);
        }

        if (p[2] === 'join' && method === 'POST') {
          const roomId = String(b.room_id || b.roomId || '');
          if (!roomId) return json({ ok: false, error: '缺少 room_id' }, 400, cors);
          const room = await db.prepare('SELECT id, members FROM rooms WHERE id = ?').bind(roomId).first();
          if (!room) return json({ ok: false, error: '聊天室不存在' }, 404, cors);
          const members = parseJsonArraySafe(room.members);
          if (!members.includes(botUser)) {
            members.push(botUser);
            await db.prepare('UPDATE rooms SET members = ? WHERE id = ?').bind(JSON.stringify(members), roomId).run();
          }
          return json({ ok: true, roomId, botUsername: botUser, joined: true }, 200, cors);
        }

        return json({ ok: false, error: 'unknown bot endpoint' }, 404, cors);
      }

      // ============================================================
      //  会议（快速会议 / 预定会议 / 会议编号 / 邀请通知 / 会中聊天 / 语音视频信令）
      //    POST /api/meeting/create     { title, kind:'instant'|'scheduled', scheduledAt, durationMin, invitees[], password?, note? }
      //    GET  /api/meeting/list       我参与的会议（即将开始 / 进行中 / 已结束）
      //    POST /api/meeting/join       { code } 用会议编号加入
      //    POST /api/meeting/leave      { meetingId }
      //    GET  /api/meeting/detail?id= 会议详情 + 成员 + 最近聊天
      //    POST /api/meeting/invite     { meetingId, usernames[] } 发邀请通知
      //    POST /api/meeting/chat       { meetingId, content }
      //    GET  /api/meeting/chat?meetingId=&since=  拉取聊天（轮询）
      //    POST /api/meeting/signal     { meetingId, to, kind, payload }  WebRTC 信令
      //    GET  /api/meeting/signal?meetingId=&since= 取信令
      //    POST /api/meeting/end        { meetingId } 结束会议（主持人）
      // ============================================================
      if (p[0] === 'api' && p[1] === 'meeting' && p[2]) {
        const mAuth = await authUser(request, db);
        if (!mAuth) return json({ ok: false, error: '请先登录' }, 401, cors);
        const me = mAuth.username;
        const act = p[2];
        const nowIso = new Date().toISOString();

        const genCode = () => {
          const s = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
          let out = '';
          for (let i = 0; i < 9; i++) out += s[Math.floor(Math.random() * s.length)];
          return out.slice(0, 3) + '-' + out.slice(3, 6) + '-' + out.slice(6, 9);
        };
        const asMember = async (meetingId) => db.prepare(
          'SELECT * FROM meeting_members WHERE meeting_id = ? AND username = ?'
        ).bind(meetingId, me).first();

        if (act === 'create' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const title = String(b.title || '').trim().slice(0, 80) || (me + ' 的会议');
          const kind = b.kind === 'scheduled' ? 'scheduled' : 'instant';
          let scheduledAt = null;
          if (kind === 'scheduled') {
            scheduledAt = String(b.scheduledAt || '').trim();
            if (!scheduledAt) return json({ ok: false, error: '预定会议需要填写开始时间' }, 400, cors);
            const t = new Date(scheduledAt).getTime();
            if (isNaN(t)) return json({ ok: false, error: '开始时间格式不正确' }, 400, cors);
            scheduledAt = new Date(t).toISOString();
          }
          const id = 'mt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          let code = genCode();
          for (let i = 0; i < 5; i++) {
            const dup = await db.prepare('SELECT id FROM meetings WHERE code = ?').bind(code).first();
            if (!dup) break;
            code = genCode();
          }
          await db.prepare(
            `INSERT INTO meetings (id, code, title, host, kind, status, scheduled_at, duration_min, created_at, password, note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(id, code, title, me, kind, kind === 'instant' ? 'live' : 'scheduled', scheduledAt,
            Number(b.durationMin) || 60, nowIso, String(b.password || '').slice(0, 32), String(b.note || '').slice(0, 500)).run();
          if (kind === 'instant') {
            await db.prepare(
              `INSERT OR REPLACE INTO meeting_members (meeting_id, username, role, invited_at, joined_at, state)
               VALUES (?,?, 'host', ?,?, 'joined')`
            ).bind(id, me, nowIso, nowIso).run();
          } else {
            await db.prepare(
              `INSERT OR REPLACE INTO meeting_members (meeting_id, username, role, invited_at, state)
               VALUES (?,?, 'host', ?, 'invited')`
            ).bind(id, me, nowIso).run();
          }
          // 邀请对象：写入成员表 + 站内通知
          const invitees = Array.isArray(b.invitees) ? b.invitees.map(x => String(x).trim()).filter(Boolean).slice(0, 50) : [];
          const invited = [];
          for (const uname of invitees) {
            if (uname === me) continue;
            const exists = await db.prepare('SELECT username FROM users WHERE username = ?').bind(uname).first();
            if (!exists) continue;
            await db.prepare(
              `INSERT OR REPLACE INTO meeting_members (meeting_id, username, role, invited_at, state)
               VALUES (?,?, 'guest', ?, 'invited')`
            ).bind(id, uname, nowIso).run();
            try {
              await db.prepare(
                `INSERT OR REPLACE INTO notifications (id, type, title, content, target_user, sender, sent_at, is_read, raw_json)
                 VALUES (?,?,?,?,?,?,?,0,?)`
              ).bind('ntf_mt_' + id + '_' + uname, 'meeting',
                '📅 会议邀请：' + title,
                `${me} 邀请你参加${kind === 'scheduled' ? '预定会议' : '会议'}「${title}」，会议编号 ${code}` +
                (scheduledAt ? `，开始时间 ${scheduledAt}` : ''),
                uname, me, nowIso,
                JSON.stringify({ type: 'meeting', meetingId: id, code, title, host: me, scheduledAt })
              ).run();
            } catch (e) { /* 通知失败不影响建会 */ }
            invited.push(uname);
          }
          return json({ ok: true, meeting: { id, code, title, kind, scheduledAt, status: kind === 'instant' ? 'live' : 'scheduled' }, invited }, 201, cors);
        }

        if (act === 'list' && method === 'GET') {
          const { results } = await db.prepare(
            `SELECT m.*, mm.role, mm.state FROM meetings m
             JOIN meeting_members mm ON mm.meeting_id = m.id
             WHERE mm.username = ? ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC LIMIT 60`
          ).bind(me).all();
          return json({ ok: true, meetings: results || [] }, 200, cors);
        }

        if (act === 'join' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
          const normalized = code.length === 9 ? code.slice(0, 3) + '-' + code.slice(3, 6) + '-' + code.slice(6, 9) : code;
          const mt = await db.prepare('SELECT * FROM meetings WHERE code = ? OR id = ?').bind(normalized, String(b.code || '')).first();
          if (!mt) return json({ ok: false, error: '会议不存在，请检查会议编号' }, 404, cors);
          if (mt.status === 'ended') return json({ ok: false, error: '该会议已结束' }, 410, cors);
          if (mt.password && String(b.password || '') !== mt.password) {
            return json({ ok: false, error: '会议密码不正确', code: 'need_password' }, 403, cors);
          }
          const existing = await asMember(mt.id);
          if (existing) {
            await db.prepare(
              `UPDATE meeting_members SET state = 'joined', joined_at = ?, left_at = NULL WHERE meeting_id = ? AND username = ?`
            ).bind(nowIso, mt.id, me).run();
          } else {
            await db.prepare(
              `INSERT INTO meeting_members (meeting_id, username, role, invited_at, joined_at, state)
               VALUES (?,?, 'guest', ?,?, 'joined')`
            ).bind(mt.id, me, nowIso, nowIso).run();
          }
          if (mt.status === 'scheduled') {
            await db.prepare('UPDATE meetings SET status = ?, started_at = ? WHERE id = ?').bind('live', nowIso, mt.id).run();
          }
          return json({ ok: true, meeting: mt, code: mt.code }, 200, cors);
        }

        if (act === 'leave' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.meetingId || '');
          await db.prepare(
            `UPDATE meeting_members SET state = 'left', left_at = ? WHERE meeting_id = ? AND username = ?`
          ).bind(nowIso, id, me).run();
          return json({ ok: true }, 200, cors);
        }

        if (act === 'end' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.meetingId || '');
          const mt = await db.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first();
          if (!mt) return json({ ok: false, error: '会议不存在' }, 404, cors);
          if (mt.host !== me && !mAuth.isAdmin) return json({ ok: false, error: '只有主持人可以结束会议' }, 403, cors);
          await db.prepare('UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?').bind('ended', nowIso, id).run();
          return json({ ok: true }, 200, cors);
        }

        if (act === 'invite' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.meetingId || '');
          const mt = await db.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first();
          if (!mt) return json({ ok: false, error: '会议不存在' }, 404, cors);
          if (!(await asMember(id))) return json({ ok: false, error: '你不在该会议中' }, 403, cors);
          const list = Array.isArray(b.usernames) ? b.usernames.map(x => String(x).trim()).filter(Boolean).slice(0, 50) : [];
          const invited = [];
          for (const uname of list) {
            if (uname === me) continue;
            const exists = await db.prepare('SELECT username FROM users WHERE username = ?').bind(uname).first();
            if (!exists) continue;
            await db.prepare(
              `INSERT OR REPLACE INTO meeting_members (meeting_id, username, role, invited_at, state)
               VALUES (?,?, 'guest', ?, 'invited')`
            ).bind(id, uname, nowIso).run();
            try {
              await db.prepare(
                `INSERT OR REPLACE INTO notifications (id, type, title, content, target_user, sender, sent_at, is_read, raw_json)
                 VALUES (?,?,?,?,?,?,?,0,?)`
              ).bind('ntf_mt_' + id + '_' + uname + '_' + Date.now().toString(36), 'meeting',
                '📅 会议邀请：' + mt.title,
                `${me} 邀请你加入会议「${mt.title}」，会议编号 ${mt.code}`,
                uname, me, nowIso, JSON.stringify({ type: 'meeting', meetingId: id, code: mt.code, title: mt.title, host: mt.host })).run();
            } catch (e) { /* 忽略 */ }
            invited.push(uname);
          }
          return json({ ok: true, invited }, 200, cors);
        }

        if (act === 'chat' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.meetingId || '');
          const content = String(b.content || '').trim().slice(0, 2000);
          if (!content) return json({ ok: false, error: '消息不能为空' }, 400, cors);
          if (!(await asMember(id))) return json({ ok: false, error: '你不在该会议中' }, 403, cors);
          const msgId = 'mm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          await db.prepare(
            'INSERT INTO meeting_messages (id, meeting_id, sender, content, created_at) VALUES (?,?,?,?,?)'
          ).bind(msgId, id, me, content, nowIso).run();
          return json({ ok: true, id: msgId, createdAt: nowIso }, 201, cors);
        }

        if (act === 'chat' && method === 'GET') {
          const id = url.searchParams.get('meetingId') || '';
          const since = url.searchParams.get('since') || '';
          if (!(await asMember(id))) return json({ ok: false, error: '你不在该会议中' }, 403, cors);
          const { results } = since
            ? await db.prepare('SELECT * FROM meeting_messages WHERE meeting_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 200').bind(id, since).all()
            : await db.prepare('SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 100').bind(id).all();
          return json({ ok: true, messages: (results || []).reverse() }, 200, cors);
        }

        if (act === 'signal' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const id = String(b.meetingId || '');
          if (!(await asMember(id))) return json({ ok: false, error: '你不在该会议中' }, 403, cors);
          const kind = String(b.kind || '');
          if (!['offer', 'answer', 'ice'].includes(kind)) return json({ ok: false, error: 'kind 必须是 offer/answer/ice' }, 400, cors);
          await db.prepare(
            'INSERT INTO meeting_signals (meeting_id, from_user, to_user, kind, payload, created_at) VALUES (?,?,?,?,?,?)'
          ).bind(id, me, String(b.to || ''), kind, JSON.stringify(b.payload || null), nowIso).run();
          return json({ ok: true }, 201, cors);
        }

        if (act === 'signal' && method === 'GET') {
          const id = url.searchParams.get('meetingId') || '';
          const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
          if (!(await asMember(id))) return json({ ok: false, error: '你不在该会议中' }, 403, cors);
          const { results } = await db.prepare(
            `SELECT id, from_user, to_user, kind, payload, created_at FROM meeting_signals
             WHERE meeting_id = ? AND id > ? AND (to_user = ? OR to_user = '' OR to_user IS NULL)
             ORDER BY id ASC LIMIT 100`
          ).bind(id, since, me).all();
          const signals = (results || []).map(r => ({ ...r, payload: parsePayload(r.payload) ?? r.payload }));
          const lastId = signals.length ? signals[signals.length - 1].id : since;
          return json({ ok: true, signals, lastId }, 200, cors);
        }

        if (act === 'detail' && method === 'GET') {
          const id = url.searchParams.get('id') || '';
          const mt = await db.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first();
          if (!mt) return json({ ok: false, error: '会议不存在' }, 404, cors);
          const { results: members } = await db.prepare(
            'SELECT username, role, state, invited_at, joined_at, left_at FROM meeting_members WHERE meeting_id = ? ORDER BY joined_at ASC'
          ).bind(id).all();
          const { results: msgs } = await db.prepare(
            'SELECT * FROM meeting_messages WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 50'
          ).bind(id).all();
          return json({ ok: true, meeting: mt, members: members || [], messages: (msgs || []).reverse() }, 200, cors);
        }

        return json({ ok: false, error: 'unknown meeting action' }, 404, cors);
      }

      // ============================================================
      //  消息附件：统一存到文件托管（worker 中转，前端无需二次登录文件站）
      //    POST /api/files/upload   multipart: file, title?, visibility?
      //  返回 { ok, url, directUrl?, thumb?, size, name, id }
      // ============================================================
      if (p[0] === 'api' && p[1] === 'files' && p[2] === 'upload' && method === 'POST') {
        const fAuth = await authUser(request, db);
        if (!fAuth) return json({ ok: false, error: '请先登录' }, 401, cors);
        const form = await request.formData().catch(() => null);
        if (!form) return json({ ok: false, error: '请求格式应为 multipart/form-data' }, 400, cors);
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ ok: false, error: '缺少 file 文件字段' }, 400, cors);
        if (file.size > 20 * 1024 * 1024) {
          return json({ ok: false, error: '单个附件最大 20MB（更大的文件请到文件托管站分片上传）', code: 'too_large' }, 413, cors);
        }
        const visibility = String(form.get('visibility') || 'public') === 'private' ? 'private' : 'public';
        const title = String(form.get('title') || file.name || '附件').slice(0, 120);
        // 给文件托管站的免登录票据（HMAC，绑定用户名与时间）
        const key = String(env.FILES_SSO_SECRET || env.GOOGLE_CLIENT_SECRET || 'nflshc-files-sso');
        const exp = Date.now() + 5 * 60 * 1000;
        const sig = await hmacSha256Hex(key, `${fAuth.username}|${exp}`);
        const ticket = `${btoa(unescape(encodeURIComponent(fAuth.username)))}|${exp}|${sig}`;
        const fd = new FormData();
        fd.append('file', file, file.name || 'attachment');
        fd.append('title', title);
        fd.append('visibility', visibility);
        try {
          const up = await fetch('http://nflshcfile.l.cd/api.php?a=sso_upload', {
            method: 'POST',
            headers: {
              'X-Files-Ticket': ticket,
              // 文件托管站前端有反爬，服务器间调用用爬虫 UA 绕过（该 UA 只用于这一条内部链路）
              'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            },
            body: fd,
          });
          const text = await up.text();
          let j = null; try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
          if (!up.ok || !j || !j.ok) {
            return json({ ok: false, error: (j && j.error) || ('文件托管返回异常 HTTP ' + up.status), raw: text.slice(0, 200) }, 502, cors);
          }
          return json({ ok: true, ...j.file, host: 'nflshcfile' }, 200, cors);
        } catch (e) {
          return json({ ok: false, error: '上传到文件托管失败：' + String(e.message || e).slice(0, 120) }, 502, cors);
        }
      }

      // ============================================================
      //  1对1 音视频通话信令（WebRTC P2P，免费 STUN，不经服务器中转）
      //  POST /api/call/start    { callee, type:'audio'|'video' } → { callId }
      //  POST /api/call/answer   { callId, accept:true|false }
      //  POST /api/call/signal   { callId, kind:'offer'|'answer'|'ice', payload }
      //  GET  /api/call/poll?callId=&since=     → { call, signals[] }
      //  GET  /api/call/incoming                → 待接听的来电
      //  POST /api/call/end      { callId }
      // ============================================================
      if (p[0] === 'api' && p[1] === 'call' && p[2]) {
        const cAuth = await authUser(request, db);
        if (!cAuth) return json({ ok: false, error: '请先登录' }, 401, cors);
        const action = p[2];
        const nowIso = () => new Date().toISOString();

        if (action === 'start' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const callee = String(b.callee || '').trim();
          const type = (b.type === 'video') ? 'video' : 'audio';
          if (!callee) return json({ ok: false, error: '缺少被叫用户' }, 400, cors);
          if (callee === cAuth.username) return json({ ok: false, error: '不能呼叫自己' }, 400, cors);
          const target = await db.prepare('SELECT username FROM users WHERE username = ?').bind(callee).first();
          if (!target) return json({ ok: false, error: '对方账号不存在' }, 404, cors);
          // 结束双方此前的未完成通话，避免并发
          await db.prepare(
            `UPDATE calls SET status = 'ended', updated_at = ?, ended_by = ? 
             WHERE (caller = ? OR callee = ? OR caller = ? OR callee = ?) AND status IN ('pending','accepted')`
          ).bind(nowIso(), cAuth.username, cAuth.username, cAuth.username, callee, callee).run();
          const callId = 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          await db.prepare(
            'INSERT INTO calls (id, caller, callee, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
          ).bind(callId, cAuth.username, callee, type, 'pending', nowIso(), nowIso()).run();
          return json({ ok: true, callId, type, callee }, 201, cors);
        }

        if (action === 'answer' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const callId = String(b.callId || '');
          const accept = b.accept !== false;
          const c = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(callId).first();
          if (!c) return json({ ok: false, error: '通话不存在' }, 404, cors);
          if (c.callee !== cAuth.username && c.caller !== cAuth.username) {
            return json({ ok: false, error: '无权操作该通话' }, 403, cors);
          }
          if (c.status !== 'pending') return json({ ok: false, error: '该通话已结束或被处理', status: c.status }, 400, cors);
          const status = accept ? 'accepted' : 'rejected';
          await db.prepare('UPDATE calls SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowIso(), callId).run();
          return json({ ok: true, status, callId }, 200, cors);
        }

        if (action === 'signal' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const callId = String(b.callId || '');
          const kind = String(b.kind || '');
          if (!callId || !kind) return json({ ok: false, error: '缺少 callId 或 kind' }, 400, cors);
          if (!['offer', 'answer', 'ice'].includes(kind)) return json({ ok: false, error: 'kind 必须是 offer/answer/ice' }, 400, cors);
          const c = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(callId).first();
          if (!c) return json({ ok: false, error: '通话不存在' }, 404, cors);
          if (c.caller !== cAuth.username && c.callee !== cAuth.username) {
            return json({ ok: false, error: '无权操作该通话' }, 403, cors);
          }
          await db.prepare(
            'INSERT INTO call_signals (call_id, from_user, kind, payload, created_at) VALUES (?,?,?,?,?)'
          ).bind(callId, cAuth.username, kind, JSON.stringify(b.payload === undefined ? null : b.payload), nowIso()).run();
          return json({ ok: true }, 200, cors);
        }

        if (action === 'poll' && method === 'GET') {
          const callId = url.searchParams.get('callId') || '';
          const since = parseInt(url.searchParams.get('since') || '0');
          if (!callId) return json({ ok: false, error: '缺少 callId' }, 400, cors);
          const c = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(callId).first();
          if (!c) return json({ ok: false, error: '通话不存在' }, 404, cors);
          if (c.caller !== cAuth.username && c.callee !== cAuth.username) {
            return json({ ok: false, error: '无权查看该通话' }, 403, cors);
          }
          // 只返回发给自己的信令（from_user 非本人）
          const { results } = await db.prepare(
            'SELECT id, from_user, kind, payload, created_at FROM call_signals WHERE call_id = ? AND id > ? AND from_user != ? ORDER BY id ASC LIMIT 100'
          ).bind(callId, since, cAuth.username).all();
          const signals = (results || []).map(r => ({
            id: r.id, from: r.from_user, kind: r.kind,
            payload: (() => { try { return JSON.parse(r.payload); } catch (e) { return null; } })(),
          }));
          return json({
            ok: true,
            call: { id: c.id, caller: c.caller, callee: c.callee, type: c.type, status: c.status, createdAt: c.created_at },
            signals,
            lastSignalId: signals.length ? signals[signals.length - 1].id : since,
          }, 200, cors);
        }

        if (action === 'incoming' && method === 'GET') {
          const c = await db.prepare(
            `SELECT * FROM calls WHERE callee = ? AND status = 'pending' AND created_at > ? 
             ORDER BY created_at DESC LIMIT 1`
          ).bind(cAuth.username, new Date(Date.now() - 60000).toISOString()).first();
          return json({ ok: true, call: c ? { id: c.id, caller: c.caller, type: c.type, status: c.status, createdAt: c.created_at } : null }, 200, cors);
        }

        if (action === 'end' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const callId = String(b.callId || '');
          const c = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(callId).first();
          if (!c) return json({ ok: false, error: '通话不存在' }, 404, cors);
          if (c.caller !== cAuth.username && c.callee !== cAuth.username) {
            return json({ ok: false, error: '无权操作该通话' }, 403, cors);
          }
          await db.prepare('UPDATE calls SET status = ?, updated_at = ?, ended_by = ? WHERE id = ?')
            .bind('ended', nowIso(), cAuth.username, callId).run();
          return json({ ok: true, status: 'ended' }, 200, cors);
        }

        return json({ ok: false, error: 'unknown call endpoint' }, 404, cors);
      }

      // ============================================================
      //  OAuth 开放平台（accounts.nflshcchat.cc.cd 授权中心 + platform 开发者平台）
      // ============================================================
      if (p[0] === 'api' && p[1] === 'oauth') {
        const seg = p[2]; // oauth 子路由

        // GET /api/oauth/scopes —— 全部可用权限说明（公开，platform 配置界面用）
        if (seg === 'scopes' && method === 'GET') {
          return json({
            ok: true,
            scopes: Object.keys(OAUTH_SCOPES).map(k => ({ key: k, ...OAUTH_SCOPES[k] })),
          }, 200, cors);
        }

        // GET /api/oauth/authorize-info?client_id=&redirect_uri=&scope=&state=
        //   授权页展示用（公开）：返回应用信息 + 申请到的权限清单
        if (seg === 'authorize-info' && method === 'GET') {
          const clientId = url.searchParams.get('client_id') || '';
          const redirectUri = url.searchParams.get('redirect_uri') || '';
          const scopes = normalizeScopes(url.searchParams.get('scope'));
          const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
          if (!row) return json({ ok: false, error: '应用不存在或已被删除', code: 'invalid_client' }, 404, cors);
          if (row.status !== 'active') return json({ ok: false, error: '应用已被停用', code: 'client_suspended' }, 403, cors);
          const okRedirect = matchRedirectUri(row.redirect_uris, redirectUri);
          if (!okRedirect) return json({ ok: false, error: '回调地址未被该应用登记', code: 'invalid_redirect_uri' }, 400, cors);
          if (scopes.length === 0) return json({ ok: false, error: '应用未申请任何有效权限', code: 'invalid_scope' }, 400, cors);
          return json({
            ok: true,
            client: oauthClientPublic(row),
            redirectUri: okRedirect,
            scopes: scopes.map(k => ({ key: k, ...OAUTH_SCOPES[k] })),
          }, 200, cors);
        }

        // POST /api/oauth/authorize —— 用户同意/拒绝授权（需登录）
        //   body: { clientId, redirectUri, scopes[], state, approve: true|false }
        //   approve → 返回带 code 的回调地址；deny → 返回带 error=access_denied 的回调地址
        if (seg === 'authorize' && method === 'POST') {
          const auth = await authUser(request, db);
          if (!auth) return json({ ok: false, error: '请先登录 nflshcchat 账号', code: 'login_required' }, 401, cors);
          const b = await request.json().catch(() => ({}));
          const clientId = String(b.clientId || '');
          const state = b.state ? String(b.state) : '';
          const approve = b.approve !== false;
          const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
          if (!row) return json({ ok: false, error: '应用不存在', code: 'invalid_client' }, 404, cors);
          if (row.status !== 'active') return json({ ok: false, error: '应用已被停用', code: 'client_suspended' }, 403, cors);
          const redirectUri = matchRedirectUri(row.redirect_uris, String(b.redirectUri || ''));
          if (!redirectUri) return json({ ok: false, error: '回调地址未被该应用登记', code: 'invalid_redirect_uri' }, 400, cors);

          const buildRedirect = (params) => {
            const u = new URL(redirectUri);
            for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
            if (state) u.searchParams.set('state', state);
            return u.toString();
          };

          if (!approve) {
            return json({ ok: true, approved: false, redirect: buildRedirect({ error: 'access_denied', error_description: '用户拒绝了授权' }) }, 200, cors);
          }

          // 用户授权的权限：不能超过应用登记的权限
          const grantedScopes = normalizeScopes(b.scopes).filter(s => parseJsonArr(row.scopes).includes(s));
          if (grantedScopes.length === 0) return json({ ok: false, error: '未选择任何有效权限', code: 'invalid_scope' }, 400, cors);

          const code = oauthRandom('naco_', 32);
          const nowIso = new Date().toISOString();
          await db.prepare(
            `INSERT INTO oauth_codes (code, client_id, username, scopes, redirect_uri, expires_at, used, created_at)
             VALUES (?,?,?,?,?,?,0,?)`
          ).bind(code, clientId, auth.username, JSON.stringify(grantedScopes), redirectUri,
            new Date(Date.now() + OAUTH_CODE_TTL_MS).toISOString(), nowIso).run();
          // 记录/更新长期授权（用户可在 accounts 撤销）
          await db.prepare(
            `INSERT INTO oauth_grants (client_id, username, scopes, granted_at, updated_at, revoked)
             VALUES (?,?,?,?,?,0)
             ON CONFLICT(client_id, username) DO UPDATE SET scopes = excluded.scopes, updated_at = excluded.updated_at, revoked = 0`
          ).bind(clientId, auth.username, JSON.stringify(grantedScopes), nowIso, nowIso).run();
          return json({ ok: true, approved: true, code, redirect: buildRedirect({ code }) }, 200, cors);
        }

        // POST /api/oauth/token —— 授权码换令牌 / 刷新令牌（服务端到服务端，client_secret 鉴权）
        //   body: { grant_type:'authorization_code', code, client_id, client_secret, redirect_uri }
        //    或: { grant_type:'refresh_token', refresh_token, client_id, client_secret }
        if (seg === 'token' && method === 'POST') {
          // body 只能读一次：先取原始文本，再按 JSON → 表单 顺序解析
          const rawBody = await request.text().catch(() => '');
          let b = {};
          try {
            b = JSON.parse(rawBody);
          } catch (e) {
            b = Object.fromEntries(rawBody.split('&').filter(Boolean)
              .map(kv => {
                const i = kv.indexOf('=');
                const k = i === -1 ? kv : kv.slice(0, i);
                const v = i === -1 ? '' : kv.slice(i + 1);
                return [decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))];
              }));
          }
          if (!b || typeof b !== 'object') b = {};
          const clientId = String(b.client_id || b.clientId || '');
          const clientSecret = String(b.client_secret || b.clientSecret || '');
          const grantType = String(b.grant_type || b.grantType || '');
          if (!clientId || !clientSecret) return json({ error: 'invalid_client', error_description: '缺少 client_id 或 client_secret' }, 401, cors);
          const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
          if (!row) return json({ error: 'invalid_client', error_description: '应用不存在' }, 401, cors);
          if (row.status !== 'active') return json({ error: 'invalid_client', error_description: '应用已被停用' }, 403, cors);
          if (row.client_secret_hash !== await sha256Hex(clientSecret)) {
            return json({ error: 'invalid_client', error_description: 'client_secret 不正确' }, 401, cors);
          }

          const nowIso = new Date().toISOString();
          const issueTokens = async (username, scopes) => {
            const accessToken = oauthRandom('naat_', 48);
            const refreshToken = oauthRandom('nart_', 48);
            await db.prepare(
              `INSERT INTO oauth_tokens (access_token, refresh_token, client_id, username, scopes, created_at, expires_at, refresh_expires_at, revoked)
               VALUES (?,?,?,?,?,?,?,?,0)`
            ).bind(accessToken, refreshToken, clientId, username, JSON.stringify(scopes), nowIso,
              new Date(Date.now() + OAUTH_TOKEN_TTL_MS).toISOString(),
              new Date(Date.now() + OAUTH_REFRESH_TTL_MS).toISOString()).run();
            return {
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: Math.floor(OAUTH_TOKEN_TTL_MS / 1000),
              refresh_token: refreshToken,
              scope: scopes.join(' '),
            };
          };

          if (grantType === 'authorization_code') {
            const code = String(b.code || '');
            const codeRow = await db.prepare('SELECT * FROM oauth_codes WHERE code = ?').bind(code).first();
            if (!codeRow || codeRow.used) return json({ error: 'invalid_grant', error_description: '授权码无效或已被使用' }, 400, cors);
            if (codeRow.client_id !== clientId) return json({ error: 'invalid_grant', error_description: '授权码不属于该应用' }, 400, cors);
            if (codeRow.expires_at && new Date(codeRow.expires_at).getTime() < Date.now()) {
              return json({ error: 'invalid_grant', error_description: '授权码已过期（5 分钟有效）' }, 400, cors);
            }
            if (b.redirect_uri && b.redirect_uri !== codeRow.redirect_uri) {
              return json({ error: 'invalid_grant', error_description: 'redirect_uri 与授权时不一致' }, 400, cors);
            }
            await db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').bind(code).run();
            // 用户授权后若被撤销，禁止换令牌
            const grant = await db.prepare('SELECT revoked FROM oauth_grants WHERE client_id = ? AND username = ?')
              .bind(clientId, codeRow.username).first();
            if (grant && grant.revoked) {
              return json({ error: 'access_denied', error_description: '用户已撤销对该应用的授权' }, 403, cors);
            }
            const tokens = await issueTokens(codeRow.username, parseJsonArr(codeRow.scopes));
            return json(tokens, 200, cors);
          }

          if (grantType === 'refresh_token') {
            const refreshToken = String(b.refresh_token || b.refreshToken || '');
            const t = await db.prepare('SELECT * FROM oauth_tokens WHERE refresh_token = ?').bind(refreshToken).first();
            if (!t || t.revoked) return json({ error: 'invalid_grant', error_description: 'refresh_token 无效' }, 400, cors);
            if (t.client_id !== clientId) return json({ error: 'invalid_grant', error_description: 'refresh_token 不属于该应用' }, 400, cors);
            if (t.refresh_expires_at && new Date(t.refresh_expires_at).getTime() < Date.now()) {
              return json({ error: 'invalid_grant', error_description: 'refresh_token 已过期，请用户重新授权' }, 400, cors);
            }
            await db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE refresh_token = ?').bind(refreshToken).run();
            const tokens = await issueTokens(t.username, parseJsonArr(t.scopes));
            return json(tokens, 200, cors);
          }

          return json({ error: 'unsupported_grant_type', error_description: '仅支持 authorization_code 与 refresh_token' }, 400, cors);
        }

        // GET /api/oauth/userinfo —— 用访问令牌读取用户信息（按授权 scope 过滤，永不返回密码）
        if (seg === 'userinfo' && (method === 'GET' || method === 'POST')) {
          const token = bearerToken(request) || url.searchParams.get('access_token');
          if (!token) return json({ error: 'invalid_token', error_description: '缺少访问令牌' }, 401, cors);
          const t = await db.prepare('SELECT * FROM oauth_tokens WHERE access_token = ?').bind(token).first();
          if (!t || t.revoked) return json({ error: 'invalid_token', error_description: '访问令牌无效' }, 401, cors);
          if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) {
            return json({ error: 'invalid_token', error_description: '访问令牌已过期，请用 refresh_token 刷新' }, 401, cors);
          }
          const scopes = parseJsonArr(t.scopes);
          const user = await db.prepare('SELECT username, raw_json FROM users WHERE username = ?').bind(t.username).first();
          if (!user) return json({ error: 'invalid_token', error_description: '用户不存在' }, 404, cors);
          const p2 = parsePayload(user.raw_json) || {};
          const out = { sub: t.username, client_id: t.client_id, scope: scopes.join(' ') };
          if (scopes.includes('profile')) {
            Object.assign(out, {
              username: t.username,
              nickname: p2.nickname || t.username,
              avatarUrl: p2.avatarUrl || p2.avatar || '',
              bio: p2.bio || '',
              xp: Number(p2.xp || 0),
              isAdmin: t.username === 'huangzhiyuan' || !!p2.isAdmin,
              createdAt: p2.createdAt || null,
            });
          }
          if (scopes.includes('email')) out.email = p2.email || '';
          if (scopes.includes('stats')) {
            const msgCount = await db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sender = ?').bind(t.username).first().catch(() => null);
            out.messageCount = msgCount ? (msgCount.c || 0) : 0;
          }
          if (scopes.includes('rooms')) {
            const { results } = await db.prepare('SELECT id, name, type, members FROM rooms').all().catch(() => ({ results: [] }));
            out.rooms = (results || []).filter(r => {
              const mem = parseJsonArr(r.members);
              return mem.includes(t.username);
            }).map(r => ({ id: r.id, name: r.name, type: r.type }));
          }
          if (scopes.includes('friends')) {
            const { results } = await db.prepare('SELECT user1, user2 FROM friends WHERE user1 = ? OR user2 = ?')
              .bind(t.username, t.username).all().catch(() => ({ results: [] }));
            out.friends = (results || []).map(f => f.user1 === t.username ? f.user2 : f.user1);
          }
          if (scopes.includes('messages')) {
            const { results } = await db.prepare('SELECT id, room_id, content, timestamp FROM messages WHERE sender = ? ORDER BY timestamp DESC LIMIT 50')
              .bind(t.username).all().catch(() => ({ results: [] }));
            out.messages = (results || []).map(m => ({ id: m.id, roomId: m.room_id, content: m.content, timestamp: m.timestamp }));
          }
          return json(out, 200, cors);
        }

        // POST /api/oauth/revoke —— 应用吊销令牌
        if (seg === 'revoke' && method === 'POST') {
          let b = await request.json().catch(() => ({}));
          const clientId = String(b.client_id || b.clientId || '');
          const clientSecret = String(b.client_secret || b.clientSecret || '');
          const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
          if (!row || row.client_secret_hash !== await sha256Hex(clientSecret)) {
            return json({ error: 'invalid_client' }, 401, cors);
          }
          const token = String(b.token || b.access_token || '');
          await db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE access_token = ? OR refresh_token = ?')
            .bind(token, token).run();
          return json({ ok: true }, 200, cors);
        }

        // POST /api/oauth/check —— 【校验端口】开发者校验用户在自己项目内的状态
        //   body: { client_id, client_secret, username }
        //   → { ok, banned, reason, bannedAt, granted }（不泄露任何其他信息）
        if (seg === 'check' && method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const clientId = String(b.client_id || b.clientId || '');
          const clientSecret = String(b.client_secret || b.clientSecret || '');
          const username = String(b.username || '').trim();
          if (!clientId || !clientSecret || !username) {
            return json({ ok: false, error: '缺少 client_id、client_secret 或 username' }, 400, cors);
          }
          const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
          if (!row) return json({ ok: false, error: '应用不存在' }, 404, cors);
          if (row.client_secret_hash !== await sha256Hex(clientSecret)) {
            return json({ ok: false, error: 'client_secret 不正确' }, 401, cors);
          }
          // 用户是否已授权该应用（管辖范围）
          const grant = await db.prepare('SELECT revoked, scopes, granted_at FROM oauth_grants WHERE client_id = ? AND username = ?')
            .bind(clientId, username).first();
          const ban = await db.prepare('SELECT active, reason, banned_at, banned_by FROM oauth_project_bans WHERE client_id = ? AND username = ?')
            .bind(clientId, username).first();
          return json({
            ok: true,
            username,
            granted: !!(grant && !grant.revoked),
            banned: !!(ban && ban.active),
            reason: (ban && ban.active) ? (ban.reason || '') : '',
            bannedAt: (ban && ban.active) ? (ban.banned_at || null) : null,
          }, 200, cors);
        }

        // GET /api/oauth/grants —— 用户查看自己授权过的应用（需登录）
        // DELETE /api/oauth/grants/:clientId —— 用户撤销授权（同时吊销该应用全部令牌）
        if (seg === 'grants') {
          const auth = await authUser(request, db);
          if (!auth) return json({ ok: false, error: '请先登录', code: 'login_required' }, 401, cors);
          if (method === 'GET') {
            const { results } = await db.prepare(
              `SELECT g.client_id, g.scopes, g.granted_at, g.updated_at, g.revoked,
                      c.name, c.description, c.logo, c.homepage, c.owner, c.status
               FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
               WHERE g.username = ? ORDER BY g.updated_at DESC`
            ).bind(auth.username).all();
            const list = (results || []).map(r => ({
              clientId: r.client_id,
              name: r.name || '(应用已删除)',
              description: r.description || '',
              logo: r.logo || '',
              homepage: r.homepage || '',
              owner: r.owner || '',
              status: r.status || 'deleted',
              scopes: parseJsonArr(r.scopes).map(k => ({ key: k, ...(OAUTH_SCOPES[k] || { name: k, desc: '' }) })),
              grantedAt: r.granted_at,
              updatedAt: r.updated_at,
              revoked: !!r.revoked,
            }));
            return json({ ok: true, grants: list }, 200, cors);
          }
          if (method === 'DELETE' && p[3]) {
            const clientId = decodeURIComponent(p[3]);
            await db.prepare('UPDATE oauth_grants SET revoked = 1, updated_at = ? WHERE client_id = ? AND username = ?')
              .bind(new Date().toISOString(), clientId, auth.username).run();
            await db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND username = ?')
              .bind(clientId, auth.username).run();
            return json({ ok: true, revoked: true }, 200, cors);
          }
          return json({ ok: false, error: 'unsupported' }, 400, cors);
        }

        // ===== 开发者应用管理（需登录；只能操作自己的应用）=====
        if (seg === 'clients') {
          const auth = await authUser(request, db);
          if (!auth) return json({ ok: false, error: '请先登录开发者账号', code: 'login_required' }, 401, cors);
          const clientId = p[3] ? decodeURIComponent(p[3]) : null;

          // POST /api/oauth/clients —— 创建应用
          if (!clientId && method === 'POST') {
            const b = await request.json().catch(() => ({}));
            const name = String(b.name || '').trim();
            if (!name) return json({ ok: false, error: '请填写应用名称' }, 400, cors);
            if (name.length > 40) return json({ ok: false, error: '应用名称过长（40 字以内）' }, 400, cors);
            const redirectUris = (Array.isArray(b.redirectUris) ? b.redirectUris : String(b.redirectUris || '').split(/[\n,]+/))
              .map(s => String(s).trim()).filter(Boolean);
            if (redirectUris.length === 0) return json({ ok: false, error: '至少填写一个回调地址' }, 400, cors);
            for (const u of redirectUris) {
              try { new URL(u); } catch (e) { return json({ ok: false, error: '回调地址格式不正确：' + u }, 400, cors); }
            }
            const scopes = normalizeScopes(b.scopes);
            if (scopes.length === 0) return json({ ok: false, error: '至少选择一项需要获取的用户信息' }, 400, cors);
            // 同一开发者应用数量上限，避免滥用
            const cnt = await db.prepare('SELECT COUNT(*) AS c FROM oauth_clients WHERE owner = ?').bind(auth.username).first();
            if (cnt && (cnt.c || 0) >= 20) return json({ ok: false, error: '应用数量已达上限（20 个）' }, 400, cors);

            const newClientId = oauthRandom('nac_', 24);
            const secretPlain = oauthRandom('nacs_', 48);
            const nowIso = new Date().toISOString();
            await db.prepare(
              `INSERT INTO oauth_clients (client_id, client_secret_hash, name, description, homepage, logo,
                 redirect_uris, scopes, owner, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
            ).bind(newClientId, await sha256Hex(secretPlain), name, String(b.description || '').slice(0, 500),
              String(b.homepage || ''), String(b.logo || ''), JSON.stringify(redirectUris),
              JSON.stringify(scopes), auth.username, 'active', nowIso, nowIso).run();
            const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(newClientId).first();
            return json({ ok: true, client: oauthClientPublic(row), clientSecret: secretPlain }, 201, cors);
          }

          // GET /api/oauth/clients —— 我的应用列表
          if (!clientId && method === 'GET') {
            const { results } = await db.prepare('SELECT * FROM oauth_clients WHERE owner = ? ORDER BY created_at DESC')
              .bind(auth.username).all();
            const clients = [];
            for (const r of results || []) {
              const usersCnt = await db.prepare('SELECT COUNT(*) AS c FROM oauth_grants WHERE client_id = ? AND revoked = 0')
                .bind(r.client_id).first().catch(() => null);
              clients.push({ ...oauthClientPublic(r), authorizedUsers: usersCnt ? (usersCnt.c || 0) : 0 });
            }
            return json({ ok: true, clients }, 200, cors);
          }

          if (clientId) {
            const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
            if (!row) return json({ ok: false, error: '应用不存在' }, 404, cors);
            const isOwner = row.owner === auth.username;
            if (!isOwner && !auth.isAdmin) return jsonForbidden();

            // GET /api/oauth/clients/:id —— 应用详情
            if (method === 'GET' && !p[4]) {
              const usersCnt = await db.prepare('SELECT COUNT(*) AS c FROM oauth_grants WHERE client_id = ? AND revoked = 0')
                .bind(clientId).first().catch(() => null);
              const bansCnt = await db.prepare('SELECT COUNT(*) AS c FROM oauth_project_bans WHERE client_id = ? AND active = 1')
                .bind(clientId).first().catch(() => null);
              return json({
                ok: true,
                client: oauthClientPublic(row),
                authorizedUsers: usersCnt ? (usersCnt.c || 0) : 0,
                activeBans: bansCnt ? (bansCnt.c || 0) : 0,
              }, 200, cors);
            }

            // PATCH /api/oauth/clients/:id —— 更新应用
            if ((method === 'PATCH' || method === 'PUT') && !p[4]) {
              const b = await request.json().catch(() => ({}));
              const name = b.name === undefined ? row.name : String(b.name).trim();
              if (!name) return json({ ok: false, error: '应用名称不能为空' }, 400, cors);
              let redirectUris = row.redirect_uris;
              if (b.redirectUris !== undefined) {
                const list = (Array.isArray(b.redirectUris) ? b.redirectUris : String(b.redirectUris).split(/[\n,]+/))
                  .map(s => String(s).trim()).filter(Boolean);
                if (list.length === 0) return json({ ok: false, error: '至少填写一个回调地址' }, 400, cors);
                for (const u of list) {
                  try { new URL(u); } catch (e) { return json({ ok: false, error: '回调地址格式不正确：' + u }, 400, cors); }
                }
                redirectUris = JSON.stringify(list);
              }
              let scopes = row.scopes;
              if (b.scopes !== undefined) {
                const list = normalizeScopes(b.scopes);
                if (list.length === 0) return json({ ok: false, error: '至少选择一项权限' }, 400, cors);
                scopes = JSON.stringify(list);
              }
              const status = (b.status !== undefined && auth.isAdmin) ? String(b.status) : row.status;
              // 机器人登记：is_bot=true 时可用 /api/bot/* 以 botUsername 身份收发消息
              const isBot = b.isBot === undefined ? (row.is_bot || 0) : (b.isBot ? 1 : 0);
              const botUsername = b.botUsername === undefined
                ? (row.bot_username || null)
                : (String(b.botUsername || '').trim().slice(0, 40) || null);
              await db.prepare(
                `UPDATE oauth_clients SET name = ?, description = ?, homepage = ?, logo = ?,
                   redirect_uris = ?, scopes = ?, status = ?, is_bot = ?, bot_username = ?, updated_at = ? WHERE client_id = ?`
              ).bind(name, b.description === undefined ? row.description : String(b.description).slice(0, 500),
                b.homepage === undefined ? row.homepage : String(b.homepage),
                b.logo === undefined ? row.logo : String(b.logo),
                redirectUris, scopes, status, isBot, botUsername, new Date().toISOString(), clientId).run();
              const updated = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
              return json({ ok: true, client: oauthClientPublic(updated) }, 200, cors);
            }

            // DELETE /api/oauth/clients/:id —— 删除应用（级联清理授权与令牌）
            if (method === 'DELETE' && !p[4]) {
              await db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').bind(clientId).run();
              await db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').bind(clientId).run();
              await db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').bind(clientId).run();
              await db.prepare('DELETE FROM oauth_grants WHERE client_id = ?').bind(clientId).run();
              await db.prepare('DELETE FROM oauth_project_bans WHERE client_id = ?').bind(clientId).run();
              return json({ ok: true, deleted: true }, 200, cors);
            }

            // POST /api/oauth/clients/:id/secret —— 重置密钥（旧密钥立即失效）
            if (p[4] === 'secret' && method === 'POST') {
              const secretPlain = oauthRandom('nacs_', 48);
              await db.prepare('UPDATE oauth_clients SET client_secret_hash = ?, updated_at = ? WHERE client_id = ?')
                .bind(await sha256Hex(secretPlain), new Date().toISOString(), clientId).run();
              await db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?').bind(clientId).run();
              return json({ ok: true, clientSecret: secretPlain }, 200, cors);
            }

            // GET /api/oauth/clients/:id/users —— 授权访问该应用的用户（密码与隐私信息除外）
            if (p[4] === 'users' && method === 'GET') {
              const { results } = await db.prepare(
                `SELECT g.username, g.scopes, g.granted_at, g.updated_at,
                        b.active AS ban_active, b.reason AS ban_reason, b.banned_at AS ban_at
                 FROM oauth_grants g
                 LEFT JOIN oauth_project_bans b ON b.client_id = g.client_id AND b.username = g.username
                 WHERE g.client_id = ? AND g.revoked = 0
                 ORDER BY g.granted_at DESC LIMIT 500`
              ).bind(clientId).all();
              const users = [];
              for (const r of results || []) {
                const u = await db.prepare('SELECT raw_json FROM users WHERE username = ?').bind(r.username).first();
                const pl = u ? (parsePayload(u.raw_json) || {}) : {};
                const scopes = parseJsonArr(r.scopes);
                // 仅返回用户实际授权范围内的字段；邮箱等敏感字段需在授权范围内
                users.push({
                  username: r.username,
                  nickname: pl.nickname || r.username,
                  avatarUrl: scopes.includes('profile') ? (pl.avatarUrl || pl.avatar || '') : '',
                  bio: scopes.includes('profile') ? (pl.bio || '') : '',
                  xp: scopes.includes('profile') ? Number(pl.xp || 0) : null,
                  email: scopes.includes('email') ? (pl.email || '') : null,
                  createdAt: pl.createdAt || null,
                  scopes: scopes.map(k => ({ key: k, ...(OAUTH_SCOPES[k] || { name: k, desc: '' }) })),
                  grantedAt: r.granted_at,
                  updatedAt: r.updated_at,
                  banned: !!r.ban_active,
                  banReason: r.ban_active ? (r.ban_reason || '') : '',
                  bannedAt: r.ban_active ? (r.ban_at || null) : null,
                  globalBanned: !!pl.isBanned,
                });
              }
              return json({ ok: true, users }, 200, cors);
            }

            // POST /api/oauth/clients/:id/users/:username/ban —— 项目内封禁（仅限已授权用户）
            if (p[4] === 'users' && p[5] && p[6] === 'ban' && method === 'POST') {
              const targetUser = decodeURIComponent(p[5]);
              const b = await request.json().catch(() => ({}));
              const reason = String(b.reason || '').trim();
              if (!reason) return json({ ok: false, error: '请填写封禁原因（项目内封禁必须说明原因）' }, 400, cors);
              const grant = await db.prepare('SELECT revoked FROM oauth_grants WHERE client_id = ? AND username = ?')
                .bind(clientId, targetUser).first();
              if (!grant || grant.revoked) {
                return json({ ok: false, error: '该用户未授权你的应用，不在管辖范围内' }, 403, cors);
              }
              const nowIso = new Date().toISOString();
              await db.prepare(
                `INSERT INTO oauth_project_bans (client_id, username, reason, banned_by, banned_at, active)
                 VALUES (?,?,?,?,?,1)
                 ON CONFLICT(client_id, username) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, banned_at = excluded.banned_at, active = 1`
              ).bind(clientId, targetUser, reason.slice(0, 500), auth.username, nowIso).run();
              return json({ ok: true, banned: true, username: targetUser, scope: 'project' }, 200, cors);
            }

            // POST /api/oauth/clients/:id/users/:username/unban —— 解除项目内封禁
            if (p[4] === 'users' && p[5] && p[6] === 'unban' && method === 'POST') {
              const targetUser = decodeURIComponent(p[5]);
              await db.prepare('UPDATE oauth_project_bans SET active = 0 WHERE client_id = ? AND username = ?')
                .bind(clientId, targetUser).run();
              return json({ ok: true, banned: false, username: targetUser }, 200, cors);
            }

            // GET /api/oauth/clients/:id/bans —— 项目内封禁列表
            if (p[4] === 'bans' && method === 'GET') {
              const { results } = await db.prepare(
                'SELECT username, reason, banned_by, banned_at, active FROM oauth_project_bans WHERE client_id = ? AND active = 1 ORDER BY banned_at DESC'
              ).bind(clientId).all();
              return json({ ok: true, bans: (results || []).map(oauthProjectBanPublic) }, 200, cors);
            }

            // ===== Webhook 配置（每个应用一条）=====
            // GET    /api/oauth/clients/:id/webhook  —— 查看配置
            // PUT    /api/oauth/clients/:id/webhook  —— 保存配置 body:{ url, events[], active }
            // POST   /api/oauth/clients/:id/webhook/test —— 发送测试事件
            // DELETE /api/oauth/clients/:id/webhook  —— 删除配置
            if (p[4] === 'webhook') {
              const existing = await db.prepare('SELECT * FROM oauth_webhooks WHERE client_id = ?').bind(clientId).first();
              if (method === 'GET' && !p[5]) {
                return json({
                  ok: true,
                  webhook: existing ? {
                    url: existing.url || '',
                    events: parseJsonArr(existing.events),
                    active: !!existing.active,
                    hasSecret: !!existing.secret,
                    lastStatus: existing.last_status,
                    lastAt: existing.last_at,
                    lastError: existing.last_error || '',
                  } : null,
                  availableEvents: Object.keys(OAUTH_WEBHOOK_EVENTS).map(k => ({ event: k, desc: OAUTH_WEBHOOK_EVENTS[k] })),
                }, 200, cors);
              }
              if ((method === 'PUT' || method === 'PATCH') && !p[5]) {
                const b = await request.json().catch(() => ({}));
                const whUrl = String(b.url || '').trim();
                if (!whUrl) return json({ ok: false, error: '请填写 Webhook 地址' }, 400, cors);
                try { new URL(whUrl); } catch (e) { return json({ ok: false, error: 'Webhook 地址格式不正确' }, 400, cors); }
                const events = (Array.isArray(b.events) ? b.events : []).filter(e => OAUTH_WEBHOOK_EVENTS[e] || e === '*');
                const nowIso = new Date().toISOString();
                // 密钥：首次自动生成，之后保持不变（重置需显式传 rotateSecret）
                const secret = (b.rotateSecret || !existing) ? oauthRandom('nawh_', 40) : existing.secret;
                const active = b.active === false ? 0 : 1;
                await db.prepare(
                  `INSERT INTO oauth_webhooks (client_id, url, secret, events, active, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(client_id) DO UPDATE SET url = excluded.url, secret = excluded.secret,
                     events = excluded.events, active = excluded.active, updated_at = excluded.updated_at`
                ).bind(clientId, whUrl, secret, JSON.stringify(events), active, nowIso, nowIso).run();
                return json({
                  ok: true,
                  webhook: { url: whUrl, events, active: !!active, hasSecret: true },
                  secret: (b.rotateSecret || !existing) ? secret : undefined,
                }, 200, cors);
              }
              if (method === 'POST' && p[5] === 'test') {
                if (!existing || !existing.url) return json({ ok: false, error: '请先保存 Webhook 配置' }, 400, cors);
                await deliverWebhook(db, clientId, 'webhook.test', { message: '这是一条测试事件', client: oauthClientPublic(row) });
                const after = await db.prepare('SELECT last_status, last_at, last_error FROM oauth_webhooks WHERE client_id = ?').bind(clientId).first();
                return json({ ok: true, lastStatus: after ? after.last_status : null, lastAt: after ? after.last_at : null, lastError: after ? (after.last_error || '') : '' }, 200, cors);
              }
              if (method === 'DELETE' && !p[5]) {
                await db.prepare('DELETE FROM oauth_webhooks WHERE client_id = ?').bind(clientId).run();
                return json({ ok: true, deleted: true }, 200, cors);
              }
              return json({ ok: false, error: 'unsupported' }, 400, cors);
            }
          }
          return json({ ok: false, error: 'unsupported' }, 400, cors);
        }

        // ===== 全站封禁申请 =====
        // POST /api/oauth/ban-requests —— 开发者提交（理由必填，不限字数）
        // GET  /api/oauth/ban-requests —— 开发者查看自己提交的申请
        if (seg === 'ban-requests') {
          const auth = await authUser(request, db);
          if (!auth) return json({ ok: false, error: '请先登录', code: 'login_required' }, 401, cors);
          if (method === 'POST') {
            const b = await request.json().catch(() => ({}));
            const clientId = String(b.clientId || b.client_id || '');
            const targetUser = String(b.username || '').trim();
            const reason = String(b.reason || '').trim();
            if (!clientId || !targetUser) return json({ ok: false, error: '缺少应用或目标用户' }, 400, cors);
            if (!reason) return json({ ok: false, error: '必须填写申请理由' }, 400, cors);
            const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
            if (!row) return json({ ok: false, error: '应用不存在' }, 404, cors);
            if (row.owner !== auth.username && !auth.isAdmin) return jsonForbidden();
            const user = await db.prepare('SELECT username FROM users WHERE username = ?').bind(targetUser).first();
            if (!user) return json({ ok: false, error: '该用户不存在' }, 404, cors);
            // 同一应用对同一用户只保留一条待审申请
            const pending = await db.prepare(
              `SELECT id FROM oauth_ban_requests WHERE client_id = ? AND username = ? AND status = 'pending'`
            ).bind(clientId, targetUser).first();
            if (pending) return json({ ok: false, error: '该用户的封禁申请已在审核中', requestId: pending.id }, 409, cors);

            const id = 'nbr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const nowIso = new Date().toISOString();
            await db.prepare(
              `INSERT INTO oauth_ban_requests (id, client_id, username, reason, applicant, status, created_at)
               VALUES (?,?,?,?,?,'pending',?)`
            ).bind(id, clientId, targetUser, reason.slice(0, 5000), auth.username, nowIso).run();
            // 通知系统管理员
            await notifyAdmin(db, '🚫 收到全站封禁申请',
              '开发者 ' + auth.username + '（应用：' + (row.name || clientId) + '）申请全站封禁用户 ' + targetUser +
              '。理由：' + reason.slice(0, 500) + '（完整理由请在 platform 或管理后台查看，申请编号 ' + id + '）');
            return json({ ok: true, requestId: id, status: 'pending' }, 201, cors);
          }
          if (method === 'GET') {
            const { results } = await db.prepare(
              `SELECT r.*, c.name AS client_name FROM oauth_ban_requests r
               LEFT JOIN oauth_clients c ON c.client_id = r.client_id
               WHERE r.applicant = ? ORDER BY r.created_at DESC LIMIT 200`
            ).bind(auth.username).all();
            return json({ ok: true, requests: (results || []).map(oauthBanRequestPublic) }, 200, cors);
          }
          return json({ ok: false, error: 'unsupported' }, 400, cors);
        }

        // ===== 应用目录（公开，供 accounts「发现应用」页使用）=====
        if (seg === 'apps' && p[3] === 'directory' && method === 'GET') {
          const keyword = (url.searchParams.get('q') || '').trim().toLowerCase();
          const { results } = await db.prepare(
            `SELECT c.client_id, c.name, c.description, c.homepage, c.logo, c.scopes, c.owner, c.created_at, c.is_bot,
                    (SELECT COUNT(*) FROM oauth_grants g WHERE g.client_id = c.client_id AND g.revoked = 0) AS users
             FROM oauth_clients c WHERE c.status = 'active' ORDER BY users DESC, c.created_at DESC LIMIT 200`
          ).all();
          let list = (results || []).map(r => ({
            clientId: r.client_id,
            name: r.name || '(未命名应用)',
            description: r.description || '',
            homepage: r.homepage || '',
            logo: r.logo || '',
            owner: r.owner || '',
            isBot: !!r.is_bot,
            scopes: parseJsonArr(r.scopes),
            authorizedUsers: r.users || 0,
            createdAt: r.created_at || null,
            authorizeUrl: 'https://accounts.nflshcchat.cc.cd/authorize.html?client_id=' + encodeURIComponent(r.client_id),
          }));
          if (keyword) {
            list = list.filter(a => (a.name + ' ' + a.description + ' ' + a.owner).toLowerCase().includes(keyword));
          }
          return json({ ok: true, apps: list, count: list.length }, 200, cors);
        }


        // ===== 管理员：审批全站封禁申请 =====
        if (seg === 'admin' && p[3] === 'ban-requests') {
          const auth = await authUser(request, db);
          if (!auth) return json({ ok: false, error: '请先登录' }, 401, cors);
          if (!auth.isAdmin) return jsonForbidden();
          if (method === 'GET') {
            const { results } = await db.prepare(
              `SELECT r.*, c.name AS client_name, c.owner AS client_owner FROM oauth_ban_requests r
               LEFT JOIN oauth_clients c ON c.client_id = r.client_id
               ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 300`
            ).all();
            return json({ ok: true, requests: (results || []).map(oauthBanRequestPublic) }, 200, cors);
          }
          if (method === 'POST' && p[4]) {
            const id = decodeURIComponent(p[4]);
            const b = await request.json().catch(() => ({}));
            const action = String(b.action || '');
            const note = String(b.note || '');
            const req = await db.prepare('SELECT * FROM oauth_ban_requests WHERE id = ?').bind(id).first();
            if (!req) return json({ ok: false, error: '申请不存在' }, 404, cors);
            if (req.status !== 'pending') return json({ ok: false, error: '该申请已处理' }, 400, cors);
            const nowIso = new Date().toISOString();
            if (action === 'approve') {
              // 执行全站封禁（与管理员手动封禁一致：is_banned + isBanned 标记）
              const u = await db.prepare('SELECT raw_json FROM users WHERE username = ?').bind(req.username).first();
              const payload = u ? (parsePayload(u.raw_json) || {}) : {};
              await db.prepare('UPDATE users SET is_banned = 1 WHERE username = ?').bind(req.username).run();
              await db.prepare('UPDATE users SET raw_json = ? WHERE username = ?').bind(
                '```json\n' + JSON.stringify({ ...payload, isBanned: true, banReason: req.reason }) + '\n```', req.username).run();
              await db.prepare('DELETE FROM auth_tokens WHERE username = ?').bind(req.username).run();
              await db.prepare(
                `UPDATE oauth_ban_requests SET status = 'approved', reviewed_at = ?, reviewer = ?, review_note = ? WHERE id = ?`
              ).bind(nowIso, auth.username, note, id).run();
              // 通知申请开发者
              try {
                await db.prepare(
                  `INSERT OR REPLACE INTO notifications (id, type, title, content, target_user, sender, sent_at, is_read, raw_json)
                   VALUES (?,?,?,?,?,?,?,?,?)`
                ).bind('notif_' + Date.now() + '_br', 'system', '✅ 全站封禁申请已通过',
                  '你对用户 ' + req.username + ' 的封禁申请已通过。' + (note ? ('管理员备注：' + note) : ''),
                  req.applicant, 'huangzhiyuan', nowIso, 0,
                  JSON.stringify({ type: 'system', title: '✅ 全站封禁申请已通过', content: '你对用户 ' + req.username + ' 的封禁申请已通过。', targetUser: req.applicant, sender: 'huangzhiyuan', sentAt: nowIso, isRead: false })).run();
              } catch (e) { /* 通知失败不影响主流程 */ }
              return json({ ok: true, status: 'approved' }, 200, cors);
            }
            if (action === 'reject') {
              await db.prepare(
                `UPDATE oauth_ban_requests SET status = 'rejected', reviewed_at = ?, reviewer = ?, review_note = ? WHERE id = ?`
              ).bind(nowIso, auth.username, note, id).run();
              try {
                await db.prepare(
                  `INSERT OR REPLACE INTO notifications (id, type, title, content, target_user, sender, sent_at, is_read, raw_json)
                   VALUES (?,?,?,?,?,?,?,?,?)`
                ).bind('notif_' + Date.now() + '_br', 'system', '❌ 全站封禁申请未通过',
                  '你对用户 ' + req.username + ' 的封禁申请未通过。' + (note ? ('管理员备注：' + note) : ''),
                  req.applicant, 'huangzhiyuan', nowIso, 0,
                  JSON.stringify({ type: 'system', title: '❌ 全站封禁申请未通过', content: '你对用户 ' + req.username + ' 的封禁申请未通过。', targetUser: req.applicant, sender: 'huangzhiyuan', sentAt: nowIso, isRead: false })).run();
              } catch (e) { /* 忽略 */ }
              return json({ ok: true, status: 'rejected' }, 200, cors);
            }
            return json({ ok: false, error: 'action 必须是 approve 或 reject' }, 400, cors);
          }
          return json({ ok: false, error: 'unsupported' }, 400, cors);
        }

        return json({ ok: false, error: 'unknown oauth endpoint' }, 404, cors);
      }

      // POST /api/auth/forgot —— 忘记密码：校验用户名+邮箱 → 生成 6 位验证码
      //   → D1 临时保存（5 分钟有效，最新生成覆盖旧的）→ 按原 EmailJS 逻辑发送邮件
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'forgot' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || '').trim();
        const email = String(b.email || '').trim();
        if (!username || !email) return json({ ok: false, error: '缺少用户名或邮箱' }, 400, cors);
        // 校验用户存在且邮箱匹配（避免向任意邮箱发信）
        const user = await db.prepare('SELECT username, raw_json FROM users WHERE username = ?').bind(username).first();
        const userPayload = user ? parsePayload(user.raw_json) : null;
        const userEmail = (userPayload && (userPayload.email || '')) || '';
        if (!user || userEmail.toLowerCase() !== email.toLowerCase()) {
          return json({ ok: false, error: '用户名或邮箱不匹配' }, 404, cors);
        }
        if (userPayload.isBanned) return json({ ok: false, error: '账号已被封禁' }, 403, cors);
        // 生成 6 位验证码，5 分钟有效；同一用户最新验证码覆盖旧的
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + RESET_CODE_TTL_MS);
        await db.prepare('DELETE FROM auth_reset_codes WHERE username = ?').bind(username).run();
        await db.prepare('INSERT INTO auth_reset_codes (username, email, code, expires_at) VALUES (?,?,?,?)')
          .bind(username, email, code, expiresAt.toISOString()).run();
        // 发送邮件（沿用前端预设的 EmailJS 服务/模板；参数优先取请求，缺省用环境变量）。
        // 服务端调用 EmailJS REST API：有私钥（api_key）用私钥，否则用公钥（user_id）
        // （公钥从非浏览器环境调用需在 EmailJS 后台开启 "API access from non-browser environments"）
        const serviceId = b.serviceId || env.EMAILJS_SERVICE_ID || '';
        const templateId = b.templateId || env.EMAILJS_VERIFY_TEMPLATE_ID || '';
        const publicKey = b.publicKey || env.EMAILJS_PUBLIC_KEY || '';
        const apiKey = b.apiKey || env.EMAILJS_API_KEY || '';
        if (!serviceId || !templateId || (!publicKey && !apiKey)) {
          return json({ ok: false, error: '邮件服务未配置' }, 500, cors);
        }
        let mailOk = false, mailErr = '';
        try {
          // EmailJS REST API：user_id(公钥) 必填，accessToken(私钥) 服务端鉴权增强
          const mailBody = {
            service_id: serviceId,
            template_id: templateId,
            user_id: publicKey,
            template_params: { username: username, verify_code: code, email: email }
          };
          if (apiKey) mailBody.accessToken = apiKey;
          const mailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mailBody)
          });
          if (mailRes.status === 200) { mailOk = true; }
          else { mailErr = 'HTTP ' + mailRes.status + ' ' + (await mailRes.text()).slice(0, 200); }
        } catch (e) { mailErr = String(e && e.message || e); }
        if (!mailOk) {
          // 邮件失败则删除验证码，避免留下无效记录
          await db.prepare('DELETE FROM auth_reset_codes WHERE username = ?').bind(username).run();
          return json({ ok: false, error: '邮件发送失败：' + mailErr.slice(0, 200) }, 502, cors);
        }
        return json({ ok: true, message: '验证码已发送至 ' + maskEmail(email) }, 200, cors);
      }

      // POST /api/auth/verify-reset —— 校验验证码（5 分钟有效，取最新一条）
      //   成功后：删除验证码并签发 Bearer Token，用户用该 token 修改密码
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'verify-reset' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || '').trim();
        const code = String(b.code || '').trim();
        if (!username || !code) return json({ ok: false, error: '缺少用户名或验证码' }, 400, cors);
        const row = await db.prepare('SELECT username, code, expires_at FROM auth_reset_codes WHERE username = ?').bind(username).first();
        if (!row) return json({ ok: false, error: '验证码不存在，请先获取验证码' }, 404, cors);
        if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
          await db.prepare('DELETE FROM auth_reset_codes WHERE username = ?').bind(username).run();
          return json({ ok: false, error: '验证码已过期（5 分钟有效），请重新获取' }, 410, cors);
        }
        if (row.code !== code) return json({ ok: false, error: '验证码错误' }, 400, cors);
        // 校验通过：删除验证码，签发 token（同一用户旧 token 作废）
        await db.prepare('DELETE FROM auth_reset_codes WHERE username = ?').bind(username).run();
        const user = await db.prepare('SELECT username, raw_json FROM users WHERE username = ?').bind(username).first();
        const userPayload = user ? parsePayload(user.raw_json) : null;
        const token = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('tok_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_MS);
        await db.prepare('DELETE FROM auth_tokens WHERE username = ?').bind(username).run();
        // 重置密码属于安全敏感操作：作废该账号全部旧会话，只保留本次登录的这一台设备
        await createSession(db, {
          token, username, expiresAt,
          via: 'reset',
          userAgent: request.headers.get('User-Agent') || '',
          ip: (request.headers.get('CF-Connecting-IP') || '').trim(),
        });
        const isAdmin = (username === 'huangzhiyuan') || !!(userPayload && userPayload.isAdmin);
        await recordMetric(env, { kind: 'login', name: 'reset', status: 200, username, request });
        return json({ ok: true, token, username, isAdmin, expiresAt: expiresAt.toISOString() }, 200, cors);
      }

      // GET /api/auth/me —— 校验 token 是否有效（前端可用来自动续期/校验）
      if (p[0] === 'api' && p[1] === 'auth' && p[2] === 'me' && method === 'GET') {
        const auth = await authUser(request, db);
        if (!auth) return json({ ok: false, error: 'unauthorized' }, 401, cors);
        return json({ ok: true, username: auth.username, isAdmin: auth.isAdmin }, 200, cors);
      }

      // ============================================================
      //  实时消息推送（SSE · Server-Sent Events）
      //  为什么用 SSE：浏览器 EventSource 无法自定义请求头，因此 token 走查询参数；
      //  该端点必须放在「统一鉴权」之前，自行完成鉴权。
      //  每次连接持续约 55 秒后主动结束并提示客户端带 since 重连，
      //  既保持准实时（1.5 秒轮询 D1），又避免长时间占用连接。
      // ============================================================
      if (p[0] === 'api' && p[1] === 'realtime' && p[2] === 'stream' && method === 'GET') {
        const qToken = url.searchParams.get('access_token') || url.searchParams.get('token') || bearerToken(request);
        if (!qToken) return json({ ok: false, error: 'unauthorized: 缺少访问令牌' }, 401, cors);
        const tRow = await db.prepare('SELECT username, expires_at FROM auth_tokens WHERE token = ?').bind(qToken).first();
        if (!tRow) return json({ ok: false, error: 'unauthorized: 令牌无效' }, 401, cors);
        if (tRow.expires_at && new Date(tRow.expires_at).getTime() < Date.now()) {
          return json({ ok: false, error: 'unauthorized: 令牌已过期' }, 401, cors);
        }
        const rtUser = { username: tRow.username, isAdmin: tRow.username === 'huangzhiyuan' };
        const roomId = url.searchParams.get('room_id') || '';
        // since：只推送该时间点之后的新消息（客户端重连时带上，避免重复）
        let lastTs = url.searchParams.get('since') || new Date(Date.now() - 5000).toISOString();

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (event, data) => {
              try { controller.enqueue(enc.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')); }
              catch (e) { /* 客户端已断开 */ }
            };
            send('hello', { ok: true, username: rtUser.username, roomId, since: lastTs });
            const deadline = Date.now() + 55000;
            let ticks = 0;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 1500));
              ticks++;
              try {
                let rows = [];
                if (roomId) {
                  const q = await db.prepare(
                    'SELECT * FROM messages WHERE room_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 50'
                  ).bind(roomId, lastTs).all();
                  rows = q.results || [];
                } else {
                  // 未指定房间：推送该用户相关的全部新消息（用于会话列表红点/通知）
                  const q = await db.prepare(
                    'SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC LIMIT 50'
                  ).bind(lastTs).all();
                  rows = q.results || [];
                }
                if (rows.length > 0) {
                  lastTs = rows[rows.length - 1].timestamp || lastTs;
                  send('messages', { roomId, messages: rows.map(hydrateRow), since: lastTs });
                } else if (ticks % 8 === 0) {
                  // 心跳：保持连接不被中间层断开
                  try { controller.enqueue(enc.encode(': keep-alive\n\n')); } catch (e) { /* 已断开 */ }
                }
              } catch (e) { /* 查询失败继续下一轮 */ }
            }
            send('bye', { reason: 'rotate', since: lastTs });
            try { controller.close(); } catch (e) { /* 已关闭 */ }
          }
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...cors,
          },
        });
      }

      // ================= 读写统一鉴权 =================
      // GET 也不能全部公开：除认证端点外，所有读取都需要有效 token
      // （用户表含密码哈希，绝不能再匿名可读；登录校验已全部移到服务端 /api/auth/login）
      let wAuth = null; // { username, isAdmin }：当前请求调用者
      if (!(p[0] === 'api' && p[1] === 'auth')) {
        if (method === 'GET') {
          wAuth = await authUser(request, db);
          if (!wAuth) {
            return json({ ok: false, error: 'unauthorized: 请先登录', hint: 'missing or invalid Bearer token' }, 401, cors);
          }
        }
      }
      // 写操作统一 Bearer Token 鉴权（豁免：注册 POST users）
      if (method !== 'GET' && method !== 'OPTIONS' && !(p[0] === 'api' && p[1] === 'auth')) {
        let allowAnonymousUserCreate = false;
        if (p[0] === 'api' && p[1] === 'legacy' && p[2] === 'issues' && method === 'POST') {
          try {
            const b = await request.clone().json();
            const label = (b.labels && b.labels[0]) || url.searchParams.get('labels');
            allowAnonymousUserCreate = (labelToTable(label) === 'users');
          } catch (e) { /* 非 JSON 或解析失败则按需鉴权 */ }
        }
        if (!allowAnonymousUserCreate) {
          wAuth = await authUser(request, db);
          if (!wAuth) {
            return json({ ok: false, error: 'unauthorized: missing or invalid Bearer token', hint: '请先登录获取 token' }, 401, cors);
          }
        }
      }

      // ---- Direct table reads (snake_case rows) ----
      if (p[0] === 'api' && p[1] && p[1] !== 'legacy') {
        const table = p[1];
        const allowed = ['users','rooms','friends','notices','broadcasts','reports','notifications','favorites','suggestions','music_history','articles','hzyai_conversations','misc_issues','messages'];
        if (!allowed.includes(table)) return json({ error: 'table not allowed' }, 403, cors);

        if (method === 'GET') {
          if (table === 'messages') {
            const room = url.searchParams.get('room_id');
            const limit = parseInt(url.searchParams.get('limit') || '100');
            let rows;
            if (room) {
              const { results } = await db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY timestamp ASC LIMIT ?').bind(room, limit).all();
              rows = results;
            } else {
              const { results } = await db.prepare('SELECT * FROM messages ORDER BY timestamp ASC LIMIT ?').bind(limit).all();
              rows = results;
            }
            return json(rows.map(hydrateRow), 200, cors);
          }
          const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
          return json(results.map(hydrateRow), 200, cors);
        }

        if (method === 'POST' && table === 'messages') {
          const b = withAliases(await request.json());
          if (!b.id) return json({ error: 'missing id', ok: false }, 400, cors);
          // 语音等扩展字段（is_voice/voice_data）没有独立列，统一保存在 raw_json 中
          await db.prepare(
            `INSERT OR REPLACE INTO messages
             (id,room_id,sender,content,mentions,has_mention_all,reply_to,is_recalled,is_pinned,timestamp,raw_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            b.id, b.room_id || null, b.sender || null, b.content ?? '',
            JSON.stringify(b.mentions || []), b.has_mention_all ? 1 : 0,
            b.reply_to || null, b.is_recalled ? 1 : 0, b.is_pinned ? 1 : 0,
            b.timestamp || new Date().toISOString(), JSON.stringify(b)
          ).run();
          return json({ ok: true, id: b.id }, 200, cors);
        }

        // 通用写入：支持 favorites / notifications 等表的直接写入
        if (method === 'POST') {
          const b = withAliases(await request.json());
          const rid = b.id || (b.username) || (Date.now().toString());
          await upsertRow(db, table, rid, b);
          return json({ ok: true, id: rid }, 200, cors);
        }

        // 通用更新：PATCH /api/<table>/<id>，与现有行合并
        if ((method === 'PATCH' || method === 'PUT') && p[2]) {
          const rid = decodeURIComponent(p[2]);
          let b = withAliases(await request.json().catch(() => ({})));
          const keyCol = (table === 'users') ? 'username' : 'id';
          const existing = await db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).bind(rid).first();
          if (!existing) return json({ error: 'not found', ok: false }, 404, cors);

          // ===== 直连表 PATCH 行级权限校验 =====
          if (table === 'users') {
            // 仅本人或管理员可改（防止任意用户改他人密码）
            if (!(wAuth && (wAuth.isAdmin || wAuth.username === existing.username))) return jsonForbidden();
          } else if (table === 'messages') {
            // 消息：非管理员只能改白名单字段（reactions/is_recalled/is_pinned），
            // 且 is_recalled 仅发送者（2 分钟内），is_pinned 仅管理员或群管理员
            if (!(wAuth && wAuth.isAdmin)) {
              const allowedKeys = Object.keys(b).filter(k => MESSAGE_PATCH_ALLOWED.includes(k));
              if (Object.keys(b).length !== allowedKeys.length) return jsonForbidden();
              // 撤回：仅发送者且 2 分钟内
              if (allowedKeys.includes('is_recalled')) {
                if (!canRecallMessage(existing, wAuth)) return jsonForbidden();
              }
              // 置顶：群主或群管理员
              if (allowedKeys.includes('is_pinned')) {
                const room = existing.room_id
                  ? await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(existing.room_id).first().catch(() => null)
                  : null;
                const admins = room ? parseJsonArraySafe(room.admins) : [];
                const isRoomManager = room && (room.creator === wAuth.username || admins.includes(wAuth.username));
                if (!isRoomManager) return jsonForbidden();
              }
            }
          } else if (table === 'rooms') {
            // 普通成员仅允许更新 members（加入/退出群聊），
            // 防止成员篡改公告、验证码、群管理员等管理字段
            const roomAdmins = parseJsonArraySafe(existing.admins);
            const isRoomManager = existing.creator === wAuth.username || roomAdmins.includes(wAuth.username);
            if (!isRoomManager) {
              // 非管理成员：members 变更只能涉及自己（加入=把自己加进去；退出=把自己移除）
              if (b.members !== undefined) {
                const oldMembers = parseJsonArraySafe(existing.members);
                const newMembers = parseJsonArraySafe(b.members);
                const added = newMembers.filter(m => !oldMembers.includes(m));
                const removed = oldMembers.filter(m => !newMembers.includes(m));
                const selfAffected = (added.length === 1 && added[0] === wAuth.username && removed.length === 0)
                  || (removed.length === 1 && removed[0] === wAuth.username && added.length === 0);
                if (!selfAffected) return jsonForbidden();
              }
              const allowed = {};
              if (b.members !== undefined) allowed.members = b.members;
              if (b.updatedAt !== undefined) allowed.updatedAt = b.updatedAt;
              if (Object.keys(allowed).length === 0) return jsonForbidden();
              b = allowed;
            } else {
              // 群主/群管理员：解散(is_dissolved)、封禁(is_banned)、转让(creator)仅群主或系统管理员
              if (b.is_dissolved !== undefined || b.isDissolved !== undefined || b.is_banned !== undefined || b.isBanned !== undefined || b.creator !== undefined) {
                if (!(wAuth.isAdmin || existing.creator === wAuth.username)) return jsonForbidden();
              }
            }
          } else {
            const existingPayload = parsePayload(existing.raw_json);
            const payloadForAuth = existingPayload ? { ...existingPayload, ...stripMeta(existing), ...b } : null;
            if (!canWriteRow(table, existing, payloadForAuth, null, wAuth)) return jsonForbidden();
          }

          const merged = { ...parsePayload(existing.raw_json), ...stripMeta(existing), ...b };
          await upsertRow(db, table, rid, merged);
          return json({ ok: true, id: rid }, 200, cors);
        }

        if (method === 'DELETE' && p[2]) {
          const rid = decodeURIComponent(p[2]);
          const keyCol = (table === 'users') ? 'username' : 'id';

          // ===== 直连表 DELETE 行级权限校验 =====
          if (table === 'users') {
            if (!(wAuth && wAuth.isAdmin)) return jsonForbidden(); // 删除用户仅管理员
          } else {
            const existing = await db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).bind(rid).first();
            if (!existing) return json({ error: 'not found', ok: false }, 404, cors);
            if (table === 'messages') {
              // 消息删除仅管理员：发送者即使 2 分钟内也只能"撤回"（PATCH is_recalled），不能物理删除
              if (!(wAuth && wAuth.isAdmin)) return jsonForbidden();
            } else {
              const existingPayload = parsePayload(existing.raw_json);
              if (!canWriteRow(table, existing, existingPayload, null, wAuth)) return jsonForbidden();
            }
          }

          await db.prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`).bind(rid).run();
          return json({ ok: true, id: rid, deleted: true }, 200, cors);
        }
        return json({ error: 'unsupported route' }, 400, cors);
      }

      // ---- Legacy GitHub-Issues compatibility layer ----
      // GET /api/legacy/issues?labels=<label>&state=open[&type=<type>]
      // returns array of pseudo-issues: { number, body, labels:[label] }
      if (p[0] === 'api' && p[1] === 'legacy' && p[2] === 'issues' && method === 'GET') {
        const label = url.searchParams.get('labels') || url.searchParams.get('label');
        const table = labelToTable(label);
        if (!table) return json([], 200, cors);
        // 用户隔离：hzyai_* 表按 user（及可选 type）过滤，杜绝“加载所有用户对话”
        let sql = `SELECT * FROM ${table}`;
        const binds = [];
        if (table === 'misc_issues' && label) {
          // 群相册：仅群成员（或系统管理员）可查看
          if (parseRoomGalleryLabel(label)) {
            const room = await loadRoomForGallery(db, label);
            if (!isRoomMemberOrAdmin(room, wAuth)) return jsonForbidden();
          }
          sql += ' WHERE label = ?';
          binds.push(label);
        }
        if (table === 'hzyai_conversations' || table === 'hzyai_gen') {
          const user = parseHzUser(label);
          const type = url.searchParams.get('type');
          if (user) {
            sql += ' WHERE user = ?';
            binds.push(user);
            if (type) { sql += ' AND type = ?'; binds.push(type); }
          }
        }
        const { results } = await db.prepare(sql).bind(...binds).all();
        const useBody = (table === 'misc_issues');
        const issues = results.map((row, i) => ({
          number: row.id || i + 1,
          title: (row.title) || (row.name) || String(row.id || i + 1),
          body: useBody
            ? ((typeof row.body === 'string' && row.body.trim()) ? row.body : fence(JSON.stringify(row)))
            : fence(mergedPayload(row)),
          labels: [label],
          state: 'open',
          created_at: row.created_at || row.timestamp || row.sent_at || null,
          updated_at: row.updated_at || row.created_at || row.timestamp || row.sent_at || null,
        }));
        return json(issues, 200, cors);
      }

      // POST /api/legacy/issues  -> create a new record from fenced JSON body
      if (p[0] === 'api' && p[1] === 'legacy' && p[2] === 'issues' && method === 'POST') {
        const b = await request.json();
        const label = (b.labels && b.labels[0]) || url.searchParams.get('labels');
        const table = labelToTable(label);
        if (!table) return json([], 200, cors);
        // 容错解析：支持 ```json 围栏、\r\n、无围栏纯 JSON 等多种写法
        const payload = parsePayload(b.body);
        // 公告/广播仅管理员可创建
        if (table === 'notices' || table === 'broadcasts') {
          if (!(wAuth && wAuth.isAdmin)) return jsonForbidden();
        }
        // hzyai 个人对话/生成历史：label 中的用户名必须是本人（共享公开标签除外）
        if (table === 'hzyai_conversations' || table === 'hzyai_gen') {
          if (!canWriteHzLabel(label, wAuth)) return jsonForbidden();
        }
        // 日历/图床：label 前缀用户名必须是本人
        if (table === 'misc_issues' && label && (label.startsWith('calendar_') || label.startsWith('image_'))) {
          const owner = label.slice(label.indexOf('_') + 1);
          if (!(wAuth && (wAuth.isAdmin || owner === wAuth.username))) return jsonForbidden();
        }
        // 群相册：仅群成员可上传（label 形如 roomgallery_<roomId>）
        if (table === 'misc_issues' && parseRoomGalleryLabel(label)) {
          const room = await loadRoomForGallery(db, label);
          if (!isRoomMemberOrAdmin(room, wAuth)) return jsonForbidden();
        }
        const id = payload.id || payload.username || (b.number) || (Date.now().toString());
        const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
        const user = parseHzUser(label);
        const type = url.searchParams.get('type') || payload.type || null;
        if (table === 'misc_issues') {
          // misc_issues.id 是自增整数主键，不能写入字符串逻辑 id（会 datatype mismatch 报错）。
          // 这里让 id 自增，并把逻辑 id 存进 label/issue_number 以便检索，返回自增 rowid 作为 number。
          const info = await db.prepare(
            `INSERT INTO misc_issues (label, title, body, state, created_at)
             VALUES (?, ?, ?, 'open', datetime('now'))`
          ).bind(label, payload.name || payload.title || String(id), fenced).run();
          const number = info.meta && info.meta.last_row_id ? info.meta.last_row_id : id;
          return json({ number, ok: true }, 200, cors);
        } else if (table === 'hzyai_conversations' || table === 'hzyai_gen') {
          await db.prepare(
            `INSERT OR REPLACE INTO ${table} (id, title, raw_json, user, type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
          ).bind(id, payload.name || payload.title || String(id), fenced, user || null, type, ).run();
        } else if (table === 'users') {
          // 安全加固：users 表主键是 username，POST 走 INSERT OR REPLACE 会覆盖已存在用户
          // （例如直接调 API 注册 huangzhiyuan 即可改掉管理员密码）。这里禁止覆盖：
          // 注册走 POST（查重后创建），资料/改密走 PATCH，互不冲突。
          // 被封禁 IP 不允许注册新账号
          const regIp = (request.headers.get('CF-Connecting-IP') || '').trim();
          if (regIp && await isIpBanned(db, regIp)) {
            return json({ ok: false, error: '您的 IP 已被封禁，请联系管理员', code: 'ip_banned' }, 403, cors);
          }
          const existingUser = await db.prepare('SELECT username FROM users WHERE username = ?').bind(id).first();
          if (existingUser) {
            return json({ error: 'username already exists', ok: false }, 409, cors);
          }
          // 防恶意注册：同 IP 已注册账号数达到阈值 → 拒绝并触发处罚
          if (regIp) {
            const cntRow = await db.prepare('SELECT COUNT(*) AS c FROM register_log WHERE ip = ?').bind(regIp).first();
            if (cntRow && (cntRow.c || 0) >= REGISTER_IP_LIMIT) {
              await punishMassRegistration(db, regIp);
              return json({ ok: false, error: '注册过于频繁，IP 已被封禁，请联系管理员', code: 'ip_banned' }, 403, cors);
            }
          }
          await upsertRow(db, table, id, payload);
          // 记录该 IP 本次注册；若达到阈值则封禁 IP + 冻结该 IP 注册的全部账号 + 通知管理员
          if (regIp) {
            await db.prepare('INSERT OR IGNORE INTO register_log (ip, username, created_at) VALUES (?,?,?)')
              .bind(regIp, String(id), new Date().toISOString()).run();
            const cntRow = await db.prepare('SELECT COUNT(*) AS c FROM register_log WHERE ip = ?').bind(regIp).first();
            if (cntRow && (cntRow.c || 0) >= REGISTER_IP_LIMIT) {
              await punishMassRegistration(db, regIp);
            }
          }
        } else {
          // 按目标表的真实列写入：只写该表存在的列，避免 "no such column"
          await upsertRow(db, table, id, payload);
        }
        // 新消息 → 向「已授权该用户」且订阅了 message.created 的应用投递 Webhook
        if (table === 'messages' && payload && payload.sender) {
          await fanoutWebhookToAuthorizedApps(db, 'message.created', payload.sender, {
            roomId: payload.roomId || payload.room_id || null,
            messageId: id,
            content: payload.content || '',
            timestamp: payload.timestamp || null,
          });
        }
        return json({ number: id, ok: true }, 200, cors);
      }

      // PATCH/PUT /api/legacy/issues/{number} -> 更新 D1 中对应记录
      // 让 issues-manager 等前端可以编辑已存在的数据（D1 更新能力）。
      if (p[0] === 'api' && p[1] === 'legacy' && p[2] === 'issues' && (method === 'PATCH' || method === 'PUT') && p[3]) {
        const urlId = p[3];
        const b = await request.json().catch(() => ({}));
        const label = (b.labels && b.labels[0]) || url.searchParams.get('labels');
        // 大量历史前端代码 PATCH 时不带 labels（GitHub Issues 时代不需要），
        // 直接 400 会让"编辑/删除/封禁"等功能全部静默失效，这里按 id 反查所属表。
        const table = labelToTable(label) || await findTableById(db, urlId);
        if (!table) return json({ error: 'unknown label', ok: false }, 400, cors);

        let payload = parsePayload(b.body);

        // users 表主键是 username，不是 id；posts/articles 等真实主键是 payload.id，
        // 而前端 PATCH 用的 urlId 是 GitHub issue 编号，不等于 D1 主键，必须优先用 payload 内的真实主键。
        const realId = (table === 'users')
          ? (payload.username || urlId)
          : (payload.id || urlId);
        const keyCol = (table === 'users') ? 'username' : 'id';
        // 先按真实主键查，查不到再退回 urlId（兼容纯数字 id 场景）
        let info = await db.prepare(`SELECT ${keyCol} AS k FROM ${table} WHERE ${keyCol} = ?`).bind(realId).first();
        if (!info) {
          info = await db.prepare(`SELECT ${keyCol} AS k FROM ${table} WHERE ${keyCol} = ?`).bind(urlId).first();
        }
        if (!info && !isNaN(Number(realId))) {
          info = await db.prepare(`SELECT ${keyCol} AS k FROM ${table} WHERE ${keyCol} = ?`).bind(Number(realId)).first();
        }
        if (!info && !isNaN(Number(urlId))) {
          info = await db.prepare(`SELECT ${keyCol} AS k FROM ${table} WHERE ${keyCol} = ?`).bind(Number(urlId)).first();
        }
        // 行不存在时不再返回 404：PATCH 视为 upsert，交由 upsertRow 创建新行
        // （例如新注册/首次保存资料的 admin 用户可能在 users 表中尚不存在）。
        const resolvedId = info ? info.k : realId;

        // ===== 行级权限校验（PATCH）=====
        // users：仅本人或管理员可改（防止任意用户改他人密码/封禁状态）
        // messages：发送者 2 分钟内可撤回/更新，管理员任意
        // 其余：归属人（作者/创建者/发送者/成员等）或管理员
        if (table === 'users') {
          const targetUser = (payload.username) || resolvedId;
          if (!(wAuth && (wAuth.isAdmin || wAuth.username === targetUser))) {
            return jsonForbidden();
          }
        } else if (table === 'messages') {
          const existingRow = await db.prepare(`SELECT * FROM messages WHERE id = ?`).bind(resolvedId).first().catch(() => null);
          if (!(wAuth && (wAuth.isAdmin || canRecallMessage(existingRow, wAuth)))) {
            return jsonForbidden();
          }
        } else if (table === 'rooms') {
          // 房间：群主/群管理员可管理；普通成员仅能改 members 且只能增减自己
          const existingRoom = await db.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(resolvedId).first().catch(() => null);
          const roomAdmins = existingRoom ? parseJsonArraySafe(existingRoom.admins) : [];
          const isRoomManager = existingRoom && (existingRoom.creator === wAuth.username || roomAdmins.includes(wAuth.username));
          if (wAuth && (wAuth.isAdmin || existingRoom && existingRoom.creator === wAuth.username)) {
            // 管理员/群主：可改，包括解散/转让
          } else if (isRoomManager) {
            // 群管理员：可管理，但不能解散/转让/封禁
            const mgrBannedKeys = ['is_dissolved', 'isDissolved', 'is_banned', 'isBanned', 'creator'];
            if (mgrBannedKeys.some(k => payload[k] !== undefined)) return jsonForbidden();
          } else {
            // 普通成员：只允许增减自己（加入/退出）
            const oldMembers = existingRoom ? parseJsonArraySafe(existingRoom.members) : [];
            const newMembers = Array.isArray(payload.members) ? payload.members : oldMembers;
            const added = newMembers.filter(m => !oldMembers.includes(m));
            const removed = oldMembers.filter(m => !newMembers.includes(m));
            const selfAffected = (added.length === 1 && added[0] === wAuth.username && removed.length === 0)
              || (removed.length === 1 && removed[0] === wAuth.username && added.length === 0);
            if (!selfAffected) return jsonForbidden();
            const restricted = {};
            if (payload.members !== undefined) restricted.members = payload.members;
            payload = restricted;
          }
          if (!canWriteRow(table, existingRoom, payload, label, wAuth)) return jsonForbidden();
        } else {
          const existingRow = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(resolvedId).first().catch(() => null);
          const existingPayload = existingRow ? parsePayload(existingRow.raw_json) : null;
          const payloadForAuth = existingPayload ? { ...existingPayload, ...payload } : payload;
          if (!canWriteRow(table, existingRow, payloadForAuth, label, wAuth)) {
            return jsonForbidden();
          }
        }

        const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
        const user = parseHzUser(label);
        const type = url.searchParams.get('type') || payload.type || null;
        if (table === 'misc_issues') {
          await db.prepare(
            `UPDATE misc_issues SET body = ?, title = ? WHERE id = ?`
          ).bind(fenced, payload.name || payload.title || String(resolvedId), resolvedId).run();
        } else if (table === 'hzyai_conversations' || table === 'hzyai_gen') {
          // 前端 PATCH 有时不带 labels（此时 user 为 null），不能把 user/type 覆盖成 NULL，
          // 否则按 user 隔离的 GET（WHERE user=?) 将再也查不到这条记录（历史记录"消失"）。
          const prev = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(resolvedId).first();
          const keepUser = user || (prev && prev.user) || null;
          const keepType = type || (prev && prev.type) || null;
          await db.prepare(
            `UPDATE ${table} SET raw_json = ?, title = ?, user = ?, type = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(fenced, payload.name || payload.title || String(resolvedId), keepUser, keepType, resolvedId).run();
        } else {
          // PATCH 语义：与已存在行合并，避免前端只传部分字段时丢数据
          const existing = await db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} = ?`).bind(resolvedId).first();
          const base = existing ? { ...parsePayload(existing.raw_json), ...stripMeta(existing) } : {};
          const merged = { ...base, ...payload };
          await upsertRow(db, table, resolvedId, merged);
        }
        return json({ number: resolvedId, ok: true }, 200, cors);
      }

      // DELETE /api/legacy/issues/{number}?labels=xxx -> 删除 D1 中对应记录
      if (p[0] === 'api' && p[1] === 'legacy' && p[2] === 'issues' && method === 'DELETE' && p[3]) {
        const id = p[3];
        // 注意：DELETE 请求体通常为空，这里不能引用 b（历史 bug：b is not defined）
        let delBody = {};
        try { delBody = await request.json(); } catch (e) { delBody = {}; }
        const label = url.searchParams.get('labels') || (delBody.labels && delBody.labels[0]);
        // 同 PATCH：历史前端删除时常不带 labels，按 id 反查所属表
        const table = labelToTable(label) || await findTableById(db, id);
        if (!table) return json({ error: 'unknown label', ok: false }, 400, cors);
        const delKey = (table === 'users') ? 'username' : 'id';
        let info = await db.prepare(`SELECT ${delKey} AS k FROM ${table} WHERE ${delKey} = ?`).bind(id).first();
        if (!info && !isNaN(Number(id))) {
          info = await db.prepare(`SELECT ${delKey} AS k FROM ${table} WHERE ${delKey} = ?`).bind(Number(id)).first();
        }
        if (!info) return json({ error: 'not found', ok: false }, 404, cors);

        // ===== 行级权限校验（DELETE）=====
        // users：仅管理员可删除；messages：仅管理员可删除（发送者只能撤回，不能物理删除）；
        // 其余：归属人或管理员（公告/广播仅管理员）
        if (table === 'users') {
          if (!(wAuth && wAuth.isAdmin)) return jsonForbidden();
        } else if (table === 'messages') {
          // 消息删除仅管理员：普通发送者即使 2 分钟内也只能走 PATCH is_recalled 撤回
          if (!(wAuth && wAuth.isAdmin)) return jsonForbidden();
        } else if (table === 'misc_issues' && parseRoomGalleryLabel(label)) {
          // 群相册：上传者本人、群主/群管理员、系统管理员可删
          const row = await db.prepare('SELECT * FROM misc_issues WHERE id = ?').bind(info.k).first().catch(() => null);
          const payload = row ? (parsePayload(row.body) || {}) : {};
          const uploader = payload.uploader || payload.username || '';
          const room = await loadRoomForGallery(db, label);
          const allowed = wAuth && (wAuth.isAdmin || (uploader && uploader === wAuth.username) || isRoomAdmin(room, wAuth));
          if (!allowed) return jsonForbidden();
        } else {
          const existingRow = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(info.k).first().catch(() => null);
          const existingPayload = existingRow ? parsePayload(existingRow.raw_json) : null;
          if (!canWriteRow(table, existingRow, existingPayload, label, wAuth)) return jsonForbidden();
        }

        await db.prepare(`DELETE FROM ${table} WHERE ${delKey} = ?`).bind(info.k).run();
        return json({ number: info.k, ok: true, deleted: true }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      // 健康看板数据：记录 5xx 异常
      await recordMetric(env, {
        kind: 'error', name: url.pathname, status: 500,
        detail: String(e && e.message || e).slice(0, 300), ms: Date.now() - t0,
        request,
      });
      return json({ error: 'worker exception', detail: String(e && e.message || e), ok: false }, 500, cors);
    }
  }
};

// ---- 兼容层辅助函数 ----

// ================= Bearer Token 鉴权 =================
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const RESET_CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效

// 登录安全策略：连续失败 20 次锁 5 分钟；累计失败 50 次冻结+封 IP
const LOGIN_LOCK_THRESHOLD = 20;
const LOGIN_FREEZE_THRESHOLD = 50;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
// 防恶意注册：同一 IP 注册账号数达到该阈值 → 封禁 IP + 冻结该 IP 注册的全部账号 + 通知管理员
const REGISTER_IP_LIMIT = 5;

async function ensureAuthTable(db) {
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_tokens (
         token TEXT PRIMARY KEY,
         username TEXT,
         created_at TEXT,
         expires_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  // 多设备会话：给每个登录会话记录设备信息与最近活跃时间（旧库补列，已存在则忽略）
  for (const col of [
    `ALTER TABLE auth_tokens ADD COLUMN session_id TEXT`,
    `ALTER TABLE auth_tokens ADD COLUMN device_label TEXT`,
    `ALTER TABLE auth_tokens ADD COLUMN user_agent TEXT`,
    `ALTER TABLE auth_tokens ADD COLUMN ip TEXT`,
    `ALTER TABLE auth_tokens ADD COLUMN last_seen_at TEXT`,
    `ALTER TABLE auth_tokens ADD COLUMN via TEXT`,
  ]) {
    try { await db.prepare(col).run(); } catch (e) { /* 列已存在 */ }
  }
  try {
    // 扫码登录会话（PC 出码 → 手机确认 → PC 拿到 token）
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS qr_login_sessions (
         id TEXT PRIMARY KEY,
         secret TEXT,
         status TEXT DEFAULT 'pending',
         username TEXT,
         token TEXT,
         created_at TEXT,
         expires_at TEXT,
         confirmed_at TEXT,
         ip TEXT,
         user_agent TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    // 注销账号申请（GDPR 风格：可撤销的冷静期）
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS account_deletions (
         username TEXT PRIMARY KEY,
         requested_at TEXT,
         effective_at TEXT,
         reason TEXT,
         cancelled_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    // 健康看板用的运行事件（错误/慢请求/关键动作）
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS metrics_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT, name TEXT, detail TEXT, status INTEGER, ms INTEGER,
         username TEXT, ip TEXT, created_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    // 会议
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meetings (
         id TEXT PRIMARY KEY, code TEXT UNIQUE, title TEXT, host TEXT, kind TEXT,
         status TEXT DEFAULT 'scheduled', scheduled_at TEXT, duration_min INTEGER,
         created_at TEXT, started_at TEXT, ended_at TEXT, password TEXT, note TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meeting_members (
         meeting_id TEXT, username TEXT, role TEXT DEFAULT 'guest',
         invited_at TEXT, joined_at TEXT, left_at TEXT, state TEXT DEFAULT 'invited',
         PRIMARY KEY (meeting_id, username))`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meeting_messages (
         id TEXT PRIMARY KEY, meeting_id TEXT, sender TEXT, content TEXT, created_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS meeting_signals (
         id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, from_user TEXT,
         to_user TEXT, kind TEXT, payload TEXT, created_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_reset_codes (
         username TEXT PRIMARY KEY,
         email TEXT,
         code TEXT,
         expires_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS login_security (
         key TEXT PRIMARY KEY,
         fail_count INTEGER DEFAULT 0,
         locked_until TEXT,
         updated_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS banned_ips (
         ip TEXT PRIMARY KEY,
         reason TEXT,
         banned_at TEXT)`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS register_log (
         ip TEXT NOT NULL,
         username TEXT NOT NULL,
         created_at TEXT,
         PRIMARY KEY (ip, username))`
    ).run();
  } catch (e) { /* 已存在则忽略 */ }
}

// ================= OAuth 开放平台表结构 =================
async function ensureOAuthTables(db) {
  const tables = [
    // 开发者应用
    `CREATE TABLE IF NOT EXISTS oauth_clients (
       client_id TEXT PRIMARY KEY,
       client_secret_hash TEXT,
       name TEXT, description TEXT, homepage TEXT, logo TEXT,
       redirect_uris TEXT, scopes TEXT, owner TEXT, status TEXT DEFAULT 'active',
       created_at TEXT, updated_at TEXT)`,
    // 授权码（一次性，5 分钟有效）
    `CREATE TABLE IF NOT EXISTS oauth_codes (
       code TEXT PRIMARY KEY, client_id TEXT, username TEXT, scopes TEXT,
       redirect_uri TEXT, expires_at TEXT, used INTEGER DEFAULT 0, created_at TEXT)`,
    // 访问令牌 / 刷新令牌
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
       access_token TEXT PRIMARY KEY, refresh_token TEXT, client_id TEXT, username TEXT,
       scopes TEXT, created_at TEXT, expires_at TEXT, refresh_expires_at TEXT, revoked INTEGER DEFAULT 0)`,
    // 用户对应用的长期授权记录（可在 accounts 撤销）
    `CREATE TABLE IF NOT EXISTS oauth_grants (
       client_id TEXT, username TEXT, scopes TEXT, granted_at TEXT, updated_at TEXT,
       revoked INTEGER DEFAULT 0, PRIMARY KEY (client_id, username))`,
    // 项目内封禁（仅在该开发者应用内生效，不影响主站账号）
    `CREATE TABLE IF NOT EXISTS oauth_project_bans (
       client_id TEXT, username TEXT, reason TEXT, banned_by TEXT, banned_at TEXT,
       active INTEGER DEFAULT 1, PRIMARY KEY (client_id, username))`,
    // 向主站管理员提交的全站封禁申请
    `CREATE TABLE IF NOT EXISTS oauth_ban_requests (
       id TEXT PRIMARY KEY, client_id TEXT, username TEXT, reason TEXT, applicant TEXT,
       status TEXT DEFAULT 'pending', created_at TEXT, reviewed_at TEXT, reviewer TEXT, review_note TEXT)`,
    // Webhook 事件订阅（每个应用一条）
    `CREATE TABLE IF NOT EXISTS oauth_webhooks (
       client_id TEXT PRIMARY KEY, url TEXT, secret TEXT, events TEXT,
       active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, last_status INTEGER, last_at TEXT, last_error TEXT)`,
    // 第三方登录身份绑定（Google 等）：一个账号可绑定多个三方身份
    `CREATE TABLE IF NOT EXISTS oauth_identities (
       provider TEXT, subject TEXT, username TEXT, email TEXT, created_at TEXT,
       PRIMARY KEY (provider, subject))`,
    // Google 登录的一次性兑换凭据（避免把长期 token 放在 URL 里）
    `CREATE TABLE IF NOT EXISTS google_login_tickets (
       ticket TEXT PRIMARY KEY, username TEXT, token TEXT, created_at TEXT, expires_at TEXT,
       used INTEGER DEFAULT 0)`,
  ];
  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (e) { /* 已存在则忽略 */ }
  }
  // 兼容性补列（已存在时报错忽略）：机器人账号
  for (const sql of [
    `ALTER TABLE oauth_clients ADD COLUMN is_bot INTEGER DEFAULT 0`,
    `ALTER TABLE oauth_clients ADD COLUMN bot_username TEXT`,
  ]) {
    try { await db.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
  }
}

// ================= 1对1 音视频通话信令（WebRTC） =================
// 说明：音视频走 WebRTC P2P（免费 STUN，不经过服务器中转），
// 本 worker 只负责交换信令（offer / answer / ICE candidate）与通话状态。
// 状态机：pending（待接听）→ accepted（通话中）/ rejected（已拒绝）/ ended（已结束）
async function ensureCallTables(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS calls (
       id TEXT PRIMARY KEY, caller TEXT, callee TEXT, type TEXT, status TEXT,
       created_at TEXT, updated_at TEXT, ended_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS call_signals (
       id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, from_user TEXT,
       kind TEXT, payload TEXT, created_at TEXT)`,
  ];
  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (e) { /* 已存在则忽略 */ }
  }
}

// Webhook 可用事件
const OAUTH_WEBHOOK_EVENTS = {
  'message.created': '已授权用户发送了新消息',
  'user.granted': '用户同意授权你的应用',
  'user.revoked': '用户撤销了对你的应用的授权',
  'ban.applied': '你在项目内封禁了某用户',
  'ban.request.reviewed': '你的全站封禁申请被审核',
};

// ================= Google 账号登录（配置 / 状态签名 / id_token 校验 / 账号关联）=================
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

// 允许回跳的前端域名白名单（防止被当成开放重定向）
const GOOGLE_REDIRECT_HOSTS = [
  'nflshcchat.cc.cd', 'www.nflshcchat.cc.cd',
  'chatai.bot.cd', 'www.chatai.bot.cd',
  'accounts.nflshcchat.cc.cd', 'platform.nflshcchat.cc.cd', 'home.nflshcchat.cc.cd',
  'nflshcfile.l.cd', 'file.nflshcchat.cc.cd',
  'localhost', '127.0.0.1',
];

function googleConfig(env) {
  const clientId = String((env && env.GOOGLE_CLIENT_ID) || '').trim();
  const clientSecret = String((env && env.GOOGLE_CLIENT_SECRET) || '').trim();
  return {
    clientId,
    clientSecret,
    enabled: !!(clientId && clientSecret),
    // 状态签名密钥：优先用独立的 GOOGLE_STATE_SECRET，否则复用 client_secret
    secret: String((env && env.GOOGLE_STATE_SECRET) || clientSecret || 'nflshc-google-state'),
  };
}

function googleSafeRedirect(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    if (!GOOGLE_REDIRECT_HOSTS.includes(u.hostname)) return null;
    return u.origin + u.pathname + u.search;
  } catch (e) {
    return null;
  }
}

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(s + '='.repeat((4 - s.length % 4) % 4))));
}

async function googleSignState(payload, secret) {
  const body = { ...payload, iat: Date.now() };
  const raw = b64urlEncode(JSON.stringify(body));
  const sig = await hmacSha256Hex(secret, raw);
  return raw + '.' + sig;
}
async function googleVerifyState(state, secret) {
  try {
    const [raw, sig] = String(state).split('.');
    if (!raw || !sig) return null;
    const expect = await hmacSha256Hex(secret, raw);
    if (expect !== sig) return null;
    const body = JSON.parse(b64urlDecode(raw));
    if (!body.iat || Date.now() - body.iat > 15 * 60 * 1000) return null;   // 15 分钟有效
    return body;
  } catch (e) {
    return null;
  }
}

// 校验 Google 的 id_token：RS256 签名（用 Google 公钥）+ aud/iss/exp
async function googleVerifyIdToken(idToken, clientId) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;
  let header, claims;
  try {
    header = JSON.parse(b64urlDecode(h64));
    claims = JSON.parse(b64urlDecode(p64));
  } catch (e) {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const jwksRes = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  const jwks = await jwksRes.json().catch(() => null);
  const jwk = jwks && jwks.keys ? jwks.keys.find(k => k.kid === header.kid) : null;
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(h64 + '.' + p64);
  const sig = Uint8Array.from(atob(s64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s64.length % 4) % 4)), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) return null;

  if (claims.aud !== clientId) return null;
  if (!GOOGLE_ISSUERS.includes(claims.iss)) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  if (!claims.sub || !claims.email) return null;
  return claims;
}

// 用 Google 资料定位账号：已绑定 → 邮箱匹配 → 新建
async function googleResolveUser(db, prof) {
  const email = String(prof.email || '').toLowerCase();
  const nowIso = new Date().toISOString();

  const ident = await db.prepare(`SELECT username FROM oauth_identities WHERE provider = 'google' AND subject = ?`)
    .bind(String(prof.sub)).first();
  if (ident) {
    const u = await db.prepare('SELECT username, raw_json, is_banned FROM users WHERE username = ?').bind(ident.username).first();
    if (u) {
      const payload = parsePayload(u.raw_json) || {};
      return {
        username: u.username, isNew: false,
        banned: u.is_banned === 1 || u.is_banned === true || !!payload.isBanned,
        frozen: !!payload.isFrozen,
        banReason: payload.banReason || payload.frozenReason || '',
      };
    }
  }

  // 邮箱匹配（之前用同一邮箱绑过 Google 的账号）
  const byMail = await db.prepare(`SELECT username FROM oauth_identities WHERE provider = 'google' AND email = ?`)
    .bind(email).first();
  let username = byMail ? byMail.username : null;

  // 再尝试：账号资料里填过同一邮箱（raw_json 里存 email）
  if (!username) {
    const row = await db.prepare(`SELECT username FROM users WHERE raw_json LIKE ? LIMIT 1`)
      .bind('%"' + email + '"%').first();
    if (row) username = row.username;
  }

  let isNew = false;
  if (!username) {
    // 用邮箱前缀生成用户名，必要时加后缀去重
    let base = email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'user';
    if (base.length < 3) base = base + 'user';
    username = base;
    for (let i = 0; i < 50; i++) {
      const exists = await db.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
      if (!exists) break;
      username = base + Math.floor(Math.random() * 9000 + 1000);
    }
    // 随机不可用密码（Google 账号不走密码登录；以后可在账号中心设置密码）
    const randomPwd = await sha256Hex('google:' + crypto.randomUUID());
    await upsertRow(db, 'users', username, {
      username,
      password: randomPwd,
      passwordHashed: true,
      email,
      isGoogle: true,
      isGoogleNew: true,
      name: prof.name || username,
      avatar: prof.picture || '',
      nickname: prof.name || username,
      registerSource: 'google',
      createdAt: nowIso,
    });
    isNew = true;
  }

  await db.prepare(`INSERT OR REPLACE INTO oauth_identities (provider, subject, username, email, created_at)
                    VALUES ('google', ?, ?, ?, ?)`)
    .bind(String(prof.sub), username, email, nowIso).run();

  const u = await db.prepare('SELECT username, raw_json, is_banned FROM users WHERE username = ?').bind(username).first();
  const payload = u ? (parsePayload(u.raw_json) || {}) : {};
  return {
    username, isNew,
    banned: u ? (u.is_banned === 1 || u.is_banned === true || !!payload.isBanned) : false,
    frozen: !!payload.isFrozen,
    banReason: payload.banReason || payload.frozenReason || '',
  };
}

// ================= 多设备会话（登录设备列表 / 一键下线）=================
const MAX_SESSIONS_PER_USER = 10;

// 从 UA 里猜一个人类可读的设备名（够用即可，不追求穷尽）
function describeDevice(ua) {
  const s = String(ua || '');
  let os = '未知系统';
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let br = '未知浏览器';
  if (/Edg\//.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) br = 'Opera';
  else if (/Chrome\//.test(s)) br = 'Chrome';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Safari\//.test(s)) br = 'Safari';
  else if (/curl/i.test(s)) br = '命令行';
  else if (/Electron/i.test(s)) br = '桌面版';
  return `${br} · ${os}`;
}

// 登记一个登录会话（同时清理过期会话、限制单用户会话数量）
async function createSession(db, { token, username, expiresAt, via, userAgent, ip }) {
  const nowIso = new Date().toISOString();
  const sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, '').slice(0, 16);
  await db.prepare(
    `INSERT INTO auth_tokens (token, username, created_at, expires_at, session_id, device_label, user_agent, ip, last_seen_at, via)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    token, username, nowIso, (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString(),
    sessionId, describeDevice(userAgent), String(userAgent || '').slice(0, 300), String(ip || ''), nowIso, via || 'password'
  ).run();

  // 清理该用户已过期的会话
  await db.prepare('DELETE FROM auth_tokens WHERE username = ? AND expires_at < ?')
    .bind(username, nowIso).run();

  // 超出上限时，删掉最久未活跃的会话
  const { results } = await db.prepare(
    'SELECT token, session_id FROM auth_tokens WHERE username = ? ORDER BY COALESCE(last_seen_at, created_at) DESC'
  ).bind(username).all();
  const rows = results || [];
  if (rows.length > MAX_SESSIONS_PER_USER) {
    for (const r of rows.slice(MAX_SESSIONS_PER_USER)) {
      await db.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(r.token).run();
    }
  }
  return sessionId;
}

// 更新会话活跃时间（5 分钟节流，避免每个请求都写库）
async function touchSession(db, token) {
  try {
    const row = await db.prepare('SELECT last_seen_at FROM auth_tokens WHERE token = ?').bind(token).first();
    if (!row) return;
    const last = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - last > 5 * 60 * 1000) {
      await db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token = ?')
        .bind(new Date().toISOString(), token).run();
    }
  } catch (e) { /* 忽略 */ }
}

async function hmacSha256Hex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ================= 健康看板指标 =================
// 记录运行事件（错误 / 慢请求 / 关键动作），供 /api/admin/health 汇总。
// 失败一律静默：指标不能影响主流程。
async function recordMetric(env, opts) {
  try {
    const db = env && env.DB;
    if (!db) return;
    const o = opts || {};
    let ip = '';
    try {
      ip = (o.request && o.request.headers.get('CF-Connecting-IP')) || '';
    } catch (e) { ip = ''; }
    await db.prepare(
      `INSERT INTO metrics_events (kind, name, detail, status, ms, username, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      String(o.kind || 'event').slice(0, 24),
      String(o.name || '').slice(0, 160),
      String(o.detail || '').slice(0, 500),
      Number(o.status) || 0,
      Number(o.ms) || 0,
      String(o.username || '').slice(0, 64),
      ip.slice(0, 64),
      new Date().toISOString()
    ).run();
  } catch (e) { /* 指标写入失败忽略 */ }
}

// 投递 Webhook（失败不影响主流程；记录最近一次状态便于开发者排查）
async function deliverWebhook(db, clientId, event, data, allClients) {
  try {
    const wh = await db.prepare('SELECT * FROM oauth_webhooks WHERE client_id = ? AND active = 1').bind(clientId).first();
    if (!wh || !wh.url) return;
    const events = parseJsonArr(wh.events);
    if (events.length > 0 && !events.includes(event) && !events.includes('*')) return;
    const body = JSON.stringify({
      event, client_id: clientId,
      sent_at: new Date().toISOString(),
      data: data || {},
    });
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'NFLSHC-Webhook/1.0 (+https://platform.nflshcchat.cc.cd)',
      'X-NFLSHC-Event': event,
      'X-NFLSHC-Client': clientId,
    };
    if (wh.secret) headers['X-NFLSHC-Signature'] = 'sha256=' + await hmacSha256Hex(wh.secret, body);
    const res = await fetch(wh.url, { method: 'POST', headers, body });
    await db.prepare('UPDATE oauth_webhooks SET last_status = ?, last_at = ?, last_error = ? WHERE client_id = ?')
      .bind(res.status, new Date().toISOString(), res.ok ? null : ('HTTP ' + res.status), clientId).run();
  } catch (e) {
    try {
      await db.prepare('UPDATE oauth_webhooks SET last_status = 0, last_at = ?, last_error = ? WHERE client_id = ?')
        .bind(new Date().toISOString(), String(e && e.message || e).slice(0, 200), clientId).run();
    } catch (e2) { /* 忽略 */ }
  }
}

// 向所有「已获得该用户授权」且订阅了该事件的应用投递事件
async function fanoutWebhookToAuthorizedApps(db, event, username, data) {
  try {
    const { results } = await db.prepare(
      `SELECT g.client_id FROM oauth_grants g
       JOIN oauth_webhooks w ON w.client_id = g.client_id AND w.active = 1
       WHERE g.username = ? AND g.revoked = 0`
    ).bind(username).all();
    for (const row of (results || [])) {
      await deliverWebhook(db, row.client_id, event, Object.assign({ user: username }, data || {}));
    }
  } catch (e) { /* 忽略 */ }
}

// OAuth 权限（scope）定义：开发者可申请，用户授权时可见
const OAUTH_SCOPES = {
  profile:  { name: '基本资料', desc: '用户名、头像、个人简介、等级经验、注册时间' },
  email:    { name: '邮箱地址', desc: '你的注册邮箱（隐私信息，请谨慎授权）', sensitive: true },
  rooms:    { name: '群聊列表', desc: '你已加入的群聊名称与类型' },
  friends:  { name: '好友列表', desc: '你的好友用户名列表' },
  messages: { name: '消息内容', desc: '你在公开群聊中发送的最近消息（隐私信息）', sensitive: true },
  stats:    { name: '统计信息', desc: '消息数量等使用统计（不含内容）' },
};

const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;            // 授权码 5 分钟
const OAUTH_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;      // 访问令牌 2 小时
const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 刷新令牌 30 天

function oauthRandom(prefix, len) {
  const bytes = new Uint8Array(len / 2);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseJsonArr(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// 校验回调地址：必须与应用登记的 redirect_uris 之一完全匹配（防开放重定向）
function matchRedirectUri(registered, candidate) {
  const list = parseJsonArr(registered);
  if (!candidate) return list.length === 1 ? list[0] : null;
  return list.includes(candidate) ? candidate : null;
}

// 校验申请权限：必须是已定义的 scope
function normalizeScopes(requested) {
  const arr = Array.isArray(requested) ? requested : String(requested || '').split(/[\s,]+/);
  return arr.map(s => String(s).trim()).filter(s => s && OAUTH_SCOPES[s]);
}

function oauthClientPublic(row) {
  if (!row) return null;
  return {
    clientId: row.client_id,
    name: row.name || '',
    description: row.description || '',
    homepage: row.homepage || '',
    logo: row.logo || '',
    redirectUris: parseJsonArr(row.redirect_uris),
    scopes: parseJsonArr(row.scopes),
    owner: row.owner || '',
    status: row.status || 'active',
    isBot: !!row.is_bot,
    botUsername: row.bot_username || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

// 封禁申请对外结构（统一 camelCase，与 API 文档一致）
function oauthBanRequestPublic(r) {
  if (!r) return null;
  return {
    id: r.id,
    clientId: r.client_id || '',
    clientName: r.client_name || '',
    clientOwner: r.client_owner || '',
    username: r.username || '',
    reason: r.reason || '',
    applicant: r.applicant || '',
    status: r.status || 'pending',
    createdAt: r.created_at || null,
    reviewedAt: r.reviewed_at || null,
    reviewer: r.reviewer || '',
    reviewNote: r.review_note || '',
  };
}

// 项目内封禁记录对外结构
function oauthProjectBanPublic(b) {
  if (!b) return null;
  return {
    username: b.username,
    reason: b.reason || '',
    bannedBy: b.banned_by || '',
    bannedAt: b.banned_at || null,
    active: !!b.active,
  };
}

// 开发者鉴权：Bearer <nflshcchat 用户 token>，返回 { username, isAdmin }
async function oauthRequireUser(request, db) {
  const auth = await authUser(request, db);
  if (!auth) return null;
  return auth;
}

async function isIpBanned(db, ip) {
  if (!ip) return false;
  try {
    const row = await db.prepare('SELECT ip FROM banned_ips WHERE ip = ?').bind(ip).first();
    return !!row;
  } catch (e) { return false; }
}

// 防恶意注册处罚：封禁该 IP + 冻结该 IP 注册的全部账号（is_banned+isFrozen 双标记）+ 通知系统管理员
async function punishMassRegistration(db, ip) {
  if (!ip) return;
  try {
    const nowIso = new Date().toISOString();
    // 1) 封禁 IP
    await db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason, banned_at) VALUES (?,?,?)')
      .bind(ip, '同一 IP 注册账号数达 ' + REGISTER_IP_LIMIT + ' 个（恶意注册）', nowIso).run();
    // 2) 冻结该 IP 注册的全部账号
    const { results } = await db.prepare('SELECT username FROM register_log WHERE ip = ?').bind(ip).all();
    const frozenUsers = [];
    for (const row of results || []) {
      const username = row.username;
      if (!username) continue;
      try {
        const u = await db.prepare('SELECT raw_json FROM users WHERE username = ?').bind(username).first();
        const payload = u ? parsePayload(u.raw_json) : {};
        await db.prepare('UPDATE users SET is_banned = 1 WHERE username = ?').bind(username).run();
        await db.prepare(`UPDATE users SET raw_json = ? WHERE username = ?`).bind(
          '```json\n' + JSON.stringify({ ...payload, isBanned: true, isFrozen: true, frozenReason: '同 IP 批量注册' }) + '\n```', username).run();
        // 作废该用户所有 token，使其立即掉线
        await db.prepare('DELETE FROM auth_tokens WHERE username = ?').bind(username).run();
        frozenUsers.push(username);
      } catch (e) { /* 单个账号冻结失败不影响其他 */ }
    }
    // 3) 通知系统管理员
    await notifyAdmin(db, '🚨 检测到恶意批量注册',
      'IP ' + ip + ' 注册账号数达 ' + REGISTER_IP_LIMIT + ' 个，已封禁该 IP 并冻结以下账号：' +
      (frozenUsers.join('、') || '（无）') + '，请到管理后台处理。');
  } catch (e) { /* 处罚失败不影响注册主流程 */ }
}

// 登录失败记录：用户键 + IP 键分别计数
async function recordLoginFailure(db, username, clientIp) {
  const nowIso = new Date().toISOString();
  for (const key of ['user:' + username, clientIp ? ('ip:' + clientIp) : null]) {
    if (!key) continue;
    const row = await db.prepare('SELECT fail_count FROM login_security WHERE key = ?').bind(key).first();
    const next = (row ? (row.fail_count || 0) : 0) + 1;
    if (row) {
      await db.prepare('UPDATE login_security SET fail_count = ?, updated_at = ? WHERE key = ?').bind(next, nowIso, key).run();
    } else {
      await db.prepare('INSERT INTO login_security (key, fail_count, updated_at) VALUES (?,?,?)').bind(key, next, nowIso).run();
    }
    // IP 达到 50 次直接封禁（不锁 IP，避免共享 IP 误伤）
    if (key.startsWith('ip:') && next >= LOGIN_FREEZE_THRESHOLD) {
      const ip = key.slice(3);
      await db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason, banned_at) VALUES (?,?,?)')
        .bind(ip, '登录失败达 50 次', nowIso).run();
    }
  }
}

// 向系统管理员（huangzhiyuan）发送站内通知
async function notifyAdmin(db, title, content) {
  try {
    const id = 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await db.prepare(
      `INSERT OR REPLACE INTO notifications (id, type, title, content, target_user, sender, sent_at, is_read, raw_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(id, 'security', title, content, 'huangzhiyuan', 'system', new Date().toISOString(), 0,
      JSON.stringify({ id, type: 'security', title, content, target_user: 'huangzhiyuan', targetUser: 'huangzhiyuan', sender: 'system', sent_at: new Date().toISOString(), sentAt: new Date().toISOString(), is_read: 0, isRead: false })).run();
  } catch (e) { /* 通知失败不影响主流程 */ }
}

// 邮箱脱敏显示：test@example.com -> t***@example.com
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  if (name.length <= 1) return name + '***@' + domain;
  return name[0] + '***@' + domain;
}

// 从 Authorization: Bearer <token> 中取出 token
function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 校验 token，返回 { username, isAdmin }（无效/过期返回 null）
async function authUser(request, db) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const row = await db.prepare('SELECT username, expires_at FROM auth_tokens WHERE token = ?').bind(token).first();
    if (!row) return null;
    if (row.expires_at) {
      const exp = new Date(row.expires_at).getTime();
      if (isNaN(exp) || exp < Date.now()) return null;
    }
    // 记录会话活跃时间（5 分钟节流），供"登录设备"页面展示
    await touchSession(db, token);
    // 管理员判定与全站前端一致：仅 huangzhiyuan
    return { username: row.username, isAdmin: isAdminUser(row.username) };
  } catch (e) { return null; }
}

// 系统管理员判定（与各前端 isSystemAdmin 一致）
function isAdminUser(username) {
  return username === 'huangzhiyuan';
}

// 消息撤回时间窗（与前端 recallMessage 一致）：2 分钟
const RECALL_WINDOW_MS = 2 * 60 * 1000;

function parseJsonArraySafe(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch (e) { return []; } }
  return [];
}

// 行级写权限（PATCH/UPDATE/DELETE 通用）：
// 管理员（huangzhiyuan）全通过；其余按表规则校验归属。
// row: D1 行（含列），payload: 本次请求/合并后的业务对象，label: 请求标签
function canWriteRow(table, row, payload, label, auth) {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  if (table === 'notices' || table === 'broadcasts') return false; // 公告/广播仅管理员
  if (table === 'users') return false; // 非管理员不能改他人账号（本人改密在调用处单独校验）
  const merged = Object.assign({}, row || {}, payload || {});
  if (table === 'messages') {
    // 非管理员仅发送者可操作（是否在撤回时间窗内由消息专用函数校验）
    return !!merged.sender && merged.sender === auth.username;
  }
  if (table === 'rooms') {
    // 群主/群管理员可管理；普通成员可改（用于加入/退出时更新 members）
    const admins = parseJsonArraySafe(merged.admins);
    const members = parseJsonArraySafe(merged.members);
    return merged.creator === auth.username || admins.includes(auth.username) || members.includes(auth.username);
  }
  if (table === 'friends') {
    return merged.user1 === auth.username || merged.user2 === auth.username;
  }
  if (table === 'hzyai_conversations' || table === 'hzyai_gen') {
    return merged.user === auth.username || merged.username === auth.username;
  }
  if (table === 'notifications') {
    return merged.target_user === auth.username || merged.targetUser === auth.username || merged.sender === auth.username;
  }
  if (label && (label.startsWith('calendar_') || label.startsWith('image_'))) {
    const owner = label.slice(label.indexOf('_') + 1);
    return owner === auth.username;
  }
  const owner = merged.author || merged.creator || merged.reporter || merged.user || merged.sender || merged.username;
  return !!owner && owner === auth.username;
}

// hzyai 共享/公开标签的固定用户名（发布者可为任意登录用户）
const HZYAI_SHARED_USERS = ['share_chat', 'public_character', 'public_chat', 'character', 'task', 'chat'];

// ================= 群相册（label: roomgallery_<roomId>）=================
// 复用 misc_issues 表存储（与 image_<user> 图床同一套机制），但权限按“群成员”判定，
// 而不是按用户名：群成员可查看/上传，上传者本人、群主/群管理员、系统管理员可删除。
function parseRoomGalleryLabel(label) {
  if (!label || !label.startsWith('roomgallery_')) return null;
  const roomId = label.slice('roomgallery_'.length);
  return roomId || null;
}

async function loadRoomForGallery(db, label) {
  const roomId = parseRoomGalleryLabel(label);
  if (!roomId) return null;
  try {
    return await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first();
  } catch (e) { return null; }
}

// 群成员 / 群管理员 / 群主 / 系统管理员
function isRoomMemberOrAdmin(room, auth) {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  if (!room) return false;
  const members = parseJsonArraySafe(room.members);
  const admins = parseJsonArraySafe(room.admins);
  return room.creator === auth.username || admins.includes(auth.username) || members.includes(auth.username);
}

// 群管理员及以上（群主 / 群管理员 / 系统管理员）
function isRoomAdmin(room, auth) {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  if (!room) return false;
  const admins = parseJsonArraySafe(room.admins);
  return room.creator === auth.username || admins.includes(auth.username);
}

// hzyai 写入校验：个人标签（hzyai_<用户名>）必须是本人；共享/公开标签任意登录用户可写
function canWriteHzLabel(label, auth) {
  if (!auth || auth.isAdmin) return true;
  const u = parseHzUser(label);
  if (!u) return true;
  if (HZYAI_SHARED_USERS.includes(u)) return true;
  return u === auth.username;
}

// 消息删除/撤回权限：管理员任意；发送者仅在 2 分钟时间窗内
function canRecallMessage(row, auth) {
  if (!auth) return false;
  if (auth.isAdmin) return true;
  if (!row || row.sender !== auth.username) return false;
  const ts = row.timestamp || row.sent_at;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) <= RECALL_WINDOW_MS;
}

// 消息 PATCH 字段白名单：非管理员只能改这几个字段，防止篡改内容/发送者等
// （与前端一致：表情回应 reactions / 撤回 is_recalled / 置顶 is_pinned；
//  注意 withAliases 会把 snake/camel 两种写法都带上，白名单需同时收录）
const MESSAGE_PATCH_ALLOWED = ['reactions', 'is_recalled', 'isRecalled', 'is_pinned', 'isPinned'];

function jsonForbidden() {
  return json({ ok: false, error: 'forbidden: 无权限执行该操作' }, 403, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });
}

// 包裹成前端期望的 ```json 围栏
function fence(s) {
  return '```json\n' + s + '\n```';
}

// 安全解析 raw_json：可能是纯 JSON，也可能被历史代码包成了 ```json 围栏
function parsePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw || typeof raw !== 'string') return {};
  let s = raw.trim();
  // 兼容 ```json / ``` 围栏，兼容 \r\n 与缺失换行。
  // 关键修复：围栏内 JSON 的字符串值可能本身包含 ```（如 AI 回复里的代码块，
  // 形如 "...\n```python\n...\n```..."，其中 \n 是转义字符），
  // 旧的 /```(?:json)?\s*([\s\S]*?)\s*```/ 会在第一个 ```（代码块围栏）处截断，
  // 导致整条对话/生成历史被解析成 {} 或残缺 JSON 后入库。这里改为：
  // 取第一个 ```json 之后、最后一个 ``` 之前的内容（body 中 JSON 总是写在末尾）。
  const openIdx = s.indexOf('```json');
  if (openIdx !== -1) {
    const afterOpen = s.indexOf('\n', openIdx);
    const contentStart = afterOpen === -1 ? openIdx + 7 : afterOpen + 1;
    const closeIdx = s.lastIndexOf('```');
    if (closeIdx > contentStart) s = s.slice(contentStart, closeIdx).trim();
  } else {
    // 无围栏：截取第一个 { 到最后一个 } 之间的内容
    const a = s.indexOf('{'), z = s.lastIndexOf('}');
    if (a !== -1 && z > a) s = s.slice(a, z + 1);
  }
  try {
    const v = JSON.parse(s);
    // 历史 bug 会产生双重编码（JSON.parse 后仍是字符串），这里再解一层
    if (typeof v === 'string') {
      try { return JSON.parse(v) || {}; } catch (e) { return {}; }
    }
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

// 关键：历史数据用 camelCase（roomId/hasMentionAll/replyTo），新数据用 snake_case。
// 这里统一补齐两种写法，任何前端读法都能取到值。
const KEY_ALIASES = [
  ['room_id', 'roomId'],
  ['has_mention_all', 'hasMentionAll'],
  ['reply_to', 'replyTo'],
  ['is_recalled', 'isRecalled'],
  ['is_pinned', 'isPinned'],
  ['is_voice', 'isVoice'],
  ['voice_data', 'voiceData'],
  ['voice_duration', 'voiceDuration'],
  ['message_id', 'messageId'],
  ['target_user', 'targetUser'],
  ['is_read', 'isRead'],
  ['sent_at', 'sentAt'],
  ['created_at', 'createdAt'],
  ['updated_at', 'updatedAt'],
  ['password_hashed', 'passwordHashed'],
];

function withAliases(obj) {
  const o = { ...obj };
  for (const [snake, camel] of KEY_ALIASES) {
    if (o[snake] === undefined && o[camel] !== undefined) o[snake] = o[camel];
    if (o[camel] === undefined && o[snake] !== undefined) o[camel] = o[snake];
  }
  return o;
}

// 把 D1 行还原成前端 payload：以 raw_json 为主，用真实列补齐缺失字段
// users 表的封禁/冻结状态以数据库列为权威值。
// 历史原因：管理员封禁时只写了 is_banned 列，raw_json 里仍是旧值（isBanned:false），
// 而 raw_json 优先的合并策略会让前端显示成「未封禁」→ 管理后台看不到解封按钮。
// 这里统一用列值覆盖，保证前后端一致。
function applyAuthoritativeUserFlags(row, out) {
  if (!row || row.is_banned === undefined || row.is_banned === null) return out;
  const banned = !!Number(row.is_banned);
  out.isBanned = banned;
  out.is_banned = banned;
  if (!banned) {
    // 已解封：清掉残留的封禁原因，避免界面继续显示「封禁理由」
    delete out.banReason;
    delete out.frozenReason;
  }
  return out;
}

function mergedPayload(row) {
  const payload = parsePayload(row.raw_json);
  const out = { ...row };
  delete out.raw_json;
  delete out.migrated_from_issue;
  // raw_json 里的值优先（它是前端写入时的完整对象）
  for (const k of Object.keys(payload)) {
    if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  }
  // 例外：封禁状态以列为准
  applyAuthoritativeUserFlags(row, out);
  return JSON.stringify(withAliases(out));
}

// 按 id 反查记录属于哪张表（用于前端未携带 labels 的 PATCH/DELETE）。
// 顺序很重要：优先匹配业务表，最后才是 misc_issues 兜底。
// hzyai_conversations / hzyai_gen 的 PATCH（前端更新对话/生成历史时通常不带 labels）
// 也必须能反查出来，否则对话更新永远无法写入 D1。
const ID_LOOKUP_TABLES = [
  'messages', 'rooms', 'notifications', 'favorites', 'notices', 'broadcasts',
  'reports', 'suggestions', 'posts', 'polls', 'articles', 'friends',
  'hzyai_conversations', 'hzyai_gen', 'misc_issues',
];

async function findTableById(db, id) {
  for (const t of ID_LOOKUP_TABLES) {
    try {
      const row = await db.prepare(`SELECT id FROM ${t} WHERE id = ? LIMIT 1`).bind(id).first();
      if (row) return t;
      if (!isNaN(Number(id))) {
        const row2 = await db.prepare(`SELECT id FROM ${t} WHERE id = ? LIMIT 1`).bind(Number(id)).first();
        if (row2) return t;
      }
    } catch (e) { /* 表不存在或无 id 列，跳过 */ }
  }
  // users 表主键是 username
  try {
    const u = await db.prepare(`SELECT username FROM users WHERE username = ? LIMIT 1`).bind(id).first();
    if (u) return 'users';
  } catch (e) { /* ignore */ }
  return null;
}

// 去掉内部元数据列，只保留业务字段
function stripMeta(row) {
  const o = { ...row };
  delete o.raw_json;
  delete o.migrated_from_issue;
  for (const k of Object.keys(o)) {
    if (o[k] === null || o[k] === undefined) delete o[k];
  }
  return o;
}

// 直读表行 -> 前端对象：展开 raw_json、解析 JSON 列、补齐 camelCase 别名
function hydrateRow(row) {
  const payload = parsePayload(row.raw_json);
  const out = { ...stripMeta(row) };
  for (const k of Object.keys(payload)) {
    if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  }
  // mentions/members/admins/options/votes/history 在库里是 JSON 字符串
  for (const c of ['mentions','members','admins','options','votes','history']) {
    if (typeof out[c] === 'string') {
      try { out[c] = JSON.parse(out[c]); } catch (e) { /* 保持原样 */ }
    }
  }
  for (const c of ['has_mention_all','is_recalled','is_pinned','is_read','is_banned']) {
    if (out[c] !== undefined) out[c] = !!Number(out[c]);
  }
  // 封禁状态以列为准（同 mergedPayload）
  applyAuthoritativeUserFlags(row, out);
  return withAliases(out);
}

// 每张表的真实列（与 D1 schema 严格一致），用于只写存在的列
const TABLE_COLUMNS = {
  users: ['username','email','password','password_hashed','bio','avatar','is_banned','created_at'],
  rooms: ['id','name','type','creator','members','admins','join_type','verify_code','announcement','is_banned','created_at'],
  friends: ['id','user1','user2','created_at'],
  messages: ['id','room_id','sender','content','mentions','has_mention_all','reply_to','is_recalled','is_pinned','timestamp'],
  notices: ['id','title','content','author','created_at'],
  broadcasts: ['id','title','content','created_by','created_at'],
  reports: ['id','reporter','target_user','reason','description','evidence','status','created_at','resolved_at','resolved_by','admin_note','issue_number'],
  notifications: ['id','type','title','content','target_user','sender','room_id','sent_at','is_read'],
  favorites: ['id','message_id','room_id','sender','content','user','created_at'],
  suggestions: ['id','title','content','author','status','created_at','updated_at','admin_note','issue_number'],
  music_history: ['id','username','history'],
  articles: ['id','title','content'],
  posts: ['id','title','content','author','category','created_at'],
  polls: ['id','title','content','author','options','votes','created_at'],
};

// JSON 数组/对象类型的列，写库时需序列化
const JSON_COLUMNS = new Set(['mentions','members','admins','options','votes','history']);
// 布尔语义列，写库时转 0/1
const BOOL_COLUMNS = new Set(['has_mention_all','is_recalled','is_pinned','is_read','is_banned','password_hashed']);

// 按真实列结构 upsert，并把完整 payload 存进 raw_json
async function upsertRow(db, table, id, payloadRaw) {
  const payload = withAliases(payloadRaw || {});
  // users：封禁别名字段强制同步，避免 raw_json 里出现 isBanned:false 与 is_banned:1 并存
  // （曾导致管理后台读 raw_json 显示「未封禁」，与数据库列不一致）
  if (table === 'users') {
    let b;
    if (payload.is_banned !== undefined && payload.is_banned !== null) b = !!Number(payload.is_banned);
    else if (payload.isBanned !== undefined) b = !!payload.isBanned;
    if (b !== undefined) { payload.isBanned = b; payload.is_banned = b ? 1 : 0; }
  }
  const cols = TABLE_COLUMNS[table];
  if (!cols) {
    // 未知表：退化为最小写入
    await db.prepare(`INSERT OR REPLACE INTO ${table} (id, raw_json) VALUES (?, ?)`)
      .bind(id, JSON.stringify(payload)).run();
    return;
  }

  // music_history.id 是 INTEGER AUTOINCREMENT，不能塞入字符串 id
  const idIsAuto = (table === 'music_history');
  const names = [];
  const values = [];
  for (const c of cols) {
    let v = payload[c];
    if (c === 'id') {
      if (idIsAuto) { if (v === undefined || v === null || isNaN(Number(v))) continue; v = Number(v); }
      else v = id;
    }
    if (c === 'username' && v === undefined) v = payload.username || null;
    if (v === undefined) continue;
    if (JSON_COLUMNS.has(c) && typeof v !== 'string') v = JSON.stringify(v || []);
    else if (BOOL_COLUMNS.has(c)) v = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
    names.push(c);
    values.push(v);
  }

  // 时间戳兜底：只在该表确有此列且 payload 未提供时补
  const nowIso = new Date().toISOString();
  for (const tcol of ['created_at', 'timestamp', 'sent_at']) {
    if (cols.includes(tcol) && !names.includes(tcol)) {
      names.push(tcol);
      values.push(nowIso);
    }
  }
  if (cols.includes('updated_at') && !names.includes('updated_at')) {
    names.push('updated_at');
    values.push(nowIso);
  }
  // 主键兜底（messages/favorites 等以 id 为主键）
  if (cols.includes('id') && !names.includes('id') && !idIsAuto) {
    names.push('id');
    values.push(id);
  }
  // users 表主键是 username
  if (table === 'users' && !names.includes('username')) {
    names.push('username');
    values.push(id);
  }

  names.push('raw_json');
  values.push(JSON.stringify(payload));

  const placeholders = names.map(() => '?').join(',');
  await db.prepare(
    `INSERT OR REPLACE INTO ${table} (${names.join(',')}) VALUES (${placeholders})`
  ).bind(...values).run();
}

function labelToTable(label) {
  const map = {
    chatmessage: 'messages',
    chatroom: 'rooms',
    user: 'users',
    users: 'users',
    friend: 'friends',
    friends: 'friends',
    friend_request: 'friends',
    notice: 'notices',
    notices: 'notices',
    report: 'reports',
    reports: 'reports',
    nflshc_report: 'reports',
    suggestion: 'suggestions',
    suggestions: 'suggestions',
    favorite: 'favorites',
    favorites: 'favorites',
    music: 'music_history',
    music_history: 'music_history',
    article: 'articles',
    articles: 'articles',
    post: 'posts',
    posts: 'posts',
    poll: 'polls',
    polls: 'polls',
    hzyai: 'hzyai_conversations',
    hzyai_conversations: 'hzyai_conversations',
    hzyai_public_chat: 'hzyai_conversations',
    hzyai_public_character: 'hzyai_conversations',
    hzyai_chat: 'hzyai_conversations',
    hzyai_character: 'hzyai_conversations',
    hzyai_task: 'hzyai_conversations',
    system: 'misc_issues',
    system_notification: 'notifications',
    notification: 'notifications',
    notifications: 'notifications',
    broadcast: 'broadcasts',
    broadcasts: 'broadcasts',
    calendar: 'misc_issues',
    image: 'misc_issues',
  };
  if (map[label]) return map[label];
  // prefix fallbacks for hzyai_* / calendar_* / image_*
  if (label && label.startsWith('hzyai_')) {
    // hzyai_<user>_gen 存到独立的 hzyai_gen 表，与普通对话隔离
    if (label.endsWith('_gen')) return 'hzyai_gen';
    return 'hzyai_conversations';
  }
  if (label && (label.startsWith('calendar_') || label.startsWith('image_'))) return 'misc_issues';
  // 群相册：roomgallery_<roomId> 同样落在 misc_issues（权限在端点内按群成员判定）
  if (label && label.startsWith('roomgallery_')) return 'misc_issues';
  return null;
}

// 从 label 解析出用户名：hzyai_<user> 或 hzyai_<user>_gen -> <user>
function parseHzUser(label) {
  if (!label || !label.startsWith('hzyai_')) return null;
  let rest = label.slice('hzyai_'.length);
  if (rest.endsWith('_gen')) rest = rest.slice(0, -('_gen'.length));
  return rest;
}

// 确保 hzyai 表结构完整（用户隔离 + 时间戳列）。列已存在时会报错，忽略即可。
// 注意：hzyai_gen 表在原始 schema 中不存在，这里先建表再补列。
let __hzMigrated = false;
async function ensureHzColumns(db) {
  if (__hzMigrated) return;
  __hzMigrated = true; // 先置位，避免并发请求重复执行
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS hzyai_gen (
         id TEXT PRIMARY KEY, category TEXT, owner TEXT, title TEXT,
         raw_json TEXT, migrated_from_issue INTEGER,
         user TEXT, type TEXT, created_at TEXT, updated_at TEXT)`
    ).run();
  } catch (e) { /* 忽略 */ }
  for (const table of ['hzyai_conversations', 'hzyai_gen']) {
    for (const col of ['user', 'type', 'created_at', 'updated_at']) {
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT;`).run();
      } catch (e) { /* 列已存在 */ }
    }
  }
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 关键：禁止浏览器/CDN 缓存 API 响应，否则数据库更新后前端读到旧数据
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...cors,
    },
  });
}
