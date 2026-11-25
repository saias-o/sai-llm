// SAI web tools: an MCP server (stdio, NDJSON JSON-RPC) that gives the SAI models web access.
//
// Tools (llama-server prefixes them with the server name "web"):
//   search    keyless web search, DuckDuckGo + Bing merged by reciprocal rank fusion
//   fetch     read a page as Markdown (static fetch, headless Chrome/Edge for JavaScript pages, PDF text)
//   research  search, then read the best pages in one call
//
// Node.js 22, no dependencies. Started by llama-server through --mcp-servers-json (see Launch-Inkling.cmd).
// Environment: SAI_BROWSER (path to a Chromium browser), SAI_WEB_ALLOW_PRIVATE=1 (allow local/LAN URLs).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { execFile } = require('node:child_process');

const VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const ALLOW_PRIVATE = process.env.SAI_WEB_ALLOW_PRIVATE === '1';

const err = (...a) => process.stderr.write(a.join(' ') + '\n');

// ---------------------------------------------------------------- entities / text

const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', hellip: '…', bull: '•', middot: '·', trade: '™', euro: '€', oelig: 'œ', OElig: 'Œ', rarr: '→', larr: '←', harr: '↔', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '', zwnj: '', lrm: '', rlm: '', prime: '′', Prime: '″', dagger: '†', permil: '‰', laquo: '«', raquo: '»', minus: '−', le: '≤', ge: '≥', ne: '≠', infin: '∞', asymp: '≈' };
LATIN1.forEach((n, i) => { ENTITIES[n] = String.fromCharCode(160 + i); });

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

const squash = s => s.replace(/[\s ]+/g, ' ').trim();
const stripTags = s => squash(decodeEntities(s.replace(/<[^>]*>/g, ' ')));

// ---------------------------------------------------------------- HTML parsing

const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW = new Set('script style textarea title noscript template xmp iframe noembed noframes'.split(' '));
const CLOSES_P = new Set('address article aside blockquote details div dl fieldset figure footer form h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul'.split(' '));

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const closeTo = (tag, stopAt) => {
    for (let n = cur; n && n !== root; n = n.parent) {
      if (stopAt && stopAt.has(n.tag)) return;
      if (n.tag === tag) { cur = n.parent; return; }
    }
  };
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))) {
    const [tok, closeTag, openTag, attrStr = ''] = m;
    if (closeTag) { closeTo(closeTag.toLowerCase()); continue; }
    if (openTag) {
      const tag = openTag.toLowerCase();
      if (cur.tag === 'p' && CLOSES_P.has(tag)) cur = cur.parent;
      if (tag === 'li') closeTo('li', new Set(['ul', 'ol']));
      else if (tag === 'dt' || tag === 'dd') { closeTo('dt', new Set(['dl'])); closeTo('dd', new Set(['dl'])); }
      else if (tag === 'tr') closeTo('tr', new Set(['table', 'tbody', 'thead', 'tfoot']));
      else if (tag === 'td' || tag === 'th') { closeTo('td', new Set(['tr', 'table'])); closeTo('th', new Set(['tr', 'table'])); }
      else if (tag === 'option' && cur.tag === 'option') cur = cur.parent;
      const node = { tag, attrs: parseAttrs(attrStr), children: [], parent: cur };
      cur.children.push(node);
      if (RAW.has(tag)) {
        const end = new RegExp(`</${tag}\\s*>`, 'ig');
        end.lastIndex = re.lastIndex;
        const em = end.exec(html);
        node.children.push(html.slice(re.lastIndex, em ? em.index : html.length));
        re.lastIndex = em ? em.index + em[0].length : html.length;
      } else if (!VOID.has(tag) && !/\/\s*$/.test(attrStr)) {
        cur = node;
      }
      continue;
    }
    if (tok[0] === '<' && tok.length > 1) continue; // comment, doctype, processing instruction
    cur.children.push(tok);
  }
  return root;
}

function* walk(node) {
  yield node;
  for (const c of node.children) if (typeof c !== 'string') yield* walk(c);
}

function findFirst(node, pred) {
  for (const n of walk(node)) if (pred(n)) return n;
  return null;
}

const textCache = new WeakMap();
function textOf(node) {
  if (typeof node === 'string') return decodeEntities(node);
  let t = textCache.get(node);
  if (t === undefined) {
    t = RAW.has(node.tag) && node.tag !== 'title' && node.tag !== 'textarea' ? '' : squash(node.children.map(textOf).join(' '));
    textCache.set(node, t);
  }
  return t;
}

function linkDensity(node) {
  const total = textOf(node).length;
  if (!total) return 1;
  let links = 0;
  for (const n of walk(node)) if (n.tag === 'a') links += textOf(n).length;
  return Math.min(1, links / total);
}

// ---------------------------------------------------------------- readability

const DROP = new Set('script style noscript template svg canvas iframe object embed nav aside footer dialog menu button input select textarea label form-control video audio map picture source head link meta'.split(' '));
const DROP_ROLES = new Set('navigation banner contentinfo complementary dialog alertdialog search menu menubar toolbar tablist'.split(' '));
const UNLIKELY = /\b(cookie|consent|gdpr|banner|breadcrumbs?|comments?|disqus|footer|header|masthead|menu|modal|navbar|nav|newsletter|popup|promo|related|share|sharing|sidebar|social|sponsor(ed)?|subscribe|advert(isement)?|ads?|outbrain|taboola|skip-link|toolbar|signup|paywall|widget)\b/i;
const LIKELY = /\b(article|body|content|entry|main|page|post|text|blog|story|prose|markdown|documentation|docs?)\b/i;

function prune(node, inArticle = false) {
  node.children = node.children.filter(ch => {
    if (typeof ch === 'string') return true;
    const t = ch.tag;
    if (DROP.has(t)) return false;
    if (t === 'header' && !inArticle) return false;
    const a = ch.attrs;
    if ('hidden' in a || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '')) return false;
    if (DROP_ROLES.has(a.role)) return false;
    if (t !== 'body' && t !== 'html' && t !== 'article' && t !== 'main') {
      const ci = `${a.class || ''} ${a.id || ''}`;
      if (UNLIKELY.test(ci) && !LIKELY.test(ci)) return false;
    }
    prune(ch, inArticle || t === 'article' || t === 'main');
    if (t === 'ul' || t === 'ol') {
      // pure link lists (language switchers, menus, tag clouds)
      const items = ch.children.filter(c => typeof c !== 'string' && c.tag === 'li');
      if (items.length >= 5 && linkDensity(ch) > 0.8 && textOf(ch).length / items.length < 40) return false;
    }
    return true;
  });
}

function mainContent(body) {
  const scores = new Map();
  for (const n of walk(body)) {
    if (!['p', 'pre', 'td', 'blockquote'].includes(n.tag)) continue;
    const t = textOf(n);
    if (t.length < 25) continue;
    const s = 1 + (t.match(/[,،，]/g) || []).length + Math.min(Math.floor(t.length / 100), 3);
    let p = n.parent;
    for (let level = 0; p && level < 3; level++, p = p.parent) {
      scores.set(p, (scores.get(p) || 0) + s / (level === 0 ? 1 : level === 1 ? 2 : 6));
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [n, s] of scores) {
    const adj = s * (1 - linkDensity(n));
    if (adj > bestScore) { best = n; bestScore = adj; }
  }
  const bodyLen = textOf(body).length;
  if (!best || textOf(best).length < bodyLen * 0.25) return body;
  // climb while the parent adds little (keeps the title and intro that sit next to the text block)
  while (best.parent && best.parent !== body && best.parent.tag !== '#root' && textOf(best.parent).length < textOf(best).length * 1.35) best = best.parent;
  // keep the siblings that also carry article text (sections split into several containers)
  const parent = best.parent;
  if (!parent || parent.tag === '#root') return best;
  const threshold = Math.max(10, bestScore * 0.2);
  const kept = parent.children.filter(c => {
    if (c === best) return true;
    if (typeof c === 'string') return false;
    if ((scores.get(c) || 0) * (1 - linkDensity(c)) >= threshold) return true;
    if (/^h[1-6]$/.test(c.tag)) return true;
    const t = textOf(c);
    return (c.tag === 'p' || c.tag === 'ul' || c.tag === 'ol' || c.tag === 'pre' || c.tag === 'table') && t.length > 80 && linkDensity(c) < 0.25;
  });
  return kept.length > 1 ? { tag: 'div', attrs: {}, children: kept, parent } : best;
}

// ---------------------------------------------------------------- Markdown rendering

function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

function rawText(node) {
  return typeof node === 'string' ? decodeEntities(node) : node.tag === 'br' ? '\n' : node.children.map(rawText).join('');
}

function toMarkdown(root, base, links) {
  const BLOCK = new Set('address article aside body center details div dl fieldset figcaption figure footer form header main nav p section summary html'.split(' '));
  function inner(node) { return node.children.map(render).join(''); }
  function render(node) {
    if (typeof node === 'string') return decodeEntities(node).replace(/[\s ]+/g, ' ');
    const t = node.tag;
    switch (t) {
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'img': return '';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const s = squash(inner(node));
        return s ? `\n\n${'#'.repeat(Number(t[1]))} ${s}\n\n` : '';
      }
      case 'pre': return '\n\n```\n' + rawText(node).replace(/^\n+|\s+$/g, '') + '\n```\n\n';
      case 'code': { const s = inner(node).trim(); return s ? '`' + s + '`' : ''; }
      case 'strong': case 'b': { const s = inner(node).trim(); return s ? ` **${s}** ` : ''; }
      case 'em': case 'i': { const s = inner(node).trim(); return s ? ` _${s}_ ` : ''; }
      case 'a': {
        const s = squash(inner(node));
        if (!s) return '';
        const href = node.attrs.href;
        if (!links || !href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return ` ${s} `;
        const abs = resolveUrl(href, base);
        return abs ? ` [${s}](${abs}) ` : ` ${s} `;
      }
      case 'ul': case 'ol': {
        let i = 0;
        const items = node.children.filter(c => typeof c !== 'string' && c.tag === 'li').map(li => {
          const body = clean(inner(li)).split('\n');
          const marker = t === 'ol' ? `${++i}. ` : '- ';
          return marker + body[0] + body.slice(1).map(l => (l ? '\n  ' + l : '\n')).join('');
        }).filter(s => s.trim().length > 2);
        return items.length ? '\n\n' + items.join('\n') + '\n\n' : '';
      }
      case 'li': return '\n- ' + squash(inner(node)) + '\n';
      case 'blockquote': {
        const s = clean(inner(node));
        return s ? '\n\n' + s.split('\n').map(l => '> ' + l).join('\n') + '\n\n' : '';
      }
      case 'dt': return '\n\n**' + squash(inner(node)) + '**\n';
      case 'dd': return '\n' + squash(inner(node)) + '\n';
      case 'table': return renderTable(node);
      default:
        return BLOCK.has(t) ? '\n\n' + inner(node) + '\n\n' : inner(node);
    }
  }
  function renderTable(table) {
    const rows = [];
    for (const n of walk(table)) {
      if (n.tag !== 'tr') continue;
      const cells = n.children.filter(c => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'));
      if (cells.length) rows.push(cells.map(c => squash(clean(inner(c)).replace(/\n+/g, ' ')).replace(/\|/g, '\\|')));
    }
    if (!rows.length) return '\n\n' + inner(table) + '\n\n';
    const layout = rows.some(r => r.some(c => c.length > 400)) || rows.every(r => r.length < 2);
    if (layout) return '\n\n' + rows.map(r => r.join('\n\n')).join('\n\n') + '\n\n';
    const width = Math.max(...rows.map(r => r.length));
    const line = r => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
    return '\n\n' + [line(rows[0]), '|' + ' --- |'.repeat(width), ...rows.slice(1).map(line)].join('\n') + '\n\n';
  }
  return clean(render(root));
}

function clean(s) {
  // normalize outside code fences only
  return s.split(/(\n```[\s\S]*?\n```)/).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, m => (m.includes('\n') ? '\n' : m))
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\*\* +([.,;:!?)])/g, '**$1')
      .replace(/ +([.,;:!?)])(?=\s|$)/g, '$1');
  }).join('').replace(/^\s+|\s+$/g, '');
}

function htmlToPage(html, base, links = true) {
  const doc = parseHtml(html);
  const titleNode = findFirst(doc, n => n.tag === 'title');
  const meta = name => findFirst(doc, n => n.tag === 'meta' && (n.attrs.property === name || n.attrs.name === name))?.attrs.content;
  const title = squash(meta('og:title') || (titleNode ? textOf(titleNode) : '') || '');
  const description = squash(meta('description') || meta('og:description') || '');
  const body = findFirst(doc, n => n.tag === 'body') || doc;
  prune(body);
  let markdown = toMarkdown(mainContent(body), base, links);
  if (markdown.length < 200) markdown = toMarkdown(body, base, links);
  const scripts = (html.match(/<script\b/gi) || []).length;
  return { title, description, markdown, scripts };
}

// ---------------------------------------------------------------- PDF text (best effort, no dependency)

function pdfToText(buf) {
  const src = buf.toString('latin1');
  const objects = new Map();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const decodeStream = (dict, data) => {
    if (/\/FlateDecode/.test(dict)) {
      for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) { try { return fn(data); } catch { /* try next */ } }
      try { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
    }
    return /\/Filter/.test(dict) ? null : data;
  };
  while ((m = objRe.exec(src))) {
    const start = objRe.lastIndex;
    const end = src.indexOf('endobj', start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const sIdx = body.search(/stream\r?\n/);
    let dict = body;
    let stream = null;
    if (sIdx >= 0) {
      dict = body.slice(0, sIdx);
      const dataStart = start + sIdx + body.slice(sIdx).match(/stream\r?\n/)[0].length;
      let dataEnd = src.lastIndexOf('endstream', end);
      if (dataEnd < dataStart) dataEnd = end;
      stream = decodeStream(dict, buf.subarray(dataStart, dataEnd));
    }
    objects.set(Number(m[1]), { dict, stream });
    objRe.lastIndex = end + 6;
  }
  // objects packed in object streams (PDF 1.5+)
  for (const o of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] || 0);
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] || 0);
    const text = o.stream.toString('latin1');
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[2 * i];
      const off = first + head[2 * i + 1];
      const next = i + 1 < n ? first + head[2 * i + 3] : text.length;
      if (!objects.has(num)) objects.set(num, { dict: text.slice(off, next), stream: null });
    }
  }
  const get = ref => objects.get(Number(ref));
  const refOf = (dict, key) => dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`))?.[1];
  const inlineDict = (dict, key) => {
    const i = dict.search(new RegExp(`/${key}\\s*<<`));
    if (i < 0) return null;
    let depth = 0;
    for (let j = dict.indexOf('<<', i); j < dict.length; j++) {
      if (dict.startsWith('<<', j)) { depth++; j++; } else if (dict.startsWith('>>', j)) { depth--; j++; if (!depth) return dict.slice(i, j + 1); }
    }
    return null;
  };
  const cmapCache = new Map();
  const parseCMap = ref => {
    if (cmapCache.has(ref)) return cmapCache.get(ref);
    const o = get(ref);
    const map = new Map();
    let width = 1;
    if (o?.stream) {
      const t = o.stream.toString('latin1');
      const cs = t.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
      if (cs) width = cs[1].length / 2;
      const hexToStr = h => { let s = ''; for (let i = 0; i + 3 < h.length + 0; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s || String.fromCharCode(parseInt(h, 16)); };
      for (const blk of t.match(/beginbfchar[\s\S]*?endbfchar/g) || []) {
        for (const p of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), hexToStr(p[2]));
      }
      for (const blk of t.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
        for (const p of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
          const lo = parseInt(p[1], 16); const hi = parseInt(p[2], 16);
          if (p[4]) { const baseCode = parseInt(p[4], 16); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCodePoint(baseCode + c - lo)); }
          else { const list = [...p[5].matchAll(/<([0-9a-fA-F]+)>/g)]; list.forEach((x, k) => map.set(lo + k, hexToStr(x[1]))); }
        }
      }
    }
    const res = { map, width };
    cmapCache.set(ref, res);
    return res;
  };
  const fontsFor = pageDict => {
    let res = inlineDict(pageDict, 'Resources');
    if (!res) { const r = refOf(pageDict, 'Resources'); res = r ? get(r)?.dict : ''; }
    if (!res) return {};
    let fontDict = inlineDict(res, 'Font');
    if (!fontDict) { const r = refOf(res, 'Font'); fontDict = r ? get(r)?.dict : ''; }
    const fonts = {};
    for (const f of (fontDict || '').matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fo = get(f[2]);
      const tu = fo && refOf(fo.dict, 'ToUnicode');
      fonts[f[1]] = tu ? parseCMap(tu) : null;
    }
    return fonts;
  };
  const unescapeLiteral = s => s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (x, e) => {
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[e] ?? '';
  });
  const decodeBytes = (bytes, font) => {
    if (!font) return bytes;
    let out = '';
    for (let i = 0; i < bytes.length; i += font.width) {
      let code = 0;
      for (let k = 0; k < font.width; k++) code = (code << 8) | (bytes.charCodeAt(i + k) || 0);
      out += font.map.get(code) ?? (font.width === 1 ? bytes[i] : '');
    }
    return out;
  };
  const contentText = (data, fonts) => {
    const s = data.toString('latin1');
    let out = '';
    let font = null;
    const tok = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|\[|\]|\/[^\s/<>\[\]()]+|-?\d*\.?\d+|[A-Za-z'"*]+/g;
    let t; const stack = [];
    while ((t = tok.exec(s))) {
      const v = t[0];
      if (v[0] === '(') stack.push({ str: unescapeLiteral(v.slice(1, -1)) });
      else if (v[0] === '<') { const h = v.slice(1, -1).replace(/\s/g, ''); let b = ''; for (let i = 0; i < h.length; i += 2) b += String.fromCharCode(parseInt(h.slice(i, i + 2).padEnd(2, '0'), 16)); stack.push({ str: b }); }
      else if (v[0] === '/' || v === '[' || v === ']' || /^-?\d/.test(v) || /^\.\d/.test(v)) stack.push({ op: v });
      else {
        if (v === 'Tf') { const name = [...stack].reverse().find(x => x.op && x.op[0] === '/'); font = name ? fonts[name.op.slice(1)] ?? null : null; }
        else if (v === 'Tj' || v === "'" || v === '"' || v === 'TJ') {
          if (v === "'" || v === '"') out += '\n';
          let line = '';
          for (const x of stack) {
            if (x.str !== undefined) line += decodeBytes(x.str, font);
            else if (v === 'TJ' && /^-?\d/.test(x.op) && Number(x.op) < -180) line += ' ';
          }
          out += line;
        } else if (v === 'Td' || v === 'TD' || v === 'T*') {
          const ty = Number(stack[stack.length - 1]?.op);
          out += v === 'T*' || (Number.isFinite(ty) && ty !== 0) ? '\n' : ' ';
        } else if (v === 'Tm') out += '\n';
        else if (v === 'ET') out += '\n';
        stack.length = 0;
      }
    }
    return out;
  };
  // pages in document order through the page tree
  const pages = [];
  const visit = (ref, depth = 0) => {
    const o = get(ref);
    if (!o || depth > 50) return;
    if (/\/Type\s*\/Pages\b/.test(o.dict)) {
      const kids = o.dict.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] || '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) visit(k[1], depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(o);
  };
  const rootRef = src.match(/\/Root\s+(\d+)\s+\d+\s+R/)?.[1];
  const pagesRef = rootRef && refOf(get(rootRef)?.dict || '', 'Pages');
  if (pagesRef) visit(pagesRef);
  if (!pages.length) for (const o of objects.values()) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(o);
  const parts = [];
  for (const [i, page] of pages.entries()) {
    const fonts = fontsFor(page.dict);
    const arr = page.dict.match(/\/Contents\s*\[([^\]]*)\]/)?.[1];
    const refs = arr ? [...arr.matchAll(/(\d+)\s+\d+\s+R/g)].map(x => x[1]) : [refOf(page.dict, 'Contents')].filter(Boolean);
    const text = refs.map(r => get(r)?.stream).filter(Boolean).map(d => contentText(d, fonts)).join('\n');
    parts.push(`\n\n--- Page ${i + 1} ---\n\n` + text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  const text = parts.join('').trim();
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const bad = (text.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
  if (letters < 50 || bad > letters * 0.05) return null;
  return { pages: pages.length, text };
}

// ---------------------------------------------------------------- network

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid URL: ${raw}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.');
  if (!ALLOW_PRIVATE) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
    if (host === 'localhost' || host.endsWith('.localhost') || addrs.some(isPrivateIp)) {
      throw new Error('Local and private network addresses are blocked. Set SAI_WEB_ALLOW_PRIVATE=1 to allow them.');
    }
  }
  return url;
}

async function download(url, { timeout = 25000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method, body, redirect: 'follow', signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,text/plain;q=0.8,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9', ...headers },
  });
  const chunks = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOWNLOAD) { truncated = true; await reader.cancel(); break; }
      chunks.push(value);
    }
  }
  return { status: res.status, ok: res.ok, url: res.url || url, type: res.headers.get('content-type') || '', buf: Buffer.concat(chunks), truncated };
}

function decodeText(buf, type) {
  let charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

function findBrowser() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [process.env.SAI_BROWSER];
  for (const base of pf) {
    candidates.push(
      path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(base, 'Chromium', 'Application', 'chrome.exe'),
    );
  }
  candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find(p => p && fs.existsSync(p)) || null;
}
const BROWSER = findBrowser();

function renderWithBrowser(url) {
  if (!BROWSER) return Promise.reject(new Error('No Chromium browser (Chrome, Edge, Brave) found for JavaScript rendering. Set SAI_BROWSER.'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sai-web-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    `--user-agent=${UA}`, '--lang=en-US', `--user-data-dir=${profile}`, '--virtual-time-budget=12000', '--dump-dom', url];
  return new Promise((resolve, reject) => {
    execFile(BROWSER, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (e, stdout) => {
      setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 2000);
      if (e && !stdout) reject(new Error('Browser rendering failed: ' + e.message.split('\n')[0]));
      else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------- fetch tool

const pageCache = new Map(); // key -> {title, url, content, kind}
function cachePut(key, v) {
  pageCache.set(key, v);
  if (pageCache.size > 40) pageCache.delete(pageCache.keys().next().value);
}

async function readPage(rawUrl, { render = 'auto', links = true } = {}) {
  const key = `${rawUrl}|${render}|${links}`;
  if (pageCache.has(key)) return pageCache.get(key);
  const url = (await checkUrl(rawUrl)).href;
  let page;
  if (render === 'always') {
    const html = await renderWithBrowser(url);
    page = { ...htmlToPage(html, url, links), url, kind: 'html (rendered)' };
  } else {
    const r = await download(url);
    if (!r.ok && r.status !== 203) {
      if (render === 'auto' && BROWSER && [401, 403, 429, 503].includes(r.status)) {
        const html = await renderWithBrowser(url);
        page = { ...htmlToPage(html, url, links), url, kind: 'html (rendered)' };
      } else throw new Error(`HTTP ${r.status} for ${url}`);
    } else {
      await checkUrl(r.url); // redirects must not lead into the local network either
      const type = r.type.toLowerCase();
      const isPdf = type.includes('application/pdf') || r.buf.subarray(0, 5).toString('latin1') === '%PDF-';
      if (isPdf) {
        const pdf = pdfToText(r.buf);
        if (!pdf) throw new Error('This PDF has no extractable text layer (scanned or unusual font encoding).');
        page = { title: path.basename(new URL(r.url).pathname), description: `PDF, ${pdf.pages} pages`, markdown: pdf.text, url: r.url, kind: 'pdf' };
      } else if (/html|xml/.test(type) || !type) {
        const html = decodeText(r.buf, r.type);
        page = { ...htmlToPage(html, r.url, links), url: r.url, kind: 'html' };
        if (render === 'auto' && BROWSER && page.markdown.length < 600 && page.scripts > 0) {
          try {
            const rendered = htmlToPage(await renderWithBrowser(r.url), r.url, links);
            if (rendered.markdown.length > page.markdown.length) page = { ...rendered, url: r.url, kind: 'html (rendered)' };
          } catch (e) { err('render fallback failed:', e.message); }
        }
      } else if (/^text\/|json|javascript|csv|yaml|markdown/.test(type)) {
        page = { title: path.basename(new URL(r.url).pathname), description: type, markdown: decodeText(r.buf, r.type), url: r.url, kind: type.split(';')[0] };
      } else {
        throw new Error(`Unsupported content type: ${type || 'unknown'} (${(r.buf.length / 1024).toFixed(0)} KB).`);
      }
      if (r.truncated) page.markdown += '\n\n[Download stopped at 15 MB.]';
    }
  }
  cachePut(key, page);
  return page;
}

function formatPage(page, start = 0, max = 12000) {
  const total = page.markdown.length;
  const slice = page.markdown.slice(start, start + max);
  const head = [`# ${page.title || page.url}`, `URL: ${page.url}`];
  if (page.description) head.push(`Description: ${page.description}`);
  head.push(`Characters ${start}-${start + slice.length} of ${total}`);
  let out = head.join('\n') + '\n\n' + (slice || '(no readable text)');
  if (start + slice.length < total) out += `\n\n[Truncated. Call the fetch tool again with start_index=${start + slice.length} to continue.]`;
  return out;
}

// ---------------------------------------------------------------- search

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase();
  } catch { return u; }
}

async function searchDuckDuckGo(query, { region, time }) {
  const params = new URLSearchParams({ q: query });
  if (region) params.set('kl', region.toLowerCase());
  if (time) params.set('df', { day: 'd', week: 'w', month: 'm', year: 'y' }[time]);
  const r = await download('https://html.duckduckgo.com/html/', {
    method: 'POST', body: params.toString(), timeout: 12000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://html.duckduckgo.com/' },
  });
  const html = decodeText(r.buf, r.type);
  if (/anomaly-modal|challenge-form/.test(html)) throw new Error('DuckDuckGo asked for a challenge');
  const results = [];
  for (const block of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue;
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: stripTags(a[2]), url: href, snippet: snip ? stripTags(snip[1]) : '' });
  }
  return results;
}

async function searchBing(query, { region, time }) {
  const params = new URLSearchParams({ q: query, count: '20' });
  if (region) {
    const [lang, cc] = region.toLowerCase().split('-');
    if (cc) params.set('cc', cc.toUpperCase());
    if (lang) params.set('setlang', lang);
  }
  if (time) {
    const ez = { day: 'ez1', week: 'ez2', month: 'ez3' }[time];
    if (ez) params.set('filters', `ex1:"${ez}"`);
  }
  const r = await download('https://www.bing.com/search?' + params, { timeout: 12000 });
  const html = decodeText(r.buf, r.type);
  const results = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const h = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!h) continue;
    let href = decodeEntities(h[1]);
    const u = /[?&]u=a1([^&]+)/.exec(href);
    if (u) {
      try { href = Buffer.from(u[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* keep the redirect */ }
    }
    if (!/^https?:/.test(href)) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block) || /class="b_caption"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    results.push({ title: stripTags(h[2]), url: href, snippet: p ? stripTags(p[1]).replace(/^Web\s+/, '') : '' });
  }
  return results;
}

const ENGINES = { duckduckgo: searchDuckDuckGo, bing: searchBing };

async function webSearch(query, { max = 10, region, time } = {}) {
  const settled = await Promise.allSettled(Object.entries(ENGINES).map(async ([name, fn]) => ({ name, results: await fn(query, { region, time }) })));
  const merged = new Map();
  const failures = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') { failures.push(s.reason?.message || String(s.reason)); continue; }
    const { name, results } = s.value;
    if (!results.length) failures.push(`${name}: no results`);
    results.forEach((r, rank) => {
      const key = normalizeUrl(r.url);
      const cur = merged.get(key) || { ...r, score: 0, engines: [] };
      cur.score += 1 / (60 + rank);
      cur.engines.push(name);
      if (!cur.snippet && r.snippet) cur.snippet = r.snippet;
      merged.set(key, cur);
    });
  }
  const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, max);
  return { results, failures };
}

function formatResults(query, { results, failures }) {
  const lines = [`Web results for "${query}" (date: ${new Date().toISOString().slice(0, 10)})`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || r.url}`, `   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  if (!results.length) lines.push('No results.' + (failures.length ? ' Engines: ' + failures.join('; ') : ''));
  lines.push('', 'Read a page with the fetch tool (URL above) for details.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- tools

const clampInt = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.trunc(Number(v)))) : d);
const TIME = { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from the last day, week, month or year.' };
const REGION = { type: 'string', description: 'Region and language, for example fr-fr, en-us or de-de. Defaults to automatic.' };

const TOOLS = [
  {
    name: 'search',
    description: 'Search the web (DuckDuckGo and Bing, merged). Returns titles, URLs and snippets. Use it for current events, facts you are not sure about, documentation, prices or anything after your training data. Then read promising pages with the fetch tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Use precise keywords, in the language of the expected sources.' },
        max_results: { type: 'integer', description: 'Number of results, 1-20. Default 10.' },
        region: REGION,
        time_range: TIME,
      },
      required: ['query'],
    },
    async run(a) {
      const query = String(a.query || '').trim();
      if (!query) throw new Error('query is required');
      return formatResults(query, await webSearch(query, { max: clampInt(a.max_results, 1, 20, 10), region: a.region, time: a.time_range }));
    },
  },
  {
    name: 'fetch',
    description: 'Read a web page or PDF and return its main content as Markdown, with links. JavaScript-heavy pages are rendered in a headless browser automatically. Long pages are paginated: call again with start_index to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http or https URL.' },
        max_chars: { type: 'integer', description: 'Maximum characters to return, 1000-60000. Default 12000.' },
        start_index: { type: 'integer', description: 'Character offset to start from, for the next part of a long page. Default 0.' },
        render: { type: 'string', enum: ['auto', 'always', 'never'], description: 'Headless browser rendering. auto (default) renders when the static page has little text.' },
        include_links: { type: 'boolean', description: 'Keep links in the Markdown. Default true.' },
      },
      required: ['url'],
    },
    async run(a) {
      const page = await readPage(String(a.url || ''), { render: ['auto', 'always', 'never'].includes(a.render) ? a.render : 'auto', links: a.include_links !== false });
      return formatPage(page, clampInt(a.start_index, 0, Number.MAX_SAFE_INTEGER, 0), clampInt(a.max_chars, 1000, 60000, 12000));
    },
  },
  {
    name: 'research',
    description: 'Search the web and read the top pages in one step. Returns the result list followed by the main text of the best pages. Prefer this for questions that need facts from several sources.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        pages: { type: 'integer', description: 'Number of pages to read, 1-6. Default 3.' },
        chars_per_page: { type: 'integer', description: 'Characters kept per page, 1000-15000. Default 5000.' },
        region: REGION,
        time_range: TIME,
      },
      required: ['query'],
    },
    async run(a) {
      const query = String(a.query || '').trim();
      if (!query) throw new Error('query is required');
      const nPages = clampInt(a.pages, 1, 6, 3);
      const perPage = clampInt(a.chars_per_page, 1000, 15000, 5000);
      const found = await webSearch(query, { max: 10, region: a.region, time: a.time_range });
      const out = [formatResults(query, found).replace(/\n\nRead a page with the fetch tool[^\n]*$/, '')];
      const reads = [];
      for (const r of found.results) {
        if (reads.length >= nPages + 2) break;
        reads.push(r);
      }
      const settled = await Promise.allSettled(reads.map(r => readPage(r.url, { links: false })));
      let used = 0;
      settled.forEach((s, i) => {
        if (used >= nPages) return;
        if (s.status === 'fulfilled' && s.value.markdown.length > 200) {
          used++;
          out.push('\n\n======== Source ' + used + ' ========\n' + formatPage(s.value, 0, perPage).replace(/Call the fetch tool again/, 'Call the fetch tool'));
        } else if (s.status === 'rejected') err(`research: ${reads[i].url}: ${s.reason?.message}`);
      });
      if (!used) out.push('\n\nNo page could be read. Try the fetch tool on individual results.');
      return out.join('');
    },
  },
];

// ---------------------------------------------------------------- MCP stdio server

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function onMessage(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled)
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sai-web', version: VERSION },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const text = await tool.run(params.arguments || {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

// CLI test mode: node sai-web.js search "query" | fetch URL | research "query"
if (process.argv[2] && TOOLS.some(t => t.name === process.argv[2])) {
  const tool = TOOLS.find(t => t.name === process.argv[2]);
  const arg = process.argv.slice(3).join(' ');
  const args = tool.name === 'fetch' ? { url: arg } : { query: arg };
  tool.run(args).then(t => process.stdout.write(t + '\n'), e => { err('Error:', e.message); process.exitCode = 1; });
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    onMessage(msg).catch(e => msg.id != null && fail(msg.id, -32603, e.message));
  });
  rl.on('close', () => process.exit(0));
  err(`sai-web ${VERSION} ready${BROWSER ? ` (browser: ${BROWSER})` : ' (no browser for JavaScript rendering)'}`);
}
