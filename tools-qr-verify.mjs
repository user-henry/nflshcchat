// 校验 js/qrcode.js 与参考实现 npm「qrcode」的输出矩阵是否完全一致
// 用法: node tools-qr-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let QRCode;
try {
  QRCode = require('qrcode');
} catch {
  console.error('缺少依赖，请先运行: npm i --no-save qrcode');
  process.exit(2);
}

// 把 js/qrcode.js 装进一个假的 window 里执行
const src = fs.readFileSync(path.join(process.cwd(), 'js', 'qrcode.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', src)(sandbox.window);
const mine = sandbox.window.NFLSHCQR;
if (!mine) { console.error('NFLSHCQR 未导出'); process.exit(2); }

const samples = [
  'https://nflshcchat.cc.cd/index.html?qr=b1b2fd38ff0242f69833',
  'https://nflshcchat.cc.cd/index.html?qr=0db3ffb1e0744157',
  'HELLO',
  '中文测试：扫码登录 https://nflshcchat.cc.cd/?qr=abc123',
  'a'.repeat(100),
  'x'.repeat(200),
];

let pass = 0, fail = 0;
for (const text of samples) {
  // 显式指定 byte 模式，禁用参考库的多段优化，保证与我们的实现同一条编码路径
  const ref = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: 'L', maskPattern: 0 });
  const refSize = ref.modules.size;
  const refData = ref.modules.data;         // Uint8Array, 长度 = size*size
  const m = mine.encode(text);
  if (m.size !== refSize) {
    console.log(`❌ 尺寸不一致 "${text.slice(0, 40)}"  mine=${m.size} ref=${refSize}`);
    fail++; continue;
  }
  let diff = 0, firstDiff = '';
  for (let r = 0; r < refSize; r++) {
    for (let c = 0; c < refSize; c++) {
      const a = m.modules[r][c] ? 1 : 0;
      const b = refData[r * refSize + c] ? 1 : 0;
      if (a !== b) { diff++; if (!firstDiff) firstDiff = `(${r},${c})`; }
    }
  }
  if (diff === 0) {
    console.log(`✅ 完全一致  size=${refSize}  "${text.slice(0, 44)}${text.length > 44 ? '…' : ''}"`);
    pass++;
  } else {
    console.log(`❌ 有 ${diff} 个模块不同（首个 ${firstDiff}）  size=${refSize}  "${text.slice(0, 44)}"`);
    fail++;
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
