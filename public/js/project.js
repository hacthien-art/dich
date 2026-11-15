// Dự án dịch: gắn card + từ điển + bộ nhớ dịch (TM) + chỉnh tay; phân tích, render, xuất card.
import { makeCard, listItems, buildTranslatedCard, exportCardJson, exportCardPng } from './core/card.js';
import { scanCard, mergeScan, makeDictIndex, findConflicts, cleanDictTags } from './core/dict.js';
import { analyzeItem, findDynamicEntryRefs } from './core/analyze.js';
import { validateSegment, allowedHanSet, stripGlossaryTags } from './core/translate.js';
import { collectGuardChars, runChecks } from './core/check.js';
import { legacyVariants, ParaMemory, subSegment } from './core/reuse.js';
import { uuid, hasCJK, deepClone } from './core/util.js';
import { utf8ToBase64, verifyPng, isPng } from './core/png.js';

/** Phiên bản cách đặt khóa đoạn dịch của bộ phân tích. Tăng lên khi khóa thay đổi -> dự án cũ được chuyển bản dịch 1 lần. */
export const ANALYZER_VERSION = 2;

export const DEFAULT_TRANSLATE_SETTINGS = {
  usePresetPrompts: false,
  applyPrefill: false,
  concurrency: 3,
  batchChars: 3000,
  batchSegs: 60,
  retries: 2,
  delayMs: 0,
  chunkSize: 1800,
  nameStyle: 'auto',
  varMode: 'translate',
  namingStyle: 'natural',
  markerMode: 'translate',
  keysMode: 'append',
  codeStrings: 'smart',
  ejsStrings: false,
  comments: true,
  autoFixConflicts: true,
  userName: 'User',
  translateCardName: true,
  translateTags: true,
  translateComments: true,
  translateScriptNames: true,
  translateRegexNames: true,
  translateScriptInfo: true,
  autoSuggestDict: true,
  widenRegex: true,
  prompts: {},
};

/** Tên định danh của một mục (không phụ thuộc vị trí trong mảng) — để ghép mục cũ/mới khi cập nhật card */
function itemField(it) {
  for (let i = it.path.length - 1; i >= 0; i--) if (typeof it.path[i] === 'string') return it.path[i];
  return '';
}
function itemNameSig(it) {
  const f = itemField(it);
  if (it.group === 'lorebook' || it.group === 'regex' || it.group === 'scripts') return [it.group, it.kind === 'button' ? 'button:' + it.text : '', it.meta?.title ?? '', f].join('\u0000');
  return it.id;
}
function itemTextSig(it) {
  return [it.kind, itemField(it), Array.isArray(it.text) ? JSON.stringify(it.text) : String(it.text ?? '')].join('\u0000');
}

/**
 * Ghép các mục của card cũ với card mới.
 * Trả về { same: Map(oldId -> newItem) nội dung nguồn y hệt (có thể đổi vị trí), changed: Map(oldId -> newItem) cùng tên
 * nhưng nội dung đổi, added: [newItem], removed: [oldItem] }
 */
export function matchItems(oldItems, newItems) {
  const same = new Map(), changed = new Map();
  const usedOld = new Set(), usedNew = new Set();
  const byText = new Map();
  for (const o of oldItems) { const k = itemTextSig(o); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(o); }
  for (const n of newItems) {
    const list = byText.get(itemTextSig(n));
    if (!list) continue;
    const sig = itemNameSig(n);
    const o = list.find((x) => !usedOld.has(x.id) && itemNameSig(x) === sig) || list.find((x) => !usedOld.has(x.id));
    if (!o) continue;
    same.set(o.id, n); usedOld.add(o.id); usedNew.add(n.id);
  }
  const byName = new Map();
  for (const o of oldItems) { if (usedOld.has(o.id)) continue; const k = itemNameSig(o); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(o); }
  for (const n of newItems) {
    if (usedNew.has(n.id)) continue;
    const list = byName.get(itemNameSig(n));
    const o = list && list.find((x) => !usedOld.has(x.id) && x.kind === n.kind);
    if (!o) continue;
    changed.set(o.id, n); usedOld.add(o.id); usedNew.add(n.id);
  }
  return { same, changed, added: newItems.filter((n) => !usedNew.has(n.id)), removed: oldItems.filter((o) => !usedOld.has(o.id)) };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}

export class Project {
  /** data: dạng lưu trữ JSON */
  constructor(data) {
    this.data = data;
    this.data.dict ||= {};
    this.data.tm ||= {};
    this.data.overrides ||= {};
    this.data.excluded ||= {};
    this.data.glossary ||= [];
    this.data.warnings ||= {};
    this.card = makeCard(data.card, { fileName: data.fileName, format: data.format, image: data.imageB64 ? b64ToBytes(data.imageB64) : null });
    this.tm = new Map(Object.entries(this.data.tm));
    this.items = listItems(this.card);
    this.itemById = new Map(this.items.map((it) => [it.id, it]));
    this.version = 0;
    this.analyses = new Map();
    this.scan = null;
  }

  static fromFile(card, fileName) {
    const raw = card.raw;
    const data = {
      id: uuid(),
      name: raw.data?.name || fileName,
      fileName,
      format: card.format,
      imageB64: card.image ? bytesToB64(card.image) : null,
      card: raw,
      av: ANALYZER_VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return new Project(data);
  }

  get id() { return this.data.id; }
  get name() { return this.data.name; }
  get cardName() { return this.card.raw.data?.name || ''; }

  // ------------------------------------------------------------------ quét & phân tích
  /**
   * Quét lại biến + phân tích lại card. Ghi kết quả tự sửa vào this.lastRepair:
   * { dictTags, tmTags, legacy, composed } (nhãn [biến] đã gỡ, bản dịch cũ được chuyển sang khóa mới).
   */
  rescan(settings) {
    this.scan = scanCard(this.card, this.items);
    // Kho lưu từ điển: mục có bản dịch nhưng tạm thời không còn trong card (card được cập nhật, tác giả bỏ rồi thêm lại…)
    // được cất đi thay vì xóa hẳn -> khi nó xuất hiện lại thì dùng ngay bản dịch cũ.
    const archive = (this.data.dictArchive ||= {});
    const merged = mergeScan({ ...archive, ...this.data.dict }, this.scan.entries);
    for (const [src, v] of Object.entries(this.data.dict)) {
      if (!merged[src] && v && (v.dst || v.keep)) archive[src] = { kind: v.kind, dst: v.dst, keep: !!v.keep, manual: !!v.manual, ...(v.kindManual ? { kindManual: true } : {}) };
    }
    for (const src of Object.keys(merged)) delete archive[src];
    this.data.dict = merged;
    const dictTags = cleanDictTags(this.data.dict);
    this.analyze(settings);
    // dự án dịch bằng bản cũ: khóa đoạn của bộ phân tích đã đổi -> chuyển bản dịch cũ sang khóa mới (1 lần)
    let reused = { legacy: 0, composed: 0 };
    if ((this.data.av || 1) < ANALYZER_VERSION) {
      reused = this.reuseTranslations();
      this.data.av = ANALYZER_VERSION;
      this.touch();
    }
    const tmTags = this.recheckWarnings(settings).repaired;
    if (dictTags) { this.bump(); this.touch(); }
    this.lastRepair = { dictTags, tmTags, ...reused };
    return this.scan;
  }

  /**
   * Kiểm tra lại toàn bộ bản dịch đã có -> cập nhật cảnh báo (còn sót chữ Hán, mất ký hiệu regex cần…).
   * Đồng thời gỡ nhãn phân loại "[biến]" / "[giá trị]" bị model chép vào bản dịch cũ.
   * Trả về { changed, repaired }
   */
  recheckWarnings(settings = this.settings) {
    const allowed = allowedHanSet(this.data.dict, settings, this.data.glossary);
    let changed = 0, repaired = 0;
    for (const [key, text0] of this.tm) {
      let text = text0;
      const clean = stripGlossaryTags(text, key);
      if (clean !== text) { text = clean; this.tm.set(key, text); repaired++; }
      const e = this.segByKey?.get(key);
      if (!e) continue;
      const v = validateSegment(e.seg, text, allowed, { guard: this.guard });
      const w = v.ok ? v.warn : v.reason;
      if (w) { if (this.data.warnings[key] !== w) changed++; this.data.warnings[key] = w; }
      else if (this.data.warnings[key]) { delete this.data.warnings[key]; changed++; }
    }
    if (changed || repaired) { this.bump(); this.touch(); }
    return { changed, repaired };
  }

  /**
   * Điền bản dịch cho các đoạn CHƯA có trong bộ nhớ dịch bằng những gì đã dịch trước đó, không gọi AI:
   * 1) khóa kiểu bản 1.1 (nhãn 【…】, $1 trong chuỗi) -> chuyển sang khóa mới
   * 2) ghép từ từng đoạn văn / dòng đã dịch (đoạn dài bị cắt lại, card cập nhật chỉ thêm/bớt vài dòng)
   * Trả về { legacy, composed }
   */
  reuseTranslations({ compose = true } = {}) {
    const res = { legacy: 0, composed: 0 };
    if (!this.tm.size) return res;
    const todo = this.segmentsFor(this.items.map((it) => it.id)).filter((s) => !this.tm.has(s.key));
    if (!todo.length) return res;
    const allowed = allowedHanSet(this.data.dict, this.settings, this.data.glossary);
    const accept = (seg, text, allowSoft) => {
      const v = validateSegment(seg, text, allowed, { guard: this.guard });
      if (!v.ok && !(allowSoft && v.soft && v.out)) return false;
      this.tm.set(seg.key, v.out ?? text);
      if (v.ok) delete this.data.warnings[seg.key]; else this.data.warnings[seg.key] = v.reason;
      return true;
    };
    for (const seg of todo) {
      for (const lv of legacyVariants(seg)) {
        const old = this.tm.get(lv.key);
        if (old == null) continue;
        const t = lv.convert(old);
        if (t != null && accept(seg, t, true)) { res.legacy++; break; }
      }
    }
    if (compose) {
      const rest = todo.filter((s) => !this.tm.has(s.key));
      if (rest.length) {
        const mem = this.paraMemory();
        for (const seg of rest) {
          const t = mem.compose(seg.key);
          if (t != null && accept(seg, t, false)) res.composed++;
        }
      }
    }
    if (res.legacy || res.composed) { this.bump(); this.touch(); }
    return res;
  }

  /** Bộ nhớ đoạn văn / khối dòng học từ các bản dịch không có cảnh báo */
  paraMemory() {
    const mem = new ParaMemory();
    for (const [k, t] of this.tm) if (!this.data.warnings[k]) mem.learn(k, t);
    return mem;
  }

  /**
   * Kế hoạch dịch "chỉ phần thay đổi": đoạn chưa dịch mà phần lớn nội dung đã từng dịch (card được cập nhật, tác giả
   * sửa/thêm vài dòng) -> chỉ gửi AI các khối dòng mới (đoạn con), rồi ghép lại bằng reuseTranslations().
   * Trả về { send: [đoạn gửi AI], parts: số đoạn con, whole: số đoạn gửi nguyên, savedChars }
   */
  deltaPlan(segs) {
    const out = { send: [], parts: 0, whole: 0, savedChars: 0 };
    const mem = this.tm.size ? this.paraMemory() : null;
    const seen = new Set();
    for (const seg of segs) {
      if (this.tm.has(seg.key) || !mem) { out.send.push(seg); out.whole++; continue; }
      const m = mem.missing(seg.key);
      // chỉ tách khi phần đã biết đáng kể; phần mới không được dịch sẵn mà vẫn không ghép được (tránh vòng lặp)
      const useParts = m.parts.length && m.known >= Math.max(4, m.unknown * 0.5) && m.parts.every((pt) => !this.tm.has(subSegment(pt, seg.holes).key));
      if (!useParts) { out.send.push(seg); out.whole++; continue; }
      let partChars = 0;
      for (const pt of m.parts) {
        const sub = subSegment(pt, seg.holes);
        partChars += sub.key.length;
        if (seen.has(sub.key)) continue;
        seen.add(sub.key);
        out.send.push({ key: sub.key, holes: sub.holes, kind: seg.kind, esc: seg.esc, part: true });
        out.parts++;
      }
      out.savedChars += Math.max(0, seg.key.length - partChars);
    }
    return out;
  }

  /**
   * Cập nhật card gốc lên bản mới của tác giả mà KHÔNG mất bản dịch:
   * - bộ nhớ dịch giữ nguyên: đoạn nào văn bản nguồn không đổi thì dùng lại ngay; đoạn dài chỉ sửa vài dòng được ghép
   *   lại từ các đoạn văn/dòng đã dịch; chỉ phần thực sự mới mới cần gọi AI
   * - từ điển giữ bản dịch / "Giữ" / sửa tay; mục biến mất được cất vào kho để dùng lại
   * - chỉnh tay theo mục và lựa chọn "không dịch mục này" được chuyển sang mục tương ứng của card mới
   * Trả về { stats, undo() } — undo() khôi phục card cũ (dùng khi chọn nhầm file).
   */
  updateCard(card, settings = this.settings) {
    const allIds = () => this.items.map((it) => it.id);
    const old = {
      card: this.card, items: this.items, raw: this.data.card, fileName: this.data.fileName, format: this.data.format, imageB64: this.data.imageB64,
      dict: this.data.dict, dictArchive: { ...(this.data.dictArchive || {}) }, overrides: this.data.overrides, excluded: this.data.excluded,
      warnings: { ...this.data.warnings }, tmKeys: new Set(this.tm.keys()), stale: (this.data.staleOverrides || []).slice(), updates: (this.data.updates || []).slice(),
    };
    const oldSegKeys = new Set(this.segmentsFor(allIds()).map((s) => s.key));
    const oldDictKeys = new Set(Object.keys(this.data.dict));
    const oldById = new Map(old.items.map((it) => [it.id, it]));

    // card mới là JSON (không có ảnh) -> giữ ảnh đang dùng
    if (!card.image && this.card.image) card.image = this.card.image;
    else this.data.imageB64 = card.image ? bytesToB64(card.image) : null;
    this.card = card;
    this.data.card = card.raw;
    this.data.fileName = card.fileName;
    this.data.format = card.format;
    const newItems = listItems(card);
    const match = matchItems(old.items, newItems);

    // chỉnh tay: chỉ mang sang khi văn bản nguồn của mục không đổi; nguồn đã đổi -> cất lại để người dùng xem
    const overrides = {}, dropped = [];
    for (const [id, val] of Object.entries(old.overrides)) {
      const n = match.same.get(id);
      if (n) overrides[n.id] = val;
      else dropped.push({ label: oldById.get(id)?.label || id, value: val, at: Date.now() });
    }
    const excluded = {};
    for (const id of Object.keys(old.excluded)) {
      const n = match.same.get(id) || match.changed.get(id);
      if (n) excluded[n.id] = true;
    }
    this.data.overrides = overrides;
    this.data.excluded = excluded;
    if (dropped.length) this.data.staleOverrides = [...old.stale, ...dropped].slice(-50);
    this.items = newItems;
    this.itemById = new Map(newItems.map((it) => [it.id, it]));
    this.rescan(settings);
    const reused = this.reuseTranslations();
    this.recheckWarnings(settings);

    const segs = this.segmentsFor();
    const todo = segs.filter((s) => !this.tm.has(s.key));
    const plan = this.deltaPlan(todo);
    const allSegs = this.segmentsFor(allIds());
    const newDict = Object.keys(this.data.dict);
    const stats = {
      fileName: card.fileName,
      items: {
        total: newItems.length, same: match.same.size,
        changed: [...match.changed.values()].map((it) => it.label),
        added: match.added.map((it) => it.label),
        removed: match.removed.map((it) => it.label),
      },
      segs: {
        total: segs.length, done: segs.length - todo.length, todo: todo.length,
        // ký tự thực sự phải gửi AI: đoạn dài chỉ sửa vài dòng thì chỉ tính các dòng mới
        todoChars: plan.send.reduce((n, s) => n + s.key.length, 0), parts: plan.parts,
        exact: allSegs.filter((s) => oldSegKeys.has(s.key) && old.tmKeys.has(s.key)).length,
        legacy: reused.legacy, composed: reused.composed,
      },
      dict: {
        total: newDict.length,
        added: newDict.filter((k) => !oldDictKeys.has(k)).length,
        removed: [...oldDictKeys].filter((k) => !this.data.dict[k]).length,
        needTranslation: newDict.filter((k) => !this.data.dict[k].dst && !this.data.dict[k].keep).length,
      },
      overrides: { kept: Object.keys(overrides).length, dropped: dropped.map((d) => d.label) },
      // tỉ lệ mục của card mới ghép được với card cũ — thấp nghĩa là chọn nhầm card khác
      similarity: newItems.length ? (match.same.size + match.changed.size) / newItems.length : 0,
    };
    this.data.updates = [...old.updates, { at: Date.now(), fileName: card.fileName, same: stats.items.same, changed: stats.items.changed.length, added: stats.items.added.length, removed: stats.items.removed.length, todo: stats.segs.todo }].slice(-20);
    this.touch();

    const undo = () => {
      this.card = old.card;
      this.data.card = old.raw; this.data.fileName = old.fileName; this.data.format = old.format; this.data.imageB64 = old.imageB64;
      this.data.dict = old.dict; this.data.dictArchive = old.dictArchive;
      this.data.overrides = old.overrides; this.data.excluded = old.excluded;
      this.data.staleOverrides = old.stale; this.data.updates = old.updates;
      for (const k of [...this.tm.keys()]) if (!old.tmKeys.has(k)) this.tm.delete(k);
      this.data.warnings = old.warnings;
      this.items = old.items;
      this.itemById = new Map(old.items.map((it) => [it.id, it]));
      this.rescan(settings);
      this.touch();
    };
    return { stats, undo };
  }

  /** Kiểm tra tổng thể card sau dịch (xem core/check.js) */
  check(settings = this.settings, opts) { return runChecks(this, settings, opts); }

  /** Các đoạn (thuộc mục được dịch) chưa dịch hoặc có lỗi/cảnh báo */
  problemSegments() {
    return this.segmentsFor().filter((s) => !this.tm.has(s.key) || this.data.warnings[s.key]);
  }

  dictIndex(settings) { return makeDictIndex(this.data.dict, settings); }

  analyze(settings) {
    const idx = this.dictIndex(settings);
    const entryNames = new Set();
    this.commentItemBySrc = new Map();
    for (const it of this.items) {
      if (it.kind === 'comment' && typeof it.text === 'string' && it.text) { entryNames.add(it.text); if (!this.commentItemBySrc.has(it.text)) this.commentItemBySrc.set(it.text, it.id); }
    }
    const bookItem = this.items.find((it) => it.path.join('.') === 'data.character_book.name');
    const bookNames = new Set(bookItem ? [bookItem.text] : []);
    this.bookItem = bookItem;
    // ký hiệu mà find regex của card khớp nguyên văn (【 】 「 」…): bản dịch của mọi đoạn phải giữ đủ
    this.guard = collectGuardChars((this.card.raw.data.extensions?.regex_scripts || []).map((r) => r?.findRegex), { tolerant: settings.widenRegex !== false });
    // tên mục lorebook bị EJS/script ghép động (getwi(null, sách + ' / 第' + n + '章')) -> phải giữ nguyên
    const dyn = findDynamicEntryRefs(this.items.map((it) => it.text), entryNames);
    this.pinnedEntries = dyn.pinned;
    const ctx = {
      dict: idx,
      entryNames: settings.translateComments ? entryNames : new Set(),
      bookNames,
      opts: { codeStrings: settings.codeStrings, ejsStrings: settings.ejsStrings, comments: settings.comments, chunkSize: settings.chunkSize },
    };
    this.analyses = new Map();
    this.segByKey = new Map();
    const pinNote = 'Tên mục này được EJS/script ghép động (vd getwi(null, tênSách + " / 第" + n + "章")) nên được giữ nguyên để mã vẫn tìm thấy mục.';
    const dynNote = dyn.dynamic.length ? `Có lời gọi getwi()/activewi() lấy tên mục lorebook từ biến (${dyn.dynamic.slice(0, 3).join(' · ')}) — nếu mục không được tìm thấy sau khi dịch, hãy tắt "Dịch tên mục lorebook" ở tab Cài đặt dịch.` : null;
    for (const it of this.items) {
      const a = it.kind === 'comment' && this.pinnedEntries.has(it.text)
        ? { segments: [], warnings: [pinNote], render: () => it.text, pinned: true }
        : analyzeItem(it, ctx);
      if (dynNote && typeof it.text === 'string' && /getwi|getWorldInfo|activewi|activateWorldInfo/.test(it.text) && !a.warnings.includes(dynNote)) a.warnings.push(dynNote);
      this.analyses.set(it.id, a);
      for (const s of a.segments) {
        let e = this.segByKey.get(s.key);
        if (!e) { e = { seg: s, items: new Set() }; this.segByKey.set(s.key, e); }
        e.items.add(it.id);
      }
    }
    this.settings = settings;
    this.bump();
  }

  bump() { this.version++; this.renderCache = new Map(); }

  /** Mục có được gửi đi dịch không */
  isIncluded(it, settings = this.settings) {
    if (this.data.excluded[it.id]) return false;
    const p = it.path.join('.');
    if (it.kind === 'name') {
      if (p === 'data.name') return !!settings.translateCardName;
      if (p.includes('regex_scripts')) return !!settings.translateRegexNames;
      if (p.includes('scripts')) return !!settings.translateScriptNames;
      return true;
    }
    if (it.kind === 'comment') return !!settings.translateComments && !this.pinnedEntries?.has(it.text);
    if (it.kind === 'list') return !!settings.translateTags;
    if (it.kind === 'button') return !!settings.translateScriptNames;
    if (p.endsWith('.info')) return !!settings.translateScriptInfo;
    return true;
  }

  /** Các đoạn cần dịch (duy nhất) của danh sách mục */
  segmentsFor(itemIds) {
    const out = [];
    const seen = new Set();
    const ids = itemIds || this.items.filter((it) => this.isIncluded(it)).map((it) => it.id);
    for (const id of ids) {
      const a = this.analyses.get(id);
      if (!a) continue;
      for (const s of a.segments) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        out.push(s);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ render
  env(settings = this.settings) {
    const idx = this.dictIndex(settings);
    const self = this;
    const tm = new Map(this.tm);
    // mục bị loại trừ: không dùng bản dịch (chỉ ánh xạ biến)
    return {
      tm,
      dict: idx,
      keysMode: settings.keysMode,
      // dấu câu toàn độ rộng trong regex (：，（）…) nhận cả dấu ASCII — bản dịch tiếng Việt viết "Độ hảo cảm: 50"
      widenRegex: settings.widenRegex !== false,
      entryName(src) {
        if (!settings.translateComments) return src;
        const id = self.commentItemBySrc?.get(src);
        if (!id) return src;
        return self.output(id, settings);
      },
      bookName(src) {
        if (!self.bookItem) return src;
        return self.output(self.bookItem.id, settings);
      },
    };
  }

  output(itemId, settings = this.settings) {
    if (this.data.overrides[itemId] !== undefined) return this.data.overrides[itemId];
    if (this.renderCache.has(itemId)) return this.renderCache.get(itemId);
    const it = this.itemById.get(itemId);
    const a = this.analyses.get(itemId);
    if (!it || !a) return it?.text;
    this.renderCache.set(itemId, it.text); // chống đệ quy
    let env = this.env(settings);
    if (!this.isIncluded(it, settings)) env = { ...env, tm: new Map() };
    let out;
    try { out = a.render(env); } catch (e) { console.error('render lỗi', itemId, e); out = it.text; }
    this.renderCache.set(itemId, out);
    return out;
  }

  status(itemId) {
    const a = this.analyses.get(itemId);
    const it = this.itemById.get(itemId);
    if (!a || !it) return { total: 0, done: 0, failed: 0, state: 'none' };
    const keys = [...new Set(a.segments.map((s) => s.key))];
    const total = keys.length;
    const done = keys.filter((k) => this.tm.has(k)).length;
    const warn = keys.filter((k) => this.data.warnings[k]).length;
    let state = 'none';
    if (this.data.overrides[itemId] !== undefined) state = 'manual';
    else if (!total) state = hasCJK(Array.isArray(it.text) ? it.text.join('') : it.text) ? 'sync' : 'none';
    else if (done === total) state = warn ? 'warn' : 'done';
    else if (done) state = 'partial';
    else state = 'todo';
    if (!this.isIncluded(it) && state !== 'manual') state = total ? 'excluded' : state;
    return { total, done, warn, state };
  }

  stats() {
    const segs = this.segmentsFor();
    const done = segs.filter((s) => this.tm.has(s.key)).length;
    const chars = segs.reduce((n, s) => n + (this.tm.has(s.key) ? 0 : s.key.length), 0);
    return { total: segs.length, done, remainingChars: chars };
  }

  setTranslation(key, text, warn) {
    this.tm.set(key, text);
    this.data.tm[key] = text;
    if (warn) this.data.warnings[key] = warn; else delete this.data.warnings[key];
    this.bump();
    this.touch();
  }

  clearTranslations(keys) {
    for (const k of keys) { this.tm.delete(k); delete this.data.tm[k]; delete this.data.warnings[k]; }
    this.bump();
    this.touch();
  }

  setOverride(itemId, text) {
    if (text === undefined) delete this.data.overrides[itemId]; else this.data.overrides[itemId] = text;
    this.bump();
    this.touch();
  }

  conflicts(settings = this.settings) { return findConflicts(this.data.dict, settings); }

  touch() { this.data.updatedAt = Date.now(); this.dirty = true; }

  // ------------------------------------------------------------------ xuất
  buildCard(settings = this.settings) {
    const outputs = new Map();
    for (const it of this.items) outputs.set(it.id, this.output(it.id, settings));
    return buildTranslatedCard(this.card, outputs);
  }

  exportJson(settings) { return exportCardJson(this.buildCard(settings)); }

  exportPng(settings, fallbackImage) {
    const img = this.card.image || fallbackImage;
    if (!img) throw new Error('Card gốc không có ảnh PNG');
    const out = exportCardPng(img, this.buildCard(settings));
    // tự kiểm tra như SillyTavern (CRC, IHDR/IEND, chunk tEXt) trước khi cho tải về
    const v = verifyPng(out);
    if (!v.ok) throw new Error('File PNG tạo ra không hợp lệ (' + v.error + ')');
    return out;
  }

  /** Đổi ảnh card (bytes PNG) — null = bỏ ảnh, xuất PNG sẽ dùng ảnh tạm */
  setImage(bytes) {
    if (bytes && !isPng(bytes)) throw new Error('Ảnh phải là PNG');
    this.card.image = bytes || null;
    this.data.imageB64 = bytes ? bytesToB64(bytes) : null;
    this.touch();
  }

  toJSON() {
    return { ...this.data, tm: Object.fromEntries(this.tm) };
  }

  /** stat_data ban đầu (gốc / sau dịch) từ mục InitVar */
  initVarText(translated) {
    const it = this.items.find((x) => x.kind === 'initvar' && x.meta?.enabled !== undefined) || this.items.find((x) => x.kind === 'initvar');
    if (!it) return null;
    return translated ? this.output(it.id) : it.text;
  }
  allInitVarItems() { return this.items.filter((x) => x.kind === 'initvar'); }
  schemaItems() { return this.items.filter((x) => x.kind === 'schema'); }
}

export function projectSummary(p) {
  return { id: p.id, name: p.name, updatedAt: p.data.updatedAt };
}

export { deepClone, utf8ToBase64 };
