// 用 GitHub Contents API 批量上传/删除文件（当 git push 被网络阻断时的兜底通道）
// 用法:
//   node tools-gh-batch.mjs put    <owner/repo> <branch> "<commit message>" <files.json>
//   node tools-gh-batch.mjs delete <owner/repo> <branch> "<commit message>" <paths.json>
// files.json: { "repo/相对路径": "本地绝对或相对路径", ... }
//
// 凭据：需要环境变量 GH_TOKEN（细粒度 token，只需 Contents 读写权限）。
//       切勿把 token 写进源码，否则会被 GitHub secret scanning 拦截。
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) {
  console.log('缺少 GH_TOKEN 环境变量。示例（PowerShell）：');
  console.log('  $env:GH_TOKEN = "<你的 GitHub Token>"; node tools-gh-batch.mjs ...');
  process.exit(1);
}
const [mode, repo, branch = 'main', message = 'chore: batch update', listFile] = process.argv.slice(2);

if (!mode || !repo || !listFile) {
  console.log('用法: node tools-gh-batch.mjs <put|delete> <owner/repo> <branch> "<message>" <list.json>');
  process.exit(1);
}

const H = {
  Authorization: 'token ' + TOKEN,
  'User-Agent': 'dsh-batch-uploader',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

async function api(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json: j, text };
}

async function currentSha(repoPath) {
  const r = await api(`https://api.github.com/repos/${repo}/contents/${encodeURI(repoPath)}?ref=${branch}`, { headers: H });
  if (r.status === 200 && r.json && r.json.sha) return r.json.sha;
  return null;
}

const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const entries = Array.isArray(list) ? list.map(p => [p, p]) : Object.entries(list);

let ok = 0, fail = 0;
for (const [repoPath, localPath] of entries) {
  const sha = await currentSha(repoPath);
  if (mode === 'delete') {
    if (!sha) { console.log(`— 跳过（远端不存在）：${repoPath}`); continue; }
    const r = await api(`https://api.github.com/repos/${repo}/contents/${encodeURI(repoPath)}`, {
      method: 'DELETE', headers: H,
      body: JSON.stringify({ message: message + ' — ' + repoPath, sha, branch }),
    });
    if (r.ok) { ok++; console.log(`✅ 已删除 ${repoPath}`); } else { fail++; console.log(`❌ 删除失败 ${repoPath} HTTP ${r.status} ${String(r.text).slice(0, 160)}`); }
    continue;
  }

  let content;
  try { content = fs.readFileSync(localPath); }
  catch (e) { fail++; console.log(`❌ 读取失败 ${localPath}: ${e.message}`); continue; }

  const body = {
    message: message + ' — ' + path.basename(repoPath),
    content: content.toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  const r = await api(`https://api.github.com/repos/${repo}/contents/${encodeURI(repoPath)}`, {
    method: 'PUT', headers: H, body: JSON.stringify(body),
  });
  if (r.ok) {
    ok++;
    console.log(`✅ ${sha ? '更新' : '新增'} ${repoPath}  (${content.length} 字节)`);
  } else {
    fail++;
    console.log(`❌ 失败 ${repoPath} HTTP ${r.status} ${String(r.text).slice(0, 200)}`);
  }
}

console.log(`\n完成：成功 ${ok}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
