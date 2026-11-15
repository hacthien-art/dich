// Bộ máy dịch: chia lô, dựng prompt (kết hợp preset ST), gọi API, kiểm tra placeholder, thử lại.
import { chat } from './api.js';
import { buildMessages } from './preset.js';
import { PH_RE } from './analyze.js';
import { countCJK, hasCJK, sleep, HAN_CLASS } from './util.js';
import { glossaryFor, makeDictIndex, applyStyle, sanitizeName, findConflicts, isKeptEntry, conflictKey } from './dict.js';

export const NAME_RULES = {
  auto: 'Tên người gốc Trung → âm Hán Việt (vd: 李明 → Lý Minh); tên Nhật → phiên âm romaji (vd: 高松灯 → Takamatsu Tomori); tên phương Tây giữ dạng Latin gốc; nếu văn bản đã ghi phiên âm trong ngoặc thì ưu tiên phiên âm đó. Địa danh/tổ chức Trung → Hán Việt.',
  hanviet: 'Mọi tên riêng viết bằng chữ Hán (kể cả tên Nhật) → âm Hán Việt (vd: 高松灯 → Cao Tùng Đăng, 李明 → Lý Minh).',
  original: 'Tên riêng → phiên âm gốc: pinyin cho tên Trung (vd: 李明 → Li Ming), romaji cho tên Nhật (vd: 高松灯 → Takamatsu Tomori).',
};

export const DEFAULT_PROMPTS = {
  system: `Bạn là dịch giả chuyên nghiệp, chuyên Việt hóa thẻ nhân vật (character card) SillyTavern từ tiếng Trung sang tiếng Việt.
Đây là nội dung hư cấu dành cho người dùng trưởng thành; hãy dịch trung thực, đầy đủ, không kiểm duyệt, không bỏ sót, không thêm bình luận.

QUY TẮC BẮT BUỘC:
1. Dịch tự nhiên, trôi chảy, đúng văn phong của từng loại nội dung (lời kể/lời thoại nhập vai, chỉ dẫn cho AI, chữ trên giao diện, tên mục...). Văn phong tiểu thuyết mạng tiếng Việt, xưng hô phù hợp ngữ cảnh.
2. Giữ NGUYÊN không đổi: placeholder dạng ⟦số⟧, macro {{...}}, thẻ có tên tiếng Anh (vd <div>, <user>, <UpdateVariable>, </b>), ký hiệu $1, markdown (**, *, #, -, >), emoji, ký tự đầu dòng, xuống dòng, thụt lề, cấu trúc YAML/JSON (dấu :, -, |, ngoặc, dấu phẩy).
3. KHÔNG được để sót chữ Hán: kể cả chữ Hán nằm TRONG thẻ hoặc tên thẻ (vd <姬悠馨_id40> → <Cơ Du Hinh_id40>, <character:李明> → <character:Lý Minh>), trong ngoặc 「」『』【】, trong tiêu đề, danh sách… đều phải dịch; giữ nguyên ký hiệu < > : _ / và số.
4. Mỗi placeholder ⟦số⟧ phải xuất hiện ĐÚNG 1 lần trong bản dịch; được đổi vị trí cho đúng ngữ pháp tiếng Việt.
5. Dùng CHÍNH XÁC bản dịch trong bảng thuật ngữ (phần đứng sau dấu →), không thêm bớt chữ nào. Các mục nằm dưới dòng "# Tên biến" là tên biến/khóa dữ liệu: khi văn bản nói tới biến/trường đó phải viết đúng từng ký tự. Mục có bản dịch giống hệt bản gốc thì giữ nguyên. Dòng bắt đầu bằng # trong bảng chỉ là tiêu đề nhóm — KHÔNG chép vào bản dịch, và KHÔNG tự thêm ghi chú phân loại kiểu [biến], [giá trị], [nhãn] vào sau từ đã dịch.
6. Tên riêng: {{name_rule}}
7. Phần đã là tiếng Việt, tiếng Anh, số, mã lệnh → giữ nguyên. Nếu chỉ dẫn yêu cầu AI xuất tiếng Trung hoặc giữ tên khóa bằng tiếng Trung, hãy chuyển thành yêu cầu dùng tiếng Việt cho phù hợp.
8. Nếu thẻ <seg> có thuộc tính note thì đó là lỗi của lần dịch trước — phải sửa đúng lỗi đó.
9. Giữ đủ các ký hiệu cấu trúc của bản gốc: cặp ngoặc 【】 「」 『』 〖〗 《》 “”, dấu < > của thẻ (kể cả thẻ tên tiếng Trung: <正文>…</正文> → <Chính văn>…</Chính văn>), dấu | * # = và số lượng dòng — regex của card dựa vào chúng để nhận diện, đổi sang ký hiệu khác là hỏng giao diện.
10. Chỉ trả về kết quả theo đúng định dạng được yêu cầu, không giải thích.`,
  task: `Card: {{card_name}}
Loại đoạn: prose = văn bản/chỉ dẫn; ui = chữ trên giao diện HTML (ngắn gọn); name = tên/tiêu đề; keyword = từ khóa kích hoạt lorebook (ngắn, dễ khớp); desc = mô tả biến cho AI; comment = chú thích trong mã nguồn (ngắn gọn, giữ 1 dòng nếu bản gốc 1 dòng).

Bảng thuật ngữ (bắt buộc dùng đúng):
{{glossary}}

Dịch từng đoạn <seg> dưới đây sang tiếng Việt. Trả về MỖI đoạn trong thẻ <seg id="..."> với CÙNG id, đúng thứ tự, không gộp hay tách đoạn, không thêm gì ngoài các thẻ <seg>:

{{segments}}`,
  dict: `Hãy dịch các mục dưới đây (tên biến dữ liệu MVU, giá trị trạng thái, nhãn đánh dấu, thuật ngữ) của card "{{card_name}}" sang tiếng Việt NGẮN GỌN và NHẤT QUÁN.
- key: tên trường dữ liệu (biến) → cụm danh từ 1-4 từ, KHÔNG dùng các ký tự . / [ ] : # ' " (vd: 好感度 → Độ hảo cảm, 当前地点 → Vị trí hiện tại)
- value: giá trị/trạng thái/lựa chọn → ngắn gọn, tự nhiên (vd: 未负重 → Không quá tải)
- marker: nhãn đánh dấu trong văn bản → 1-3 từ
- term: tên riêng / thuật ngữ / từ khóa
Tên riêng: {{name_rule}}
Ngữ cảnh (đường dẫn cha) ghi trong thuộc tính ctx. Thuộc tính note (nếu có) là lỗi của lần trước cần sửa.
KHÔNG được để sót chữ Hán trong bản dịch: chữ hiếm / tên riêng không rõ nghĩa → phiên âm Hán Việt (vd: 冉駹诸部 → Các bộ Nhiễm Mang). Không thêm ghi chú, ngoặc giải thích hay nhãn phân loại.

Trả về mỗi mục trong thẻ <item id="..."> với CÙNG id, chỉ chứa bản dịch:

{{items}}`,
};

const TYPE_ATTR = { prose: 'prose', ui: 'ui', name: 'name', keyword: 'keyword', desc: 'desc', comment: 'comment' };

export const CONFLICT_PROMPT = `Trong card "{{card_name}}", các tên biến (khóa dữ liệu MVU / JSON) dưới đây đang bị dịch TRÙNG tên với một biến khác trong cùng object cha — dữ liệu sẽ ghi đè lên nhau và card bị hỏng.
Hãy đặt lại tên tiếng Việt cho từng <item>:
- Dịch đúng và ĐỦ nghĩa của từ gốc, cụ thể tới mức phân biệt được với các biến cùng nhóm (vd: 减粮 → Giảm lương thực, 减饷 → Giảm quân lương; 动向 → Xu hướng, 动态 → Động thái; 余额 → Số dư, 余量 → Lượng còn lại).
- Ngắn gọn (1-5 từ), không dùng các ký tự . / [ ] : # ' " \`
- Tên mới KHÔNG được trùng nhau, không trùng tên trong <keep> và các tên liệt kê ở thuộc tính used của cùng nhóm. Hai tên chỉ khác nhau ở chữ hoa/thường (vd "Chân" và "chân") vẫn bị coi là TRÙNG — phải khác hẳn về chữ (vd 足 → Bàn chân, 腿 → Đùi).{{style_note}}
Tên riêng: {{name_rule}}

Trả về mỗi mục trong thẻ <item id="..."> với CÙNG id, chỉ chứa tên mới, không giải thích.

{{items}}`;

function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/**
 * Bảng thuật ngữ gửi AI. KHÔNG gắn nhãn loại ("[biến]", "[giá trị]"…) sau bản dịch: model hay chép luôn nhãn đó
 * vào kết quả (vd "Nguyên Ngọc Nghi [biến]_Giai đoạn 01"). Loại được thể hiện bằng dòng tiêu đề nhóm bắt đầu bằng #.
 */
export function formatGlossary(list) {
  if (!list.length) return '(không có)';
  const line = (g) => `${g.src} → ${g.dst}`;
  const keys = list.filter((g) => g.kind === 'key');
  const rest = list.filter((g) => g.kind !== 'key');
  if (!keys.length) return rest.map(line).join('\n');
  const out = ['# Tên biến / khóa dữ liệu (viết đúng từng ký tự):', ...keys.map(line)];
  if (rest.length) out.push('# Giá trị, nhãn, thuật ngữ:', ...rest.map(line));
  return out.join('\n');
}

// Nhãn phân loại của bảng thuật ngữ bị model chép vào bản dịch: "vô [giá trị]", "thu nhập [biến] 0", "【nhãn】"…
const LEAK_WORDS = '(?:tên\\s+)?(?:biến|giá\\s*trị|nhãn|thuật\\s*ngữ)';
const LEAK_TAG_SRC = '[ \\t]*[\\[【［]\\s*' + LEAK_WORDS + '\\s*[\\]】］}]';
const LEAK_TAG_ONE = new RegExp(LEAK_TAG_SRC, 'i');
// bản gốc tự có ngoặc chứa đúng các từ này (vd "[变量]", "【数值】") thì bản dịch có "[biến]" là hợp lệ
const LEAK_SRC_RE = /[\[【［][^\]】］}\n]{0,8}(?:变量|變量|变数|值|数值|數值|取值|标签|標籤|标记|標記|术语|術語|名词)[^\]】］}\n]{0,8}[\]】］}]/;

const BRACKET_GROUP_RE = /[\[【［][^\[\]【】［］{}\n]{1,40}[\]】］}]/g;

/**
 * Gỡ nhãn phân loại bị lọt vào bản dịch. Chỉ gỡ khi bản dịch có NHIỀU nhóm ngoặc hơn bản gốc (nhãn lọt là phần thêm
 * vào); nếu số nhóm bằng nhau thì "[Nhãn]" chính là bản dịch của một nhóm ngoặc trong bản gốc (vd 【称号】) -> giữ.
 */
export function stripGlossaryTags(out, key = '') {
  const s = String(out ?? '');
  if (!s || !LEAK_TAG_ONE.test(s)) return s;
  if (LEAK_SRC_RE.test(key) || LEAK_TAG_ONE.test(key)) return s;
  const excess = (s.match(BRACKET_GROUP_RE) || []).length - (String(key).match(BRACKET_GROUP_RE) || []).length;
  if (excess <= 0) return s;
  let n = 0;
  return s.replace(new RegExp(LEAK_TAG_SRC, 'gi'), (m) => (n++ < excess ? '' : m));
}

/** Chia các đoạn chưa dịch thành lô */
export function makeBatches(segs, maxChars = 3000, maxSegs = 60) {
  const batches = [];
  let cur = [], size = 0;
  for (const s of segs) {
    const len = s.key.length;
    if (cur.length && (size + len > maxChars || cur.length >= maxSegs)) { batches.push(cur); cur = []; size = 0; }
    cur.push(s); size += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Tách các thẻ <seg id="N">...</seg> từ phản hồi */
export function parseTagged(text, tag = 'seg') {
  const out = new Map();
  const re = new RegExp(`<${tag}\\s+id\\s*=\\s*["']?(\\d+)["']?(?:\\s+[\\w-]+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*))*\\s*>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(text))) {
    let v = m[2];
    v = v.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    out.set(Number(m[1]), v);
  }
  return out;
}

/** Lấy các macro/thẻ hiển thị (ngoài placeholder) cần được giữ */
function visibleTokens(s) {
  const toks = [];
  const re = /\{\{[^{}]*\}\}|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|\$\d/g;
  let m;
  while ((m = re.exec(s))) toks.push(m[0].replace(/\s+/g, ' '));
  return toks;
}

const HAN_RUN_RE = new RegExp('[' + HAN_CLASS + ']+', 'g');

const HAN_ANY_RE = new RegExp('[' + HAN_CLASS + ']');
const allowedSorted = new WeakMap();

/**
 * Các cụm chữ Hán còn sót trong văn bản (bỏ qua placeholder và các từ được phép giữ nguyên).
 * Từ được phép chỉ được "tha" khi xuất hiện NGUYÊN VẸN — trước đây chỉ cần cụm còn sót là chuỗi con của một từ
 * được phép (vd "口" ⊂ "人口") là bỏ qua, nên rất nhiều chữ Hán sót không bị báo.
 */
export function leftoverHan(out, allowed) {
  let text = String(out ?? '');
  if (!HAN_ANY_RE.test(text)) return [];
  text = text.replace(PH_RE, ' ');
  if (allowed && allowed.size) {
    let list = allowedSorted.get(allowed);
    if (!list || list.size !== allowed.size) { list = { size: allowed.size, words: [...allowed].sort((a, b) => b.length - a.length) }; allowedSorted.set(allowed, list); }
    for (const a of list.words) if (a && text.includes(a)) text = text.split(a).join(' ');
  }
  return [...new Set(text.match(HAN_RUN_RE) || [])];
}

/**
 * Tập các từ tiếng Trung được phép giữ nguyên trong bản dịch:
 * - mục từ điển người dùng tích "Giữ", hoặc cả loại đang ở chế độ giữ nguyên (biến/giá trị, nhãn)
 * - bản dịch do NGƯỜI DÙNG sửa tay mà vẫn có chữ Hán (cố ý), thuật ngữ bổ sung có chữ Hán
 * Mục chưa có bản dịch, hoặc AI trả về vẫn là chữ Hán, KHÔNG được coi là "được phép" (trước đây có -> che mất lỗi).
 */
export function allowedHanSet(dict, settings = {}, glossary = []) {
  const idx = makeDictIndex(dict || {}, settings);
  const out = new Set();
  for (const [src, v] of Object.entries(dict || {})) {
    if (!v) continue;
    if (isKeptEntry(v, settings)) { if (hasCJK(src)) out.add(src); continue; }
    if (v.manual && v.dst) { const dst = idx.lookup(src); if (dst && hasCJK(dst)) out.add(dst); }
  }
  for (const g of glossary || []) if (g.dst && hasCJK(g.dst)) out.add(g.dst);
  return out;
}

const count = (s, ch) => { let n = 0, i = -1; while ((i = s.indexOf(ch, i + 1)) >= 0) n++; return n; };
const TAGLIKE_RE = /<\/?[^\s<>/][^<>]*>/g;
const HAN_TAG_RE = new RegExp('<\\/?[^<>]*[' + HAN_CLASS + '][^<>]*>');

/**
 * Kiểm tra bản dịch 1 đoạn. allowed: Set các từ tiếng Trung được phép còn lại.
 * opts.guard: chuỗi các ký hiệu mà regex của card cần (【 】 「 」 …) — bản dịch phải giữ đủ số lượng.
 */
export function validateSegment(seg, out, allowed, opts = {}) {
  const n = seg.holes?.length || (seg.key.match(PH_RE) || []).length;
  if (out == null) return { ok: false, reason: 'thiếu trong phản hồi' };
  out = stripGlossaryTags(normalizePlaceholders(out, n, seg.key), seg.key);
  if (!out.trim() && seg.key.trim()) return { ok: false, reason: 'rỗng' };
  const counts = new Map();
  for (const m of out.matchAll(PH_RE)) counts.set(Number(m[1]), (counts.get(Number(m[1])) || 0) + 1);
  for (let i = 1; i <= n; i++) {
    const c = counts.get(i) || 0;
    if (c !== 1) return { ok: false, reason: c ? `placeholder ⟦${i}⟧ bị lặp` : `mất placeholder ⟦${i}⟧`, out };
  }
  for (const k of counts.keys()) if (k < 1 || k > n) return { ok: false, reason: `placeholder lạ ⟦${k}⟧`, out };
  // macro / thẻ hiển thị
  const need = visibleTokens(seg.key.replace(PH_RE, ''));
  if (need.length) {
    const have = visibleTokens(out.replace(PH_RE, ''));
    const pool = new Map();
    for (const t of have) pool.set(t, (pool.get(t) || 0) + 1);
    for (const t of need) {
      const c = pool.get(t) || 0;
      if (!c) return { ok: false, reason: `mất ${t}`, out, soft: true };
      pool.set(t, c - 1);
    }
  }
  const srcHan = countCJK(seg.key);
  if (srcHan >= 4 && out.trim() === seg.key.trim()) return { ok: false, reason: 'giữ nguyên bản gốc (chưa dịch)', out, soft: true };
  // thẻ kiểu <tên tiếng Trung> (<正文>, </姬悠馨_id40>): bản dịch phải giữ đủ dấu < > — regex và cấu trúc prompt dựa vào chúng
  if (HAN_TAG_RE.test(seg.key)) {
    const a = (seg.key.match(TAGLIKE_RE) || []).length, b = (out.match(TAGLIKE_RE) || []).length;
    if (b < a) return { ok: false, reason: `mất thẻ dạng <…> (bản gốc có ${a}, bản dịch còn ${b}) — phải giữ nguyên dấu < > và chỉ dịch tên thẻ`, out, soft: true };
  }
  // ký hiệu mà regex của card dùng để nhận diện (【】「」…): mất là regex không khớp nữa
  if (opts.guard) {
    for (const ch of opts.guard) {
      const a = count(seg.key, ch);
      if (a && count(out, ch) < a) return { ok: false, reason: `mất ký hiệu «${ch}» (regex của card cần; bản gốc có ${a}, bản dịch còn ${count(out, ch)}) — phải giữ nguyên ký hiệu này`, out, soft: true };
    }
  }
  // còn sót chữ Hán (kể cả trong tên thẻ <姬悠馨_id40>) -> lỗi mềm: dịch lại kèm ghi chú, hết lượt thì nhận + cảnh báo
  const left = leftoverHan(out, allowed);
  if (left.length) return { ok: false, reason: 'còn sót chữ Hán: ' + left.slice(0, 6).join(', '), out, soft: true, leftover: left };
  return { ok: true, out, warn: null };
}

/**
 * Chuẩn hóa placeholder model viết lệch: ⟦ 1 ⟧, 〚1〛, ⟦⟦1⟧⟧, ⟦1] -> ⟦1⟧.
 * Dạng [[1]] chỉ được coi là placeholder khi số nằm trong phạm vi 1..n, bản dịch chưa có ⟦1⟧ và bản gốc không tự
 * chứa đúng chuỗi "[[1]]" (tránh làm hỏng văn bản có sẵn [[1]] như mảng lồng nhau hay chú dẫn kiểu wiki).
 */
export function normalizePlaceholders(s, n = Infinity, key = '') {
  let out = String(s).replace(/[⟦〚]{1,2}\s*(\d{1,3})\s*[⟧〛\]]{1,2}|\[{1,2}\s*(\d{1,3})\s*[⟧〛]{1,2}/g, (m, a, b) => `⟦${a ?? b}⟧`);
  if (out.includes('[[')) {
    out = out.replace(/\[\[\s*(\d{1,3})\s*\]\]/g, (m, d) => {
      const k = Number(d);
      return k >= 1 && k <= n && !out.includes(`⟦${k}⟧`) && !key.includes(m) ? `⟦${k}⟧` : m;
    });
  }
  return out;
}

/**
 * Chạy dịch.
 * job: { segments:[{key, kind, holes}], tm: Map, settings, conn, preset, dict, cardName, glossary,
 *        onResult(key, text, warn), onProgress({done,total,failed}), onLog(msg, level), onStream(text), signal }
 */
export async function runTranslation(job) {
  const { settings: st, signal } = job;
  job.notes ||= new Map();
  job.allowed ||= allowedHanSet(job.dict, st, job.glossary);
  const pending = job.segments.filter((s) => job.force || !job.tm.has(s.key));
  const total = pending.length;
  let done = 0, failed = 0;
  const failures = [];
  const report = () => job.onProgress?.({ done, total, failed });
  report();
  if (!total) return { done, failed, failures };

  const queue = makeBatches(pending, st.batchChars || 3000, st.batchSegs || 60).map((b) => ({ segs: b, attempt: 0 }));
  const concurrency = Math.max(1, Math.min(16, Number(st.concurrency) || 2));
  const maxRetries = Math.max(0, Number(st.retries ?? 2));
  let active = 0;
  let stopErr = null;

  const worker = async (wid) => {
    while (queue.length && !signal?.aborted && !stopErr) {
      const task = queue.shift();
      active++;
      try {
        const res = await translateBatch(job, task.segs, wid);
        for (const [key, out, warn] of res.ok) {
          job.tm.set(key, out);
          job.notes.delete(key);
          job.onResult?.(key, out, warn);
          done++;
        }
        const bad = res.bad;
        // ghi chú lỗi để lần dịch lại AI biết phải sửa gì
        for (const b of bad) if (b.reason) job.notes.set(b.seg.key, b.reason + (b.leftover ? ' — phải dịch nốt các chữ này' : ''));
        if (bad.length) {
          if (task.attempt < maxRetries) {
            const size = Math.max(1, Math.ceil(bad.length / (res.truncated ? 2 : 1)));
            for (let i = 0; i < bad.length; i += size) queue.push({ segs: bad.slice(i, i + size).map((b) => b.seg), attempt: task.attempt + 1 });
            job.onLog?.(`Lô #${wid}: ${bad.length} đoạn lỗi (${bad[0].reason}) → thử lại lần ${task.attempt + 1}`, 'warn');
          } else {
            for (const b of bad) {
              // lỗi mềm (mất macro) vẫn chấp nhận nhưng gắn cờ
              if (b.soft && b.out) { job.tm.set(b.seg.key, b.out); job.onResult?.(b.seg.key, b.out, b.reason); done++; continue; }
              failed++;
              failures.push({ key: b.seg.key, reason: b.reason });
            }
            job.onLog?.(`${bad.length} đoạn thất bại sau ${maxRetries} lần thử: ${bad[0].reason}`, 'error');
          }
        }
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') break;
        const status = e.status || 0;
        if (status === 401 || status === 403) { stopErr = e; job.onLog?.('Lỗi xác thực: ' + e.message, 'error'); break; }
        if (task.attempt < maxRetries + 2) {
          const wait = status === 429 ? 8000 * (task.attempt + 1) : 2500 * (task.attempt + 1);
          job.onLog?.(`Lỗi API (${e.message.slice(0, 200)}) → đợi ${Math.round(wait / 1000)}s rồi thử lại`, 'warn');
          queue.unshift({ segs: task.segs, attempt: task.attempt + 1 });
          try { await sleep(wait, signal); } catch { break; }
        } else {
          failed += task.segs.length;
          for (const s of task.segs) failures.push({ key: s.key, reason: e.message });
          job.onLog?.('Bỏ qua lô sau nhiều lần lỗi: ' + e.message, 'error');
        }
      } finally {
        active--;
        report();
      }
      if (st.delayMs) { try { await sleep(Number(st.delayMs), signal); } catch { break; } }
    }
  };
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker(i + 1));
  await Promise.all(workers);
  void active;
  if (stopErr) throw stopErr;
  return { done, failed, failures, aborted: !!signal?.aborted };
}

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(card_name|glossary|segments|items|name_rule|target_lang)\}\}/g, (m, k) => vars[k] ?? m);
}

export function buildBatchMessages(job, segs) {
  const st = job.settings;
  const prompts = { ...DEFAULT_PROMPTS, ...(st.prompts || {}) };
  const nameRule = NAME_RULES[st.nameStyle || 'auto'];
  const glossary = glossaryFor(segs.map((s) => s.key), job.dict, st, job.glossary || []);
  const segText = segs.map((s, i) => {
    const note = job.notes?.get(s.key);
    return `<seg id="${i + 1}" type="${TYPE_ATTR[s.kind] || 'prose'}"${note ? ` note="${escAttr('Lần dịch trước bị lỗi: ' + note)}"` : ''}>${s.key}</seg>`;
  }).join('\n');
  const vars = { card_name: job.cardName || '', glossary: formatGlossary(glossary), segments: segText, name_rule: nameRule, target_lang: 'tiếng Việt' };
  const system = fillTemplate(prompts.system, vars);
  let task = fillTemplate(prompts.task, vars);
  // ký hiệu mà regex của card cần (chỉ nhắc khi các đoạn trong lô thật sự có chúng)
  const need = (job.guard || []).filter((ch) => segs.some((s) => s.key.includes(ch)));
  if (need.length) task += `\n\nKý hiệu BẮT BUỘC giữ nguyên, đúng số lượng (regex của card dùng để nhận diện): ${need.join(' ')}`;
  return buildMessages(job.preset || {}, {
    usePresetPrompts: !!st.usePresetPrompts,
    systemPrompt: system,
    taskMessages: [{ role: 'user', content: task }],
    macro: { user: st.userName || 'User', char: job.cardName || 'Character', model: job.conn?.model },
    provider: job.conn?.provider,
    applyPrefill: !!st.applyPrefill,
  });
}

async function translateBatch(job, segs, wid) {
  const messages = buildBatchMessages(job, segs);
  job.onLog?.(`Lô #${wid}: gửi ${segs.length} đoạn (${segs.reduce((n, s) => n + s.key.length, 0)} ký tự)…`, 'info');
  const t0 = Date.now();
  const res = await chat(job.conn, job.preset, messages, {
    signal: job.signal,
    onDelta: (text) => job.onStream?.(wid, text),
  });
  const parsed = parseTagged(res.text, 'seg');
  const ok = [], bad = [];
  segs.forEach((seg, i) => {
    const v = validateSegment(seg, parsed.get(i + 1), job.allowed, { guard: job.guard });
    if (v.ok) ok.push([seg.key, v.out, v.warn]);
    else bad.push({ seg, reason: v.reason, out: v.out, soft: v.soft, leftover: v.leftover });
  });
  job.onLog?.(`Lô #${wid}: xong ${ok.length}/${segs.length} đoạn trong ${((Date.now() - t0) / 1000).toFixed(1)}s${res.truncated ? ' (bị cắt do giới hạn token)' : ''}`, bad.length ? 'warn' : 'ok');
  if (!parsed.size && res.text) job.onLog?.('Phản hồi không đúng định dạng: ' + res.text.slice(0, 300), 'error');
  return { ok, bad, truncated: res.truncated };
}

/**
 * Gợi ý bản dịch cho từ điển biến/thuật ngữ.
 * entries: [{src, kind, parents}] -> onItem(src, dst)
 */
export async function suggestDict(job, entries) {
  const st = job.settings;
  const prompts = { ...DEFAULT_PROMPTS, ...(st.prompts || {}) };
  const nameRule = NAME_RULES[st.nameStyle || 'auto'];
  const batches = [];
  for (let i = 0; i < entries.length; i += 80) batches.push(entries.slice(i, i + 80));
  let done = 0;
  const concurrency = Math.max(1, Math.min(8, Number(st.concurrency) || 2));
  const queue = batches.map((b) => ({ b, attempt: 0 }));
  const notes = new Map();   // src -> lỗi của lần gợi ý trước (vd trả về vẫn là chữ Hán)
  const failed = [];         // mục AI không dịch được sau các lần thử
  const worker = async () => {
    while (queue.length && !job.signal?.aborted) {
      const { b, attempt } = queue.shift();
      const items = b.map((e, i) => `<item id="${i + 1}" kind="${e.kind}"${e.parents?.length ? ` ctx="${escAttr(e.parents.slice(0, 2).join(' | '))}"` : ''}${notes.has(e.src) ? ` note="${escAttr(notes.get(e.src))}"` : ''}>${e.src}</item>`).join('\n');
      const content = fillTemplate(prompts.dict, { card_name: job.cardName || '', name_rule: nameRule, items });
      const messages = buildMessages(job.preset || {}, {
        usePresetPrompts: !!st.usePresetPrompts,
        systemPrompt: 'Bạn là dịch giả Trung → Việt chuyên Việt hóa card SillyTavern. Chỉ trả về đúng định dạng được yêu cầu.',
        taskMessages: [{ role: 'user', content }],
        macro: { user: st.userName || 'User', char: job.cardName || 'Character' },
        provider: job.conn?.provider,
        applyPrefill: !!st.applyPrefill,
      });
      try {
        const res = await chat(job.conn, job.preset, messages, { signal: job.signal, onDelta: (t) => job.onStream?.(0, t) });
        const parsed = parseTagged(res.text, 'item');
        const missing = [];
        b.forEach((e, i) => {
          const v = parsed.get(i + 1);
          const name = v != null ? sanitizeName(stripGlossaryTags(v.trim()), e.kind) : '';
          // bản dịch vẫn còn chữ Hán (model không dịch được chữ hiếm, hoặc chép lại bản gốc) -> không nhận, gợi ý lại
          if (name && !hasCJK(name)) { job.onItem?.(e.src, name); notes.delete(e.src); done++; return; }
          if (name) notes.set(e.src, `lần trước trả về "${name}" — vẫn còn chữ Hán; phải dịch hoặc phiên âm Hán Việt toàn bộ`);
          missing.push(e);
        });
        if (missing.length && attempt < 2) queue.push({ b: missing, attempt: attempt + 1 });
        else if (missing.length) failed.push(...missing.map((e) => e.src));
        job.onLog?.(`Từ điển: đã gợi ý ${done}/${entries.length}`, 'ok');
      } catch (e) {
        if (job.signal?.aborted) break;
        if (attempt < 2) { queue.push({ b, attempt: attempt + 1 }); job.onLog?.('Lỗi gợi ý từ điển: ' + e.message + ' → thử lại', 'warn'); await sleep(3000 * (attempt + 1), job.signal).catch(() => {}); }
        else job.onLog?.('Lỗi gợi ý từ điển: ' + e.message, 'error');
        if (e.status === 401 || e.status === 403) throw e;
      }
      job.onProgress?.({ done, total: entries.length });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failed.length) job.onLog?.(`Từ điển: ${failed.length} mục AI chưa dịch được (để trống, sẽ được báo ở tab Kiểm tra): ${failed.slice(0, 12).join(', ')}${failed.length > 12 ? '…' : ''}`, 'warn');
  return { done, failed };
}

// ====================================================================== xung đột tên biến

/** Tên đang dùng (sau kiểu đặt tên) của các khóa thuộc object cha `parent`, bỏ qua các khóa trong `exclude` */
function namesUnder(dict, settings, parent, exclude) {
  const idx = makeDictIndex(dict, settings);
  const out = new Set();
  for (const [src, v] of Object.entries(dict || {})) {
    if (v.kind !== 'key' || exclude?.has(src)) continue;
    const ps = v.parents?.length ? v.parents : [''];
    if (ps.includes(parent)) out.add(idx.lookup(src));
  }
  return out;
}

/**
 * Lập kế hoạch sửa xung đột: mỗi nhóm giữ tên cho 1 mục (mục sửa tay nếu không phải tất cả đều sửa tay,
 * ngược lại mục dùng nhiều nhất), các mục còn lại cần đặt tên mới.
 * Trả về [{ parent, keep:[src], rename:[src] }]
 */
export function planConflicts(dict, conflicts) {
  const groups = [];
  const seen = new Set();
  for (const c of conflicts) {
    const members = c.srcs.filter((s) => dict[s]);
    if (members.length < 2) continue;
    const manual = members.filter((s) => dict[s].manual);
    const keep = manual.length && manual.length < members.length
      ? manual
      : [members.slice().sort((a, b) => (dict[b].count || 0) - (dict[a].count || 0) || a.localeCompare(b))[0]];
    const rename = members.filter((s) => !keep.includes(s) && !seen.has(s));
    rename.forEach((s) => seen.add(s));
    if (rename.length) groups.push({ parent: c.parent, dst: c.dst, keep, rename });
  }
  return groups;
}

/** Hậu tố số cho các khóa vẫn còn trùng (bảo đảm khác nhau tuyệt đối). Trả về danh sách thay đổi */
export function suffixConflicts(dict, settings) {
  const changes = [];
  for (let guard = 0; guard < 6; guard++) {
    const conflicts = findConflicts(dict, settings);
    if (!conflicts.length) break;
    for (const g of planConflicts(dict, conflicts)) {
      const style = settings.namingStyle || 'natural';
      for (const src of g.rename) {
        const e = dict[src];
        const used = new Set();
        for (const p of e.parents?.length ? e.parents : ['']) for (const n of namesUnder(dict, settings, p, new Set([src]))) used.add(conflictKey(n));
        const from = makeDictIndex(dict, settings).lookup(src);
        const base = String(e.dst || src).replace(/[\s_]*\d+$/, '').trim() || src;
        let k = 2, cand = '';
        do { cand = `${base} ${k++}`; } while (used.has(conflictKey(applyStyle(cand, style, 'key', src))) && k < 200);
        e.dst = cand; e.auto = true; e.manual = false;
        changes.push({ src, from, to: makeDictIndex(dict, settings).lookup(src) });
      }
    }
  }
  return changes;
}

/**
 * Tự dịch lại các biến bị trùng tên bằng AI (tối đa `rounds` vòng), còn trùng thì thêm hậu tố số.
 * job: { settings, conn, preset, cardName, signal, onLog, onStream }
 * dict: từ điển của dự án (được sửa trực tiếp). useAI=false -> chỉ thêm hậu tố.
 * Trả về { renamed:[{src,from,to}], suffixed:[{src,from,to}], remaining: conflicts[] }
 */
export async function resolveConflicts(job, dict, { rounds = 2, useAI = true } = {}) {
  const st = job.settings || {};
  const prompts = { ...DEFAULT_PROMPTS, ...(st.prompts || {}) };
  const nameRule = NAME_RULES[st.nameStyle || 'auto'];
  const style = st.namingStyle || 'natural';
  const styleNote = style === 'snake' || style === 'camel' ? '\n- Tên biến sẽ được BỎ DẤU (kiểu đặt tên không dấu) nên các tên phải khác nhau cả khi bỏ dấu tiếng Việt (vd "Năm" và "Nam" bị coi là trùng).' : '';
  const renamed = [];
  const notes = new Map();
  for (let round = 0; round < rounds && useAI; round++) {
    if (job.signal?.aborted) break;
    const conflicts = findConflicts(dict, st);
    if (!conflicts.length) break;
    const groups = planConflicts(dict, conflicts);
    // chia lô theo nhóm, mỗi lô <= 50 mục
    const batches = [];
    let cur = [], n = 0;
    for (const g of groups) {
      if (cur.length && n + g.rename.length > 50) { batches.push(cur); cur = []; n = 0; }
      cur.push(g); n += g.rename.length;
    }
    if (cur.length) batches.push(cur);
    job.onLog?.(`Xung đột tên biến: ${conflicts.length} nhóm → AI đặt lại ${groups.reduce((x, g) => x + g.rename.length, 0)} tên (vòng ${round + 1})`, 'info');
    for (const batch of batches) {
      if (job.signal?.aborted) break;
      const idx = makeDictIndex(dict, st);
      const ids = [];
      const parts = batch.map((g) => {
        const members = new Set([...g.keep, ...g.rename]);
        const used = [...namesUnder(dict, st, g.parent, members)].slice(0, 40);
        const lines = [`<group ctx="${escAttr(g.parent || '(gốc)')}"${used.length ? ` used="${escAttr(used.join(' | '))}"` : ''}>`];
        for (const s of g.keep) lines.push(`<keep src="${escAttr(s)}">${idx.lookup(s)}</keep>`);
        for (const s of g.rename) {
          ids.push(s);
          const note = notes.get(s);
          lines.push(`<item id="${ids.length}" now="${escAttr(idx.lookup(s))}"${note ? ` note="${escAttr(note)}"` : ''}>${s}</item>`);
        }
        lines.push('</group>');
        return lines.join('\n');
      }).join('\n\n');
      const content = fillTemplate(prompts.conflict || CONFLICT_PROMPT, { card_name: job.cardName || '', name_rule: nameRule, items: parts }).replace('{{style_note}}', styleNote);
      const messages = buildMessages(job.preset || {}, {
        usePresetPrompts: !!st.usePresetPrompts,
        systemPrompt: 'Bạn là dịch giả Trung → Việt chuyên Việt hóa card SillyTavern. Chỉ trả về đúng định dạng được yêu cầu.',
        taskMessages: [{ role: 'user', content }],
        macro: { user: st.userName || 'User', char: job.cardName || 'Character' },
        provider: job.conn?.provider,
        applyPrefill: !!st.applyPrefill,
      });
      try {
        const res = await chat(job.conn, job.preset, messages, { signal: job.signal, onDelta: (t) => job.onStream?.('conflict', t) });
        const parsed = parseTagged(res.text, 'item');
        ids.forEach((src, i) => {
          const v = parsed.get(i + 1);
          if (v == null || !v.trim()) return;
          const e = dict[src];
          const from = makeDictIndex(dict, st).lookup(src);
          const name = sanitizeName(stripGlossaryTags(v.trim()), 'key');
          // tên chỉ khác chữ hoa/thường ("chân" so với "Chân") vẫn là trùng
          if (!name || hasCJK(name) || conflictKey(applyStyle(name, style, 'key', src)) === conflictKey(from)) { notes.set(src, `tên "${from}" vẫn bị trùng — hãy chọn tên khác hẳn (khác cả khi không phân biệt chữ hoa/thường)`); return; }
          e.dst = name; e.auto = true; e.manual = false;
          renamed.push({ src, from, to: makeDictIndex(dict, st).lookup(src) });
        });
      } catch (e) {
        if (job.signal?.aborted || e.name === 'AbortError') break;
        job.onLog?.('Lỗi khi nhờ AI sửa tên biến trùng: ' + e.message, 'warn');
        if (e.status === 401 || e.status === 403) throw e;
      }
    }
    for (const c of findConflicts(dict, st)) for (const s of c.srcs) if (!notes.has(s)) notes.set(s, `lần trước vẫn trùng tên "${c.dst}" — hãy chọn tên khác hẳn`);
  }
  const suffixed = job.signal?.aborted ? [] : suffixConflicts(dict, st);
  return { renamed, suffixed, remaining: findConflicts(dict, st) };
}

export { makeDictIndex, applyStyle, hasCJK, isKeptEntry };
