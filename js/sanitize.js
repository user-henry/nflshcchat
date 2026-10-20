/* ============================================================
 * NFLSHC Chat — Markdown 渲染出的 HTML 白名单过滤（sanitize.js）
 * ------------------------------------------------------------
 * 为什么需要：消息 / 文章 / 帖子 / 公告 / 笔记的正文都用 marked 渲染，
 * 而 marked 默认**保留内联 HTML**。如果不做过滤，任何人在消息里写
 * <img src=x onerror=...> 或 <script> 就能执行脚本（XSS），
 * 也能用 <div style="position:fixed;inset:0"> 盖住整个页面。
 *
 * 这里采用「DOM 解析 + 白名单重建」的方式：
 *   1. 用 DOMParser 把 HTML 解析成文档（解析阶段不会执行脚本）；
 *   2. 深度遍历，只保留白名单里的标签与属性，其余按规则删除或「去标签留内容」；
 *   3. 链接/图片地址做协议校验（javascript:、vbscript:、data:text/html 一律丢弃）；
 *   4. 去掉 id/name（防止 DOM clobbering 覆盖页面自己的元素）、所有 on* 事件属性、
 *      以及 style 里除排版白名单以外的声明（防止 fixed 蒙层）。
 *
 * 允许内联媒体，正是为了「文件托管站直链贴进 Markdown」的场景：
 *   <video src="https://file.nflshcchat.cc.cd/f.php?id=…" controls></video>
 *
 * 用法：const html = window.sanitizeHtml(marked.parse(text));
 * ============================================================ */
(function () {
  'use strict';

  // 这些标签连同内容一起删掉（可执行脚本 / 可覆盖页面 / 可发起请求的表单类）
  var DROP = {
    script: 1, style: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
    param: 1, portal: 1, form: 1, input: 1, textarea: 1, select: 1, option: 1, optgroup: 1,
    button: 1, link: 1, meta: 1, base: 1, title: 1, head: 1, noscript: 1, template: 1,
    svg: 1, math: 1, dialog: 1, canvas: 1
  };

  // 允许保留的标签
  var ALLOW = {
    a: 1, abbr: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, del: 1, ins: 1, mark: 1,
    small: 1, sub: 1, sup: 1, code: 1, pre: 1, kbd: 1, samp: 1, var: 1, span: 1,
    div: 1, p: 1, br: 1, hr: 1, blockquote: 1, q: 1, cite: 1, figure: 1, figcaption: 1,
    ul: 1, ol: 1, li: 1, dl: 1, dt: 1, dd: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, th: 1, td: 1, caption: 1, colgroup: 1, col: 1,
    img: 1, video: 1, audio: 1, source: 1, track: 1,
    details: 1, summary: 1, time: 1
  };

  // 各标签允许的属性（不在此表的属性一律删除，所以 onerror/onclick 等天然进不来）
  var ATTRS = {
    a: ['href', 'title'],
    abbr: ['title'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    video: ['src', 'poster', 'controls', 'loop', 'muted', 'preload', 'width', 'height', 'playsinline'],
    audio: ['src', 'controls', 'loop', 'muted', 'preload'],
    source: ['src', 'type'],
    track: ['src', 'kind', 'srclang', 'label', 'default'],
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'scope', 'headers'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    details: ['open'],
    col: ['span'],
    colgroup: ['span'],
    blockquote: ['cite'],
    q: ['cite'],
    time: ['datetime']
  };

  // 所有标签都允许的属性（class 供 marked / 代码高亮用；style 只留给媒体排版）
  var GLOBAL = { title: 1, class: 1, lang: 1, dir: 1 };
  var STYLE_OK = { img: 1, video: 1, audio: 1, figure: 1, table: 1 };

  // style 里允许的声明（只看属性名，值里再挡 url(/expression/behavior）
  var STYLE_PROPS = {
    'max-width': 1, 'max-height': 1, width: 1, height: 1, display: 1,
    margin: 1, 'margin-top': 1, 'margin-bottom': 1, 'margin-left': 1, 'margin-right': 1,
    'border-radius': 1, 'object-fit': 1,
  };

  // 布尔属性：值本身就是空字符串（<video controls>），去掉空值等于把属性删掉，所以要特殊保留
  var BOOL = { controls: 1, loop: 1, muted: 1, open: 1, reversed: 1, 'default': 1, playsinline: 1 };

  var SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
  var CTRL = /[\u0000-\u001f\u007f]/;

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 链接 / 图片地址校验：只放行 http(s)、站内相对地址、mailto/tel（仅链接）、位图 data: URL
  function safeUrl(raw, kind) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v || CTRL.test(v)) return '';
    // 浏览器会忽略协议里的空白与制表符（java\tscript:），判定前先去掉再比对
    var probe = v.replace(/[\s\u0000-\u001f\u007f]+/g, '');
    if (!SCHEME.test(probe)) return v;                       // 相对地址：f.php?id=… / /storage/… / //cdn…
    if (/^https?:/i.test(probe)) return v;
    if (kind === 'href' && /^(mailto|tel):/i.test(probe)) return v;
    if (kind === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(probe)) return v;
    return '';                                               // javascript: / vbscript: / data:text/html 等
  }

  // style 只保留排版相关的少量声明
  function safeStyle(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v || CTRL.test(v)) return '';
    if (/url\s*\(|expression|behavior|@import|\\/i.test(v)) return '';
    var out = [];
    v.split(';').forEach(function (decl) {
      var i = decl.indexOf(':');
      if (i < 0) return;
      var prop = decl.slice(0, i).trim().toLowerCase();
      var val = decl.slice(i + 1).trim();
      if (!STYLE_PROPS[prop] || !val) return;
      if (/[<>{}]/.test(val)) return;
      if (val.length > 60) return;
      out.push(prop + ': ' + val);
    });
    return out.join('; ');
  }

  function safeClass(raw) {
    var v = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_\- ]+/g, ' ').trim();
    if (!v) return '';
    return v.slice(0, 120);
  }

  function walk(node) {
    var kids = Array.prototype.slice.call(node.childNodes);
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      if (el.nodeType === 3) continue;                 // 文本节点保留
      if (el.nodeType !== 1) {                         // 注释、CDATA 等一律删除
        try { node.removeChild(el); } catch (e) { /* 忽略 */ }
        continue;
      }
      var tag = (el.tagName || '').toLowerCase();

      if (DROP[tag]) {                                 // 危险标签：连内容一起删
        try { node.removeChild(el); } catch (e) { /* 忽略 */ }
        continue;
      }
      if (!ALLOW[tag]) {                               // 未知标签：先清理子树，再去掉标签保留内容
        walk(el);
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        try { node.removeChild(el); } catch (e) { /* 忽略 */ }
        continue;
      }

      // ---- 属性过滤 ----
      var allowed = ATTRS[tag] || [];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var a = 0; a < attrs.length; a++) {
        var name = String(attrs[a].name || '').toLowerCase();
        var value = attrs[a].value;
        var keep = false, out = value;

        if (GLOBAL[name]) {
          keep = true;
          if (name === 'class') out = safeClass(value);
        } else if (allowed.indexOf(name) >= 0) {
          keep = true;
          if (BOOL[name]) {
            out = '';                                    // 布尔属性：保留空值，下面按 BOOL 特判写回
          } else if (name === 'href' || name === 'src' || name === 'cite' || name === 'poster') {
            out = safeUrl(value, name === 'href' ? 'href' : 'src');
            if (!out) keep = false;
          } else if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan' ||
                     name === 'start' || name === 'value' || name === 'span') {
            out = String(value).replace(/[^0-9\-]/g, '').slice(0, 6);
            if (!out) keep = false;
          } else if (name === 'loading') {
            out = /^(lazy|eager)$/i.test(value) ? value.toLowerCase() : '';
            if (!out) keep = false;
          }
        } else if (name === 'style' && STYLE_OK[tag]) {
          out = safeStyle(value);
          keep = !!out;
        }

        try {
          if (keep && (BOOL[name] || out !== '')) el.setAttribute(name, out);
          else el.removeAttribute(name);
        } catch (e) { /* 忽略异常属性 */ }
      }

      // ---- 个别标签的收尾处理 ----
      if (tag === 'img' && !el.getAttribute('src')) {   // 没有合法 src 的图片直接丢掉
        try { node.removeChild(el); } catch (e) { /* 忽略 */ }
        continue;
      }
      if (tag === 'a' && el.getAttribute('href')) {     // 外链统一新窗口 + 安全 rel
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }

      walk(el);
    }
  }

  // 简单结果缓存：同一条内容重复渲染时不用反复解析（列表/预览会重复调用）
  var cache = new Map();
  var CACHE_MAX = 300;

  function sanitizeHtml(dirty) {
    if (dirty == null) return '';
    var src = String(dirty);
    if (!src) return '';
    if (cache.has(src)) return cache.get(src);

    var out;
    try {
      if (typeof DOMParser === 'undefined') {
        out = escapeText(src);                          // 极端环境兜底：当纯文本
      } else {
        var doc = new DOMParser().parseFromString('<!doctype html><html><body>' + src, 'text/html');
        var body = doc.body || doc.documentElement;
        walk(body);
        out = body ? body.innerHTML : escapeText(src);
        // 兜底：即便走漏，也不允许出现脚本标签
        if (/<\s*script|<\s*iframe|on[a-z]+\s*=/i.test(out)) out = out.replace(/<\s*\/?\s*(script|iframe)[^>]*>/gi, '');
      }
    } catch (e) {
      out = escapeText(src);
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(src, out);
    return out;
  }

  window.sanitizeHtml = sanitizeHtml;
  // 方便其它脚本确认已经加载
  window.NFLSHC_SANITIZER = 'v1';
})();
