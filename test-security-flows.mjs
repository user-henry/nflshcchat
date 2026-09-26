// 安全流程回归：多设备会话吊销是否真的失效、扫码签发的 token 是否可用、导出/注销状态
// 用法: node test-security-flows.mjs
const API = 'https://worker.nflshcchat.cc.cd';
const uname = 't_' + Math.random().toString(36).slice(2, 8);
const pwd = 'Test12345';

const sha256hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};
const call = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  const tk = opts.token;
  if (tk) headers.Authorization = 'Bearer ' + tk;
  if (opts.json) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, {
    method: opts.method || (opts.json || opts.body ? 'POST' : 'GET'),
    headers, body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json: j, text };
};

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅ ' + n + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + n + '  ' + extra); } };

console.log('\n[1] 建账号并模拟两台设备登录');
const pwHash = await sha256hex(pwd);
await call('/api/legacy/issues?labels=users', {
  json: { labels: ['users'], body: '```json\n' + JSON.stringify({ username: uname, password: pwHash, passwordHashed: true, nickname: uname }) + '\n```' },
});
const A = await call('/api/auth/login', { json: { username: uname, password: pwHash } });
const B = await call('/api/auth/login', { json: { username: uname, password: pwHash } });
const tokA = A.json && A.json.token;
const tokB = B.json && B.json.token;
check('设备 A 登录', !!tokA);
check('设备 B 登录', !!tokB);
check('A、B 是两个不同会话', tokA !== tokB);

console.log('\n[2] 两个 token 都能访问接口');
check('A 可用', (await call('/api/auth/me', { token: tokA })).status === 200);
check('B 可用', (await call('/api/auth/me', { token: tokB })).status === 200);

console.log('\n[3] 会话列表与一键下线其他设备');
const s1 = await call('/api/auth/sessions', { token: tokA });
const list = (s1.json && s1.json.sessions) || [];
check('会话数为 2', list.length === 2, 'count=' + list.length);
check('恰好一个标记为当前设备', list.filter(s => s.current).length === 1);
const ro = await call('/api/auth/sessions/revoke-others', { token: tokA, json: {} });
check('revoke-others 调用成功', ro.status === 200 && ro.json && ro.json.ok !== false, JSON.stringify(ro.json).slice(0, 120));
const afterA = await call('/api/auth/me', { token: tokA });
const afterB = await call('/api/auth/me', { token: tokB });
check('当前设备 A 仍可用', afterA.status === 200, 'HTTP ' + afterA.status);
check('被下线设备 B 立即失效（401）', afterB.status === 401, 'HTTP ' + afterB.status);
const s2 = await call('/api/auth/sessions', { token: tokA });
check('会话列表只剩 1 个', ((s2.json && s2.json.sessions) || []).length === 1);

console.log('\n[4] 扫码登录：签发的新 token 必须真的能用');
const qr = await call('/api/auth/qr/create', { json: {} });
const qid = qr.json && qr.json.id, qsecret = qr.json && qr.json.secret;
check('创建二维码', !!qid && !!qsecret);
check('未确认时轮询返回 pending', (await call('/api/auth/qr/poll', { json: { id: qid, secret: qsecret } })).json.status === 'pending');
const cf = await call('/api/auth/qr/confirm', { token: tokA, json: { id: qid } });
check('手机端确认', cf.status === 200 && cf.json.ok !== false);
const polled = await call('/api/auth/qr/poll', { json: { id: qid, secret: qsecret } });
const tokQ = polled.json && polled.json.token;
check('轮询拿到 token', !!tokQ);
const meQ = await call('/api/auth/me', { token: tokQ });
check('扫码 token 可用（/api/auth/me 200）', meQ.status === 200, 'HTTP ' + meQ.status);
check('扫码 token 归属正确', meQ.json && meQ.json.username === uname, JSON.stringify(meQ.json).slice(0, 80));
const viaQr = await call('/api/auth/sessions', { token: tokQ });
const qrSession = ((viaQr.json && viaQr.json.sessions) || []).find(s => s.via === 'qr');
check('会话列表出现「扫码登录」会话', !!qrSession, qrSession ? JSON.stringify(qrSession).slice(0, 140) : '未找到');
check('二维码一次性（重复轮询 401）', (await call('/api/auth/qr/poll', { json: { id: qid, secret: qsecret } })).status === 401);

console.log('\n[5] 数据导出内容');
const ex = await call('/api/account/export', { token: tokA });
let dump = null; try { dump = JSON.parse(ex.text); } catch { /* 忽略 */ }
check('导出成功且为 JSON', ex.status === 200 && !!dump);
check('导出含 account 与 data', !!(dump && dump.account && dump.data));
check('导出含登录设备（sessions）', !!(dump && dump.data && Array.isArray(dump.data.sessions) && dump.data.sessions.length >= 1),
  dump && dump.data && dump.data.sessions ? ('count=' + dump.data.sessions.length) : '');
check('导出不含可用 token 字段', !(dump && dump.data && dump.data.sessions || []).some(s => s.token));
check('导出不含密码哈希', !JSON.stringify(dump).includes(pwHash));

console.log('\n[6] 注销状态流转');
const d1 = await call('/api/account/delete', { token: tokA, json: { confirm: 'wrong-name', reason: 'x' } });
check('用户名不匹配被拒（need_confirm）', d1.status === 400 && d1.json.code === 'need_confirm', 'HTTP ' + d1.status);
const d2 = await call('/api/account/delete', { token: tokA, json: { confirm: uname, reason: '回归测试' } });
check('提交注销申请', d2.status === 200 && d2.json.ok !== false, JSON.stringify(d2.json).slice(0, 120));
const st = await call('/api/account/status', { token: tokA });
check('状态显示待生效', !!(st.json && st.json.deletion && !st.json.deletion.cancelled_at));
check('冷静期为 7 天', (() => {
  const a = new Date(st.json.deletion.requested_at).getTime();
  const b = new Date(st.json.deletion.effective_at).getTime();
  return Math.abs((b - a) - 7 * 86400000) < 60000;
})(), JSON.stringify(st.json.deletion).slice(0, 140));
check('撤销注销申请', (await call('/api/account/delete/cancel', { token: tokA, json: {} })).json.cancelled === true);
const st2 = await call('/api/account/status', { token: tokA });
check('撤销后状态为已取消', !!(st2.json.deletion && st2.json.deletion.cancelled_at));

console.log('\n[7] 会议权限：非成员不能读取他人会议');
const m = await call('/api/meeting/create', { token: tokA, json: { title: '权限测试', kind: 'instant', invitees: [] } });
const mid = m.json.meeting.id;
const outsider = await call('/api/meeting/detail?id=' + encodeURIComponent(mid), { token: tokB });
check('被下线 token 无法访问（401）', outsider.status === 401, 'HTTP ' + outsider.status);
await call('/api/meeting/end', { token: tokA, json: { meetingId: mid } });

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`测试账号：${uname}（请用 _cleanup 清理）`);
process.exit(fail ? 1 : 0);
