// 检查 HTML 中引用的本地资源（href/src，不含 http(s)、mailto、#、data:）是否存在
// 用法: node tools-check-links.mjs file1.html [file2.html ...]
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) { console.log('用法: node tools-check-links.mjs <html...>'); process.exit(1); }

let bad = 0;
for (const f of files) {
  let html;
  try { html = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`ERR  无法读取 ${f}`); bad++; continue; }
  const dir = path.dirname(path.resolve(f));
  const refs = new Set();
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = m[1].trim();
    if (!u || u.startsWith('#') || u.startsWith('data:')) continue;
    if (/^(https?:)?\/\//i.test(u) || /^(mailto|tel|javascript):/i.test(u)) continue;
    u = u.split('#')[0].split('?')[0];
    if (!u || u.startsWith('/')) continue;          // 站点根路径（GitHub Pages 根）跳过
    refs.add(u);
  }
  const missing = [];
  for (const r of refs) {
    const abs = path.resolve(dir, r);
    if (!fs.existsSync(abs)) missing.push(r);
  }
  if (missing.length) { console.log(`FAIL  ${f}\n  缺失: ${missing.join(', ')}`); bad += missing.length; }
  else console.log(`OK    ${f}  (本地引用 ${refs.size} 个均可解析)`);
}
console.log(`\n问题数：${bad}`);
process.exit(bad ? 1 : 0);
