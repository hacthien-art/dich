// Tệp tài nguyên đi kèm card (gói bản đồ .gz, trang HTML, tệp JS / JSON…) và tệp tải từ link ngoài:
// mở vỏ (gzip / văn bản thường) -> văn bản -> bóc các lớp nhúng (xem embed.js); đóng gói lại sau khi dịch.
import { gunzip, gzip, isGzip, utf8Decode, utf8Encode, binaryMagic, looksLikeText } from './pack.js';
import { unpackText, kindFromName, kindFromMime, sniffKind, normalizeLayerText } from './embed.js';
import { absolutizeJs, absolutizeCss } from './links.js';

export const RESOURCE_ACCEPT = '.gz,.html,.htm,.js,.mjs,.json,.css,.txt,.md,.svg,.xml,.yaml,.yml';

/** Tệp có vẻ là tài nguyên văn bản (không phải card / preset / ảnh) — theo đuôi tệp */
export function looksLikeResourceName(name) {
  return /\.(?:gz|html?|m?js|css|txt|md|svg|xml|ya?ml)$/i.test(String(name || ''));
}

/**
 * Mở một tệp tài nguyên.
 * opts: { baseUrl (tệp tải từ link ngoài: để đổi đường dẫn tương đối thành tuyệt đối), mime, seen }
 * Trả về { container: 'gzip'|'plain', bom, kind, text (đã thay lớp nhúng bằng token), parts, rawLen }
 */
export async function openResource(name, bytes, opts = {}) {
  if (!bytes || !bytes.length) throw new Error('Tệp rỗng');
  let container = 'plain', body = bytes;
  if (isGzip(bytes)) {
    try { body = await gunzip(bytes); } catch (e) { throw new Error('Không giải nén được tệp gzip: ' + (e.message || e)); }
    container = 'gzip';
  }
  const magic = binaryMagic(body);
  if (magic === 'zip') throw new Error('Tệp zip chưa được hỗ trợ — hãy giải nén rồi thêm từng tệp .html / .js / .json bên trong');
  if (magic) throw new Error(`Tệp là ${magic} (nhị phân) — không có văn bản để dịch`);
  if (body.length > 262 && String.fromCharCode(...body.subarray(257, 262)) === 'ustar') throw new Error('Tệp .tar.gz chưa được hỗ trợ — hãy giải nén rồi thêm từng tệp bên trong');
  let text = utf8Decode(body);
  if (text == null || !looksLikeText(text)) throw new Error('Tệp không phải văn bản UTF-8 — không có gì để dịch');
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
  const inner = String(name || '').replace(/\.gz$/i, '').replace(/[?#].*$/, '');
  const kind = kindFromName(inner) || kindFromMime(opts.mime) || sniffKind(text);
  const rawLen = text.length;
  if (opts.baseUrl) {
    if (kind === 'js') text = absolutizeJs(text, opts.baseUrl);
    else if (kind === 'css') text = absolutizeCss(text, opts.baseUrl);
  }
  const u = await unpackText(text, { seen: opts.seen });
  return { container, bom, kind, text: normalizeLayerText(u.text, kind), parts: u.parts, rawLen };
}

/** Đóng gói văn bản cuối (đã dịch, đã thay token) về đúng dạng vỏ gốc */
export async function packResource(open, finalText) {
  let bytes = utf8Encode((open.bom ? String.fromCharCode(0xfeff) : '') + finalText);
  if (open.container === 'gzip') bytes = await gzip(bytes);
  return bytes;
}

/** Tên tệp xuất: "山河舆图-资源 (7).gz" -> "山河舆图-资源 (7)_VI.gz" ; "map.html" -> "map_VI.html" */
export function exportName(name) {
  const n = String(name || 'resource').replace(/[\\/:*?"<>|]+/g, '_');
  const m = /^(.*?)((?:\.[A-Za-z0-9]{1,5}){1,2})$/.exec(n);
  return m ? `${m[1]}_VI${m[2]}` : n + '_VI';
}

export const KIND_NAMES = { html: 'HTML', js: 'JavaScript', data: 'JSON / dữ liệu', css: 'CSS', text: 'văn bản' };
