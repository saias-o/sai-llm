// Markdown to HTML for SAIAS Chat. Everything is escaped first, so model output can never inject
// markup; only the constructs below become HTML. Links are kept for http(s) addresses only.
'use strict';

(function (global) {
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    // Code spans first: their content is not formatted.
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(`<code>${code}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, before, url) =>
      `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // Models often break lines inside table cells with <br>: the one tag that is kept.
    s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  }

  function table(rows) {
    const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const align = cells(rows[1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
    const th = head.map((c, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</th>`).join('');
    const body = rows.slice(2).map(r => `<tr>${cells(r).map((c, i) => `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`).join('');
    return `<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function render(source) {
    const lines = escape(String(source || '')).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
      paragraph = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        flush();
        const close = fence[1];
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) code.push(lines[i++]);
        i++;
        const lang = fence[2] || 'text';
        out.push(`<div class="code"><div class="code-head"><span>${lang}</span><button class="copy-code" type="button">Copy</button></div><pre><code>${code.join('\n')}</code></pre></div>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${inline(heading[2].replace(/\s#+\s*$/, ''))}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        out.push(table(rows));
        continue;
      }
      if (/^\s*&gt;/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
        out.push(`<blockquote>${render.fromEscaped(quote.join('\n'))}</blockquote>`);
        continue;
      }
      const item = line.match(/^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/);
      if (item) {
        flush();
        out.push(list(lines, i, item[1].length, next => { i = next; }));
        continue;
      }
      paragraph.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  // Lists, nested by indentation.
  function list(lines, start, indent, done) {
    const first = lines[start].match(/^(\s*)([-*+]|\d{1,4}[.)])\s+/);
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/);
      if (!m || m[1].length < indent) break;
      if (m[1].length > indent) {
        const nested = list(lines, i, m[1].length, next => { i = next; });
        if (items.length) items[items.length - 1] += nested;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      let text = m[3];
      i++;
      // Continuation lines of the same item.
      while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d{1,4}[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
        text += '\n' + lines[i++].trim();
      }
      const task = text.match(/^\[([ xX])\]\s+(.*)$/s);
      items.push(task
        ? `<span class="task">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(task[2]).replace(/\n/g, '<br>')}`
        : inline(text).replace(/\n/g, '<br>'));
      if (i < lines.length && !lines[i].trim() && i + 1 < lines.length && /^(\s*)([-*+]|\d{1,4}[.)])\s+/.test(lines[i + 1])) i++;
    }
    done(i);
    const tag = ordered ? 'ol' : 'ul';
    const startAt = ordered ? Number(first[2].replace(/\D/g, '')) : 1;
    return `<${tag}${ordered && startAt !== 1 ? ` start="${startAt}"` : ''}>${items.map(x => `<li>${x}</li>`).join('')}</${tag}>`;
  }

  // For nested blocks whose text is already escaped.
  render.fromEscaped = text => {
    const unescape = s => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    return render(unescape(text));
  };

  global.SaiasMarkdown = { render, escape };
})(window);
