// Đọc/ghi metadata card trong file PNG (chunk tEXt "chara" = V2, "ccv3" = V3) — giống SillyTavern

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}
/** CRC-32 chuẩn PNG (ISO-HDLC): khởi tạo 0xFFFFFFFF và đảo bit ở cuối */
export function crc32(bytes, start = 0, end = bytes.length) {
  const t = crcTable();
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isPng(bytes) {
  return bytes && bytes.length > 8 && PNG_SIG.every((b, i) => bytes[i] === b);
}

/** Tách các chunk PNG (dễ dãi: không kiểm CRC, để đọc được cả file hơi lỗi) */
export function extractChunks(bytes) {
  if (!isPng(bytes)) throw new Error('Không phải file PNG hợp lệ');
  const chunks = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const name = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, Math.min(bytes.length, pos + 8 + len));
    chunks.push({ name, data });
    pos += 12 + len;
    if (name === 'IEND') break;
  }
  return chunks;
}

/**
 * Kiểm tra PNG nghiêm ngặt giống SillyTavern (png-chunks-extract + png-chunk-text):
 * IHDR đứng đầu, CRC từng chunk đúng, có IEND, chunk tEXt không chứa byte 0 trong phần chữ, có dữ liệu card.
 * Trả về { ok, error }
 */
export function verifyPng(bytes) {
  try {
    if (!isPng(bytes)) return { ok: false, error: 'sai chữ ký PNG' };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8, first = true, ended = false, card = false;
    while (pos < bytes.length) {
      if (pos + 12 > bytes.length) return { ok: false, error: 'chunk bị cắt cụt' };
      const len = dv.getUint32(pos);
      const name = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (first && name !== 'IHDR') return { ok: false, error: 'thiếu IHDR ở đầu' };
      first = false;
      if (pos + 12 + len > bytes.length) return { ok: false, error: `chunk ${name} vượt quá cuối file` };
      if (name === 'IEND') { ended = true; break; }
      const want = dv.getUint32(pos + 8 + len);
      const got = crc32(bytes, pos + 4, pos + 8 + len);
      if (want !== got) return { ok: false, error: `CRC chunk ${name} sai` };
      if (name === 'tEXt') {
        const data = bytes.subarray(pos + 8, pos + 8 + len);
        const z = data.indexOf(0);
        if (z >= 0 && data.indexOf(0, z + 1) >= 0) return { ok: false, error: 'chunk tEXt chứa ký tự NULL' };
        const kw = latin1Decode(data.subarray(0, z < 0 ? data.length : z)).toLowerCase();
        if (kw === 'chara' || kw === 'ccv3') card = true;
      }
      pos += 12 + len;
    }
    if (!ended) return { ok: false, error: 'thiếu chunk IEND' };
    if (!card) return { ok: false, error: 'không có chunk chara/ccv3' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function encodeChunks(chunks) {
  let total = 8;
  for (const c of chunks) total += 12 + c.data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let pos = 8;
  for (const c of chunks) {
    dv.setUint32(pos, c.data.length);
    for (let i = 0; i < 4; i++) out[pos + 4 + i] = c.name.charCodeAt(i);
    out.set(c.data, pos + 8);
    const crc = crc32(out, pos + 4, pos + 8 + c.data.length);
    dv.setUint32(pos + 8 + c.data.length, crc);
    pos += 12 + c.data.length;
  }
  return out;
}

function latin1Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}
function latin1Encode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

export function decodeText(chunkData) {
  const idx = chunkData.indexOf(0);
  if (idx < 0) return { keyword: latin1Decode(chunkData), text: '' };
  return { keyword: latin1Decode(chunkData.subarray(0, idx)), text: latin1Decode(chunkData.subarray(idx + 1)) };
}
export function encodeText(keyword, text) {
  const k = latin1Encode(keyword), t = latin1Encode(text);
  const out = new Uint8Array(k.length + 1 + t.length);
  out.set(k, 0); out[k.length] = 0; out.set(t, k.length + 1);
  return out;
}

// Base64 <-> UTF-8 (không phụ thuộc Buffer)
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}
export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Đọc JSON card từ PNG: ưu tiên ccv3, sau đó chara */
export function readCardFromPng(bytes) {
  const chunks = extractChunks(bytes);
  const texts = chunks.filter((c) => c.name === 'tEXt').map((c) => decodeText(c.data));
  const v3 = texts.find((t) => t.keyword.toLowerCase() === 'ccv3');
  const v2 = texts.find((t) => t.keyword.toLowerCase() === 'chara');
  const pick = v3 || v2;
  if (!pick) throw new Error('PNG không chứa dữ liệu card (không có chunk chara/ccv3)');
  return { json: base64ToUtf8(pick.text), source: v3 ? 'ccv3' : 'chara' };
}

/** Ghi JSON card vào PNG: xóa chunk cũ, thêm chara (v2) + ccv3 (v3) trước IEND — giống ST */
export function writeCardToPng(bytes, jsonString) {
  const chunks = extractChunks(bytes).filter((c) => {
    if (c.name !== 'tEXt') return true;
    const kw = decodeText(c.data).keyword.toLowerCase();
    return kw !== 'chara' && kw !== 'ccv3';
  });
  const iendIdx = chunks.findIndex((c) => c.name === 'IEND');
  const insertAt = iendIdx >= 0 ? iendIdx : chunks.length;
  const add = [{ name: 'tEXt', data: encodeText('chara', utf8ToBase64(jsonString)) }];
  try {
    const v3 = JSON.parse(jsonString);
    v3.spec = 'chara_card_v3';
    v3.spec_version = '3.0';
    add.push({ name: 'tEXt', data: encodeText('ccv3', utf8ToBase64(JSON.stringify(v3))) });
  } catch { /* bỏ qua */ }
  chunks.splice(insertAt, 0, ...add);
  return encodeChunks(chunks);
}
