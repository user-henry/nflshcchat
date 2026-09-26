// 会议入会与信令链路回归：验证「入会后成员可见」与「双方信令互通」（此前正是这两处断了）
// 用法: node test-meeting-signaling.mjs
const API = 'https://worker.nflshcchat.cc.cd';
const suffix = Math.random().toString(36).slice(2, 7);
const UA = 'A';
const UB = 'B';
const pwd = 'Test12345';

const sha256hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};
async function makeUser(name) {
  const hash = await sha256hex(pwd);
  await fetch(API + '/api/legacy/issues?labels=users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: ['users'], body: '```json\n' + JSON.stringify({ username: name, password: hash, passwordHashed: true }) + '\n```' }),
  });
  const j = await (await fetch(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: hash }),
  })).json();
  return j.token;
}
const call = async (path, token, opts = {}) => {
  const headers = { Authorization: 'Bearer ' + token };
  if (opts.json) headers['Content-Type'] = 'application/json';
  const r = await fetch(API + path, {
    method: opts.method || (opts.json ? 'POST' : 'GET'), headers,
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅ ' + n + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + n + '  ' + extra); } };

const nameA = 't_meet_a_' + suffix;
const nameB = 't_meet_b_' + suffix;
console.log('测试账号：' + nameA + ' / ' + nameB);

console.log('\n[1] 两个账号登录');
const tokA = await makeUser(nameA);
const tokB = await makeUser(nameB);
check('A 登录', !!tokA);
check('B 登录', !!tokB);

console.log('\n[2] A 创建会议并邀请 B');
const created = await call('/api/meeting/create', tokA, {
  json: { title: '信令测试会议', kind: 'instant', invitees: [nameB] },
});
const mt = created.json && created.json.meeting;
check('创建会议', created.status === 201 && !!mt, JSON.stringify(created.json).slice(0, 140));
const mid = mt.id;
const code = mt.code;

console.log('\n[3] B 用会议编号入会 → 必须真的成为成员（这就是之前断掉的地方）');
const joinB = await call('/api/meeting/join', tokB, { json: { code: code } });
check('B 入会成功', joinB.status === 200 && joinB.json.ok !== false, JSON.stringify(joinB.json).slice(0, 120));
const detailA = await call('/api/meeting/detail?id=' + encodeURIComponent(mid), tokA);
const members = (detailA.json && detailA.json.members) || [];
const joined = members.filter(m => m.state === 'joined').map(m => m.username);
check('A 看到入会成员数 = 2', joined.length === 2, 'members=' + JSON.stringify(members.map(m => m.username + ':' + m.state)));
check('B 出现在成员列表且状态为 joined', joined.includes(nameB), joined.join(','));
check('主持人 A 状态也是 joined', joined.includes(nameA), joined.join(','));
check('A 是 host', members.some(m => m.username === nameA && m.role === 'host'));

console.log('\n[4] 信令必须双向可达（403 会导致连接完全无法建立）');
const sigPollA = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokA);
const sigPollB = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokB);
check('A 可轮询信令（非 403）', sigPollA.status === 200, 'HTTP ' + sigPollA.status);
check('B 可轮询信令（非 403）', sigPollB.status === 200, 'HTTP ' + sigPollB.status);

// A → B 的 offer
const offer = await call('/api/meeting/signal', tokA, { json: { meetingId: mid, to: nameB, kind: 'offer', payload: { type: 'offer', sdp: 'v=0 fake-offer' } } });
check('A 发送 offer', offer.status === 201, 'HTTP ' + offer.status);
const bGot = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokB);
const bSigs = (bGot.json && bGot.json.signals) || [];
check('B 收到 A 的 offer', bSigs.some(s => s.kind === 'offer' && s.from_user === nameA), JSON.stringify(bSigs.map(s => s.kind + '@' + s.from_user)));
check('offer 内容完整（sdp 保留）', !!(bSigs[0] && bSigs[0].payload && bSigs[0].payload.sdp));
const aSigs = ((await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokA)).json.signals) || [];
check('A 不会收到自己发出的信令', !aSigs.some(s => s.from_user === nameA), JSON.stringify(aSigs));

// B → A 的 answer
const answer = await call('/api/meeting/signal', tokB, { json: { meetingId: mid, to: nameA, kind: 'answer', payload: { type: 'answer', sdp: 'v=0 fake-answer' } } });
check('B 发送 answer', answer.status === 201, 'HTTP ' + answer.status);
const aGot = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokA);
check('A 收到 B 的 answer', ((aGot.json.signals) || []).some(s => s.kind === 'answer' && s.from_user === nameB));

// B → A 的 __renegotiate 请求（开启麦克风后要求对方重新发 offer）
const ren = await call('/api/meeting/signal', tokB, { json: { meetingId: mid, to: nameA, kind: 'ice', payload: { __renegotiate: true } } });
check('B 发送重新协商请求', ren.status === 201, 'HTTP ' + ren.status);
const aRen = ((await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokA)).json.signals) || [];
check('A 收到 __renegotiate 标记', aRen.some(s => s.payload && s.payload.__renegotiate === true));

// ICE 候选
const ice = await call('/api/meeting/signal', tokA, { json: { meetingId: mid, to: nameB, kind: 'ice', payload: { candidate: 'candidate:fake', sdpMid: '0' } } });
check('ICE 候选可发送', ice.status === 201);
const bIce = ((await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokB)).json.signals) || [];
check('B 收到 ICE 候选', bIce.some(s => s.kind === 'ice' && s.payload && s.payload.candidate));

console.log('\n[5] 增量游标（客户端每秒轮询靠它只取新信令）');
const before = bIce.length ? bIce[bIce.length - 1].id : 0;
const inc = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=' + before, tokB);
check('since 之后无新信令时返回空', ((inc.json.signals) || []).length === 0, 'count=' + ((inc.json.signals) || []).length);
await call('/api/meeting/signal', tokA, { json: { meetingId: mid, to: nameB, kind: 'ice', payload: { candidate: 'candidate:new' } } });
const inc2 = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=' + before, tokB);
check('新增信令能被增量取到', ((inc2.json.signals) || []).length === 1, 'count=' + ((inc2.json.signals) || []).length);

console.log('\n[6] 非成员不能读取会议信令与聊天');
const nameC = 't_meet_c_' + suffix;
const tokC = await makeUser(nameC);
const cSig = await call('/api/meeting/signal?meetingId=' + encodeURIComponent(mid) + '&since=0', tokC);
check('非成员轮询信令被拒（403）', cSig.status === 403, 'HTTP ' + cSig.status);
const cChat = await call('/api/meeting/chat?meetingId=' + encodeURIComponent(mid), tokC);
check('非成员读取聊天被拒（403）', cChat.status === 403, 'HTTP ' + cChat.status);
const cJoin = await call('/api/meeting/join', tokC, { json: { code: code } });
check('非成员用编号仍可加入（公开会议）', cJoin.status === 200 && cJoin.json.ok !== false);

console.log('\n[7] 离开后成员状态会更新（避免幽灵成员）');
const leave = await call('/api/meeting/leave', tokC, { json: { meetingId: mid } });
check('离开接口返回成功', leave.status === 200);
const afterLeave = await call('/api/meeting/detail?id=' + encodeURIComponent(mid), tokA);
const cState = ((afterLeave.json.members) || []).find(m => m.username === nameC);
check('C 的状态变为 left', !!(cState && cState.state === 'left'), cState ? cState.state : '未找到');

console.log('\n[8] 会议密码保护');
const mt2 = (await call('/api/meeting/create', tokA, { json: { title: '带密码会议', kind: 'instant', password: 'pw123', invitees: [] } })).json.meeting;
const noPw = await call('/api/meeting/join', tokB, { json: { code: mt2.code } });
check('无密码加入被拒（need_password）', noPw.status === 403 && noPw.json.code === 'need_password', JSON.stringify(noPw.json).slice(0, 100));
const withPw = await call('/api/meeting/join', tokB, { json: { code: mt2.code, password: 'pw123' } });
check('正确密码可加入', withPw.status === 200 && withPw.json.ok !== false);

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`测试账号：${nameA} / ${nameB} / ${nameC}（前缀 t_meet_，需清理）`);
process.exit(fail ? 1 : 0);
