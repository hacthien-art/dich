// Bộ tách token cho JS / HTML / CSS — giữ nguyên vị trí (offset) để thay thế chính xác, không định dạng lại mã.

// ============================================================== JS
const PUNCT3 = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const REGEX_PREV_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WS_CODES = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0xfeff, 0x2028, 0x2029, 0x3000, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f]);
const ID_START = /[\p{ID_Start}$_\\]/u;
const ID_PART = /[\p{ID_Continue}$‌‍\\]/u;

/** Literal dữ liệu thuần từ cỡ này trở lên được lexer gói thành MỘT token 'data' (không tách từng token bên trong) */
export const DATA_MIN = 20000;

/**
 * Tách token JS trong đoạn [start, end) của src.
 * Token: { type: 'ws'|'comment'|'ident'|'num'|'str'|'tmpl'|'regex'|'punct'|'data', start, end, value?, quote?, parts? }
 * tmpl.parts: [{ type:'str', start, end } | { type:'expr', start, end, tokens }]
 * opts.data = true: object/array chỉ gồm hằng (JSON, bảng dữ liệu) dài ≥ DATA_MIN thành một token 'data' — tránh tạo
 * hàng chục triệu token cho các khối dữ liệu nhúng cỡ chục MB (bản đồ, bảng tra…). Duyệt bên trong bằng walkData().
 */
export function lexJs(src, start = 0, end = src.length, opts = null) {
  return lexJsCore(src, start, end, false, !!opts?.data).tokens;
}

/** Lõi lexer. stopAtBrace=true: dừng ở dấu } không khớp (dùng cho ${...} trong template) */
function lexJsCore(src, start, end, stopAtBrace, dataTokens = false) {
  const tokens = [];
  let i = start;
  let lastSig = null;
  let depth = 0;
  const push = (t) => { tokens.push(t); if (t.type !== 'ws' && t.type !== 'comment') lastSig = t; };

  function regexAllowed() {
    if (!lastSig) return true;
    if (lastSig.type === 'num' || lastSig.type === 'str' || lastSig.type === 'tmpl' || lastSig.type === 'regex' || lastSig.type === 'data') return false;
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
      const t = lexTemplate(src, i, end, dataTokens);
      push(t);
      i = t.end; continue;
    }
    // khối dữ liệu thuần lớn: { … } / [ … ] ở vị trí biểu thức
    if (dataTokens && (c === '{' || c === '[') && end - i >= DATA_MIN && regexAllowed()) {
      const de = walkData(src, i, end, null);
      if (de > 0 && de - i >= DATA_MIN) {
        push({ type: 'data', start: i, end: de });
        i = de; continue;
      }
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

function lexTemplate(src, start, end, dataTokens = false) {
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
      const r = lexJsCore(src, exprStart, end, true, dataTokens);
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

// ============================================================== dữ liệu thuần (JSON / literal JS chỉ gồm hằng)
/** Mã ký tự là chữ Hán / Kana / Hangul (cùng tập với hasCJK ở util.js) */
function isHanCode(c) {
  return c >= 0x3040 && ((c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff));
}
const isWsCode = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || c === 0x3000 || c === 11 || c === 12;
const isIdentCode = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || (c >= 0x80 && !isWsCode(c));
const DATA_WORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

/**
 * Duyệt một literal dữ liệu thuần bắt đầu tại src[start] ('{' hoặc '['): JSON, hoặc object/array JS chỉ gồm chuỗi, số,
 * true/false/null, !0/!1, void 0, khóa trần / khóa trong nháy, dấu phẩy thừa, chú thích. KHÔNG tạo token.
 * Trả về vị trí ngay sau dấu đóng; -1 nếu gặp thứ không phải dữ liệu (hàm, biến, phép toán, template có ${}…).
 * visitor (có thể null — chỉ kiểm tra):
 *   key(kS, kE, quote, han)                — khóa của object; quote = '' nếu là định danh trần
 *   value(vS, vE, quote, han, keyS, keyE)  — giá trị chuỗi; keyS/keyE: khóa đang chứa nó (mảng thừa hưởng khóa của
 *                                            thuộc tính chứa mảng; -1 nếu không có)
 * kS/kE, vS/vE là phạm vi NỘI DUNG (không gồm dấu nháy); han = chuỗi có chữ Hán/Kana/Hangul.
 */
export function walkData(src, start, end, visitor) {
  const isObj = [], keyS = [], keyE = [];
  let sp = -1, i = start;
  let state = 0; // 0 chờ giá trị · 1 chờ khóa · 2 sau giá trị · 3 chờ dấu ':'
  for (;;) {
    // khoảng trắng + chú thích
    for (;;) {
      if (i >= end) return -1;
      const w = src.charCodeAt(i);
      if (isWsCode(w)) { i++; continue; }
      if (w === 47) {
        const d = src.charCodeAt(i + 1);
        if (d === 47) { const nl = src.indexOf('\n', i + 2); i = nl < 0 || nl >= end ? end : nl + 1; continue; }
        if (d === 42) { const ce = src.indexOf('*/', i + 2); if (ce < 0 || ce + 2 > end) return -1; i = ce + 2; continue; }
        return -1;
      }
      break;
    }
    const c = src.charCodeAt(i);
    if (state === 2) {
      if (c === 44) { i++; state = isObj[sp] ? 1 : 0; continue; }
      if ((c === 125 && isObj[sp]) || (c === 93 && !isObj[sp])) { sp--; i++; if (sp < 0) return i; continue; }
      return -1;
    }
    if (state === 3) {
      if (c !== 58) return -1;
      i++; state = 0; continue;
    }
    // chuỗi (giá trị hoặc khóa)
    if (c === 34 || c === 39 || c === 96) {
      let j = i + 1, han = false;
      for (;;) {
        if (j >= end) return -1;
        const d = src.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === c) break;
        if (d === 10 && c !== 96) return -1;
        if (c === 96 && d === 36 && src.charCodeAt(j + 1) === 123) return -1; // `…${}…`
        if (d >= 0x3040 && !han && isHanCode(d)) han = true;
        j++;
      }
      if (state === 1) {
        keyS[sp] = i + 1; keyE[sp] = j;
        if (han && visitor) visitor.key(i + 1, j, src[i], true);
        state = 3;
      } else {
        if (han && visitor) visitor.value(i + 1, j, src[i], true, sp >= 0 ? keyS[sp] : -1, sp >= 0 ? keyE[sp] : -1);
        state = 2;
      }
      i = j + 1;
      continue;
    }
    if (state === 1) {
      if (c === 125) { sp--; i++; if (sp < 0) return i; state = 2; continue; } // {} hoặc dấu phẩy thừa
      if (!isIdentCode(c)) return -1;
      let j = i + 1, han = c >= 0x3040 && isHanCode(c);
      while (j < end) {
        const d = src.charCodeAt(j);
        if (!isIdentCode(d)) break;
        if (d >= 0x3040 && !han && isHanCode(d)) han = true;
        j++;
      }
      keyS[sp] = i; keyE[sp] = j;
      if (han && visitor) visitor.key(i, j, '', true);
      i = j; state = 3;
      continue;
    }
    // state 0: giá trị
    if (c === 123) { sp++; isObj[sp] = true; keyS[sp] = -1; keyE[sp] = -1; i++; state = 1; continue; }
    if (c === 91) {
      const ks = sp >= 0 ? keyS[sp] : -1, ke = sp >= 0 ? keyE[sp] : -1;
      sp++; isObj[sp] = false; keyS[sp] = ks; keyE[sp] = ke; i++;
      continue;
    }
    if (c === 93 && sp >= 0 && !isObj[sp]) { sp--; i++; if (sp < 0) return i; state = 2; continue; } // [] hoặc dấu phẩy thừa
    if (c === 44 && sp >= 0 && !isObj[sp]) { i++; continue; } // ô trống trong mảng
    if (sp < 0) return -1;
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      let j = i + 1;
      while (j < end) {
        const d = src.charCodeAt(j);
        if ((d >= 48 && d <= 57) || d === 46 || d === 95 || (d >= 97 && d <= 102) || (d >= 65 && d <= 70) || d === 120 || d === 88 || d === 111 || d === 79 || d === 110) { j++; continue; }
        if ((d === 43 || d === 45) && (src.charCodeAt(j - 1) | 32) === 101) { j++; continue; }
        break;
      }
      if (j === i + 1 && (c === 45 || c === 43 || c === 46)) return -1;
      i = j; state = 2;
      continue;
    }
    if (c === 33) { // !0 / !1
      const d = src.charCodeAt(i + 1);
      if (d !== 48 && d !== 49) return -1;
      i += 2; state = 2;
      continue;
    }
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
      let j = i + 1;
      while (j < end && isIdentCode(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      if (word === 'void') {
        while (j < end && isWsCode(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) !== 48) return -1;
        j++;
      } else if (!DATA_WORDS.has(word)) return -1;
      i = j; state = 2;
      continue;
    }
    return -1;
  }
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
    const tagAttrs = lexAttrs(src, j, end);
    if (tagAttrs.closed) recoverBrokenQuotes(src, tagAttrs, end);
    const { attrs, selfClose, closed } = tagAttrs;
    const k = tagAttrs.k;
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

/** Đọc danh sách thuộc tính của thẻ từ vị trí k tới dấu > — trả về { attrs, k (sau >), selfClose, closed } */
function lexAttrs(src, k, end) {
  const attrs = [];
  let selfClose = false, closed = false;
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
  return { attrs, k, selfClose, closed };
}

const QUOTE_IN_NAME = /["']/;
const CJK_IN_NAME = /[⺀-鿿豈-﫿＀-￯]/;

/**
 * Giá trị thuộc tính có dấu nháy lồng KHÔNG escape, vd:
 *   data-prompt="…当被问及"闪闪发光"的留学生活时… 【/开场白】">
 * Đọc đúng chuẩn HTML thì giá trị kết thúc ở nháy lồng đầu tiên, phần sau thành một dãy "thuộc tính rác" -> không được
 * dịch (sót chữ Hán) và nhãn đóng 【/开场白】 không được đổi theo từ điển (regex sau dịch hết khớp).
 * Ở đây ta nhận ra trường hợp đó và kéo giá trị tới nháy đóng thật: nháy cùng loại mà theo sau là khoảng trắng / dấu >
 * và phần còn lại của thẻ đọc ra các thuộc tính sạch. Thuộc tính được đánh dấu `recovered` để bộ phân tích giữ nguyên
 * từng dấu nháy lồng (mã gốc không bị đổi).
 */
function recoverBrokenQuotes(src, r, end) {
  for (let n = 0; n < r.attrs.length; n++) {
    const a = r.attrs[n];
    if (!a.quote || a.vEnd >= end) continue;
    if (!brokenAfter(src, r.attrs, n, end)) continue;
    const limit = Math.min(end, a.vStart + 40000);
    let p = a.vEnd;
    for (let tries = 0; tries < 80; tries++) {
      p = src.indexOf(a.quote, p + 1);
      if (p < 0 || p >= limit) break;
      const nx = src[p + 1];
      if (!(/[\s>]/.test(nx || ' ') || (nx === '/' && src[p + 2] === '>'))) continue;
      const rest = lexAttrs(src, p + 1, end);
      if (!rest.closed || rest.attrs.some((x) => QUOTE_IN_NAME.test(x.name))) continue;
      a.vEnd = p; a.recovered = true;
      r.attrs = [...r.attrs.slice(0, n + 1), ...rest.attrs];
      r.k = rest.k; r.selfClose = rest.selfClose;
      break;
    }
  }
}

/** Nháy đóng của thuộc tính thứ n có phải nháy lồng (giá trị bị cắt sớm) không */
function brokenAfter(src, attrs, n, end) {
  const a = attrs[n];
  // 1) ngay sau nháy đóng dính liền một "tên thuộc tính" không thể có (chứa nháy hoặc chữ CJK)
  const after = src[a.vEnd + 1];
  if (after !== undefined && a.vEnd + 1 < end && !/[\s>/]/.test(after)) {
    let t = a.vEnd + 1;
    while (t < end && !/[\s=>]/.test(src[t])) t++;
    const tok = src.slice(a.vEnd + 1, t);
    if (QUOTE_IN_NAME.test(tok) || CJK_IN_NAME.test(tok)) return true;
  }
  // 2) các "thuộc tính" không giá trị đứng sau (tới thuộc tính có giá trị kế tiếp) có tên chứa dấu nháy
  for (let i = n + 1; i < attrs.length; i++) {
    if (attrs[i].vStart >= 0) break;
    if (QUOTE_IN_NAME.test(attrs[i].name)) return true;
  }
  return false;
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
