// Từ điển đồng bộ: quét biến MVU (InitVar, schema Zod, đường dẫn), giá trị enum, marker regex, thuật ngữ.
// Mỗi mục: { src, kind: key|value|marker|term, dst, keep, manual, count, parents:Set, samples:[] }
import { load as yamlLoad } from '../../vendor/js-yaml.mjs';
import { lexJs, significant } from './lexer.js';
import { hasCJK, HAN_CLASS } from './util.js';
import { isInitVarEntry } from './card.js';

const KIND_RANK = { key: 4, value: 3, marker: 2, term: 1 };
const OBJECT_PREV = new Set(['(', ',', '=', ':', '[', '?', 'return', '=>(', '||', '&&', '??', '...', 'const', 'let', 'var']);

export const NAMING_STYLES = {
  natural: 'Tự nhiên, có dấu cách (vd: Độ hảo cảm)',
  underscore: 'Có dấu, nối bằng _ (vd: Độ_hảo_cảm)',
  snake: 'Không dấu snake_case (vd: do_hao_cam)',
  camel: 'Không dấu camelCase (vd: doHaoCam)',
};

export function isShortValue(s) {
  return typeof s === 'string' && hasCJK(s) && s.length <= 24 && !/[\n，。！？；…]|[.!?;]\s/.test(s);
}

/** Tạo bộ quét */
class Scanner {
  constructor() { this.map = new Map(); this.initVars = []; this.schemas = []; this.warnings = []; }
  add(src, kind, parent, sample) {
    if (typeof src !== 'string') return;
    src = src.trim();
    if (!src || !hasCJK(src) || src.length > 60) return;
    let e = this.map.get(src);
    if (!e) { e = { src, kind, count: 0, parents: new Set(), samples: [] }; this.map.set(src, e); }
    if (KIND_RANK[kind] > KIND_RANK[e.kind]) e.kind = kind;
    e.count++;
    if (parent != null) e.parents.add(parent);
    if (sample && e.samples.length < 3 && !e.samples.includes(sample)) e.samples.push(sample);
  }

  walkData(v, path) {
    if (Array.isArray(v)) {
      // MVU cũ: [giá trị, "mô tả"]
      if (v.length === 2 && typeof v[1] === 'string' && !isShortValue(v[1]) && typeof v[0] !== 'object') {
        if (isShortValue(v[0])) this.add(v[0], 'value', path.join('.'), path.join('.'));
        return;
      }
      v.forEach((x) => this.walkData(x, path));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (hasCJK(k)) this.add(k, 'key', path.join('.'), [...path, k].join('.'));
        this.walkData(x, [...path, k]);
      }
      return;
    }
    if (isShortValue(v)) this.add(v, 'value', path.join('.'), path.join('.'));
  }

  scanSchema(code, label) {
    const sig = significant(lexJs(code));
    const stack = [];
    const parents = [];
    for (let i = 0; i < sig.length; i++) {
      const t = sig[i], prev = sig[i - 1], next = sig[i + 1];
      if (t.type === 'punct') {
        if (t.value === '{') {
          const pv = prev ? (prev.type === 'punct' || prev.type === 'ident' ? prev.value : '') : '';
          const isObj = !!prev && OBJECT_PREV.has(pv) && pv !== '=>';
          stack.push(isObj);
          // khóa cha gần nhất: ident/str ngay trước "z.object({" hoặc ": {"
          let parentKey = null;
          for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
            const s = sig[j];
            if ((s.type === 'ident' || s.type === 'str') && sig[j + 1]?.value === ':') { parentKey = s.type === 'str' ? code.slice(s.cStart, s.cEnd) : s.value; break; }
          }
          parents.push(parentKey);
        } else if (t.value === '}') { stack.pop(); parents.pop(); }
        continue;
      }
      const inObj = stack.length && stack[stack.length - 1];
      const parentPath = parents.filter(Boolean).join('.');
      if (t.type === 'ident' && hasCJK(t.value)) {
        if (inObj && prev?.type === 'punct' && (prev.value === '{' || prev.value === ',') && next?.type === 'punct' && [':', ',', '}', '=', '('].includes(next.value)) this.add(t.value, 'key', parentPath, label);
        else if (prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) this.add(t.value, 'key', null, label);
        continue;
      }
      if (t.type === 'str') {
        const s = code.slice(t.cStart, t.cEnd);
        if (!hasCJK(s) || s.includes('\\')) continue;
        const isDescribe = prev?.value === '(' && /^(describe|meta|message|error|description)$/.test(sig[i - 2]?.value || '');
        if (isDescribe) continue;
        if (inObj && prev?.type === 'punct' && (prev.value === '{' || prev.value === ',') && next?.value === ':') { this.add(s, 'key', parentPath, label); continue; }
        if (prev?.value === '[' && next?.value === ']' && (sig[i - 2]?.type === 'ident' || [')', ']'].includes(sig[i - 2]?.value))) { this.add(s, 'key', null, label); continue; }
        if (isShortValue(s)) this.add(s, 'value', parentPath, label);
      }
    }
  }

  scanPaths(text, label) {
    if (!text || !hasCJK(text)) return;
    let m;
    const addPath = (p) => {
      const segs = p.replace(/\[\s*['"]([^'"\]]+)['"]\s*\]/g, '.$1').replace(/\[\d+\]/g, '').split(/[./]/).filter(Boolean);
      let parent = '';
      for (const s of segs) {
        if (/^(stat_data|display_data|delta_data)$/.test(s) || /^\$\{.*\}$/.test(s) || /^<.*>$/.test(s) || /^\d+$/.test(s) || s === '-' || s === '*') { parent = parent ? parent + '.' + s : ''; continue; }
        if (hasCJK(s) && s.length <= 40 && !/[\s，。：:（）()!！?？、]/.test(s)) this.add(s, 'key', parent || null, label);
        parent = parent ? parent + '.' + s : s;
      }
    };
    const re1 = /(?:stat_data|display_data|delta_data)((?:\.[^\s.,;:'"`()\[\]{}<>，。；：！？、+]+|\[\s*['"][^'"\]]+['"]\s*\])+)/g;
    while ((m = re1.exec(text))) addPath(m[1]);
    const re2 = /\b(?:getvar|setvar|addvar|incvar|decvar|getMvuVariable|setMvuVariable|_\.(?:set|get|has|unset|update)|_\.(?:insert|remove|add|assign|delete|move))\s*\(\s*(?:[\w.$]+\s*,\s*)?(['"`])([^'"`\n]+)\1/g;
    while ((m = re2.exec(text))) addPath(m[2].replace(/^stat_data\./, ''));
    const re3 = /\{\{\s*(?:getvar|setvar|addvar|incvar|decvar|get_message_variable|get_chat_variable|format_message_variable|format_chat_variable)\s*::\s*([^:}]+)/gi;
    while ((m = re3.exec(text))) addPath(m[1].trim().replace(/^stat_data\./, ''));
    const re4 = /["']?(?:path|from)["']?\s*:\s*["'](\/[^"'\n]+)["']/g;
    while ((m = re4.exec(text))) addPath(m[1]);
  }

  scanComparisons(text, label) {
    if (!text || !hasCJK(text)) return;
    let m;
    const re1 = /(?:===|!==|==|!=|\bcase)\s*(['"])([^'"\n\\]{1,24})\1/g;
    while ((m = re1.exec(text))) if (isShortValue(m[2])) this.add(m[2], 'value', null, label);
    const re2 = /(['"])([^'"\n\\]{1,24})\1\s*(?:===|!==|==|!=)/g;
    while ((m = re2.exec(text))) if (isShortValue(m[2])) this.add(m[2], 'value', null, label);
  }

  scanMarkers(findRegex, label) {
    if (!findRegex || !hasCJK(findRegex)) return;
    const runRe = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]');
    let inClass = false;
    for (let i = 0; i < findRegex.length;) {
      const c = findRegex[i];
      if (c === '\\') { i += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; i++; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (runRe.test(c)) {
        let j = i;
        while (j < findRegex.length && runRe.test(findRegex[j])) j++;
        const w = findRegex.slice(i, j);
        if (!this.map.has(w) || this.map.get(w).kind === 'term') {
          this.add(w, 'marker', null, label);
          const e = this.map.get(w);
          if (e && KIND_RANK[e.kind] > KIND_RANK.marker) { /* đã là biến -> giữ loại biến */ }
        } else this.add(w, 'marker', null, label);
        i = j; continue;
      }
      i++;
    }
  }
}

/**
 * Quét card -> danh sách mục từ điển + dữ liệu InitVar đã phân tích
 * items: kết quả listItems(card)
 */
export function scanCard(card, items) {
  const sc = new Scanner();
  // 1) InitVar
  const book = card.raw.data.character_book;
  (book?.entries || []).forEach((e, idx) => {
    if (!isInitVarEntry(e)) return;
    let data = null, error = null;
    try { data = yamlLoad(String(e.content || '')); } catch (err) { error = String(err.message || err).split('\n')[0]; }
    sc.initVars.push({ entryIndex: idx, title: e.comment || '[InitVar]', data, error });
    if (data && typeof data === 'object') sc.walkData(data, []);
  });
  // 2) schema Zod
  for (const it of items) {
    if (it.kind === 'schema') { sc.schemas.push({ itemId: it.id, title: it.meta?.title }); sc.scanSchema(it.text, it.meta?.title || 'schema'); }
  }
  // 3) đường dẫn + so sánh trong mọi văn bản
  for (const it of items) {
    if (typeof it.text !== 'string') continue;
    sc.scanPaths(it.text, it.label);
    if (it.kind !== 'initvar') sc.scanComparisons(it.text, it.label);
  }
  // 4) marker trong find regex
  for (const it of items) if (it.kind === 'regexFind') sc.scanMarkers(it.text, it.meta?.title);
  // 5) thuật ngữ: từ khóa lorebook ngắn
  (book?.entries || []).forEach((e) => {
    for (const k of [...(e.keys || []), ...(e.secondary_keys || [])]) {
      const s = String(k || '').trim();
      if (hasCJK(s) && s.length <= 16 && !/^\/.*\/[a-z]*$/i.test(s) && !/initvar/i.test(s)) sc.add(s, 'term', null, e.comment || '');
    }
  });
  const entries = [...sc.map.values()].map((e) => ({ ...e, parents: [...e.parents] }));
  entries.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || b.count - a.count || a.src.localeCompare(b.src));
  return { entries, initVars: sc.initVars, schemas: sc.schemas };
}

// ====================================================================== tên theo kiểu đặt
export function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

export function sanitizeName(dst, kind) {
  let s = String(dst ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  // bỏ thẻ/nháy bao ngoài mà model có thể lỡ trả về
  s = s.replace(/^<[^>]*>|<\/[^>]*>$/g, '').replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '').trim();
  if (kind === 'key') s = s.replace(/[.\/\[\]'"`\\:#{}<>]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  else s = s.replace(/[<>]/g, '').trim();
  return s;
}

export function applyStyle(dst, style, kind, src = '') {
  let s = sanitizeName(dst, kind);
  if (kind !== 'key' || !s) return s;
  switch (style) {
    case 'underscore': s = s.replace(/\s+/g, '_'); break;
    case 'snake': s = stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); break;
    case 'camel': {
      const w = stripAccents(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/);
      s = w.map((x, i) => (i === 0 ? x.toLowerCase() : x[0].toUpperCase() + x.slice(1).toLowerCase())).join('');
      break;
    }
    default: break;
  }
  if (src.startsWith('_') && !s.startsWith('_')) s = '_' + s;
  if (/^\d/.test(s) && style !== 'natural') s = '_' + s;
  return s;
}

// ====================================================================== mô hình từ điển trong dự án
/**
 * state.dict: { [src]: { kind, dst, keep, manual, count, parents, samples, auto } }
 * merge kết quả quét với trạng thái cũ (giữ chỉnh sửa người dùng)
 */
export function mergeScan(oldDict, scanEntries) {
  const out = {};
  for (const e of scanEntries) {
    const old = oldDict?.[e.src];
    out[e.src] = {
      kind: e.kind,
      dst: old?.dst ?? '',
      keep: old?.keep ?? false,
      manual: old?.manual ?? false,
      count: e.count,
      parents: e.parents,
      samples: e.samples,
    };
  }
  // giữ mục người dùng tự thêm
  for (const [src, v] of Object.entries(oldDict || {})) {
    if (!out[src] && v.userAdded) out[src] = v;
  }
  return out;
}

/** Tạo index cho analyze + render */
export function makeDictIndex(dict, settings = {}) {
  const varMode = settings.varMode || 'translate';
  const style = settings.namingStyle || 'natural';
  const markerMode = settings.markerMode || 'translate';
  const markers = [];
  for (const [src, v] of Object.entries(dict || {})) if (v.kind === 'marker') markers.push(src);
  return {
    kindOf(src) { const v = dict?.[src]; return v ? v.kind : null; },
    markers,
    lookup(src) {
      const v = dict?.[src];
      if (!v) return undefined;
      if (v.keep) return src;
      if ((v.kind === 'key' || v.kind === 'value') && varMode === 'keep') return src;
      if (v.kind === 'marker' && markerMode === 'keep') return src;
      if (!v.dst) return src;
      return v.kind === 'key' ? applyStyle(v.dst, style, 'key', src) : sanitizeName(v.dst, v.kind);
    },
  };
}

/** Phát hiện xung đột: 2 khóa khác nhau -> cùng tên mới trong cùng object cha */
export function findConflicts(dict, settings = {}) {
  const idx = makeDictIndex(dict, settings);
  const byParent = new Map();
  for (const [src, v] of Object.entries(dict || {})) {
    if (v.kind !== 'key') continue;
    const dst = idx.lookup(src);
    for (const p of (v.parents?.length ? v.parents : [''])) {
      const k = p + '\u0000' + dst;
      if (!byParent.has(k)) byParent.set(k, new Set());
      byParent.get(k).add(src);
    }
  }
  const out = [];
  for (const [k, set] of byParent) {
    if (set.size > 1) {
      const [parent, dst] = k.split('\u0000');
      out.push({ parent, dst, srcs: [...set] });
    }
  }
  return out;
}

/** Thuật ngữ liên quan tới đoạn văn (để đưa vào prompt) */
export function glossaryFor(texts, dict, settings, extraGlossary = []) {
  const idx = makeDictIndex(dict, settings);
  const joined = texts.join('\n');
  const out = [];
  const seen = new Set();
  for (const [src, v] of Object.entries(dict || {})) {
    if (!joined.includes(src)) continue;
    const dst = idx.lookup(src);
    if (!dst) continue;
    seen.add(src);
    out.push({ src, dst, kind: v.kind });
  }
  for (const g of extraGlossary) {
    if (!g.src || seen.has(g.src) || !joined.includes(g.src)) continue;
    out.push({ src: g.src, dst: g.dst, kind: 'term' });
  }
  out.sort((a, b) => b.src.length - a.src.length);
  return out;
}
