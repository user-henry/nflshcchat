// 附件上传后返回的地址必须是公开 HTTPS 入口，且该地址能真正取到图片
// 用法: node test-attachment-url.mjs
const API = 'https://worker.nflshcchat.cc.cd';
const uname = 't_' + Math.random().toString(36).slice(2, 8);
const pwd = 'Test12345';

const sha256hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

// 造一张最小合法 PNG（1x1）
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅ ' + n + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + n + '  ' + extra); } };

const pwHash = await sha256hex(pwd);
await fetch(API + '/api/legacy/issues?labels=users', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ labels: ['users'], body: '```json\n' + JSON.stringify({ username: uname, password: pwHash, passwordHashed: true }) + '\n```' }),
});
const lg = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: uname, password: pwHash }),
})).json();
const token = lg.token;
console.log('测试账号: ' + uname);

console.log('\n[1] 上传图片附件');
const fd = new FormData();
fd.append('file', new Blob([PNG], { type: 'image/png' }), 'url-test.png');
fd.append('title', '地址测试图');
fd.append('visibility', 'public');
const r = await fetch(API + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
const j = await r.json().catch(() => ({}));
check('上传成功', r.status === 200 && j.ok, 'HTTP ' + r.status);
console.log('     url       = ' + j.url);
console.log('     directUrl = ' + j.directUrl);
console.log('     viewUrl   = ' + j.viewUrl);

console.log('\n[2] 返回地址必须是 HTTPS 公开入口（否则 HTTPS 页面会因混合内容拦截图片）');
for (const k of ['url', 'directUrl', 'viewUrl']) {
  const v = j[k] || '';
  check(k + ' 使用 https://file.nflshcchat.cc.cd', v.startsWith('https://file.nflshcchat.cc.cd/'), v);
}
check('不含源站 nflshcfile.l.cd', !JSON.stringify(j).includes('nflshcfile.l.cd'));

console.log('\n[3] 该地址真的能取到图片');
if (j.directUrl) {
  const img = await fetch(j.directUrl);
  const ct = img.headers.get('content-type') || '';
  const len = (await img.arrayBuffer()).byteLength;
  check('直链 HTTP 200', img.status === 200, 'HTTP ' + img.status + ' ct=' + ct + ' ' + len + ' 字节');
  check('返回内容为图片', /image\//i.test(ct) && len > 0, ct);
}
if (j.url) {
  const page = await fetch(j.url);
  const body = await page.text();
  check('分享页 HTTP 200', page.status === 200, 'HTTP ' + page.status);
  check('分享页里的下载/直链也是 HTTPS', !/http:\/\/nflshcfile\.l\.cd/i.test(body));
}

console.log('\n[4] 私密附件不返回直链');
const fd2 = new FormData();
fd2.append('file', new Blob([PNG], { type: 'image/png' }), 'private.png');
fd2.append('title', '私有图');
fd2.append('visibility', 'private');
const r2 = await fetch(API + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd2 });
const j2 = await r2.json().catch(() => ({}));
check('私密上传成功', r2.status === 200 && j2.ok);
check('私密文件无 directUrl', !j2.directUrl, JSON.stringify(j2.directUrl));
check('私密文件 url 仍为 https 入口', (j2.url || '').startsWith('https://file.nflshcchat.cc.cd/'), j2.url || '');

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`测试账号：${uname}（需清理）`);
process.exit(fail ? 1 : 0);
