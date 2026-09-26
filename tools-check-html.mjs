// 检查 HTML 里内联 <script> 的语法（不执行），用于快速发现拼写/括号错误
// 用法: node tools-check-html.mjs file1.html [file2.html ...]
import fs from 'node:fs';
import vm from 'node:vm';

const files = process.argv.slice(2);
if (!files.length) { console.log('用法: node tools-check-html.mjs <html...>'); process.exit(1); }

let bad = 0, checked = 0;
for (const f of files) {
  let html;
  try { html = fs.readFileSync(f, 'utf8'); }
  catch (e) { console.log(`ERR   无法读取 ${f}: ${e.message}`); bad++; continue; }

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, idx = 0;
  const problems = [];
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;                       // 外链脚本跳过
    if (/type\s*=\s*["']?(?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue;
    idx++;
    const code = m[2];
    if (!code.trim()) continue;
    const line = html.slice(0, m.index).split('\n').length;
    try {
      new vm.Script(code, { filename: `${f}#script${idx}` });
      checked++;
    } catch (e) {
      problems.push(`  ❌ 第 ${line} 行起的 <script> 块 #${idx}: ${e.message}`);
      bad++;
    }
  }
  if (problems.length) console.log(`FAIL  ${f}\n${problems.join('\n')}`);
  else console.log(`OK    ${f}  (内联脚本 ${idx} 块)`);
}
console.log(`\n共检查 ${files.length} 个文件，语法错误 ${bad} 个`);
process.exit(bad ? 1 : 0);
