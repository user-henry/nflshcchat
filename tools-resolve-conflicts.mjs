// 合并冲突解决小工具：把冲突块统一保留指定的一侧（ours = HEAD / theirs = 合入方）
// 用法: node tools-resolve-conflicts.mjs ours <file...>   |  node tools-resolve-conflicts.mjs theirs <file...>
import fs from 'node:fs';

const [side, ...files] = process.argv.slice(2);
if (!side || !['ours', 'theirs'].includes(side) || !files.length) {
  console.log('用法: node tools-resolve-conflicts.mjs <ours|theirs> <file...>');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const out = [];
  let mode = null, blocks = 0;
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) { mode = side === 'ours' ? 'keep' : 'drop'; blocks++; continue; }
    if (line.startsWith('=======') && mode !== null) { mode = side === 'ours' ? 'drop' : 'keep'; continue; }
    if (line.startsWith('>>>>>>>') && mode !== null) { mode = null; continue; }
    if (mode === 'drop') continue;
    out.push(line);
  }
  fs.writeFileSync(f, out.join('\n'), 'utf8');
  console.log(`${f}: 解决 ${blocks} 处冲突（保留 ${side}）`);
  total += blocks;
}
console.log(`共解决 ${total} 处冲突`);
