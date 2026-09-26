// 验证本轮新增的后端能力：会话管理 / 扫码登录 / 账号导出与注销 / 健康看板 / 会议 / 附件SSO上传
// 用法: node test-new-features.mjs
const API = 'https://worker.nflshcchat.cc.cd';
const uname = 't_' + Math.random().toString(36).slice(2, 8);
const pwd = 'Test12345';
let token = '';

const sha256hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

const call = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.json) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, {
    method: opts.method || (opts.json || opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json: j, text };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + '  ' + extra); }
};

// ---------- 0) 建测试账号 ----------
console.log('\n[0] 建测试账号 ' + uname);
{
  const pwHash = await sha256hex(pwd);
  const r = await call('/api/legacy/issues?labels=users', {
    json: {
      labels: ['users'],
      body: '```json\n' + JSON.stringify({ username: uname, password: pwHash, passwordHashed: true, nickname: uname, isAdmin: false }) + '\n```',
    },
  });
  check('注册', r.status === 200 && r.json && r.json.ok !== false, JSON.stringify(r.json).slice(0, 120));
  const lg = await call('/api/auth/login', { json: { username: uname, password: pwHash } });
  check('登录', lg.status === 200 && lg.json && lg.json.token, 'HTTP ' + lg.status);
  token = (lg.json && lg.json.token) || '';
  if (!token) { console.log('无法继续，退出'); process.exit(1); }
}

// ---------- 1) 设备会话 ----------
console.log('\n[1] 登录设备列表 / 一键下线');
let mySid = '';
{
  const r = await call('/api/auth/sessions');
  check('GET /api/auth/sessions', r.status === 200 && r.json && Array.isArray(r.json.sessions), 'HTTP ' + r.status);
  const list = (r.json && r.json.sessions) || [];
  check('至少 1 个会话', list.length >= 1, 'count=' + list.length);
  mySid = (list[0] && list[0].sessionId) || (list[0] && list[0].session_id) || '';
  if (list[0]) console.log('     设备: ' + JSON.stringify(list[0]).slice(0, 220));
  const r2 = await call('/api/auth/sessions/revoke-others', { json: {} });
  check('POST revoke-others', r2.status === 200 && r2.json && r2.json.ok !== false, JSON.stringify(r2.json).slice(0, 120));
}

// ---------- 2) 扫码登录 ----------
console.log('\n[2] 扫码登录');
let qrId = '', qrSecret = '';
{
  const r = await call('/api/auth/qr/create', { json: {} });
  check('POST /api/auth/qr/create', r.status === 201 && r.json && r.json.id && r.json.secret, JSON.stringify(r.json).slice(0, 160));
  qrId = (r.json && r.json.id) || '';
  qrSecret = (r.json && r.json.secret) || '';
  const r2 = await call('/api/auth/qr/info?id=' + encodeURIComponent(qrId));
  check('GET /api/auth/qr/info', r2.status === 200 && r2.json && r2.json.ok !== false, JSON.stringify(r2.json).slice(0, 160));
  const r3 = await call('/api/auth/qr/poll', { json: { id: qrId, secret: qrSecret } });
  check('POST /api/auth/qr/poll (未确认 → pending)', r3.status === 200 && r3.json && r3.json.status === 'pending', JSON.stringify(r3.json).slice(0, 120));
  const r3b = await call('/api/auth/qr/poll', { json: { id: qrId, secret: 'wrong-secret' } });
  check('错误 secret 被拒', r3b.status === 401, 'HTTP ' + r3b.status);
  if (qrId) {
    const r4 = await call('/api/auth/qr/confirm', { json: { id: qrId } });
    check('POST /api/auth/qr/confirm（手机已登录）', r4.status === 200 && r4.json && r4.json.ok !== false, JSON.stringify(r4.json).slice(0, 160));
    const r5 = await call('/api/auth/qr/poll', { json: { id: qrId, secret: qrSecret } });
    const gotToken = !!(r5.json && r5.json.token);
    check('轮询取到 token（一次性）', gotToken, JSON.stringify(r5.json).slice(0, 140));
    const r5b = await call('/api/auth/qr/poll', { json: { id: qrId, secret: qrSecret } });
    check('token 只能用一次', r5b.status === 401, 'HTTP ' + r5b.status);
    const r6 = await call('/api/auth/qr/cancel', { json: { id: qrId, secret: qrSecret } });
    check('POST /api/auth/qr/cancel', r6.status === 200, 'HTTP ' + r6.status);
  }
}

// ---------- 3) 数据导出 / 注销 ----------
console.log('\n[3] 数据导出与注销（GDPR）');
{
  const r = await call('/api/account/status');
  check('GET /api/account/status', r.status === 200 && r.json && r.json.ok !== false, JSON.stringify(r.json).slice(0, 140));
  const e = await call('/api/account/export');
  const hasPayload = e.status === 200 && e.json && (e.json.data || e.json.export || e.json.user || e.json.ok !== false);
  check('GET /api/account/export', hasPayload, 'HTTP ' + e.status + ' size=' + e.text.length);
  console.log('     导出字段: ' + Object.keys((e.json && (e.json.data || e.json.export || e.json)) || {}).join(', ').slice(0, 200));
}

// ---------- 4) 管理员健康看板权限 ----------
console.log('\n[4] 健康看板（非管理员应 403）');
{
  const r = await call('/api/admin/health');
  check('非管理员访问被拒', r.status === 403, 'HTTP ' + r.status);
}

// ---------- 5) 会议 ----------
console.log('\n[5] 会议（快速会议 / 编号 / 会中聊天 / 列表）');
let meetingId = '', meetingCode = '';
{
  const r = await call('/api/meeting/create', { json: { title: '冒烟测试会议', kind: 'instant', invitees: [] } });
  check('POST /api/meeting/create', r.status === 201 && r.json && r.json.meeting && r.json.meeting.code,
    JSON.stringify(r.json).slice(0, 200));
  meetingId = (r.json && r.json.meeting && r.json.meeting.id) || '';
  meetingCode = (r.json && r.json.meeting && r.json.meeting.code) || '';

  const l = await call('/api/meeting/list');
  check('GET /api/meeting/list', l.status === 200 && l.json && Array.isArray(l.json.meetings), 'count=' + ((l.json && l.json.meetings || []).length));

  const s = await call('/api/meeting/create', {
    json: { title: '预定会议', kind: 'scheduled', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), durationMin: 30, invitees: [] },
  });
  check('预定会议', s.status === 201 && s.json && s.json.meeting && s.json.meeting.status === 'scheduled',
    JSON.stringify(s.json).slice(0, 160));

  const c = await call('/api/meeting/chat', { json: { meetingId, content: '会议内聊天测试' } });
  check('发送会中消息', c.status === 201 && c.json && c.json.ok !== false, JSON.stringify(c.json).slice(0, 120));
  const cg = await call('/api/meeting/chat?meetingId=' + encodeURIComponent(meetingId));
  check('拉取会中消息', cg.status === 200 && cg.json && (cg.json.messages || []).length >= 1,
    'count=' + ((cg.json && cg.json.messages || []).length));

  const j = await call('/api/meeting/join', { json: { code: meetingCode } });
  check('用会议编号加入', j.status === 200 && j.json && j.json.ok !== false, JSON.stringify(j.json).slice(0, 140));

  const d = await call('/api/meeting/detail?id=' + encodeURIComponent(meetingId));
  check('GET /api/meeting/detail', d.status === 200 && d.json && Array.isArray(d.json.members), 'members=' + ((d.json && d.json.members || []).length));

  const sig = await call('/api/meeting/signal', { json: { meetingId, to: '', kind: 'ice', payload: { candidate: 'x' } } });
  check('发送信令', sig.status === 201, 'HTTP ' + sig.status);
  const sigGet = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(meetingId) + '&since=0');
  check('拉取信令', sigGet.status === 200 && sigGet.json && (sigGet.json.signals || []).length >= 1,
    'count=' + ((sigGet.json && sigGet.json.signals || []).length));

  const en = await call('/api/meeting/end', { json: { meetingId } });
  check('结束会议（主持人）', en.status === 200 && en.json && en.json.ok !== false, JSON.stringify(en.json).slice(0, 120));
}

// ---------- 6) 附件 SSO 上传到文件托管 ----------
console.log('\n[6] 消息附件 → 文件托管（Worker 中转 SSO）');
{
  const fd = new FormData();
  const content = 'NFLSHC 附件通道测试 ' + new Date().toISOString();
  fd.append('file', new Blob([content], { type: 'text/plain' }), 'attach-test.txt');
  fd.append('title', '附件通道测试');
  fd.append('visibility', 'public');
  const r = await call('/api/files/upload', { method: 'POST', body: fd });
  check('POST /api/files/upload', r.status === 200 && r.json && r.json.ok, 'HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 240));
  if (r.json && r.json.url) console.log('     文件地址: ' + r.json.url);
}

// ---------- 7) 注销账号（清理测试数据）----------
console.log('\n[7] 注销账号流程');
{
  const r = await call('/api/account/delete', { json: { reason: '自动化测试清理', confirm: uname } });
  check('POST /api/account/delete', r.status === 200 || r.status === 202, 'HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  const st = await call('/api/account/status');
  console.log('     注销状态: ' + JSON.stringify(st.json).slice(0, 200));
  const cx = await call('/api/account/delete/cancel', { json: {} });
  check('撤销注销申请', cx.status === 200 && cx.json && cx.json.ok !== false, JSON.stringify(cx.json).slice(0, 120));
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
