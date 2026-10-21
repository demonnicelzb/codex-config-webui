/* ============================================================
   Tiny Markdown renderer — no dependencies, XSS-safe (escape first),
   tolerant of partial blocks while streaming.
   Exposes window.Markdown.render(text)
   ============================================================ */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var LINK_MARK = '\u0000L';
  var CODE_MARK = '\u0000C';

  /** Inline formatting for one paragraph or list item. */
  function inline(text) {
    var codes = [];
    var links = [];

    // 1. Pull out inline code spans so their contents are never reformatted.
    var withCode = String(text).replace(/(`+)([\s\S]*?)\1/g, function (m, ticks, body) {
      codes.push('<code>' + escapeHtml(body.trim() || body) + '</code>');
      return CODE_MARK + (codes.length - 1) + '\u0000';
    });

    // 2. Escape HTML.
    var out = escapeHtml(withCode);

    // 3. Protect markdown links before the bare-URL pass.
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (m, label, href) {
      links.push('<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
      return LINK_MARK + (links.length - 1) + '\u0000';
    });

    // 4. Autolink bare URLs.
    out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"，。；：！？）])/g, function (m, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });

    // 5. Emphasis.
    out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>');

    // 6. Restore protected spans.
    out = out.replace(/\u0000L(\d+)\u0000/g, function (m, i) { return links[Number(i)] || ''; });
    out = out.replace(/\u0000C(\d+)\u0000/g, function (m, i) { return codes[Number(i)] || ''; });

    // 7. Hard breaks.
    return out.replace(/ {2,}\n/g, '<br>');
  }

  function isBlank(line) { return !line || !line.trim(); }

  var FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^`~\s]*)\s*$/;
  var HEADING_RE = /^(#{1,6})\s+(.*)$/;
  var HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
  var UL_RE = /^(\s*)[-*+]\s+(.*)$/;
  var OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

  function indentOf(spaces) { return String(spaces).replace(/\t/g, '    ').length; }

  function listMatch(line) {
    var ul = UL_RE.exec(line);
    if (ul) return { indent: indentOf(ul[1]), ordered: false, text: ul[2] };
    var ol = OL_RE.exec(line);
    if (ol) return { indent: indentOf(ol[1]), ordered: true, text: ol[3] };
    return null;
  }

  function isTableSep(line) {
    return !!line && line.indexOf('-') >= 0 && /^[\s|:-]+$/.test(line);
  }

  function splitCells(row) {
    var s = String(row).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map(function (x) { return x.trim(); });
  }

  /* --------------------------------------------------------------- lists --- */

  function collectListBlock(lines, start) {
    var block = [];
    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) {
        var next = lines[i + 1];
        if (next && (listMatch(next) || /^\s{2,}\S/.test(next))) { block.push(''); i++; continue; }
        break;
      }
      if (listMatch(line)) { block.push(line); i++; continue; }
      if (block.length && /^\s{2,}\S/.test(line)) { block.push(line); i++; continue; }
      break;
    }
    return { block: block, next: i };
  }

  /** Build an indentation tree: [{text, ordered, children:[]}] */
  function buildListTree(block) {
    var root = { indent: -1, children: [], text: '', ordered: false };
    var stack = [root];
    var last = null;

    for (var i = 0; i < block.length; i++) {
      var line = block[i];
      if (isBlank(line)) continue;
      var m = listMatch(line);
      if (!m) {
        if (last) last.text += ' ' + line.trim();
        continue;
      }
      var node = { indent: m.indent, ordered: m.ordered, text: m.text, children: [] };
      while (stack.length > 1 && m.indent <= stack[stack.length - 1].indent) stack.pop();
      var parent = stack[stack.length - 1];
      parent.children.push(node);
      stack.push(node);
      last = node;
    }
    return root.children;
  }

  function renderListNodes(nodes) {
    var html = '';
    var i = 0;
    while (i < nodes.length) {
      var ordered = nodes[i].ordered;
      var tag = ordered ? 'ol' : 'ul';
      html += '<' + tag + '>';
      while (i < nodes.length && nodes[i].ordered === ordered) {
        var node = nodes[i];
        var inner = inline(node.text);
        if (node.children.length) inner += renderListNodes(node.children);
        html += '<li>' + inner + '</li>';
        i++;
      }
      html += '</' + tag + '>';
    }
    return html;
  }

  /* -------------------------------------------------------------- blocks --- */

  function renderBlocks(lines) {
    var html = '';
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      // Fenced code (an unclosed fence is valid while streaming).
      var fence = FENCE_RE.exec(line);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = (fence[2] || '').trim();
        var body = [];
        i++;
        while (i < lines.length) {
          var close = FENCE_RE.exec(lines[i]);
          if (close && close[1].charAt(0) === marker && !close[2]) { i++; break; }
          body.push(lines[i]);
          i++;
        }
        html += '<div class="code-block" data-lang="' + escapeHtml(lang) + '">'
          + '<div class="code-head"><span class="lang">' + escapeHtml(lang || 'text') + '</span>'
          + '<button type="button" class="code-copy" data-copy>复制</button></div>'
          + '<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre></div>';
        continue;
      }

      // Heading
      var heading = HEADING_RE.exec(line);
      if (heading) {
        var level = Math.min(heading[1].length, 6);
        html += '<h' + level + '>' + inline(heading[2].trim()) + '</h' + level + '>';
        i++;
        continue;
      }

      // Horizontal rule
      if (HR_RE.test(line)) { html += '<hr />'; i++; continue; }

      // Blockquote
      if (QUOTE_RE.test(line)) {
        var quoted = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          quoted.push(QUOTE_RE.exec(lines[i])[1]);
          i++;
        }
        html += '<blockquote>' + renderBlocks(quoted) + '</blockquote>';
        continue;
      }

      // Table
      if (line.indexOf('|') >= 0 && lines[i + 1] && isTableSep(lines[i + 1])) {
        var header = splitCells(line);
        var rows = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) {
          rows.push(splitCells(lines[i]));
          i++;
        }
        var table = '<table><thead><tr>';
        for (var h = 0; h < header.length; h++) table += '<th>' + inline(header[h]) + '</th>';
        table += '</tr></thead><tbody>';
        for (var r = 0; r < rows.length; r++) {
          table += '<tr>';
          for (var c = 0; c < header.length; c++) table += '<td>' + inline(rows[r][c] || '') + '</td>';
          table += '</tr>';
        }
        html += table + '</tbody></table>';
        continue;
      }

      // Lists
      if (listMatch(line)) {
        var collected = collectListBlock(lines, i);
        html += renderListNodes(buildListTree(collected.block));
        i = collected.next;
        continue;
      }

      // Paragraph
      var para = [];
      while (i < lines.length && !isBlank(lines[i])) {
        var cur = lines[i];
        if (FENCE_RE.test(cur) || HEADING_RE.test(cur) || HR_RE.test(cur) || QUOTE_RE.test(cur) || listMatch(cur)) break;
        if (cur.indexOf('|') >= 0 && lines[i + 1] && isTableSep(lines[i + 1])) break;
        para.push(cur.trim());
        i++;
      }
      if (para.length) html += '<p>' + inline(para.join('\n')) + '</p>';
      else i++;
    }

    return html;
  }

  function render(markdown) {
    if (markdown === null || markdown === undefined) return '';
    var text = String(markdown).replace(/\r\n?/g, '\n');
    try {
      return renderBlocks(text.split('\n'));
    } catch (err) {
      return '<p>' + escapeHtml(text) + '</p>';
    }
  }

  global.Markdown = { render: render, escapeHtml: escapeHtml };
})(window);
