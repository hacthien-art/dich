// Dự án dịch: gắn card + từ điển + bộ nhớ dịch (TM) + chỉnh tay; phân tích, render, xuất card.
import { makeCard, listItems, buildTranslatedCard, exportCardJson, exportCardPng } from './core/card.js';
import { scanCard, mergeScan, makeDictIndex, findConflicts, cleanDictTags } from './core/dict.js';
import { analyzeItem, findDynamicEntryRefs } from './core/analyze.js';
import { validateSegment, allowedHanSet, stripGlossaryTags } from './core/translate.js';
import { collectGuardChars, runChecks } from './core/check.js';
import { legacyVariants, ParaMemory, subSegment } from './core/reuse.js';
import { uuid, hasCJK, deepClone, hash32 } from './core/util.js';
import { utf8ToBase64, verifyPng, isPng } from './core/png.js';
import { unpackText, encodePart, resolveTokens, listTokens, hasToken, unescapeCjk, unescapeCjkInScripts, describeEncoding, stableId } from './core/embed.js';
import { openResource, packResource, exportName } from './core/resource.js';
import { scanLinks, tokenizeUrls, toDataUrl } from './core/links.js';

/** Phiên bản cách đặt khóa đoạn dịch của bộ phân tích. Tăng lên khi khóa thay đổi -> dự án cũ được chuyển bản dịch 1 lần. */
export const ANALYZER_VERSION = 2;

/** Lớp (tài nguyên / nội dung nhúng) từ cỡ này trở lên: nhớ kết quả phân tích, giao diện chỉ hiện trích đoạn */
export const BIG_ITEM = 200000;

/**
 * Bóc nội dung NHÚNG (base64, base64 + gzip, data: URI, payload cắt khúc) trong các mục văn bản của card, và đổi chữ Hán
 * viết dạng \uXXXX trong mã về ký tự thật. Trả về Map(itemId -> { src, text, parts }) — text là văn bản đã thay payload
 * bằng token ⟪emb:id⟫; mỗi payload (và payload lồng bên trong) thành một "lớp" được dịch như một mục riêng.
 */
export async function unpackCardItems(card) {
  const out = new Map();
  const seen = new Map();
  for (const it of listItems(card)) {
    if (typeof it.text !== 'string' || it.text.length < 48) continue;
    if (it.kind === 'regexFind' || it.kind === 'name' || it.kind === 'comment' || it.kind === 'button' || it.kind === 'json') continue;
    let u;
    try { u = await unpackText(it.text, { seen }); } catch { continue; }
    const text = it.kind === 'code' || it.kind === 'schema' ? unescapeCjk(u.text) : it.kind === 'auto' ? unescapeCjkInScripts(u.text) : u.text;
    if (u.parts.length || text !== it.text) out.set(it.id, { src: it.text, text, parts: u.parts });
  }
  return out;
}

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
  // lớp tài nguyên / nội dung nhúng: so bằng mã băm nội dung (văn bản có thể tới hàng chục MB)
  if (it.sig) return [it.kind, 'layer', it.sig].join('\u0000');
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
    this.data.resources ||= [];   // tệp tài nguyên đi kèm / link ngoài đã tải: [{ id, name, size, origin, url, mode, remapUrl, mime }]
    this.data.keepFields ||= {};  // itemId của lớp -> [tên trường dữ liệu không dịch]
    this.card = makeCard(data.card, { fileName: data.fileName, format: data.format, image: data.imageB64 ? b64ToBytes(data.imageB64) : null });
    this.tm = new Map(Object.entries(this.data.tm));
    this.baseItems = listItems(this.card); // các mục của chính card (không gồm lớp nhúng / tài nguyên)
    this.cardEmbeds = new Map();           // itemId -> { src, text, parts } (xem unpackCardItems)
    this.resources = [];                   // [{ meta, open, error }] — open = kết quả openResource()
    this.layers = new Map();               // id payload -> { part, item, resId }
    this.urlRes = new Map();               // id của URL -> tài nguyên tải từ link đó
    this.packed = new Map();               // 'emb:id' | 'url:id' -> { sig, value } (payload đã mã hóa lại sau dịch)
    this.anCache = new Map();
    this.version = 0;
    this.analyses = new Map();
    this.scan = null;
    this.rebuildItems();
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

  // ------------------------------------------------------------------ nội dung nhúng · tài nguyên đi kèm · link ngoài
  /**
   * Bước bất đồng bộ trước khi phân tích: bóc nội dung nhúng (base64 / gzip…) trong card và mở các tệp tài nguyên
   * (tệp đi kèm, tệp tải từ link ngoài). loader(meta) -> Uint8Array | null: đọc dữ liệu tệp đã lưu.
   */
  async prepare(loader) {
    this.cardEmbeds = await unpackCardItems(this.card);
    this.resources = [];
    for (const meta of this.data.resources) this.resources.push(await this.openRes(meta, loader ? await loader(meta).catch(() => null) : null));
    this.rebuildItems();
  }

  async openRes(meta, bytes) {
    const r = { meta, open: null, error: null };
    try {
      if (!bytes) throw new Error('không tìm thấy dữ liệu của tệp (data/resources) — hãy thêm lại tệp');
      r.open = await openResource(meta.name, bytes, { baseUrl: meta.origin === 'url' ? meta.url : null, mime: meta.mime });
    } catch (e) { r.error = String(e.message || e); }
    return r;
  }

  /**
   * Thêm (hoặc thay — cùng id / cùng URL) một tệp tài nguyên. meta: { id?, name, origin: 'file'|'url', url?, mime? }.
   * Trả về bản ghi tài nguyên { meta, open, error }; gọi rescan() sau đó. Tệp không đọc được -> ném lỗi, không thêm.
   */
  async addResource(meta, bytes) {
    const m = { id: meta.id || uuid().slice(0, 13), name: meta.name || 'resource', size: bytes.length, origin: meta.origin || 'file', addedAt: Date.now() };
    if (m.origin === 'url') { m.url = meta.url; m.mode = meta.mode || 'inline'; if (meta.remapUrl) m.remapUrl = meta.remapUrl; if (meta.mime) m.mime = meta.mime; }
    const r = await this.openRes(m, bytes);
    if (r.error) throw new Error(r.error);
    const dup = this.data.resources.findIndex((x) => x.id === m.id || (m.origin === 'url' && x.origin === 'url' && x.url === m.url));
    if (dup >= 0) {
      m.id = this.data.resources[dup].id;
      if (m.origin === 'url') { m.mode = this.data.resources[dup].mode || m.mode; if (this.data.resources[dup].remapUrl) m.remapUrl = this.data.resources[dup].remapUrl; }
      this.data.resources[dup] = m;
      this.resources[dup] = r;
    } else { this.data.resources.push(m); this.resources.push(r); }
    this.packed.clear();
    this.rebuildItems();
    this.touch();
    return r;
  }

  removeResource(id) {
    const i = this.data.resources.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.data.resources.splice(i, 1);
    this.resources.splice(i, 1);
    this.packed.clear();
    this.rebuildItems();
    this.touch();
    return true;
  }

  keepSet(itemId) {
    const list = this.data.keepFields[itemId];
    return list && list.length ? new Set(list) : null;
  }

  /** Bật/tắt "không dịch" cho một trường dữ liệu (tên khóa JSON) của một lớp; cần gọi analyze() sau đó */
  setKeepField(itemId, field, keep) {
    const cur = new Set(this.data.keepFields[itemId] || []);
    if (keep) cur.add(field); else cur.delete(field);
    if (cur.size) this.data.keepFields[itemId] = [...cur]; else delete this.data.keepFields[itemId];
    const it = this.itemById.get(itemId);
    if (it?.meta) it.meta.keepFields = this.keepSet(itemId);
    this.touch();
  }

  /** Dựng lại danh sách mục: mục của card (đã thay payload / link bằng token) + các lớp nhúng + các tệp tài nguyên */
  rebuildItems() {
    const urlRes = this.resources.filter((r) => r.open && r.meta.origin === 'url' && r.meta.url);
    const urls = urlRes.map((r) => r.meta.url);
    this.urlRes = new Map(urlRes.map((r) => [stableId(r.meta.url), r]));
    const items = [];
    this.layers = new Map();
    const withUrls = (text) => (urls.length ? tokenizeUrls(text, urls) : text);
    const addLayers = (parts, parent, group, resId) => {
      for (const p of parts || []) {
        if (this.layers.has(p.id)) continue; // payload giống hệt nhau dùng chung một lớp
        const id = 'emb.' + p.id;
        const title = p.hint || describeEncoding(p);
        const item = {
          id, path: ['emb', p.id], group, kind: p.kind, sig: 'L' + p.id,
          label: `${parent.meta?.title || parent.label} › ${title}`,
          text: withUrls(p.text),
          meta: { layer: true, title: `${parent.meta?.title || parent.label} › ${title}`, parent: parent.id, resource: resId, enc: describeEncoding(p), size: p.rawLen, keepFields: this.keepSet(id) },
        };
        this.layers.set(p.id, { part: p, item, resId });
        items.push(item);
        addLayers(p.parts, item, group, resId);
      }
    };
    const embedded = [];
    for (const it of this.baseItems) {
      let item = it;
      const e = this.cardEmbeds.get(it.id);
      if (e && e.src === it.text) item = { ...it, text: e.text, rawText: it.text, embeds: e.parts };
      if (urls.length && typeof item.text === 'string') {
        const t = withUrls(item.text);
        if (t !== item.text) item = { ...item, text: t, rawText: it.text };
      }
      items.push(item);
      if (item.embeds?.length) embedded.push(item);
    }
    for (const it of embedded) addLayers(it.embeds, it, 'embedded', null);
    for (const r of this.resources) {
      if (!r.open) continue;
      const id = 'res.' + r.meta.id;
      const title = (r.meta.origin === 'url' ? '🔗 ' : '📦 ') + r.meta.name;
      const root = {
        id, path: ['res', r.meta.id], group: 'resources', kind: r.open.kind, sig: 'R' + r.meta.id + ':' + r.meta.size + ':' + r.open.rawLen,
        label: title, text: withUrls(r.open.text),
        meta: { layer: true, root: true, title, resource: r.meta.id, enc: r.open.container === 'gzip' ? 'gzip' : 'văn bản', size: r.open.rawLen, keepFields: this.keepSet(id) },
      };
      items.push(root);
      addLayers(r.open.parts, root, 'resources', r.meta.id);
    }
    this.items = items;
    this.itemById = new Map(items.map((it) => [it.id, it]));
    this._links = null;
  }

  /** Link ngoài tìm thấy trong card và trong các tài nguyên (xem core/links.js), kèm tài nguyên đã tải nếu có */
  links() {
    // văn bản các mục chỉ đổi khi dựng lại danh sách mục -> quét URL một lần rồi nhớ
    this._links ||= scanLinks(this.items);
    return this._links.map((l) => ({ ...l, resource: this.urlRes.get(l.id) || null }));
  }

  /** Các mục thuộc một tệp tài nguyên (mục gốc + mọi lớp nhúng bên trong) */
  resourceItems(resId) { return this.items.filter((it) => it.meta?.resource === resId); }

  // ------------------------------------------------------------------ ghép lại payload / link sau dịch
  /** Giá trị thay cho một token khi ghép kết quả: payload đã mã hóa lại (nếu đã pack()), không thì payload / URL gốc */
  tokenValue(type, id) {
    if (type === 'emb') {
      const L = this.layers.get(id);
      if (!L) return null;
      const c = this.packed.get('emb:' + id);
      return c ? { value: c.value, changed: true } : { value: L.part.orig, changed: false };
    }
    const r = this.urlRes.get(id);
    if (!r) return null;
    const mode = r.meta.mode || 'inline';
    if (mode === 'remap' && r.meta.remapUrl) return { value: r.meta.remapUrl, changed: r.meta.remapUrl !== r.meta.url };
    const c = mode === 'inline' ? this.packed.get('url:' + id) : null;
    return c ? { value: c.value, changed: true } : { value: r.meta.url, changed: false };
  }

  /** Thay token trong văn bản bằng giá trị hiện có. Trả về { text, changed } */
  finalText(text) {
    let changed = false;
    if (!hasToken(text)) return { text, changed };
    const out = resolveTokens(text, (type, id) => { const v = this.tokenValue(type, id); if (!v) return null; if (v.changed) changed = true; return v.value; });
    return { text: out, changed };
  }

  /** Bộ đóng gói dùng chung trong một lượt: mỗi lớp chỉ mã hóa lại một lần, từ lớp trong cùng ra ngoài */
  packer(settings = this.settings) {
    const memo = new Map();
    const inner = async (itemId, path) => {
      const it = this.itemById.get(itemId);
      if (!it) return { text: '', changed: false };
      const out = String(this.output(itemId, settings) ?? '');
      let changed = out !== it.text;
      const vals = new Map();
      for (const [type, id] of listTokens(out)) {
        const key = type + ':' + id;
        if (vals.has(key)) continue;
        const r = await one(type, id, path);
        if (!r) continue;
        vals.set(key, r.value);
        if (r.changed) changed = true;
      }
      return { text: vals.size ? resolveTokens(out, (type, id) => vals.get(type + ':' + id)) : out, changed };
    };
    const compute = async (type, id, path) => {
      const key = type + ':' + id;
      if (type === 'emb') {
        const L = this.layers.get(id);
        if (!L) return null;
        const r = await inner(L.item.id, path);
        if (!r.changed) { this.packed.delete(key); return { value: L.part.orig, changed: false }; }
        const sig = hash32(r.text) + ':' + r.text.length;
        const c = this.packed.get(key);
        if (c && c.sig === sig) return { value: c.value, changed: true };
        const value = await encodePart(L.part, r.text);
        this.packed.set(key, { sig, value });
        return { value, changed: true };
      }
      const res = this.urlRes.get(id);
      if (!res) return null;
      const mode = res.meta.mode || 'inline';
      if (mode === 'remap' && res.meta.remapUrl) return { value: res.meta.remapUrl, changed: res.meta.remapUrl !== res.meta.url };
      if (mode !== 'inline' || res.open.container !== 'plain') return { value: res.meta.url, changed: false };
      const r = await inner('res.' + res.meta.id, path);
      if (!r.changed) { this.packed.delete(key); return { value: res.meta.url, changed: false }; }
      const sig = hash32(r.text) + ':' + r.text.length;
      const c = this.packed.get(key);
      if (c && c.sig === sig) return { value: c.value, changed: true };
      const value = toDataUrl(res.open.kind, r.text);
      this.packed.set(key, { sig, value });
      return { value, changed: true };
    };
    // path: các token đang được tính ở phía trên (lớp tự tham chiếu chính nó -> dùng giá trị gốc, không lặp vô hạn)
    const one = (type, id, path = []) => {
      const key = type + ':' + id;
      if (path.includes(key)) return Promise.resolve(null);
      if (!memo.has(key)) memo.set(key, compute(type, id, [...path, key]));
      return memo.get(key);
    };
    return { one, inner };
  }

  /**
   * Mã hóa lại mọi lớp nhúng / link ngoài đã dịch mà card dùng tới, để buildCard() ghép được card hoàn chỉnh.
   * (Tệp tài nguyên đi kèm được đóng gói riêng khi xuất — exportResource().)
   */
  async pack(settings = this.settings) {
    const { one } = this.packer(settings);
    for (const it of this.baseItems) {
      const cur = this.itemById.get(it.id);
      if (!cur || cur.rawText === undefined) continue;
      const out = this.output(it.id, settings);
      if (typeof out !== 'string') continue;
      for (const [type, id] of listTokens(out)) await one(type, id);
    }
    this.packedVersion = this.version;
  }

  /** Card có lớp nhúng / link ngoài nào cần pack() trước khi ghép không */
  needsPack() { return this.items.some((it) => it.rawText !== undefined && hasToken(it.text)); }

  /** Xuất một tệp tài nguyên đã dịch, đúng dạng vỏ gốc. Trả về { name, bytes, changed } */
  async exportResource(resId, settings = this.settings) {
    const r = this.resources.find((x) => x.meta.id === resId);
    if (!r || !r.open) throw new Error('Tài nguyên chưa được mở' + (r?.error ? ': ' + r.error : ''));
    const { inner } = this.packer(settings);
    const f = await inner('res.' + resId, []);
    return { name: exportName(r.meta.name), bytes: await packResource(r.open, f.text), changed: f.changed };
  }

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
      card: this.card, items: this.items, baseItems: this.baseItems, cardEmbeds: this.cardEmbeds,
      raw: this.data.card, fileName: this.data.fileName, format: this.data.format, imageB64: this.data.imageB64,
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
    // card.embeds: kết quả unpackCardItems(card) do nơi gọi chuẩn bị trước (bất đồng bộ); không có thì coi như card
    // mới không có nội dung nhúng. Tệp tài nguyên / link đã tải được giữ nguyên.
    this.baseItems = listItems(card);
    this.cardEmbeds = card.embeds || new Map();
    this.packed.clear();
    this.rebuildItems();
    const newItems = this.items;
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
      this.baseItems = old.baseItems;
      this.cardEmbeds = old.cardEmbeds;
      this.packed.clear();
      this.rebuildItems();
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
    // lớp lớn (tài nguyên hàng chục MB): kết quả phân tích chỉ phụ thuộc văn bản, LOẠI của các mục từ điển, tên mục
    // lorebook và cài đặt phân tích -> nhớ lại, chỉ phân tích lại khi một trong số đó đổi
    let ctxSig = null;
    const sigOf = () => (ctxSig ??= hash32(Object.entries(this.data.dict).map(([k, v]) => k + '\u0001' + v.kind).join('\u0002')) + '|' + JSON.stringify(ctx.opts) + '|' + hash32([...ctx.entryNames].join('\u0002')) + '|' + [...bookNames].join('\u0002'));
    const live = new Set();
    const cached = (it) => {
      if (!it.meta?.layer || typeof it.text !== 'string' || it.text.length < BIG_ITEM) return analyzeItem(it, ctx);
      const sig = sigOf() + '|' + (it.meta.keepFields ? [...it.meta.keepFields].sort().join('\u0002') : '') + '|' + it.sig;
      live.add(it.id);
      const c = this.anCache.get(it.id);
      if (c && c.sig === sig) return c.a;
      const a = analyzeItem(it, ctx);
      this.anCache.set(it.id, { sig, a });
      return a;
    };
    for (const it of this.items) {
      const a = it.kind === 'comment' && this.pinnedEntries.has(it.text)
        ? { segments: [], warnings: [pinNote], render: () => it.text, pinned: true }
        : cached(it);
      if (dynNote && typeof it.text === 'string' && /getwi|getWorldInfo|activewi|activateWorldInfo/.test(it.text) && !a.warnings.includes(dynNote)) a.warnings.push(dynNote);
      this.analyses.set(it.id, a);
      for (const s of a.segments) {
        let e = this.segByKey.get(s.key);
        if (!e) { e = { seg: s, items: new Set() }; this.segByKey.set(s.key, e); }
        e.items.add(it.id);
      }
    }
    for (const id of [...this.anCache.keys()]) if (!live.has(id)) this.anCache.delete(id);
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
  /**
   * Ghép card đã dịch. Token của lớp nhúng / link ngoài được thay bằng payload đã mã hóa lại — cần `await pack()` trước
   * (xuất card luôn làm vậy); lớp chưa được pack() dùng payload GỐC nên card vẫn chạy được, chỉ là lớp đó chưa dịch.
   */
  buildCard(settings = this.settings) {
    const outputs = new Map();
    for (const it of this.baseItems) {
      const cur = this.itemById.get(it.id) || it;
      let v = this.output(it.id, settings);
      if (cur.rawText !== undefined && typeof v === 'string') {
        const f = this.finalText(v);
        // không có gì thay đổi -> trả lại đúng văn bản gốc (kể cả cách viết \uXXXX ban đầu)
        v = v === cur.text && !f.changed ? cur.rawText : f.text;
      }
      outputs.set(it.id, v);
    }
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
