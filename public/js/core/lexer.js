// Bộ tách token cho JS / HTML / CSS — giữ nguyên vị trí (offset) để thay thế chính xác, không định dạng lại mã.

// ============================================================== JS
const PUNCT3 = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const REGEX_PREV_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WS_CODES = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0xfeff, 0x2028, 0x2029, 0x3000, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f]);
const ID_START = /[\p{ID_Start}$_\\]/u;
const ID_PART = /[\p{ID_Continue}$‌‍\\]/u;

/**
 * Tách token JS trong đoạn [start, end) của src.
 * Token: { type: 'ws'|'comment'|'ident'|'num'|'str'|'tmpl'|'regex'|'punct', start, end, value?, quote?, parts? }
 * tmpl.parts: [{ type:'str', start, end } | { type:'expr', start, end, tokens }]
 */
export function lexJs(src, start = 0, end = src.length) {
  return lexJsCore(src, start, end, false).tokens;
}

/** Lõi lexer. stopAtBrace=true: dừng ở dấu } không khớp (dùng cho ${...} trong template) */
function lexJsCore(src, start, end, stopAtBrace) {
  const tokens = [];
  let i = start;
  let lastSig = null;
  let depth = 0;
  const push = (t) => { tokens.push(t); if (t.type !== 'ws' && t.type !== 'comment') lastSig = t; };

  function regexAllowed() {
    if (!lastSig) return true;
    if (lastSig.type === 'num' || lastSig.type === 'str' || lastSig.type === 'tmpl' || lastSig.type === 'regex') return false;
    if (lastSig.type === 'ident') return REGEX_PREV_KEYWORDS.has(lastSig.value);
    if (lastSig.type === 'punct') return ![')', ']', '++', '--'].includes(lastSig.value);
    return true;
  }

  while (i < end) {
    const c = src[i];
    // khoảng trắng
    if (WS_CODES.has(c.charCodeAt(0))) {
      let j = i + 1;
      while (j < end && WS_CODES.has(src.charCodeAt(j))) j++;
      push({ type: 'ws', start: i, end: j });
      i = j; continue;
    }
    // chú thích
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < end && src[j] !== '\n' && src[j] !== '\r') j++;
      push({ type: 'comment', start: i, end: j });
      i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 || j + 2 > end ? end : j + 2;
      push({ type: 'comment', start: i, end: j });
      i = j; continue;
    }
    // chuỗi
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < end && src[j] !== c) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break; // chuỗi lỗi — dừng ở cuối dòng
        j++;
      }
      const close = j < end && src[j] === c;
      push({ type: 'str', start: i, end: close ? j + 1 : j, quote: c, cStart: i + 1, cEnd: j });
      i = close ? j + 1 : j; continue;
    }
    // template literal
    if (c === '`') {
      const t = lexTemplate(src, i, end);
      push(t);
      i = t.end; continue;
    }
    // số
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < end && /[0-9a-zA-Z_.]/.test(src[j])) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-')) j++;
        j++;
      }
      push({ type: 'num', start: i, end: j });
      i = j; continue;
    }
    // định danh (kể cả chữ Hán / tiếng Việt)
    if (ID_START.test(c) || (c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff)) {
      let j = i;
      while (j < end) {
        const cp = src.codePointAt(j);
        const ch = String.fromCodePoint(cp);
        if (j === i ? ID_START.test(ch) : ID_PART.test(ch)) { j += ch.length; continue; }
        if (src[j] === '\\' && src[j + 1] === 'u') { j += 2; continue; }
        break;
      }
      if (j === i) j = i + 1;
      push({ type: 'ident', start: i, end: j, value: src.slice(i, j) });
      i = j; continue;
    }
    // private field #x
    if (c === '#' && ID_START.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < end && ID_PART.test(src[j])) j++;
      push({ type: 'ident', start: i, end: j, value: src.slice(i, j) });
      i = j; continue;
    }
    // regex
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false, ok = false;
      while (j < end) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n' || ch === '\r') break;
        if (inClass) { if (ch === ']') inClass = false; }
        else if (ch === '[') inClass = true;
        else if (ch === '/') { ok = true; break; }
        j++;
      }
      if (ok) {
        j++;
        while (j < end && /[a-z]/i.test(src[j])) j++;
        push({ type: 'regex', start: i, end: j });
        i = j; continue;
      }
    }
    // dấu câu
    let p = null;
    for (const s of PUNCT3) if (src.startsWith(s, i)) { p = s; break; }
    if (!p) for (const s of PUNCT2) if (src.startsWith(s, i)) { p = s; break; }
    if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) p = null; // a?.5:b
    if (!p) p = c;
    if (stopAtBrace) {
      if (p === '{') depth++;
      else if (p === '}') {
        if (depth === 0) return { tokens, pos: i };
        depth--;
      }
    }
    push({ type: 'punct', start: i, end: i + p.length, value: p });
    i += p.length;
  }
  return { tokens, pos: end };
}

function lexTemplate(src, start, end) {
  const parts = [];
  let i = start + 1;
  let segStart = i;
  while (i < end) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      parts.push({ type: 'str', start: segStart, end: i });
      return { type: 'tmpl', start, end: i + 1, parts };
    }
    if (c === '$' && src[i + 1] === '{') {
      parts.push({ type: 'str', start: segStart, end: i });
      const exprStart = i + 2;
      const r = lexJsCore(src, exprStart, end, true);
      parts.push({ type: 'expr', start: exprStart, end: r.pos, tokens: r.tokens });
      i = r.pos + 1;
      segStart = i;
      continue;
    }
    i++;
  }
  if (segStart <= end) parts.push({ type: 'str', start: segStart, end });
  return { type: 'tmpl', start, end, parts, unterminated: true };
}

/** Danh sách token có nghĩa (bỏ ws/comment) kèm chỉ số gốc */
export function significant(tokens) {
  const out = [];
  tokens.forEach((t, idx) => { if (t.type !== 'ws' && t.type !== 'comment') out.push({ ...t, idx }); });
  return out;
}

// ============================================================== HTML
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
export { VOID_TAGS };

/**
 * Tách token HTML trong [start, end).
 * Token: text | comment | doctype | tag {name, close, selfClose, attrs:[{name, nStart, nEnd, vStart, vEnd, quote}]} | raw {tag, start, end}
 */
export function lexHtml(src, start = 0, end = src.length) {
  const tokens = [];
  let i = start;
  let textStart = i;
  const flushText = (to) => { if (to > textStart) tokens.push({ type: 'text', start: textStart, end: to }); };

  while (i < end) {
    if (src[i] !== '<') { i++; continue; }
    // chú thích
    if (src.startsWith('<!--', i)) {
      flushText(i);
      let j = src.indexOf('-->', i + 4);
      j = j < 0 || j + 3 > end ? end : j + 3;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j; textStart = i; continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      flushText(i);
      let j = src.indexOf('>', i + 2);
      j = j < 0 || j + 1 > end ? end : j + 1;
      tokens.push({ type: 'doctype', start: i, end: j });
      i = j; textStart = i; continue;
    }
    const isClose = src[i + 1] === '/';
    const nameStart = i + (isClose ? 2 : 1);
    if (!/[A-Za-z]/.test(src[nameStart] || '')) { i++; continue; }
    let j = nameStart;
    while (j < end && !/[\s/>]/.test(src[j])) j++;
    const name = src.slice(nameStart, j);
    const lower = name.toLowerCase();
    // thuộc tính
    const attrs = [];
    let k = j, selfClose = false, closed = false;
    while (k < end) {
      while (k < end && /\s/.test(src[k])) k++;
      if (src[k] === '>') { closed = true; k++; break; }
      if (src[k] === '/' && src[k + 1] === '>') { selfClose = true; closed = true; k += 2; break; }
      if (src[k] === '/') { k++; continue; }
      if (src[k] === '<') break; // thẻ lỗi
      const nS = k;
      while (k < end && !/[\s=>]/.test(src[k]) && !(src[k] === '/' && src[k + 1] === '>')) k++;
      const nE = k;
      if (nE === nS) { k++; continue; }
      while (k < end && /\s/.test(src[k])) k++;
      if (src[k] === '=') {
        k++;
        while (k < end && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") {
          const vS = k + 1;
          let vE = src.indexOf(q, vS);
          if (vE < 0 || vE > end) vE = end;
          attrs.push({ name: src.slice(nS, nE), nStart: nS, nEnd: nE, vStart: vS, vEnd: vE, quote: q });
          k = vE + 1;
        } else {
          const vS = k;
          while (k < end && !/[\s>]/.test(src[k])) k++;
          attrs.push({ name: src.slice(nS, nE), nStart: nS, nEnd: nE, vStart: vS, vEnd: k, quote: '' });
        }
      } else {
        attrs.push({ name: src.slice(nS, nE), nStart: nS, nEnd: nE, vStart: -1, vEnd: -1, quote: '' });
      }
    }
    if (!closed) {
      if (k >= end) {
        // thẻ dở dang tới hết đoạn (vd mảnh HTML trong chuỗi JS: '<input value="' + x) -> giữ nguyên, không phải chữ
        flushText(i);
        tokens.push({ type: 'partial', start: i, end });
        i = end; textStart = end;
        break;
      }
      i++; continue; // không phải thẻ hợp lệ -> coi như văn bản
    }
    flushText(i);
    tokens.push({ type: 'tag', start: i, end: k, name, lower, close: isClose, selfClose, attrs });
    i = k; textStart = i;
    if (!isClose && !selfClose && RAW_TEXT_TAGS.has(lower)) {
      // nội dung thô tới </tag
      const re = new RegExp('</' + lower + '\\s*>', 'ig');
      re.lastIndex = i;
      const m = re.exec(src);
      const rawEnd = m && m.index < end ? m.index : end;
      tokens.push({ type: 'raw', tag: lower, start: i, end: rawEnd, attrs });
      i = rawEnd; textStart = i;
    }
  }
  flushText(end);
  return tokens;
}

// ============================================================== CSS
/** Token CSS: ws/comment/str/other — đủ để tìm chuỗi trong thuộc tính content */
export function lexCss(src, start = 0, end = src.length) {
  const tokens = [];
  let i = start, oStart = i;
  const flush = (to) => { if (to > oStart) tokens.push({ type: 'other', start: oStart, end: to }); };
  while (i < end) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      flush(i);
      let j = src.indexOf('*/', i + 2);
      j = j < 0 || j + 2 > end ? end : j + 2;
      tokens.push({ type: 'comment', start: i, end: j });
      i = j; oStart = i; continue;
    }
    // chuỗi có dấu nháy bị escape bên trong chuỗi JS: \"...\" hoặc \'...\'
    if (c === '\\' && (src[i + 1] === '"' || src[i + 1] === "'")) {
      flush(i);
      const q = src[i + 1];
      let j = i + 2;
      while (j < end && src[j] !== '\n') {
        if (src[j] === '\\' && src[j + 1] === q) break;
        if (src[j] === '\\') j++;
        j++;
      }
      const close = j + 1 < end && src[j] === '\\' && src[j + 1] === q;
      tokens.push({ type: 'str', start: i, end: close ? j + 2 : j, quote: q, cStart: i + 2, cEnd: j });
      i = close ? j + 2 : j; oStart = i; continue;
    }
    if (c === '"' || c === "'") {
      flush(i);
      let j = i + 1;
      while (j < end && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      const close = src[j] === c;
      tokens.push({ type: 'str', start: i, end: close ? j + 1 : j, quote: c, cStart: i + 1, cEnd: j });
      i = close ? j + 1 : j; oStart = i; continue;
    }
    i++;
  }
  flush(end);
  return tokens;
}

/** Tên thuộc tính CSS đứng trước vị trí pos (để biết chuỗi có thuộc 'content:' không) */
export function cssPropertyBefore(src, pos, floor = 0) {
  let i = pos - 1;
  let depth = 0;
  while (i >= floor) {
    const c = src[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) break; depth--; }
    else if (depth === 0 && (c === ';' || c === '{' || c === '}')) return null;
    else if (depth === 0 && c === ':') {
      let j = i - 1;
      while (j >= floor && /\s/.test(src[j])) j--;
      const e = j + 1;
      while (j >= floor && /[\w-]/.test(src[j])) j--;
      return src.slice(j + 1, e).toLowerCase();
    }
    i--;
  }
  return null;
}
