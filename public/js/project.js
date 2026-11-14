// Dự án dịch: gắn card + từ điển + bộ nhớ dịch (TM) + chỉnh tay; phân tích, render, xuất card.
import { makeCard, listItems, buildTranslatedCard, exportCardJson, exportCardPng } from './core/card.js';
import { scanCard, mergeScan, makeDictIndex, findConflicts } from './core/dict.js';
import { analyzeItem } from './core/analyze.js';
import { validateSegment, allowedHanSet } from './core/translate.js';
import { uuid, hasCJK, deepClone } from './core/util.js';
import { utf8ToBase64 } from './core/png.js';

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
  comments: false,
  userName: 'User',
  translateCardName: true,
  translateTags: true,
  translateComments: true,
  translateScriptNames: true,
  translateRegexNames: true,
  translateScriptInfo: true,
  autoSuggestDict: true,
  prompts: {},
};

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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return new Project(data);
  }

  get id() { return this.data.id; }
  get name() { return this.data.name; }
  get cardName() { return this.card.raw.data?.name || ''; }

  // ------------------------------------------------------------------ quét & phân tích
  rescan(settings) {
    this.scan = scanCard(this.card, this.items);
    this.data.dict = mergeScan(this.data.dict, this.scan.entries);
    this.analyze(settings);
    this.recheckWarnings(settings);
    return this.scan;
  }

  /** Kiểm tra lại toàn bộ bản dịch đã có (vd bản dịch cũ còn sót chữ Hán) -> cập nhật cảnh báo */
  recheckWarnings(settings = this.settings) {
    const allowed = allowedHanSet(this.data.dict, settings, this.data.glossary);
    let n = 0;
    for (const [key, text] of this.tm) {
      const e = this.segByKey?.get(key);
      if (!e) continue;
      const v = validateSegment(e.seg, text, allowed);
      const w = v.ok ? v.warn : v.reason;
      if (w) { if (this.data.warnings[key] !== w) n++; this.data.warnings[key] = w; }
      else delete this.data.warnings[key];
    }
    if (n) { this.bump(); this.touch(); }
    return n;
  }

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
    const ctx = {
      dict: idx,
      entryNames: settings.translateComments ? entryNames : new Set(),
      bookNames,
      opts: { codeStrings: settings.codeStrings, ejsStrings: settings.ejsStrings, comments: settings.comments, chunkSize: settings.chunkSize },
    };
    this.analyses = new Map();
    this.segByKey = new Map();
    for (const it of this.items) {
      const a = analyzeItem(it, ctx);
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
    if (it.kind === 'comment') return !!settings.translateComments;
    if (it.kind === 'list') return !!settings.translateTags;
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
    return exportCardPng(img, this.buildCard(settings));
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
