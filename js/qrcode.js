/**
 * NFLSHC 极简 QR Code 生成器（无外部依赖）
 * ------------------------------------------------------------------
 * 用途：扫码登录（PC 端把登录链接渲染成二维码，手机扫码确认）。
 * 实现范围：字节模式（UTF-8），纠错等级 L，版本 1–10（足够容纳 ~270 字节的 URL），
 *          固定使用掩码 0（格式信息中声明，任何标准扫码器都能识别）。
 * 用法：
 *   NFLSHCQR.render(document.getElementById('box'), 'https://example.com', { size: 220 });
 *   const m = NFLSHCQR.encode('hello');   // { size, modules: [[bool]] }
 */
(function (global) {
    'use strict';

    // ---------- GF(256) 有限域 ----------
    var EXP = new Uint8Array(512);
    var LOG = new Uint8Array(256);
    (function () {
        var x = 1;
        for (var i = 0; i < 255; i++) {
            EXP[i] = x;
            LOG[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;   // 本原多项式 x^8+x^4+x^3+x^2+1
        }
        for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    })();

    function gfMul(a, b) {
        if (a === 0 || b === 0) return 0;
        return EXP[LOG[a] + LOG[b]];
    }

    function polyMul(a, b) {
        var r = new Array(a.length + b.length - 1);
        for (var i = 0; i < r.length; i++) r[i] = 0;
        for (var i2 = 0; i2 < a.length; i2++) {
            for (var j = 0; j < b.length; j++) r[i2 + j] ^= gfMul(a[i2], b[j]);
        }
        return r;
    }

    // 生成多项式 g(x) = (x-α^0)(x-α^1)...(x-α^(n-1))
    function rsGeneratorPoly(n) {
        var g = [1];
        for (var i = 0; i < n; i++) g = polyMul(g, [1, EXP[i]]);
        return g;
    }

    // Reed-Solomon 纠错码字
    function rsEncode(data, ecLen) {
        var g = rsGeneratorPoly(ecLen);
        var res = new Array(data.length + ecLen);
        var i, j;
        for (i = 0; i < data.length; i++) res[i] = data[i];
        for (i = data.length; i < res.length; i++) res[i] = 0;
        for (i = 0; i < data.length; i++) {
            var coef = res[i];
            if (coef !== 0) {
                for (j = 0; j < g.length; j++) res[i + j] ^= gfMul(g[j], coef);
            }
        }
        return res.slice(data.length);
    }

    // ---------- 版本表（纠错等级 L，版本 1–10） ----------
    // blocks: [[块数, 每块数据码字数], ...]；ec 为每块纠错码字数
    var VER_L = {
        1: { ec: 7, blocks: [[1, 19]] },
        2: { ec: 10, blocks: [[1, 34]] },
        3: { ec: 15, blocks: [[1, 55]] },
        4: { ec: 20, blocks: [[1, 80]] },
        5: { ec: 26, blocks: [[1, 108]] },
        6: { ec: 18, blocks: [[2, 68]] },
        7: { ec: 20, blocks: [[2, 78]] },
        8: { ec: 24, blocks: [[2, 97]] },
        9: { ec: 30, blocks: [[2, 116]] },
        10: { ec: 18, blocks: [[2, 68], [2, 69]] }
    };
    var ALIGN_POS = {
        1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
        6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
    };
    var MAX_VERSION = 10;

    function rsBlocksOf(version) {
        var spec = VER_L[version];
        var out = [];
        for (var i = 0; i < spec.blocks.length; i++) {
            var count = spec.blocks[i][0];
            var dc = spec.blocks[i][1];
            for (var c = 0; c < count; c++) out.push({ dataCount: dc, totalCount: dc + spec.ec });
        }
        return out;
    }

    function dataCapacityBytes(version) {
        var blocks = rsBlocksOf(version);
        var total = 0;
        for (var i = 0; i < blocks.length; i++) total += blocks[i].dataCount;
        // 减去 4 位模式指示 + 字符数指示（版本 1-9 为 8 位，10+ 为 16 位）
        var headerBits = 4 + (version >= 10 ? 16 : 8);
        return Math.floor((total * 8 - headerBits) / 8);
    }

    // ---------- UTF-8 编码 ----------
    function toUtf8Bytes(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) {
                out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
                    var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
                    out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
                    i++;
                } else {
                    out.push(0xEF, 0xBF, 0xBD);
                }
            } else {
                out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
            }
        }
        return out;
    }

    // ---------- 位缓冲 ----------
    function BitBuffer() { this.buffer = []; this.length = 0; }
    BitBuffer.prototype.put = function (num, len) {
        for (var i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1);
    };
    BitBuffer.prototype.putBit = function (bit) {
        var idx = Math.floor(this.length / 8);
        if (this.buffer.length <= idx) this.buffer.push(0);
        if (bit) this.buffer[idx] |= (0x80 >>> (this.length % 8));
        this.length++;
    };

    // ---------- 数据码字（含分块交织） ----------
    function buildCodewords(bytes, version) {
        var blocks = rsBlocksOf(version);
        var totalData = 0;
        for (var i = 0; i < blocks.length; i++) totalData += blocks[i].dataCount;

        var buf = new BitBuffer();
        buf.put(4, 4);                                   // 字节模式
        buf.put(bytes.length, version >= 10 ? 16 : 8);   // 字符数
        for (var b = 0; b < bytes.length; b++) buf.put(bytes[b], 8);

        // 终止符
        if (buf.length + 4 <= totalData * 8) buf.put(0, 4);
        while (buf.length % 8 !== 0) buf.putBit(false);
        // 填充码字 0xEC / 0x11 交替
        var pad = [0xEC, 0x11], pi = 0;
        while (buf.length < totalData * 8) { buf.put(pad[pi % 2], 8); pi++; }

        // 分块 + 纠错
        var dc = [], ec = [], offset = 0, maxDc = 0, maxEc = 0;
        for (var r = 0; r < blocks.length; r++) {
            var dcCount = blocks[r].dataCount;
            var ecCount = blocks[r].totalCount - dcCount;
            dc[r] = buf.buffer.slice(offset, offset + dcCount);
            offset += dcCount;
            ec[r] = rsEncode(dc[r], ecCount);
            if (dcCount > maxDc) maxDc = dcCount;
            if (ecCount > maxEc) maxEc = ecCount;
        }

        var out = [];
        for (var i2 = 0; i2 < maxDc; i2++) for (var r2 = 0; r2 < blocks.length; r2++) if (i2 < dc[r2].length) out.push(dc[r2][i2]);
        for (var i3 = 0; i3 < maxEc; i3++) for (var r3 = 0; r3 < blocks.length; r3++) if (i3 < ec[r3].length) out.push(ec[r3][i3]);
        return out;
    }

    // ---------- BCH 格式/版本信息 ----------
    function bchDigit(data) {
        var digit = 0;
        while (data !== 0) { digit++; data >>>= 1; }
        return digit;
    }
    var G15 = 0x0537, G15_MASK = 0x5412, G18 = 0x1F25;

    function bchTypeInfo(data) {          // data = (ecLevel << 3) | mask，ecLevel: L=1
        var d = data << 10;
        while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
        return ((data << 10) | d) ^ G15_MASK;
    }
    function bchTypeNumber(data) {        // 版本号 >= 7
        var d = data << 12;
        while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
        return (data << 12) | d;
    }

    var MASK = 0;   // 固定掩码 0：(row + col) % 2 === 0 时反转

    function encode(text) {
        var bytes = toUtf8Bytes(String(text));
        var version = 0;
        for (var v = 1; v <= MAX_VERSION; v++) {
            if (bytes.length <= dataCapacityBytes(v)) { version = v; break; }
        }
        if (!version) throw new Error('内容过长，超出本生成器支持范围（最多约 270 字节）：' + bytes.length);

        var size = version * 4 + 17;
        var modules = [];
        for (var r = 0; r < size; r++) {
            modules.push(new Array(size).fill(null));
        }

        // 1) 定位图案 + 分隔符
        function probe(row, col) {
            for (var dr = -1; dr <= 7; dr++) {
                if (row + dr <= -1 || row + dr >= size) continue;
                for (var dcx = -1; dcx <= 7; dcx++) {
                    if (col + dcx <= -1 || col + dcx >= size) continue;
                    var isDark =
                        (dr >= 0 && dr <= 6 && (dcx === 0 || dcx === 6)) ||
                        (dcx >= 0 && dcx <= 6 && (dr === 0 || dr === 6)) ||
                        (dr >= 2 && dr <= 4 && dcx >= 2 && dcx <= 4);
                    modules[row + dr][col + dcx] = isDark;
                }
            }
        }
        probe(0, 0);
        probe(size - 7, 0);
        probe(0, size - 7);

        // 2) 校正图案
        var pos = ALIGN_POS[version];
        for (var a = 0; a < pos.length; a++) {
            for (var b2 = 0; b2 < pos.length; b2++) {
                var ar = pos[a], ac = pos[b2];
                if (modules[ar][ac] !== null) continue;
                for (var dy = -2; dy <= 2; dy++) {
                    for (var dx = -2; dx <= 2; dx++) {
                        modules[ar + dy][ac + dx] =
                            (Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0));
                    }
                }
            }
        }

        // 3) 定时图案
        for (var t1 = 8; t1 < size - 8; t1++) {
            if (modules[t1][6] === null) modules[t1][6] = (t1 % 2 === 0);
        }
        for (var t2 = 8; t2 < size - 8; t2++) {
            if (modules[6][t2] === null) modules[6][t2] = (t2 % 2 === 0);
        }

        // 4) 格式信息（纠错等级 + 掩码）
        var fmt = bchTypeInfo((1 << 3) | MASK);   // 1 = 纠错等级 L
        var i;
        for (i = 0; i < 15; i++) {
            var bit = ((fmt >> i) & 1) === 1;
            if (i < 6) modules[i][8] = bit;
            else if (i < 8) modules[i + 1][8] = bit;
            else modules[size - 15 + i][8] = bit;
        }
        for (i = 0; i < 15; i++) {
            var bit2 = ((fmt >> i) & 1) === 1;
            if (i < 8) modules[8][size - i - 1] = bit2;
            else if (i < 9) modules[8][15 - i - 1 + 1] = bit2;
            else modules[8][15 - i - 1] = bit2;
        }
        modules[size - 8][8] = true;   // 固定暗模块

        // 5) 版本信息（版本 >= 7）
        if (version >= 7) {
            var vbits = bchTypeNumber(version);
            for (i = 0; i < 18; i++) {
                var vb = ((vbits >> i) & 1) === 1;
                modules[Math.floor(i / 3)][i % 3 + size - 8 - 3] = vb;
            }
            for (i = 0; i < 18; i++) {
                var vb2 = ((vbits >> i) & 1) === 1;
                modules[i % 3 + size - 8 - 3][Math.floor(i / 3)] = vb2;
            }
        }

        // 6) 放置数据（之字形，跳过第 6 列）
        var codewords = buildCodewords(bytes, version);
        var inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
        for (var col = size - 1; col > 0; col -= 2) {
            if (col === 6) col--;
            for (;;) {
                for (var c = 0; c < 2; c++) {
                    var cc = col - c;
                    if (modules[row][cc] === null) {
                        var dark = false;
                        if (byteIndex < codewords.length) {
                            dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
                        }
                        if ((row + cc) % 2 === 0) dark = !dark;   // 掩码 0
                        modules[row][cc] = dark;
                        bitIndex--;
                        if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
                    }
                }
                row += inc;
                if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
            }
        }

        return { size: size, modules: modules };
    }

    function render(target, text, opts) {
        var el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) return null;
        opts = opts || {};
        var qr;
        try {
            qr = encode(text);
        } catch (e) {
            el.innerHTML = '<div style="color:#e74c3c;font-size:13px;">二维码生成失败：' + (e.message || e) + '</div>';
            return null;
        }
        var px = opts.size || 220;
        var margin = opts.margin == null ? 2 : opts.margin;     // 静区（模块数）
        var total = qr.size + margin * 2;
        var scale = Math.max(2, Math.floor(px / total));
        var dim = total * scale;
        var cv = document.createElement('canvas');
        cv.width = dim; cv.height = dim;
        cv.style.width = dim + 'px'; cv.style.height = dim + 'px';
        cv.style.imageRendering = 'pixelated';
        var ctx = cv.getContext('2d');
        ctx.fillStyle = opts.light || '#ffffff';
        ctx.fillRect(0, 0, dim, dim);
        ctx.fillStyle = opts.dark || '#000000';
        for (var r = 0; r < qr.size; r++) {
            for (var c = 0; c < qr.size; c++) {
                if (qr.modules[r][c]) {
                    ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
                }
            }
        }
        el.innerHTML = '';
        el.appendChild(cv);
        return cv;
    }

    global.NFLSHCQR = { encode: encode, render: render, version: '1.0' };
})(window);
