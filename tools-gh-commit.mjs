// 当 github.com 的 git 协议不可达时，用 GitHub Git Data API 把本地工作树一次性提交到远端分支
// （blobs → tree → commit → 更新 ref，只产生一个提交）
//
// 用法: node tools-gh-commit.mjs <owner/repo> <branch> "<commit message>"
//
// 行为：以「远端当前提交的 tree」为基线，只上传内容与远端不同的文件；
//       远端存在但本地已删除的文件会从新 tree 中移除。
//       凭据取环境变量 GH_TOKEN（切勿写进源码）。
import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) {
  console.log('缺少 GH_TOKEN 环境变量（GitHub Token，需 Contents 读写权限）。');
  process.exit(1);
}
const [repo, branch = 'main', message = 'chore: sync from local'] = process.argv.slice(2);
if (!repo) { console.log('用法: node tools-gh-commit.mjs <owner/repo> <branch> "<message>"'); process.exit(1); }

const H = {
  Authorization: 'token ' + TOKEN,
  'User-Agent': 'dsh-tree-pusher',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

async function api(url, init) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      if (res.status >= 500 && attempt < 3) { await new Promise(r => setTimeout(r, 1500)); continue; }
      return { status: res.status, ok: res.ok, json: j, text };
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---------- 1. 远端当前提交与 tree ----------
const ref = await api(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { headers: H });
if (!ref.ok) { console.log('❌ 读取远端 ref 失败', ref.status, ref.text.slice(0, 200)); process.exit(1); }
const baseCommit = ref.json.object.sha;
const commitInfo = await api(`https://api.github.com/repos/${repo}/git/commits/${baseCommit}`, { headers: H });
const baseTree = commitInfo.json.tree.sha;
console.log(`远端 ${branch} 当前提交 ${baseCommit.slice(0, 8)}，tree ${baseTree.slice(0, 8)}`);

const remoteTree = await api(`https://api.github.com/repos/${repo}/git/trees/${baseTree}?recursive=1`, { headers: H });
if (!remoteTree.ok) { console.log('❌ 读取远端 tree 失败', remoteTree.status); process.exit(1); }
const remoteFiles = new Map();
for (const e of remoteTree.json.tree || []) {
  if (e.type === 'blob') remoteFiles.set(e.path, e.sha);
}
console.log(`远端文件数：${remoteFiles.size}`);

// ---------- 2. 本地 HEAD 的 tree ----------
const localTreeRaw = git('ls-tree', '-r', 'HEAD').split('\n').filter(Boolean);
const localFiles = new Map();      // path -> { sha, mode }
let headSha = git('rev-parse', 'HEAD').trim();
if (remoteTree.json.truncated) console.log('⚠️ 远端 tree 被截断，可能漏判部分文件');
for (const line of localTreeRaw) {
  const m = /^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/.exec(line);
  if (!m) continue;
  localFiles.set(m[4], { mode: m[1], sha: m[3] });
}
console.log(`本地文件数：${localFiles.size}`);

// 未跟踪但需要一起提交的文件（显式列出）
const EXTRA = (process.env.EXTRA_FILES || '').split(',').map(s => s.trim()).filter(Boolean);

// ---------- 3. 计算差异 ----------
const toUpload = [];     // { path, mode }
const toDelete = [];
for (const [p, info] of localFiles) {
  const r = remoteFiles.get(p);
  if (!r || r !== info.sha) toUpload.push({ path: p, mode: info.mode });
}
for (const p of EXTRA) {
  if (!localFiles.has(p)) toUpload.push({ path: p, mode: '100644' });
}
for (const p of remoteFiles.keys()) {
  if (!localFiles.has(p)) toDelete.push(p);
}

console.log(`需要上传：${toUpload.length} 个文件；需要删除：${toDelete.length} 个`);
if (toDelete.length) console.log('  删除：', toDelete.slice(0, 20).join(', ') + (toDelete.length > 20 ? ' …' : ''));
if (process.env.DRY_RUN === '1') {
  console.log('\n[DRY RUN] 待上传清单：');
  for (const i of toUpload) console.log('  ' + i.path);
  for (const p of EXTRA) console.log('  + ' + p + '（新增）');
  console.log('\n[DRY RUN] 待删除清单：');
  for (const p of toDelete) console.log('  - ' + p);
  process.exit(0);
}
if (!toUpload.length && !toDelete.length) { console.log('没有差异，无需提交'); process.exit(0); }

// ---------- 4. 上传 blob ----------
const tree = [];
let done = 0;
for (const item of toUpload) {
  const content = execFileSync('git', ['show', `HEAD:${item.path}`], { maxBuffer: 64 * 1024 * 1024 });
  const b = await api(`https://api.github.com/repos/${repo}/git/blobs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  if (!b.ok) { console.log(`❌ blob 失败 ${item.path} HTTP ${b.status} ${String(b.text).slice(0, 160)}`); process.exit(1); }
  tree.push({ path: item.path, mode: item.mode === '100755' ? '100755' : '100644', type: 'blob', sha: b.json.sha });
  done++;
  if (done % 10 === 0 || done === toUpload.length) console.log(`  blobs ${done}/${toUpload.length}`);
}
for (const item of EXTRA) {
  const fs = await import('node:fs');
  if (!fs.existsSync(item)) continue;
  const content = fs.readFileSync(item);
  const b = await api(`https://api.github.com/repos/${repo}/git/blobs`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  if (!b.ok) { console.log(`❌ blob 失败（新增）${item} HTTP ${b.status}`); process.exit(1); }
  tree.push({ path: item, mode: '100644', type: 'blob', sha: b.json.sha });
  console.log(`  + 新增文件 ${item}`);
}
for (const p of toDelete) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });

// ---------- 5. 建 tree / commit / 更新 ref ----------
const nt = await api(`https://api.github.com/repos/${repo}/git/trees`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ base_tree: baseTree, tree }),
});
if (!nt.ok) { console.log('❌ 建 tree 失败', nt.status, String(nt.text).slice(0, 300)); process.exit(1); }
console.log(`新 tree ${nt.json.sha.slice(0, 8)}`);

const nc = await api(`https://api.github.com/repos/${repo}/git/commits`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ message, tree: nt.json.sha, parents: [baseCommit] }),
});
if (!nc.ok) { console.log('❌ 建 commit 失败', nc.status, String(nc.text).slice(0, 300)); process.exit(1); }
console.log(`新提交 ${nc.json.sha.slice(0, 8)}`);

const upd = await api(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ sha: nc.json.sha, force: false }),
});
if (!upd.ok) { console.log('❌ 更新 ref 失败', upd.status, String(upd.text).slice(0, 300)); process.exit(1); }
console.log(`✅ 已把 ${repo}#${branch} 更新到 ${nc.json.sha.slice(0, 8)}（本地 HEAD 为 ${headSha.slice(0, 8)}）`);
