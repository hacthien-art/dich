// Tiện ích dùng chung (chạy được cả trên trình duyệt lẫn Node để kiểm thử)

// Ký tự CJK: Hán, Kana, Hangul, dấu câu CJK và ký tự toàn độ rộng
export const CJK_CLASS = '\\u2E80-\\u2FDF\\u3000-\\u303F\\u3040-\\u30FF\\u3100-\\u312F\\u3190-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
export const HAN_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
const CJK_RE = new RegExp('[' + CJK_CLASS + ']');
const HAN_RE = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF\\uAC00-\\uD7AF]');

/** Có chứa ký tự Hán/Kana/Hangul (cần dịch) */
export function hasCJK(s) { return typeof s === 'string' && HAN_RE.test(s); }
/** Có chứa bất kỳ ký tự CJK nào, kể cả dấu câu toàn độ rộng */
export function hasCJKAny(s) { return typeof s === 'string' && CJK_RE.test(s); }
export function countCJK(s) {
  if (!s) return 0;
  const m = s.match(new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]', 'g'));
  return m ? m.length : 0;
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }
export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function deepClone(o) {
  if (typeof structuredClone === 'function') return structuredClone(o);
  return JSON.parse(JSON.stringify(o));
}

/** Băm chuỗi nhanh (FNV-1a 32bit) -> hex */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** Định danh JS hợp lệ (cho phép chữ Unicode, kể cả tiếng Việt có dấu) */
const IDENT_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await'.split(' '));
export function isIdentifier(s) { return typeof s === 'string' && IDENT_RE.test(s) && !RESERVED.has(s); }

/** Escape nội dung để đặt trong chuỗi JS với dấu nháy quote */
export function escapeJsString(s, quote) {
  let out = '';
  for (const ch of String(s)) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch.charCodeAt(0) === 0x2028) out += '\\u2028';
    else if (ch.charCodeAt(0) === 0x2029) out += '\\u2029';
    else if (quote === '`' && ch === '$') out += '$'; // xử lý ${ riêng
    else out += ch;
  }
  if (quote === '`') out = out.replace(/\$\{/g, '\\${');
  return out;
}

export function escapeHtmlAttr(s, quote) {
  let v = String(s).replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
  if (quote === '"') v = v.replace(/"/g, '&quot;');
  else if (quote === "'") v = v.replace(/'/g, '&#39;');
  return v;
}

export function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** Gộp chuỗi theo đường dẫn object kiểu a.b[0].c */
export function getPath(obj, path) {
  let o = obj;
  for (const k of path) { if (o == null) return undefined; o = o[k]; }
  return o;
}
export function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null) o[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
    o = o[path[i]];
  }
  o[path[path.length - 1]] = value;
}
