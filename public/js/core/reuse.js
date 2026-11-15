// Dùng lại bản dịch cũ khi khóa đoạn (segment key) thay đổi nhưng nội dung thực ra đã từng được dịch:
// (1) khóa kiểu bản 1.1: bộ phân tích 1.2 đổi cách đặt placeholder cho nhãn 【…】 và $1 -> chuyển bản dịch cũ sang khóa mới
// (2) card được cập nhật: đoạn dài bị cắt lại ở chỗ khác, chèn/xóa vài dòng -> ghép bản dịch từ từng ĐOẠN VĂN / DÒNG
//     đã dịch trước đó (không tốn lượt gọi AI). Chỉ nhận khi ghép được trọn vẹn và qua kiểm tra placeholder.
import { HAN_CLASS } from './util.js';

const PH = () => /⟦\s*(\d+)\s*⟧/g;
const HAN_ONE = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]');
const REF_TEXT_RE = /^(?:\$(?:\d+|<[^>]+>|&)|\{\{\s*match\s*\}\})$/i;
const OPEN_B = '【\\[<「『〖〔（(';
const CLOSE_B = '】\\]>」』〗〕）)';

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Các biến thể "khóa cũ" của một đoạn + hàm chuyển bản dịch cũ sang dạng khóa mới.
 * - nhãn: bản cũ để ngoặc ở ngoài placeholder  「【⟦1⟧】」  -> bản mới placeholder bao cả ngoặc  「⟦1⟧」
 * - $1 / $<tên> / {{match}} trong chuỗi JS, thuộc tính: bản cũ để nguyên chữ, bản mới là placeholder
 * Trả về [{ key, convert(oldTranslation) -> string|null }]
 */
export function legacyVariants(seg) {
  const holes = seg.holes || [];
  const markerAt = holes.map((h) => h && h.type === 'marker');
  const refAt = holes.map((h) => h && h.type === 'raw' && REF_TEXT_RE.test(h.text || ''));
  const out = [];
  const combos = [];
  const anyM = markerAt.some(Boolean), anyR = refAt.some(Boolean);
  if (anyM) combos.push([true, false]);
  if (anyR) combos.push([false, true]);
  if (anyM && anyR) combos.push([true, true]);
  for (const [useM, useR] of combos) {
    const inline = holes.map((h, i) => useR && refAt[i]);
    const oldNum = [];
    let c = 0;
    holes.forEach((h, i) => { oldNum[i] = inline[i] ? 0 : ++c; });
    const key = seg.key.replace(PH(), (m, d) => {
      const i = Number(d) - 1, h = holes[i];
      if (!h) return m;
      if (inline[i]) return h.text;
      const p = `⟦${oldNum[i]}⟧`;
      return useM && markerAt[i] ? h.open + p + h.close : p;
    });
    if (key === seg.key) continue;
    const convert = (tr) => {
      // số placeholder cũ -> số mới (qua ký hiệu tạm để không đè lên nhau)
      let bad = false;
      let s = String(tr).replace(PH(), (m, d) => { const i = oldNum.indexOf(Number(d)); if (i < 0) { bad = true; return m; } return `\u0000${i + 1}\u0000`; });
      if (bad) return null;
      // nhãn: bỏ ngoặc (và dấu /) dính quanh placeholder — placeholder mới đã gồm cả ngoặc
      holes.forEach((h, i) => {
        if (!(useM && markerAt[i])) return;
        const slash = h.open.endsWith('/') ? '\\/?' : '';
        s = s.replace(new RegExp('(?:[' + OPEN_B + ']' + slash + ')?\\u0000' + (i + 1) + '\\u0000[' + CLOSE_B + ']?'), `\u0000${i + 1}\u0000`);
      });
      // $1 dạng chữ -> placeholder mới (mỗi hole một lần xuất hiện, theo thứ tự)
      for (let i = 0; i < holes.length; i++) {
        if (!inline[i]) continue;
        const t = holes[i].text;
        const re = new RegExp(escapeRe(t) + (/^\$\d+$/.test(t) ? '(?!\\d)' : ''));
        const m = re.exec(s);
        if (!m) return null;
        s = s.slice(0, m.index) + `\u0000${i + 1}\u0000` + s.slice(m.index + m[0].length);
      }
      return s.replace(/\u0000(\d+)\u0000/g, '⟦$1⟧');
    };
    out.push({ key, convert });
  }
  return out;
}

// ====================================================================== ghép từ đoạn văn / dòng
/** Tách theo dòng trống: { parts, seps } (seps[i] nằm giữa parts[i] và parts[i+1]) */
function splitParas(text) {
  const bits = String(text).split(/(\n[ \t\r]*\n(?:[ \t\r]*\n)*)/);
  const parts = [], seps = [];
  for (let i = 0; i < bits.length; i++) (i % 2 ? seps : parts).push(bits[i]);
  return { parts, seps };
}

/** Đánh số lại placeholder theo thứ tự xuất hiện: { key, map: số cũ -> số chuẩn } */
function normalize(text) {
  const map = new Map();
  const key = text.replace(PH(), (m, d) => { const n = Number(d); if (!map.has(n)) map.set(n, map.size + 1); return `⟦${map.get(n)}⟧`; });
  return { key, map };
}

function numsOf(text) { const s = new Set(); for (const m of text.matchAll(PH())) s.add(Number(m[1])); return s; }
function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }
const edges = (s) => { const lead = /^\s*/.exec(s)[0]; const body = s.slice(lead.length); const trail = /\s*$/.exec(body)[0]; return { lead, core: body.slice(0, body.length - trail.length), trail }; };

const MAX_BLOCK = 60; // số dòng tối đa của một khối ghép

const lineKey = (ln) => normalize(edges(ln).core).key;

export class ParaMemory {
  constructor() { this.map = new Map(); this.size = 0; this.heads = new Set(); this.maxLines = 1; }

  _learn(k, t) {
    const kc = edges(k).core, tc = edges(t).core;
    if (!kc || !tc || !HAN_ONE.test(kc) || HAN_ONE.test(tc)) return false;
    if (!sameSet(numsOf(kc), numsOf(tc))) return false;
    const n = normalize(kc);
    if (this.map.has(n.key)) return true;
    this.map.set(n.key, tc.replace(PH(), (m, d) => `⟦${n.map.get(Number(d))}⟧`));
    this.size++;
    // khối nhiều dòng: nhớ dòng đầu (đánh số placeholder giống hệt khi chuẩn hóa cả khối) để _cover chỉ thử
    // ghép khối dài khi dòng hiện tại có thể là đầu khối -> tuyến tính thay vì thử mọi độ dài
    const nl = kc.split('\n').length;
    if (nl > 1) { this.heads.add(lineKey(kc.split('\n')[0])); if (nl > this.maxLines) this.maxLines = nl; }
    return true;
  }

  /** Học từ một cặp (khóa nguồn, bản dịch) đã có: cả khối, từng đoạn văn, từng dòng (khi số dòng khớp) */
  learn(key, tr) {
    if (typeof key !== 'string' || typeof tr !== 'string' || !tr) return;
    const ks = splitParas(key), ts = splitParas(tr);
    if (ks.parts.length !== ts.parts.length) { this._learn(key, tr); return; }
    if (ks.parts.length > 1) this._learn(key, tr);
    for (let i = 0; i < ks.parts.length; i++) {
      const k = ks.parts[i], t = ts.parts[i];
      if (!this._learn(k, t)) continue;
      const kl = k.split('\n'), tl = t.split('\n');
      if (kl.length > 1 && kl.length === tl.length) for (let j = 0; j < kl.length; j++) this._learn(kl[j], tl[j]);
    }
  }

  /** Bản dịch của một khối văn bản đã học (placeholder đánh số lại theo khối) — null nếu chưa từng dịch */
  lookup(text) {
    const e = edges(text);
    if (!e.core || !HAN_ONE.test(e.core)) return text;
    const n = normalize(e.core);
    const t = this.map.get(n.key);
    if (t == null) return null;
    const inv = new Map([...n.map].map(([o, s]) => [s, o]));
    return e.lead + t.replace(PH(), (m, d) => `⟦${inv.get(Number(d))}⟧`) + e.trail;
  }

  /**
   * Phủ một đoạn văn bằng các khối dòng liên tiếp đã dịch (ưu tiên khối dài nhất).
   * Trả về [{ text, tr }] — tr = null ở các khối dòng liên tiếp chưa từng dịch.
   */
  _cover(para) {
    const whole = this.lookup(para);
    if (whole != null) return [{ text: para, tr: whole }];
    const lines = para.split('\n');
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ text: run.join('\n'), tr: null }); run = []; } };
    for (let i = 0; i < lines.length;) {
      let k = 0, tr = null;
      const top = this.heads.has(lineKey(lines[i])) ? Math.min(lines.length, i + Math.min(MAX_BLOCK, this.maxLines)) : i + 1;
      for (let j = top; j > i; j--) {
        if (j - i === lines.length) continue; // cả đoạn đã thử ở trên
        const t = this.lookup(lines.slice(i, j).join('\n'));
        if (t != null) { k = j - i; tr = t; break; }
      }
      if (k) { flush(); out.push({ text: lines.slice(i, i + k).join('\n'), tr }); i += k; } else { run.push(lines[i]); i++; }
    }
    flush();
    return out;
  }

  /** Ghép bản dịch cho khóa mới từ các đoạn văn / khối dòng đã học — null nếu còn phần chưa từng dịch */
  compose(key) {
    if (!this.size) return null;
    const ks = splitParas(key);
    let out = '';
    for (let i = 0; i < ks.parts.length; i++) {
      const cov = this._cover(ks.parts[i]);
      if (cov.some((c) => c.tr == null)) return null;
      out += cov.map((c) => c.tr).join('\n') + (ks.seps[i] ?? '');
    }
    return out;
  }

  /**
   * Phần CHƯA từng dịch của khóa (các khối dòng liên tiếp), kèm số chữ Hán đã biết / chưa biết.
   * Dùng để chỉ gửi AI phần thay đổi khi card được cập nhật. Trả về { parts:[text], known, unknown }
   */
  missing(key) {
    const ks = splitParas(key);
    const parts = [];
    let known = 0, unknown = 0;
    const han = (s) => (s.match(HAN_ALL) || []).length;
    for (const p of ks.parts) {
      for (const c of this._cover(p)) {
        if (c.tr == null) { const core = edges(c.text).core; if (core && HAN_ONE.test(core)) { parts.push(core); unknown += han(core); } }
        else known += han(c.text);
      }
    }
    return { parts, known, unknown };
  }
}

const HAN_ALL = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]', 'g');

/**
 * Khóa con chuẩn hóa (placeholder đánh số lại 1..k) của một phần trong đoạn, kèm các hole tương ứng
 * — để gửi AI như một đoạn dịch riêng. Trả về { key, holes }
 */
export function subSegment(part, holes) {
  const n = normalize(part);
  const sub = [];
  for (const [orig, idx] of n.map) sub[idx - 1] = holes?.[orig - 1] ?? { type: 'raw', text: '' };
  return { key: n.key, holes: sub };
}
