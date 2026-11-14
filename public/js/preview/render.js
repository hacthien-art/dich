// Hiển thị tin nhắn giống ST + Tavern Helper: regex -> markdown (showdown) -> lọc (DOMPurify) -> khối HTML thành iframe
let converter = null;
function getConverter() {
  if (converter) return converter;
  const sd = window.showdown;
  if (!sd) return null;
  converter = new sd.Converter({
    emoji: true, literalMidWordUnderscores: true, parseImgDimensions: true, tables: true, underline: true,
    simpleLineBreaks: true, strikethrough: true, disableForced4SpacesIndentedSublists: true,
  });
  return converter;
}

/** Điều kiện Tavern Helper coi khối mã là giao diện (render iframe) */
export function isFrontend(code) {
  return ['html>', '<head>', '<body'].some((t) => code.includes(t));
}

/**
 * Chuyển văn bản tin nhắn (đã áp regex) thành HTML an toàn + danh sách khối iframe
 */
export function formatMessage(text) {
  const conv = getConverter();
  let html = conv ? conv.makeHtml(String(text ?? '')) : String(text ?? '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html, {
      ADD_TAGS: ['style', 'q'],
      ADD_ATTR: ['target'],
      FORCE_BODY: true,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
    });
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const blocks = [];
  tpl.content.querySelectorAll('pre > code, pre').forEach((el) => {
    const pre = el.tagName === 'PRE' ? el : el.parentElement;
    if (!pre?.isConnected && !tpl.content.contains(pre)) return;
    if (pre.dataset.thDone) return;
    const code = (pre.querySelector('code') || pre).textContent;
    if (!isFrontend(code)) return;
    pre.dataset.thDone = '1';
    const ph = document.createElement('div');
    ph.className = 'th-frame-slot';
    ph.dataset.block = String(blocks.length);
    blocks.push(code);
    pre.replaceWith(ph);
  });
  const div = document.createElement('div');
  div.appendChild(tpl.content.cloneNode(true));
  return { html: div.innerHTML, blocks };
}

const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
function safeJson(o) {
  return JSON.stringify(o ?? null).replace(/</g, '\\u003c').replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
}

// Iframe sandbox (origin "null") KHÔNG được tải script từ localhost (chính sách Local Network Access của trình duyệt)
// -> nạp mã thư viện 1 lần rồi nhúng trực tiếp vào iframe.
const VENDOR_FILES = { jquery: '/vendor/jquery.min.js', lodash: '/vendor/lodash.min.js', yaml: '/vendor/yaml.iife.js', zod: '/vendor/zod.iife.js', env: '/js/preview/th-env.js' };
const vendorCache = new Map();
export function vendorSource(name) {
  if (!vendorCache.has(name)) {
    vendorCache.set(name, fetch(VENDOR_FILES[name]).then((r) => { if (!r.ok) throw new Error('Không tải được ' + VENDOR_FILES[name]); return r.text(); }));
  }
  return vendorCache.get(name);
}
export async function vendorSources(names) {
  const out = {};
  await Promise.all(names.map(async (n) => { out[n] = await vendorSource(n); }));
  return out;
}
/** Nhúng mã JS vào thẻ <script> an toàn */
export function inlineScript(code) {
  return '<script>' + String(code).replace(/<\/script/gi, '<\\/script') + '<\/script>';
}

/** Dựng tài liệu cho iframe giao diện (giống Tavern Helper): chèn môi trường giả lập vào <head>.
 *  libs: kết quả vendorSources(['jquery','lodash','yaml','env']) */
export function buildFrameDoc(code, data, { viewportHeight = 800 } = {}, libs = {}) {
  let doc = String(code).replace(/(\d+(?:\.\d+)?)vh\b/gi, 'calc(var(--TH-viewport-height) * $1 / 100)');
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{--TH-viewport-height:${viewportHeight}px}html,body{margin:0;padding:0;}body{color:#d5d9e3;font-family:'Segoe UI',Arial,sans-serif;}</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<script>window.__TH_DATA__=${safeJson(data)};<\/script>
${inlineScript(libs.jquery || '')}
${inlineScript(libs.lodash || '')}
${inlineScript(libs.yaml || '')}
${inlineScript(libs.env || '')}`;
  if (/<head(\s[^>]*)?>/i.test(doc)) doc = doc.replace(/<head(\s[^>]*)?>/i, (m) => m + head);
  else if (/<html(\s[^>]*)?>/i.test(doc)) doc = doc.replace(/<html(\s[^>]*)?>/i, (m) => m + '<head>' + head + '</head>');
  else doc = '<!DOCTYPE html><html><head>' + head + '</head><body>' + doc + '</body></html>';
  return doc;
}

export const FRAME_SANDBOX = 'allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads';

/** CSS nền cho nội dung tin nhắn trong shadow DOM (giống giao diện ST tối) */
export const MESSAGE_CSS = `
:host{display:block;color:#d5d9e3;font:14px/1.6 'Segoe UI',Arial,sans-serif;word-wrap:break-word}
p{margin:0 0 .6em} q,em{color:#c5a3ff} q::before,q::after{content:''} strong{color:#fff}
pre{background:#0f1015;border:1px solid #2f3442;border-radius:6px;padding:8px;overflow:auto;white-space:pre-wrap}
code{font-family:Consolas,monospace;font-size:12.5px}
img{max-width:100%} blockquote{border-left:3px solid #555;margin:0;padding-left:10px;color:#aaa}
table{border-collapse:collapse} td,th{border:1px solid #444;padding:3px 6px}
details{margin:.4em 0} summary{cursor:pointer}
.th-frame-slot iframe{width:100%;border:0;display:block;background:transparent;min-height:30px}
`;
