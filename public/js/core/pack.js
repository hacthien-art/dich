// Nén / giải nén (gzip, zlib, deflate thô) + base64 + UTF-8 cho dữ liệu lớn.
// Chạy được cả trên trình duyệt lẫn Node ≥ 18 (CompressionStream / DecompressionStream có sẵn ở cả hai).

const hasBuffer = typeof globalThis.Buffer === 'function' && typeof globalThis.Buffer.from === 'function';

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export const gunzip = (bytes) => pipe(bytes, new DecompressionStream('gzip'));
export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate'));
export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate'));
export const inflateRaw = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));
export const deflateRaw = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));

export function isGzip(b) { return !!b && b.length > 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8; }
/** Đầu luồng zlib: CMF = 0x78 (deflate, cửa sổ 32K) và (CMF*256 + FLG) chia hết cho 31 */
export function isZlib(b) { return !!b && b.length > 6 && b[0] === 0x78 && ((b[0] << 8) | b[1]) % 31 === 0 && (b[1] & 0x20) === 0; }

/** Giải nén theo kiểu đã biết ('gzip' | 'zlib') — lỗi thì trả null */
export async function decompress(bytes, comp) {
  try { return comp === 'gzip' ? await gunzip(bytes) : comp === 'zlib' ? await inflate(bytes) : bytes; } catch { return null; }
}
export async function compress(bytes, comp) {
  return comp === 'gzip' ? gzip(bytes) : comp === 'zlib' ? deflate(bytes) : bytes;
}

// ---------------------------------------------------------------- base64
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64 -> byte. Trả null nếu không phải base64 hợp lệ. */
export function base64ToBytes(b64) {
  const s = String(b64);
  if (s.length % 4 === 1) return null;
  if (hasBuffer) {
    // Buffer.from bỏ qua ký tự lạ thay vì báo lỗi -> tự kiểm tra trước
    if (s.length < 4096 ? !B64_RE.test(s) : !validB64Long(s)) return null;
    const buf = globalThis.Buffer.from(s, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  let bin;
  try { bin = atob(s); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function validB64Long(s) {
  const n = s.length;
  let end = n;
  while (end > 0 && end > n - 2 && s.charCodeAt(end - 1) === 61) end--;
  for (let i = 0; i < end; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) return false;
  }
  return true;
}

export function bytesToBase64(bytes) {
  if (hasBuffer) return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  // btoa theo từng khối 3n byte để không tạo một chuỗi nhị phân khổng lồ
  const STEP = 3 * 16384;
  const parts = [];
  for (let i = 0; i < bytes.length; i += STEP) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + STEP));
    let bin = '';
    for (let j = 0; j < sub.length; j += 8192) bin += String.fromCharCode.apply(null, sub.subarray(j, j + 8192));
    parts.push(btoa(bin));
  }
  return parts.join('');
}

// ---------------------------------------------------------------- UTF-8
const enc = new TextEncoder();
export function utf8Encode(str) { return enc.encode(str); }
/** Giải mã UTF-8 nghiêm ngặt — dữ liệu không phải UTF-8 hợp lệ trả null */
export function utf8Decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

// ---------------------------------------------------------------- nhận diện nhị phân
const MAGICS = [
  ['png', [0x89, 0x50, 0x4e, 0x47]], ['jpg', [0xff, 0xd8, 0xff]], ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['riff', [0x52, 0x49, 0x46, 0x46]], ['woff', [0x77, 0x4f, 0x46, 0x46]], ['woff2', [0x77, 0x4f, 0x46, 0x32]],
  ['otf', [0x4f, 0x54, 0x54, 0x4f]], ['ttf', [0x00, 0x01, 0x00, 0x00]], ['zip', [0x50, 0x4b, 0x03, 0x04]],
  ['pdf', [0x25, 0x50, 0x44, 0x46]], ['ogg', [0x4f, 0x67, 0x67, 0x53]], ['mp3', [0x49, 0x44, 0x33]],
  ['flac', [0x66, 0x4c, 0x61, 0x43]], ['wasm', [0x00, 0x61, 0x73, 0x6d]], ['bmp', [0x42, 0x4d]], ['ico', [0x00, 0x00, 0x01, 0x00]],
];
/** Tên định dạng nhị phân quen thuộc (ảnh, font, âm thanh, zip…) hoặc null */
export function binaryMagic(b) {
  if (!b || b.length < 4) return null;
  for (const [name, sig] of MAGICS) {
    if (name === 'bmp' && b.length < 54) continue;
    if (sig.every((x, i) => b[i] === x)) return name;
  }
  if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';
  return null;
}

/** Văn bản "thật": không có NUL, rất ít ký tự điều khiển (bỏ qua \t \n \r) */
export function looksLikeText(s) {
  if (typeof s !== 'string' || !s.length) return false;
  const n = Math.min(s.length, 20000);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || c === 0xfffd) return false;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
  }
  return bad <= n * 0.003;
}

// ---------------------------------------------------------------- gzip "stored" đồng bộ (không nén)
// Dùng khi cần một luồng gzip hợp lệ ngay lập tức mà không chờ được CompressionStream (hiện chưa dùng ở giao diện;
// giữ làm phương án dự phòng cho môi trường không có CompressionStream).
let CRC_T = null;
export function crc32(bytes) {
  if (!CRC_T) {
    CRC_T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_T[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function gzipStored(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(10 + bytes.length + blocks * 5 + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0);
  let p = 10;
  for (let i = 0, b = 0; b < blocks; b++, i += 65535) {
    const len = Math.min(65535, bytes.length - i);
    out[p++] = b === blocks - 1 ? 1 : 0;
    out[p++] = len & 0xff; out[p++] = len >>> 8;
    out[p++] = ~len & 0xff; out[p++] = (~len >>> 8) & 0xff;
    out.set(bytes.subarray(i, i + len), p);
    p += len;
  }
  const dv = new DataView(out.buffer);
  dv.setUint32(p, crc32(bytes), true);
  dv.setUint32(p + 4, bytes.length >>> 0, true);
  return out;
}
