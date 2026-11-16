// Link ngoài trong card / tài nguyên: tìm URL, đoán loại (mã JS, trang HTML, CSS, JSON…), phân biệt thư viện dùng chung
// với mã RIÊNG của card (thường nằm trên GitHub, nạp qua jsDelivr / raw.githubusercontent / github.io).
// Link được tải về (máy chủ cục bộ tải hộ) -> thành một tệp tài nguyên -> dịch -> thay link trong card bằng data: URL
// của bản dịch (nhúng thẳng), hoặc bằng URL khác do người dùng tự đăng tải.
import { lexJs, significant } from './lexer.js';
import { bytesToBase64, utf8Encode } from './pack.js';
import { stableId, makeToken } from './embed.js';

const URL_RE = /https?:\/\/[^\s'"`<>()\\,;|^{}[\]]+/g;
const EXT_KIND = {
  js: 'js', mjs: 'js', cjs: 'js', html: 'html', htm: 'html', xhtml: 'html', css: 'css', json: 'data', jsonl: 'data',
  txt: 'text', md: 'text', yaml: 'text', yml: 'text', csv: 'text', svg: 'html', xml: 'html', gz: 'gz',
};
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|mp3|ogg|wav|flac|m4a|mp4|webm|mov|woff2?|ttf|otf|eot|pdf|zip|rar|7z)(?:[?#]|$)/i;
// thư viện / framework dùng chung — không phải nội dung của card, không nên dịch
const LIB_RE = /(?:MagVarUpdate|tavern_resource\/dist\/util|JS-Slash-Runner|cdnjs\.cloudflare\.com|jsdelivr\.net\/npm\/|unpkg\.com|esm\.sh|esm\.run|skypack\.dev|jspm\.|fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.loli\.net|cdn\.tailwindcss\.com|code\.jquery\.com|ajax\.googleapis\.com|bootcdn\.|staticfile\.|font-awesome|fontawesome|bootstrap(?:\.min)?\.(?:css|js)|jquery(?:[.-][\w.]*)?\.js|vue(?:\.[\w.]*)?\.js|lodash|pixi|three(?:\.module)?(?:\.min)?\.js|echarts|chart(?:\.umd)?(?:\.min)?\.js|d3(?:\.v\d+)?(?:\.min)?\.js|animate(?:\.min)?\.css|highlight\.js|katex|mathjax|live2d|howler|gsap|swiper)/i;
// nơi tác giả card hay đặt mã riêng
const CODE_HOST_RE = /(?:jsdelivr\.net\/gh\/|raw\.githubusercontent\.com|\.github\.io|gist\.githubusercontent\.com|gitee\.com|gitlab\.|gitcode\.|\.pages\.dev|\.vercel\.app|\.netlify\.app|\.workers\.dev|\.r2\.dev|codeberg\.)/i;

export const KIND_MIME = { js: 'text/javascript', html: 'text/html', css: 'text/css', data: 'application/json', text: 'text/plain' };
export const KIND_LABEL = { js: 'mã JavaScript', html: 'trang HTML', css: 'CSS', data: 'JSON', text: 'văn bản', gz: 'tệp nén .gz', other: 'không rõ' };

function extOf(url) {
  const path = url.replace(/[?#].*$/, '');
  const m = /\.([a-z0-9]{1,6})$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/** Cách URL được dùng, suy từ đoạn văn bản đứng ngay trước nó */
function usage(before) {
  const b = before.slice(-160);
  if (/(?:^|[\s;{}(])import\s*\(?\s*["'`]$/.test(b) || /\bfrom\s*["'`]$/.test(b) || /\bimportScripts\s*\(\s*["'`]$/.test(b) || /\bgetScript\s*\(\s*["'`]$/.test(b) || /\bloadScript\s*\(\s*["'`]$/.test(b)) return { how: 'import', kind: 'js' };
  if (/<script\b[^>]*\bsrc\s*=\s*["']?$/i.test(b)) return { how: '<script src>', kind: 'js' };
  if (/@import\s+(?:url\(\s*)?["']?$/i.test(b)) return { how: '@import', kind: 'css' };
  if (/<link\b[^>]*\bhref\s*=\s*["']?$/i.test(b)) return { how: '<link href>', kind: 'css' };
  if (/<i?frame\b[^>]*\bsrc\s*=\s*["']?$/i.test(b)) return { how: '<iframe src>', kind: 'html' };
  if (/\.load\s*\(\s*["'`]$/.test(b)) return { how: '.load()', kind: 'html' };
  if (/<(?:img|audio|video|source|image|embed|track)\b[^>]*\b(?:src|href|xlink:href|poster)\s*=\s*["']?$/i.test(b) || /url\(\s*["']?$/i.test(b)) return { how: 'ảnh / âm thanh / font', kind: 'media' };
  if (/<a\b[^>]*\bhref\s*=\s*["']?$/i.test(b)) return { how: 'liên kết <a>', kind: 'page' };
  if (/\b(?:fetch|get|getJSON|ajax|post|axios|request|open)\s*\(\s*(?:["']GET["']\s*,\s*)?["'`]$/i.test(b) || /\burl\s*:\s*["'`]$/.test(b)) return { how: 'fetch()', kind: null };
  return { how: '', kind: null };
}

/**
 * Tìm link ngoài trong các mục. Trả về [{ url, id, kind, klass, uses:[{ itemId, label, how }], count }]
 * klass: 'code' (mã / dữ liệu riêng của card — ứng viên để dịch) | 'lib' (thư viện dùng chung) | 'media' | 'page' | 'other'
 */
export function scanLinks(items) {
  const map = new Map();
  for (const it of items) {
    const text = typeof it.rawText === 'string' ? it.rawText : it.text;
    if (typeof text !== 'string' || !text.includes('://')) continue;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      let url = m[0].replace(/[.!?:*]+$/, '');
      if (url.length < 12) continue;
      const u = usage(text.slice(Math.max(0, m.index - 160), m.index));
      let e = map.get(url);
      if (!e) {
        const ext = extOf(url);
        let kind = u.kind || EXT_KIND[ext] || (MEDIA_EXT.test(url) ? 'media' : 'other');
        if (kind !== 'media' && kind !== 'page' && MEDIA_EXT.test(url)) kind = 'media';
        if (u.kind === 'html' && EXT_KIND[ext] && EXT_KIND[ext] !== 'html') kind = EXT_KIND[ext];
        // "mã / dữ liệu của card": URL được NẠP bởi mã (import, <script src>, <link>, <iframe>, .load(), fetch…), hoặc tệp
        // mã nằm trên kho của tác giả. URL chỉ được nhắc tới (trích dẫn nguồn, liên kết tham khảo) không phải ứng viên.
        const loaded = !!u.how && u.kind !== 'media' && u.kind !== 'page';
        const codeFile = CODE_HOST_RE.test(url) && ['js', 'html', 'css', 'data', 'text'].includes(EXT_KIND[ext]);
        let klass = kind === 'media' ? 'media' : kind === 'page' ? 'page' : !(loaded || codeFile) ? 'other' : LIB_RE.test(url) ? 'lib' : 'code';
        if (klass === 'code' && kind === 'other') kind = 'text';
        e = { url, id: stableId(url), kind, klass, uses: [], count: 0 };
        map.set(url, e);
      } else {
        if (e.kind === 'other' && u.kind) e.kind = u.kind;
        // cùng URL, chỗ này mới thấy nó được nạp bởi mã
        if (e.klass === 'other' && u.how && u.kind !== 'media' && u.kind !== 'page') e.klass = LIB_RE.test(url) ? 'lib' : 'code';
      }
      e.count++;
      if (!e.uses.some((x) => x.itemId === it.id)) e.uses.push({ itemId: it.id, label: it.label, how: u.how });
    }
  }
  const rank = { code: 0, other: 1, lib: 2, page: 3, media: 4 };
  return [...map.values()].sort((a, b) => rank[a.klass] - rank[b.klass] || a.url.localeCompare(b.url));
}

export const urlToken = (url) => makeToken('url', stableId(url));

/** Thay các URL đã tải về bằng token ⟪url:id⟫ (URL dài trước, để URL này không cắt ngang URL kia) */
export function tokenizeUrls(text, urls) {
  if (typeof text !== 'string' || !urls.length || !text.includes('://')) return text;
  let out = text;
  for (const url of urls.slice().sort((a, b) => b.length - a.length)) {
    if (!out.includes(url)) continue;
    // không thay khi URL chỉ là tiền tố của một URL dài hơn (…/index.js so với …/index.js.map)
    const parts = out.split(url);
    let s = parts[0];
    for (let i = 1; i < parts.length; i++) s += (/^[\w\-.~%/?#&=+:@]/.test(parts[i]) ? url : urlToken(url)) + parts[i];
    out = s;
  }
  return out;
}

/** Các địa chỉ dự phòng cho cùng một tệp trên jsDelivr (testingcf / fastly / gcore / cdn là các gương của nhau) */
export function mirrorUrls(url) {
  const m = /^(https?:\/\/)(cdn|testingcf|fastly|gcore|test1|quantil)\.jsdelivr\.net\//i.exec(url);
  if (!m) return [url];
  const rest = url.slice(m[0].length);
  const out = [url];
  for (const h of ['cdn', 'fastly', 'testingcf', 'gcore']) { const u = `${m[1]}${h}.jsdelivr.net/${rest}`; if (!out.includes(u)) out.push(u); }
  return out;
}

export function toDataUrl(kind, text) {
  return `data:${KIND_MIME[kind] || 'text/plain'};charset=utf-8;base64,${bytesToBase64(utf8Encode(text))}`;
}

/**
 * Mã JS tải từ link ngoài sẽ được nhúng lại bằng data: URL, nơi đường dẫn tương đối không còn nghĩa:
 * đổi  import './x.js' / from '../y.js' / import('./z.js')  thành URL tuyệt đối theo địa chỉ gốc, và
 * import.meta.url thành chuỗi địa chỉ gốc (để new URL('./asset', import.meta.url) vẫn trỏ đúng).
 */
export function absolutizeJs(text, baseUrl) {
  if (!baseUrl || !/\bimport\b/.test(text)) return text;
  let sig;
  try { sig = significant(lexJs(text, 0, text.length, { data: true })); } catch { return text; }
  const reps = [];
  const abs = (spec) => { try { return new URL(spec, baseUrl).href; } catch { return null; } };
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.type !== 'ident') continue;
    if (t.value === 'import' || t.value === 'from') {
      let s = sig[i + 1];
      if (t.value === 'import' && s?.type === 'punct' && s.value === '(') s = sig[i + 2];
      if (s?.type === 'str') {
        const spec = text.slice(s.cStart, s.cEnd);
        if (/^\.{0,2}\//.test(spec) && !spec.startsWith('//')) { const a = abs(spec); if (a) reps.push([s.cStart, s.cEnd, a]); }
      } else if (t.value === 'import' && s?.type === 'punct' && s.value === '.' && sig[i + 2]?.value === 'meta' && sig[i + 3]?.value === '.' && sig[i + 4]?.value === 'url') {
        reps.push([t.start, sig[i + 4].end, JSON.stringify(baseUrl)]);
      }
    }
  }
  if (!reps.length) return text;
  reps.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b, v] of reps) { if (a < pos) continue; out += text.slice(pos, a) + v; pos = b; }
  return out + text.slice(pos);
}

/** CSS tải từ link ngoài: url(./font.woff2) -> URL tuyệt đối */
export function absolutizeCss(text, baseUrl) {
  if (!baseUrl || !/url\(/i.test(text)) return text;
  return text.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|#|blob:|about:)([^'")\s]+)\1\s*\)/gi, (m, q, spec) => {
    try { return `url(${q}${new URL(spec, baseUrl).href}${q})`; } catch { return m; }
  });
}
