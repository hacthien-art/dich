// Nội dung NHÚNG bên trong văn bản: base64, base64 + gzip/zlib, data: URI, payload bị cắt khúc ["…","…"].join('').
// - unpackText(): tìm payload, giải mã thành văn bản và thay nó trong văn bản cha bằng một TOKEN ngắn  ⟪emb:id⟫
//   (đệ quy: payload lồng trong payload). Mỗi payload thành một "lớp" được phân tích / dịch như một mục riêng.
// - encodePart(): mã hóa lại bản dịch của lớp theo đúng chuỗi mã hóa gốc để đặt vào chỗ token.
// Token chỉ gồm ký tự không bị bất kỳ hàm escape nào đụng tới (JS, HTML, JSON, YAML) và không chứa chữ Hán,
// nên bộ phân tích coi nó như mã thường; khi ghép card / tài nguyên, token được thay bằng payload đã mã hóa lại.
import { base64ToBytes, bytesToBase64, isGzip, isZlib, decompress, compress, utf8Decode, utf8Encode, binaryMagic, looksLikeText } from './pack.js';
import { hasCJK, hash32 } from './util.js';

export const TOKEN_RE = /⟪(emb|url):([0-9a-z]+)⟫/g;
const TOKEN_TEST = /⟪(?:emb|url):[0-9a-z]+⟫/;
export const makeToken = (type, id) => `⟪${type}:${id}⟫`;
export const hasToken = (s) => typeof s === 'string' && s.includes('⟪') && TOKEN_TEST.test(s);

/** Thay mọi token bằng fn(type, id, token); fn trả undefined/null thì giữ nguyên token */
export function resolveTokens(text, fn) {
  if (!hasToken(text)) return text;
  return text.replace(TOKEN_RE, (m, type, id) => { const v = fn(type, id, m); return v == null ? m : v; });
}
/** Danh sách [type, id] các token có trong văn bản (theo thứ tự xuất hiện, có lặp) */
export function listTokens(text) {
  const out = [];
  if (!hasToken(text)) return out;
  for (const m of text.matchAll(TOKEN_RE)) out.push([m[1], m[2]]);
  return out;
}

export const stableId = (s) => hash32(s) + s.length.toString(36);

// ---------------------------------------------------------------- chữ Hán viết dạng \uXXXX
// Mã do bundler tạo (esbuild mặc định, JSON của Python ensure_ascii…) viết chữ Hán thành 中文 -> bộ phân tích
// không thấy chữ nào để dịch. Trong chuỗi / template / regex / JSON, \uXXXX tương đương đúng ký tự đó nên đổi về ký tự thật.
const ESC_CJK_TEST = /\\u(?:3[0-9a-f]|[4-9][0-9a-f]|f[9af]|ff)[0-9a-f]{2}/i;
function isCjkCode(c) {
  return (c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}
export const hasEscapedCjk = (s) => typeof s === 'string' && s.includes('\\u') && ESC_CJK_TEST.test(s);
export function unescapeCjk(text) {
  if (!hasEscapedCjk(text)) return text;
  // "\\\\" (dấu \ đã escape) được ăn trước để không nhầm "\\u4e2d" (chữ "中" theo nghĩa đen) thành escape
  return text.replace(/\\\\|\\u([0-9a-fA-F]{4})/g, (m, hex) => {
    if (!hex) return m;
    const c = parseInt(hex, 16);
    return isCjkCode(c) ? String.fromCharCode(c) : m;
  });
}
/** Chỉ đổi trong thân các thẻ <script> của một đoạn HTML (ngoài script, "中" là chữ thường) */
export function unescapeCjkInScripts(html) {
  if (!hasEscapedCjk(html)) return html;
  let out = '', pos = 0;
  const re = /<script\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const bodyStart = m.index + m[0].length;
    const closeRe = /<\/script\s*>/gi;
    closeRe.lastIndex = bodyStart;
    const c = closeRe.exec(html);
    const bodyEnd = c ? c.index : html.length;
    out += html.slice(pos, bodyStart) + unescapeCjk(html.slice(bodyStart, bodyEnd));
    pos = bodyEnd;
    re.lastIndex = bodyEnd;
  }
  return out + html.slice(pos);
}
/** Chuẩn hóa văn bản của một lớp theo loại nội dung */
export function normalizeLayerText(text, kind) {
  if (kind === 'js' || kind === 'data') return unescapeCjk(text);
  if (kind === 'html') return unescapeCjkInScripts(text);
  return text;
}

/** Văn bản (hoặc lớp con của nó) có gì để dịch không */
export const hasTranslatable = (s) => hasCJK(s) || hasEscapedCjk(s);

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------------------------------------------------------------- nhận loại nội dung
const TEXT_MIME = /^(?:text\/|application\/(?:json|javascript|x-javascript|ecmascript|xml|xhtml\+xml|ld\+json|manifest\+json|x-yaml|yaml)|image\/svg\+xml)/i;
const BIN_MIME = /^(?:image\/(?!svg)|audio\/|video\/|font\/|application\/(?:octet-stream|font|x-font|vnd\.ms-fontobject|pdf|zip|gzip|wasm))/i;

export function kindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (/html|xml|svg/.test(m)) return 'html';
  if (/javascript|ecmascript/.test(m)) return 'js';
  if (/json/.test(m)) return 'data';
  if (/css/.test(m)) return 'css';
  return null;
}
export function kindFromName(name) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (['html', 'htm', 'xhtml', 'svg', 'xml', 'vue'].includes(ext)) return 'html';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts'].includes(ext)) return 'js';
  if (['json', 'jsonl', 'geojson', 'webmanifest'].includes(ext)) return 'data';
  if (ext === 'css') return 'css';
  if (['txt', 'md', 'markdown', 'yaml', 'yml', 'csv', 'ini', 'toml'].includes(ext)) return 'text';
  return null;
}
/** Đoán loại nội dung từ chính văn bản: html | js | data (JSON) | css | text */
export function sniffKind(text) {
  const head = stripBom(text.slice(0, 4000)).trimStart();
  if (/^<(?:!doctype|html|\?xml|svg|head|body|div|section|main|style|script|template|!--|[a-z][\w-]*[\s>])/i.test(head)) return 'html';
  if (/^[{[]/.test(head)) {
    const tail = text.slice(-64).trimEnd();
    if (/[}\]]$/.test(tail) && /^(?:\{\s*(?:"|\})|\[\s*(?:[{["\d\]-]|true|false|null))/.test(head)) return 'data';
  }
  if (/(?:^|[\s;{}(])(?:function\b|const\s|let\s|var\s|import\s|export\s|return\b|=>|document\.|window\.|\(function|\(\(\)\s*=>|'use strict')/.test(head)) return 'js';
  if (/^(?:@(?:charset|import|font-face|media|keyframes)\b|:root\s*\{|[.#]?[\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{\s*[\w-]+\s*:)/.test(head)) return 'css';
  if (/<\/(?:div|span|p|script|style|html|body|svg|section|table)>/i.test(text.slice(0, 20000))) return 'html';
  return 'text';
}

// ---------------------------------------------------------------- tìm payload
const MIN_RUN = 64;     // dãy base64 ngắn hơn không xét
const MIN_BARE = 96;    // chuỗi base64 trần (không có "data:…;base64,") phải dài hơn mức này
const MAX_DEPTH = 6;

const isB64 = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47;

/** Các dãy ký tự base64 dài [start, end) — quét tuyến tính, chạy được trên văn bản hàng chục MB */
export function findBase64Runs(text, min = MIN_RUN) {
  const runs = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isB64(text.charCodeAt(i))) { i++; continue; }
    let j = i + 1;
    while (j < n && isB64(text.charCodeAt(j))) j++;
    if (j - i >= min) {
      let k = j;
      while (k < n && k - j < 2 && text.charCodeAt(k) === 61) k++;
      runs.push([i, k]);
      i = k;
    } else i = j;
  }
  return runs;
}

const DATA_HEAD_RE = /data:([\w.+-]+\/[\w.+-]+)?((?:;[\w-]+=[^;,"'\s]*)*);base64,$/i;
const JOIN_TAIL_RE = /^\s*,?\s*\]\s*\.\s*join\s*\(\s*(?:''|""|``)\s*\)/;

function classifyRun(text, s, e) {
  const hs = Math.max(0, s - 200);
  const m = DATA_HEAD_RE.exec(text.slice(hs, s));
  if (m) return { form: 'datauri', mime: (m[1] || '').toLowerCase() };
  const q = text[s - 1];
  if ((q === '"' || q === "'" || q === '`') && text[e] === q) return { form: 'b64', quote: q };
  return null;
}

/**
 * Gom các ứng viên payload trong văn bản: [{ start, end, form, mime, quote, chunks?, sep? }]
 * - 'datauri': phần base64 sau "data:<mime>;base64,"
 * - 'b64': nguyên một chuỗi trong nháy toàn ký tự base64
 * - 'chunks': nhiều chuỗi base64 liền nhau  "…", "…", "…"  theo sau là ].join('')  (hoặc nối bằng +)
 */
export function findCandidates(text) {
  const runs = findBase64Runs(text);
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    const [s, e] = runs[i];
    const c = classifyRun(text, s, e);
    if (!c) continue;
    if (c.form === 'datauri') { out.push({ start: s, end: e, ...c }); continue; }
    // gom khúc: "A", "B", "C"
    const q = c.quote;
    const chunks = [[s, e]];
    let sep = null, j = i;
    while (j + 1 < runs.length) {
      const [ns, ne] = runs[j + 1];
      const last = chunks[chunks.length - 1];
      if (text[ns - 1] !== q || text[ne] !== q) break;
      const between = text.slice(last[1] + 1, ns - 1);
      if (!/^\s*[,+]\s*$/.test(between)) break;
      if (sep == null) sep = between;
      chunks.push([ns, ne]);
      j++;
    }
    if (chunks.length > 1) {
      // khúc cuối có thể ngắn hơn MIN_RUN nên chưa nằm trong runs
      const last = chunks[chunks.length - 1];
      const tail = text.slice(last[1] + 1, last[1] + 200);
      const tm = new RegExp('^(\\s*[,+]\\s*)\\' + q + '([A-Za-z0-9+/]{1,' + (MIN_RUN - 1) + '}={0,2})\\' + q).exec(tail);
      if (tm) { const cs = last[1] + 1 + tm[1].length + 1; chunks.push([cs, cs + tm[2].length]); }
      const endQ = chunks[chunks.length - 1][1];
      const plus = sep.includes('+');
      if (plus || JOIN_TAIL_RE.test(text.slice(endQ + 1, endQ + 80))) {
        out.push({ start: s, end: endQ, form: 'chunks', quote: q, chunks, sep });
        i = j;
        continue;
      }
    }
    out.push({ start: s, end: e, ...c });
  }
  return out;
}

const PCT_RE = /data:(text\/html|text\/plain|text\/css|text\/javascript|application\/javascript|application\/json|image\/svg\+xml)((?:;[\w-]+=[\w.+-]*)*),([^"'`\s)<>\\]{48,})/gi;

/** Nhãn gợi ý cho payload: tên biến / khóa đứng ngay trước nó (files.watch, ADMIN_PAYLOAD, atob…) */
function hintBefore(text, start) {
  const head = text.slice(Math.max(0, start - 120), start);
  let m = /data:([\w.+-]+\/[\w.+-]+)[^,]*,$/i.exec(head);
  if (m) return m[1];
  m = /([\w$一-鿿.]{1,48})["']?\s*[:=(]\s*\[?\s*["'`]$/.exec(head);
  return m ? m[1].replace(/^window\./, '') : '';
}

async function decodeBase64Payload(b64, { mime, bare }) {
  if (mime && BIN_MIME.test(mime)) return null;
  if (bare && b64.length < MIN_BARE) return null;
  // xem trước vài byte đầu: ảnh / font / âm thanh thì bỏ qua ngay, khỏi giải mã cả chục MB
  const peek = base64ToBytes(b64.slice(0, 24));
  if (!peek) return null;
  if (!isGzip2(peek) && binaryMagic(peek)) return null;
  const bytes = base64ToBytes(b64);
  if (!bytes || !bytes.length) return null;
  let comp = isGzip(bytes) ? 'gzip' : isZlib(bytes) ? 'zlib' : null;
  let raw = bytes;
  if (comp) {
    raw = await decompress(bytes, comp);
    if (!raw) { if (comp === 'gzip') return null; comp = null; raw = bytes; } // "x " đầu văn bản trông giống zlib
  }
  if (binaryMagic(raw)) return null;
  const inner = utf8Decode(raw);
  if (inner == null || !looksLikeText(inner)) return null;
  if (mime && !TEXT_MIME.test(mime) && !hasCJK(inner)) return null;
  return { inner, comp };
}
const isGzip2 = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * Tách payload nhúng khỏi văn bản.
 * Trả về { text, parts } — text là văn bản đã thay payload bằng token; parts: [{ id, token, form, comp, mime, quote,
 * chunk, orig, kind, text, parts, rawLen, hint }]. Chỉ payload (hoặc lớp con của nó) CÓ nội dung cần dịch mới được tách.
 */
export async function unpackText(text, opts = {}, depth = 0) {
  if (typeof text !== 'string' || text.length < MIN_RUN || depth > MAX_DEPTH) return { text, parts: [] };
  const found = []; // { start, end, part }
  const seen = opts.seen || (opts.seen = new Map()); // id -> part (payload giống hệt nhau dùng chung một lớp)

  const make = async (start, end, form, extra, inner, comp) => {
    const orig = text.slice(start, end);
    const id = stableId(orig);
    let part = seen.get(id);
    if (!part) {
      const kind0 = kindFromMime(extra.mime) || sniffKind(inner);
      const sub = await unpackText(inner, opts, depth + 1);
      if (!hasTranslatable(sub.text) && !sub.parts.length) return;
      part = {
        id, token: makeToken('emb', id), form, comp: comp || null, mime: extra.mime || '', quote: extra.quote || '',
        chunk: extra.chunk || null, orig, kind: kind0, text: normalizeLayerText(sub.text, kind0), parts: sub.parts,
        rawLen: inner.length, hint: hintBefore(text, start),
      };
      seen.set(id, part);
    }
    found.push({ start, end, part });
  };

  // 1) data URI mã hóa %XX (data:text/html,%3Chtml…)
  const taken = [];
  if (text.includes('data:') && text.includes('%')) {
    PCT_RE.lastIndex = 0;
    let m;
    while ((m = PCT_RE.exec(text))) {
      const body = m[3];
      if (!body.includes('%')) continue;
      let inner;
      try { inner = decodeURIComponent(body); } catch { continue; }
      const start = m.index + m[0].length - body.length;
      const before = found.length;
      await make(start, start + body.length, 'pct', { mime: m[1].toLowerCase() }, inner, null);
      if (found.length > before) taken.push([start, start + body.length]);
    }
  }
  // 2) base64
  for (const c of findCandidates(text)) {
    if (taken.some(([a, b]) => c.start < b && c.end > a)) continue;
    const b64 = c.chunks ? c.chunks.map(([a, b]) => text.slice(a, b)).join('') : text.slice(c.start, c.end);
    const dec = await decodeBase64Payload(b64, { mime: c.mime, bare: c.form !== 'datauri' });
    if (!dec) continue;
    const chunk = c.chunks ? { size: c.chunks[0][1] - c.chunks[0][0], sep: c.sep } : null;
    await make(c.start, c.end, c.form, { mime: c.mime, quote: c.quote, chunk }, dec.inner, dec.comp);
  }
  if (!found.length) return { text, parts: [] };
  found.sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  const parts = [];
  for (const f of found) {
    if (f.start < pos) continue;
    out += text.slice(pos, f.start) + f.part.token;
    pos = f.end;
    if (!parts.includes(f.part)) parts.push(f.part);
  }
  return { text: out + text.slice(pos), parts };
}

/** Mã hóa lại văn bản (đã dịch, đã thay token con) của một lớp theo đúng dạng gốc để đặt vào chỗ token */
export async function encodePart(part, innerText) {
  if (part.form === 'pct') return encodeURIComponent(innerText);
  let bytes = utf8Encode(innerText);
  if (part.comp) bytes = await compress(bytes, part.comp);
  const b64 = bytesToBase64(bytes);
  if (part.form === 'chunks' && part.chunk) {
    const size = Math.max(16, part.chunk.size - (part.chunk.size % 4)); // khúc bội số của 4 để từng khúc vẫn là base64 trọn vẹn
    const pieces = [];
    for (let i = 0; i < b64.length; i += size) pieces.push(b64.slice(i, i + size));
    return pieces.join(part.quote + part.chunk.sep + part.quote);
  }
  return b64;
}

/** Mô tả ngắn chuỗi mã hóa của một lớp (để hiện trong giao diện) */
export function describeEncoding(part) {
  if (part.form === 'url') return 'link ngoài';
  if (part.form === 'pct') return 'data: URI (%XX)';
  const bits = [part.form === 'chunks' ? 'base64 cắt khúc' : part.form === 'datauri' ? 'data: URI base64' : 'base64'];
  if (part.comp) bits.push(part.comp);
  return bits.join(' + ');
}

/** Duyệt mọi lớp (cả lớp lồng) của một danh sách parts */
export function walkParts(parts, fn, parent = null) {
  for (const p of parts || []) { fn(p, parent); walkParts(p.parts, fn, p); }
}
