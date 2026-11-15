// Kiểm tra tổng thể card SAU DỊCH: chữ Hán còn sót (toàn bộ card, không chỉ các đoạn đã gửi AI), từ điển,
// EJS / script còn biên dịch được, InitVar YAML, đồng bộ đường dẫn biến, regex còn khớp, tên mục lorebook,
// bảo toàn cấu trúc ($1, macro, thẻ HTML). Chạy được cả trên trình duyệt lẫn Node (kiểm thử).
import { lexHtml } from './lexer.js';
import { hasCJK, HAN_CLASS, truncate } from './util.js';
import { makeDictIndex, dictProblems, findConflicts, isKeptEntry } from './dict.js';
import { allowedHanSet, stripGlossaryTags } from './translate.js';
import { regexFromString } from './stregex.js';
import { looksLikeHtml } from './analyze.js';
import { load as yamlLoad } from '../../vendor/js-yaml.mjs';

const HAN_RUN = () => new RegExp('[' + HAN_CLASS + ']+', 'g');
const HAN_ONE = new RegExp('[' + HAN_CLASS + ']');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ====================================================================== ký hiệu regex cần giữ
// dấu câu toàn độ rộng đã được "nới" trong regex (xem REGEX_PUNCT ở analyze.js) -> không bắt bản dịch phải giữ
const TOLERANT_PUNCT = new Set('：，；。！？、（）“”‘’'.split(''));

/**
 * Các ký hiệu (không phải chữ/số/ASCII) xuất hiện nguyên văn trong find regex của card: 【 】 「 」 ◆ ★ …
 * Regex dựa vào đúng các ký tự này để nhận diện, nên bản dịch của mọi đoạn phải giữ đủ số lượng.
 */
export function collectGuardChars(regexSources, { tolerant = true } = {}) {
  const out = new Set();
  for (const raw of regexSources || []) {
    const s = String(raw || '');
    for (let i = 0; i < s.length;) {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (ch === '\\') { i += 2; continue; }
      i += ch.length;
      if (cp < 0x80 || (tolerant && TOLERANT_PUNCT.has(ch))) continue;
      if (/[\p{L}\p{N}\p{M}\s]/u.test(ch)) continue;
      out.add(ch);
      if (out.size >= 48) return [...out];
    }
  }
  return [...out];
}

// ====================================================================== cú pháp JS / EJS
/** Lỗi cú pháp của một đoạn mã JS (null = hợp lệ). Chỉ PHÂN TÍCH cú pháp, không chạy mã. */
export function jsSyntaxError(code, isModule = false) {
  try {
    let c = String(code);
    if (isModule || /^\s*(?:import|export)\b/m.test(c)) {
      c = c.replace(/^\s*import\s+[\s\S]*?\bfrom\s*(['"])[^'"\n]*\1\s*;?/gm, '')
        .replace(/^\s*import\s*(['"])[^'"\n]*\1\s*;?/gm, '')
        .replace(/^(\s*)export\s*\{[^}]*\}\s*(?:from\s*(['"])[^'"\n]*\2)?\s*;?/gm, '$1')
        .replace(/^(\s*)export\s+default\s+(?=(?:async\s+)?function|class)/gm, '$1')
        .replace(/^(\s*)export\s+default\s+/gm, '$1void ')
        .replace(/^(\s*)export\s+(?=const|let|var|function|class|async)/gm, '$1')
        .replace(/\bimport\.meta\b/g, '({})');
    }
    new AsyncFunction(c);
    return null;
  } catch (e) {
    return String(e && e.message || e);
  }
}

/** Biên dịch thử mẫu EJS giống thư viện ejs (ST-Prompt-Template): tách thẻ, dựng thân hàm, kiểm tra cú pháp */
export function ejsSyntaxError(tpl) {
  try {
    const parts = String(tpl).split(/(<%%|%%>|<%=|<%-|<%_|<%#|<%|-%>|_%>|%>)/);
    let mode = null, src = '';
    for (const p of parts) {
      if (p === '<%%' || p === '%%>') { if (!mode) src += '; __o+=' + JSON.stringify(p) + '\n'; else src += p; continue; }
      if (p === '<%=' || p === '<%-' || p === '<%_' || p === '<%#' || p === '<%') {
        if (mode) throw new Error('thẻ EJS "' + mode + '" chưa đóng thì gặp thẻ mở mới');
        mode = p; continue;
      }
      if (p === '%>' || p === '-%>' || p === '_%>') { mode = null; continue; }
      if (!mode) { src += '; __o+=' + JSON.stringify(p) + '\n'; continue; }
      if (mode === '<%#') continue;
      if (mode === '<%=' || mode === '<%-') src += '; __o+=(' + p.replace(/;(\s*$)/, '$1') + ')\n';
      else src += '; ' + p + '\n';
    }
    if (mode) throw new Error('thiếu thẻ đóng %> cho "' + mode + '"');
    new AsyncFunction('let __o="";' + src);
    return null;
  } catch (e) {
    return String(e && e.message || e);
  }
}

/** Các khối <script> JS trong một đoạn HTML */
export function scriptBlocks(html) {
  const out = [];
  if (typeof html !== 'string' || !/<script/i.test(html)) return out;
  for (const t of lexHtml(html)) {
    if (t.type !== 'raw' || t.tag !== 'script') continue;
    const typeAttr = (t.attrs || []).find((a) => a.name.toLowerCase() === 'type');
    const type = typeAttr && typeAttr.vStart >= 0 ? html.slice(typeAttr.vStart, typeAttr.vEnd).toLowerCase() : '';
    if (type && !/javascript|module/.test(type)) continue; // json, template, babel… không phải JS thuần
    out.push({ code: html.slice(t.start, t.end), isModule: /module/.test(type) });
  }
  return out;
}

// ====================================================================== đường dẫn biến
/** Trích các đường dẫn biến MVU được nhắc tới trong văn bản, theo thứ tự xuất hiện */
export function extractPathRefs(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  const push = (i, p) => { const s = String(p).trim(); if (s) out.push({ i, path: s }); };
  let m;
  if (text.includes('_data')) {
    const re = /(?:stat_data|display_data|delta_data)((?:\.[^\s.,;:'"`()\[\]{}<>，。；：！？、+]+|\[\s*['"][^'"\]]+['"]\s*\]|\[\d+\])+)/g;
    while ((m = re.exec(text))) push(m.index, m[1].replace(/^\./, ''));
  }
  if (text.includes('(')) {
    const re = /\b(?:getvar|setvar|addvar|incvar|decvar|getMvuVariable|setMvuVariable|_\.(?:set|get|has|unset|update|insert|remove|add|assign|delete|move))\s*\(\s*(?:[\w.$]+\s*,\s*)?(['"`])([^'"`\n]+)\1/g;
    while ((m = re.exec(text))) if (!/^(?:stat_data|display_data|delta_data)\b/.test(m[2])) push(m.index, m[2]);
  }
  if (text.includes('{{')) {
    const re = /\{\{\s*(?:getvar|setvar|addvar|incvar|decvar|get_message_variable|get_chat_variable|format_message_variable|format_chat_variable)\s*::\s*([^:}]+)/gi;
    while ((m = re.exec(text))) if (!/^\s*(?:stat_data|display_data|delta_data)\b/.test(m[1])) push(m.index, m[1]);
  }
  if (text.includes('path') || text.includes('from')) {
    const re = /["']?(?:path|from)["']?\s*:\s*["'](\/[^"'\n]+)["']/g;
    while ((m = re.exec(text))) push(m.index, m[1]);
  }
  out.sort((a, b) => a.i - b.i);
  return out.map((x) => x.path);
}

const WORDISH = /[\p{L}\p{N}_$\])}]/u;
/** Đoạn [i,j) của text là tên biến đang được dùng làm biến: .名 / ['名'] / 名.x / /名/ (JSON Patch) / khóa YAML "名:" */
function isVarRef(text, i, j) {
  const a = text[i - 1] || '', b = text[j] || '';
  const a2 = text[i - 2] || '', b2 = text[j + 1] || '';
  if (a === '.' && WORDISH.test(a2)) return true;                 // obj.名 / stat_data.名
  if (b === '.' && /[\p{L}\p{N}_$]/u.test(b2)) return true;      // 名.x
  if ((a === "'" || a === '"') && a2 === '[' && b === a && b2 === ']') return true; // obj['名']
  if (a === '/' && (b === '/' || b === '"' || b === "'")) return true; // "/名/x" JSON Patch
  if (b === ':' && /^[ \t]*(?:-[ \t]+)?$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i)) && (b2 === ' ' || b2 === '\n' || b2 === '\r' || b2 === '')) return true; // khóa YAML
  return false;
}

/** Chuẩn hóa truy cập obj['tên'] / obj["tên"] thành .tên (mã JS đổi a.名 thành a['tên có dấu cách']) */
function normPath(t) { return String(t).replace(/\[\s*(['"])([^'"\]\n]+)\1\s*\]/g, '.$2').replace(/^\./, ''); }
function countSub(text, sub) { if (!sub) return 0; let n = 0, i = -1; while ((i = text.indexOf(sub, i + 1)) >= 0) n++; return n; }

/** Dịch một đường dẫn theo từ điển (giống renderPath) để so với kết quả thực tế */
function expectedPath(path, idx) {
  const look = (k) => { const v = idx.lookup(k); return v == null || v === '' ? k : v; };
  return path.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, (m, q, k) => `[${q}${look(k)}${q}]`)
    .replace(/[^.\/\[\]'"]+/g, (seg) => {
      if (!hasCJK(seg)) return seg;
      const ph = /^\$\{([^{}]*)\}$/.exec(seg);
      if (ph) return '${' + ph[1].split('|').map((x) => { const t = x.trim(); return hasCJK(t) ? x.replace(t, look(t)) : x; }).join('|') + '}';
      return look(seg);
    });
}

// ====================================================================== cấu trúc
function countAll(text, re) { const m = text.match(re); return m ? m.length : 0; }
function multiset(list) { const m = new Map(); for (const x of list) m.set(x, (m.get(x) || 0) + 1); return m; }
function diffMultiset(a, b) {
  const out = [];
  for (const [k, n] of a) { const d = n - (b.get(k) || 0); if (d > 0) out.push(d > 1 ? `${k} ×${d}` : k); }
  return out;
}

/** Các thành phần cấu trúc phải được giữ nguyên qua bản dịch */
function structure(text, { html, replace }) {
  const s = { refs: [], macros: [], tags: [], ejs: 0, fences: 0 };
  if (replace) s.refs = text.match(/\$(?:\d+|<[^>]+>)|\{\{\s*match\s*\}\}/gi) || [];
  if (text.includes('{{')) s.macros = (text.match(/\{\{\s*[a-zA-Z_][\w]*/g) || []).map((x) => x.replace(/\{\{\s*/, '').toLowerCase());
  if (text.includes('<%')) s.ejs = countAll(text, /<%(?!%)/g);
  if (text.includes('```')) s.fences = countAll(text, /```/g);
  if (html) for (const t of lexHtml(text)) if (t.type === 'tag') s.tags.push((t.close ? '/' : '') + t.lower);
  return s;
}

// ====================================================================== chữ Hán còn sót
function fontContext(text, i) {
  const back = text.slice(Math.max(0, i - 220), i);
  return /font(?:-family|Family)?[\w-]*\s*[:=][^;{}\n]*$/i.test(back) || /--[\w-]*font[\w-]*\s*:[^;{}\n]*$/i.test(back);
}

/** Chuỗi trong nháy bao quanh vị trí [i,j) trên cùng một dòng (để gợi ý thêm vào từ điển) */
function enclosingLiteral(text, i, j) {
  let k = i - 1;
  const lo = Math.max(0, i - 80);
  while (k >= lo && text[k] !== '\n' && text[k] !== "'" && text[k] !== '"' && text[k] !== '`') k--;
  if (k < lo || text[k] === '\n' || k < 0) return null;
  const q = text[k];
  let r = j;
  const hi = Math.min(text.length, j + 80);
  while (r < hi && text[r] !== '\n' && text[r] !== q) r++;
  if (r >= hi || text[r] !== q) return null;
  const lit = text.slice(k + 1, r);
  return lit.length <= 60 && !/[<>{}]/.test(lit) ? { quote: q, text: lit } : null;
}

const CAT_LABEL = {
  ai: 'AI dịch sót trong đoạn đã dịch',
  todo: 'đoạn chưa dịch',
  dict: 'mục từ điển chưa có bản dịch',
  code: 'ngoài đoạn dịch (chuỗi/mã được giữ nguyên)',
  font: 'tên font chữ (cố ý giữ)',
  design: 'giữ theo cài đặt (từ khóa gốc, mục không dịch, tên mục ghép động)',
};
export { CAT_LABEL as HAN_CATEGORIES };

/**
 * Quét chữ Hán trong card XUẤT RA (mọi mục, kể cả phần không gửi AI).
 * Trả về { total, chars, byCat, items:[{itemId,label,group,count,chars,cats,samples}], literals:[{text,count,items}] }
 */
export function scanHan(p, settings = p.settings) {
  const allowed = [...allowedHanSet(p.data.dict, settings, p.data.glossary)].sort((a, b) => b.length - a.length);
  const idx = makeDictIndex(p.data.dict, settings);
  const untrans = new Set(dictProblems(p.data.dict, settings).untranslated);
  const res = { total: 0, chars: 0, byCat: {}, items: [], literals: [] };
  const lits = new Map();
  for (const it of p.items) {
    const o = p.output(it.id, settings);
    let text = Array.isArray(o) ? o.join('\n') : String(o ?? '');
    if (!HAN_ONE.test(text)) continue;
    for (const a of allowed) if (text.includes(a)) text = text.split(a).join(' '.repeat(a.length));
    if (!HAN_ONE.test(text)) continue;
    const an = p.analyses.get(it.id);
    // giữ tiếng Trung theo thiết kế: mục người dùng không cho dịch, tên mục bị mã ghép động, từ khóa gốc (chế độ giữ + thêm)
    const designed = !p.isIncluded(it, settings) || !!an?.pinned || (it.kind === 'keys' && (settings.keysMode || 'append') !== 'replace');
    let trBlob = null, todoBlob = null;
    const blobs = () => {
      if (trBlob != null) return;
      const tr = [], todo = [];
      for (const s of an?.segments || []) { const t = p.tm.get(s.key); if (t == null) todo.push(s.key); else tr.push(t); }
      trBlob = tr.join('\n'); todoBlob = todo.join('\n');
    };
    const src = typeof it.text === 'string' ? it.text : '';
    const row = { itemId: it.id, label: it.label, group: it.group, count: 0, chars: 0, cats: {}, samples: [] };
    const re = HAN_RUN();
    let m;
    while ((m = re.exec(text))) {
      const w = m[0], i = m.index;
      let cat;
      if (designed) cat = 'design';
      else if (fontContext(text, i)) cat = 'font';
      else {
        blobs();
        if (trBlob && trBlob.includes(w)) cat = 'ai';
        else if (untrans.has(w) || (idx.kindOf(w) && idx.lookup(w) === w && !isKeptEntry(p.data.dict[w], settings))) cat = 'dict';
        else if (todoBlob && todoBlob.includes(w)) cat = 'todo';
        else cat = 'code';
      }
      row.cats[cat] = (row.cats[cat] || 0) + 1;
      res.byCat[cat] = (res.byCat[cat] || 0) + 1;
      if (cat === 'font' || cat === 'design') continue;
      row.count++; row.chars += w.length;
      if (row.samples.length < 6) row.samples.push({ cat, text: text.slice(Math.max(0, i - 26), i + w.length + 18).replace(/\s+/g, ' ') });
      if (cat === 'code') {
        const lit = enclosingLiteral(text, i, i + w.length);
        const key = lit && src.includes(lit.quote + lit.text + lit.quote) ? lit.text : null;
        if (key) { let e = lits.get(key); if (!e) { e = { text: key, count: 0, items: new Set() }; lits.set(key, e); } e.count++; e.items.add(it.id); }
      }
    }
    if (row.count) { res.items.push(row); res.total += row.count; res.chars += row.chars; }
  }
  res.items.sort((a, b) => b.chars - a.chars);
  res.literals = [...lits.values()].map((e) => ({ text: e.text, count: e.count, items: [...e.items] })).sort((a, b) => b.count - a.count);
  return res;
}

// ====================================================================== chạy toàn bộ
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, error: 3 };

function shapeOf(v) {
  if (Array.isArray(v)) return v.map(shapeOf);
  if (v && typeof v === 'object') return Object.values(v).map(shapeOf);
  return typeof v;
}

/**
 * Chạy mọi phép kiểm tra đồng bộ. p: Project (đã analyze).
 * Trả về { sections:[{id,title,level,summary,findings:[{level,text,itemId,detail}],more}], totals:{error,warn,info}, han, dict }
 */
export function runChecks(p, settings = p.settings, { deadlineMs = 6000 } = {}) {
  const t0 = Date.now();
  const sections = [];
  const sec = (id, title) => {
    const s = { id, title, level: 'ok', summary: '', findings: [], more: 0 };
    sections.push(s);
    s.add = (level, text, itemId, detail) => {
      if (LEVEL_RANK[level] > LEVEL_RANK[s.level]) s.level = level;
      if (s.findings.length < 60) s.findings.push({ level, text, itemId, detail }); else s.more++;
    };
    return s;
  };
  const idx = makeDictIndex(p.data.dict, settings);
  const out = (it) => { const o = p.output(it.id, settings); return Array.isArray(o) ? o.join('\n') : String(o ?? ''); };
  const src = (it) => (Array.isArray(it.text) ? it.text.join('\n') : String(it.text ?? ''));
  const strItems = p.items.filter((it) => typeof it.text === 'string');

  // ------------------------------------------------------------ 1) từ điển
  {
    const s = sec('dict', 'Từ điển biến / thuật ngữ');
    const dp = dictProblems(p.data.dict, settings);
    const conflicts = findConflicts(p.data.dict, settings);
    if (dp.untranslated.length) s.add('warn', `${dp.untranslated.length} mục chưa có bản dịch (sẽ giữ nguyên tiếng Trung trong card): ${dp.untranslated.slice(0, 14).join(', ')}${dp.untranslated.length > 14 ? '…' : ''}`);
    if (dp.hanLeft.length) s.add('warn', `${dp.hanLeft.length} mục có bản dịch vẫn còn chữ Hán: ${dp.hanLeft.slice(0, 14).map((k) => `${k} → ${idx.lookup(k)}`).join(', ')}${dp.hanLeft.length > 14 ? '…' : ''}`);
    for (const c of conflicts.slice(0, 20)) s.add('error', `Trùng tên biến trong "${c.parent || '(gốc)'}": ${c.srcs.join(', ')} → "${c.dst}" (kể cả khi chỉ khác chữ hoa/thường)`);
    if (conflicts.length > 20) s.more += conflicts.length - 20;
    s.data = { untranslated: dp.untranslated, hanLeft: dp.hanLeft, conflicts };
    s.summary = s.level === 'ok' ? `${Object.keys(p.data.dict).length} mục, đã dịch đủ, không trùng tên` : `${dp.untranslated.length} chưa dịch · ${dp.hanLeft.length} còn chữ Hán · ${conflicts.length} trùng tên`;
  }

  // ------------------------------------------------------------ 2) đoạn dịch
  {
    const s = sec('segments', 'Đoạn dịch (gửi AI)');
    const segs = p.segmentsFor();
    const todo = segs.filter((x) => !p.tm.has(x.key));
    const warned = segs.filter((x) => p.tm.has(x.key) && p.data.warnings[x.key]);
    if (todo.length) s.add('warn', `${todo.length} đoạn chưa dịch (${todo.reduce((n, x) => n + x.key.length, 0)} ký tự) — bấm "Dịch toàn bộ" hoặc "Dịch chỗ thiếu/lỗi"`);
    const byReason = new Map();
    for (const x of warned) { const r = String(p.data.warnings[x.key]).replace(/[:(].*$/s, '').trim(); byReason.set(r, (byReason.get(r) || 0) + 1); }
    for (const [r, n] of byReason) s.add('warn', `${n} đoạn bị cảnh báo: ${r}`);
    s.data = { todo: todo.length, warned: warned.length };
    s.summary = `${segs.length - todo.length}/${segs.length} đoạn đã dịch` + (warned.length ? `, ${warned.length} đoạn có cảnh báo` : '');
  }

  // ------------------------------------------------------------ 3) chữ Hán còn sót trong card xuất ra
  let han = null;
  {
    const s = sec('han', 'Chữ Hán còn sót trong card xuất ra');
    han = scanHan(p, settings);
    const cats = han.byCat;
    for (const cat of ['ai', 'todo', 'dict', 'code']) if (cats[cat]) s.add(cat === 'code' ? 'info' : 'warn', `${cats[cat]} cụm — ${CAT_LABEL[cat]}`);
    for (const row of han.items.slice(0, 40)) {
      const worst = ['ai', 'todo', 'dict'].some((c) => row.cats[c]) ? 'warn' : 'info';
      s.add(worst, `${row.label}: ${row.count} cụm / ${row.chars} chữ`, row.itemId, row.samples.map((x) => `[${CAT_LABEL[x.cat].split(' (')[0]}] …${x.text}…`).join('\n'));
    }
    if (han.items.length > 40) s.more += han.items.length - 40;
    s.data = han;
    s.summary = han.total ? `${han.total} cụm (${han.chars} chữ) trong ${han.items.length} mục` + (cats.font || cats.design ? ` · bỏ qua ${(cats.font || 0) + (cats.design || 0)} cụm cố ý giữ` : '') : 'Không còn chữ Hán ngoài các từ cố ý giữ' + (cats.font || cats.design ? ` (${(cats.font || 0) + (cats.design || 0)} cụm: tên font / từ khóa gốc / mục không dịch)` : '');
  }

  // ------------------------------------------------------------ 4) rò rỉ placeholder / nhãn phân loại
  {
    const s = sec('leak', 'Ký hiệu nội bộ lọt vào card');
    for (const it of p.items) {
      const o = out(it);
      if (/⟦\s*\d+\s*⟧/.test(o) && !/⟦\s*\d+\s*⟧/.test(src(it))) s.add('error', `${it.label}: còn placeholder ⟦n⟧ trong kết quả`, it.id);
      if (stripGlossaryTags(o, src(it)) !== o) s.add('error', `${it.label}: còn nhãn phân loại kiểu [biến] / [giá trị] trong bản dịch`, it.id);
      if (/<\/?seg\b[^>]*>/.test(o) && !/<\/?seg\b/.test(src(it))) s.add('error', `${it.label}: còn thẻ <seg> của prompt dịch`, it.id);
    }
    s.summary = s.level === 'ok' ? 'Không có placeholder ⟦n⟧, nhãn [biến] hay thẻ <seg> nào lọt ra' : `${s.findings.length + s.more} mục có ký hiệu nội bộ`;
  }

  // ------------------------------------------------------------ 5) đồng bộ biến
  {
    const s = sec('sync', 'Đồng bộ biến (InitVar · schema · đường dẫn)');
    let checkedPaths = 0, badPaths = 0;
    for (const it of p.items) {
      if (it.kind === 'initvar') {
        let d0, d1, e0 = null, e1 = null;
        try { d0 = yamlLoad(src(it)); } catch (e) { e0 = String(e.message || e).split('\n')[0]; }
        try { d1 = yamlLoad(out(it)); } catch (e) { e1 = String(e.message || e).split('\n')[0]; }
        if (!e0 && e1) s.add('error', `${it.label}: InitVar sau dịch không còn là YAML hợp lệ — ${e1}`, it.id);
        else if (!e0 && !e1 && JSON.stringify(shapeOf(d0)) !== JSON.stringify(shapeOf(d1))) s.add('error', `${it.label}: cấu trúc InitVar sau dịch khác bản gốc (số khóa thay đổi — thường do 2 biến bị dịch trùng tên)`, it.id);
      }
      if (it.kind === 'json') { try { JSON.parse(src(it)); try { JSON.parse(out(it)); } catch (e) { s.add('error', `${it.label}: JSON sau dịch không hợp lệ — ${e.message}`, it.id); } } catch { /* gốc đã lỗi */ } }
      if (typeof it.text !== 'string' || it.kind === 'regexFind') continue;
      const refs = extractPathRefs(it.text).filter(hasCJK);
      if (!refs.length) continue;
      // mỗi đường dẫn gốc phải xuất hiện trong bản dịch dưới dạng đã ánh xạ theo từ điển (đủ số lần).
      // So theo số lần thay vì ghép cặp từng vị trí: tên dịch có dấu cách ("Độ hảo cảm") và truy cập obj['tên']
      // làm việc tách đường dẫn trong bản dịch không chắc chắn.
      const need = new Map();
      for (const r of refs) {
        const p0 = normPath(r);
        const want = expectedPath(p0, idx);
        if (want === p0) continue;
        const e = need.get(want) || { n: 0, src: p0 };
        e.n++; need.set(want, e);
      }
      if (!need.size) continue;
      const o = normPath(out(it));
      for (const [want, e] of need) {
        checkedPaths += e.n;
        const have = countSub(o, want);
        if (have < e.n) { badPaths++; s.add('error', `${it.label}: đường dẫn biến "${e.src}" phải thành "${want}" nhưng chỉ tìm thấy ${have}/${e.n} chỗ trong bản dịch`, it.id); }
      }
    }
    // tên gốc của biến ĐÃ dịch còn được DÙNG LÀM BIẾN ở đâu đó (truy cập .名 / ['名'] / đường dẫn 名.x / khóa YAML 名:)
    // — chỗ bộ phân tích chưa đồng bộ được. Chữ hiển thị tình cờ trùng tên biến (vd '／回合。') không tính.
    const srcNames = Object.entries(p.data.dict).filter(([k, v]) => v.kind === 'key' && k.length >= 2 && idx.lookup(k) !== k).map(([k]) => k);
    if (srcNames.length && han && han.total) {
      const set = new Set(srcNames);
      const hits = new Map();
      for (const row of han.items) {
        const o = out(p.itemById.get(row.itemId));
        const re = HAN_RUN();
        let m;
        while ((m = re.exec(o))) {
          if (!set.has(m[0]) || !isVarRef(o, m.index, m.index + m[0].length)) continue;
          let e = hits.get(m[0]);
          if (!e) { e = { n: 0, items: new Set(), sample: '' }; hits.set(m[0], e); }
          e.n++; e.items.add(row.itemId);
          if (!e.sample) e.sample = o.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30).replace(/\s+/g, ' ');
        }
      }
      for (const [name, e] of [...hits].sort((x, y) => y[1].n - x[1].n).slice(0, 25)) {
        const first = [...e.items][0];
        s.add('warn', `Biến "${name}" (đã dịch thành "${idx.lookup(name)}") vẫn được truy cập bằng tên gốc ở ${e.n} chỗ — trong ${e.items.size} mục, vd: ${p.itemById.get(first)?.label}`, first, '…' + e.sample + '…');
      }
    }
    s.summary = s.level === 'ok' || s.level === 'info' ? `${checkedPaths} đường dẫn biến khớp từ điển, InitVar hợp lệ` : `${badPaths} đường dẫn lệch / ${checkedPaths} đã kiểm`;
  }

  // ------------------------------------------------------------ 6) EJS
  {
    const s = sec('ejs', 'EJS (ST-Prompt-Template)');
    let n = 0, skipped = 0;
    for (const it of strItems) {
      if (!it.text.includes('<%')) continue;
      if (ejsSyntaxError(it.text)) { skipped++; continue; } // bản gốc đã không biên dịch được -> không kết luận
      n++;
      const e = ejsSyntaxError(out(it));
      if (e) s.add('error', `${it.label}: EJS hỏng sau dịch — ${e}`, it.id);
    }
    s.summary = n || skipped ? `${n} mục EJS đã kiểm` + (s.level === 'ok' ? ', tất cả còn biên dịch được' : '') + (skipped ? ` (${skipped} mục bản gốc vốn không biên dịch được, bỏ qua)` : '') : 'Card không dùng EJS';
  }

  // ------------------------------------------------------------ 7) script
  {
    const s = sec('js', 'Mã JavaScript (script trong HTML, Tavern Helper)');
    let n = 0;
    for (const it of strItems) {
      if (it.kind === 'code' || it.kind === 'schema') {
        if (jsSyntaxError(it.text, true)) continue;
        n++;
        const e = jsSyntaxError(out(it), true);
        if (e) s.add('error', `${it.label}: script hỏng sau dịch — ${e}`, it.id);
        continue;
      }
      if (!/<script/i.test(it.text)) continue;
      const b0 = scriptBlocks(it.text), b1 = scriptBlocks(out(it));
      if (b0.length !== b1.length) { s.add('error', `${it.label}: số khối <script> thay đổi ${b0.length} → ${b1.length}`, it.id); continue; }
      b0.forEach((b, i) => {
        if (/\$\d|\{\{/.test(b.code) || jsSyntaxError(b.code, b.isModule)) return; // có $1 / macro: chỉ hợp lệ sau khi regex thay thế
        n++;
        const e = jsSyntaxError(b1[i].code, b1[i].isModule);
        if (e) s.add('error', `${it.label}: khối <script> #${i + 1} hỏng sau dịch — ${e}`, it.id);
      });
    }
    s.summary = n ? `${n} khối mã đã kiểm` + (s.level === 'ok' ? ', tất cả còn hợp lệ' : '') : 'Không có mã JS kiểm được';
  }

  // ------------------------------------------------------------ 8) regex
  {
    const s = sec('regex', 'Regex (find regex còn khớp sau dịch)');
    const rx0 = p.card.raw.data.extensions?.regex_scripts || [];
    const findItems = new Map(p.items.filter((it) => it.kind === 'regexFind').map((it) => [it.meta?.regexIndex, it]));
    const texts = strItems.filter((it) => it.kind !== 'regexFind' && it.group !== 'regex' && it.group !== 'scripts' && it.text.length <= 400000);
    let checked = 0, timeUp = false;
    rx0.forEach((r, i) => {
      if (!r || typeof r.findRegex !== 'string' || !r.findRegex) return;
      const fit = findItems.get(i);
      const f1 = fit ? String(p.output(fit.id, settings)) : r.findRegex;
      const re0 = regexFromString(r.findRegex);
      if (!re0) return;
      const re1 = regexFromString(f1);
      const name = r.scriptName || `#${i + 1}`;
      if (!re1) { s.add('error', `Regex "${name}": find regex sau dịch không hợp lệ: ${truncate(f1, 120)}`, fit?.id); return; }
      checked++;
      if (timeUp || r.disabled) return; // regex đang tắt không chạy trong ST -> chỉ cần hợp lệ
      const g = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      const g0 = g(re0), g1 = g(re1);
      const lost = [];
      for (const it of texts) {
        if (Date.now() - t0 > deadlineMs) { timeUp = true; break; }
        let m0;
        try { m0 = countAll(it.text, g0); } catch { break; }
        if (!m0) continue;
        const m1 = countAll(out(it), g1);
        if (m1 < m0) lost.push({ it, m0, m1 });
      }
      for (const x of lost.slice(0, 6)) s.add('warn', `Regex "${name}" khớp ${x.m0} lần ở bản gốc nhưng chỉ còn ${x.m1} lần sau dịch trong: ${x.it.label}`, x.it.id, `gốc:  ${truncate(r.findRegex, 160)}\ndịch: ${truncate(f1, 160)}`);
      if (lost.length > 6) s.more += lost.length - 6;
    });
    // ký hiệu regex cần mà bản dịch làm mất
    const guard = p.guard || [];
    if (guard.length) {
      let n = 0;
      for (const seg of p.segmentsFor()) {
        const t = p.tm.get(seg.key);
        if (t == null) continue;
        for (const ch of guard) { if (seg.key.includes(ch) && t.split(ch).length < seg.key.split(ch).length) { n++; break; } }
      }
      if (n) s.add('warn', `${n} đoạn dịch làm mất ký hiệu mà regex của card cần (${guard.slice(0, 12).join(' ')}) — bấm "Dịch chỗ thiếu/lỗi" để dịch lại`);
    }
    s.summary = rx0.length ? `${checked}/${rx0.length} regex đã kiểm` + (s.level === 'ok' ? ', vẫn khớp như bản gốc' : '') + (timeUp ? ' (dừng sớm vì card quá lớn)' : '') : 'Card không có regex';
  }

  // ------------------------------------------------------------ 9) tên mục lorebook (getwi)
  {
    const s = sec('entries', 'Tên mục lorebook được EJS / script gọi');
    const comments = p.items.filter((it) => it.kind === 'comment');
    const names0 = new Set(comments.map((it) => it.text));
    const names1 = new Map();
    for (const it of comments) { const o = String(p.output(it.id, settings)); if (!names1.has(o)) names1.set(o, []); names1.get(o).push(it); }
    const callRe = () => /\b(?:getwi|getWI|getWorldInfo|activewi|activateWorldInfo|activateWI|getEntry|getLorebookEntry)\s*\(\s*(?:[^,()'"`]*,\s*)?(['"`])([^'"`\n]+)\1/g;
    let n = 0;
    for (const it of strItems) {
      if (!/getwi|getWorldInfo|activewi|activateWorldInfo|activateWI|getEntry|getLorebookEntry/i.test(it.text)) continue;
      const a = [...it.text.matchAll(callRe())].map((m) => m[2]);
      const b = [...out(it).matchAll(callRe())].map((m) => m[2]);
      if (a.length !== b.length) continue;
      a.forEach((name, i) => {
        if (!names0.has(name)) return; // bản gốc cũng không trỏ tới mục có thật (tên ghép động…)
        n++;
        if (!names1.has(b[i])) s.add('error', `${it.label}: gọi mục "${name}" → sau dịch là "${b[i]}" nhưng không có mục lorebook nào tên như vậy`, it.id);
      });
    }
    for (const [name, list] of names1) {
      if (list.length > 1 && new Set(list.map((x) => x.text)).size > 1) s.add('warn', `${list.length} mục lorebook khác nhau bị dịch trùng tên "${truncate(name, 60)}": ${list.slice(0, 4).map((x) => x.text).join(' · ')}`, list[0].id);
    }
    if (p.pinnedEntries?.size) s.add('info', `${p.pinnedEntries.size} tên mục được giữ nguyên vì mã ghép tên động (getwi(null, a + b))`);
    s.summary = n ? `${n} lời gọi getwi()/activewi() đã kiểm` + (s.level === 'error' ? '' : ', đều trỏ đúng mục') : 'Không có lời gọi mục lorebook theo tên cố định';
  }

  // ------------------------------------------------------------ 10) bảo toàn cấu trúc
  {
    const s = sec('structure', 'Bảo toàn cấu trúc ($1, macro, thẻ HTML, EJS)');
    let n = 0;
    for (const it of strItems) {
      if (it.kind === 'regexFind' || it.kind === 'name' || it.kind === 'comment' || it.kind === 'button') continue;
      if (Date.now() - t0 > deadlineMs * 2) break;
      const o = out(it);
      if (o === it.text) continue;
      const html = it.kind !== 'code' && it.kind !== 'schema' && it.kind !== 'json' && it.kind !== 'initvar' && it.text.length < 600000 && looksLikeHtml(it.text);
      const replace = !!it.meta?.isReplace;
      const a = structure(it.text, { html, replace }), b = structure(o, { html, replace });
      n++;
      const lostRefs = diffMultiset(multiset(a.refs), multiset(b.refs));
      if (lostRefs.length) s.add('error', `${it.label}: mất tham chiếu regex ${lostRefs.slice(0, 6).join(', ')}`, it.id);
      const lostMacros = diffMultiset(multiset(a.macros), multiset(b.macros));
      if (lostMacros.length) s.add('warn', `${it.label}: mất macro ${lostMacros.slice(0, 6).map((x) => '{{' + x + '}}').join(', ')}`, it.id);
      if (a.ejs !== b.ejs) s.add('error', `${it.label}: số thẻ EJS thay đổi ${a.ejs} → ${b.ejs}`, it.id);
      if (a.fences !== b.fences) s.add('warn', `${it.label}: số dấu \`\`\` thay đổi ${a.fences} → ${b.fences}`, it.id);
      if (html) {
        const lostTags = diffMultiset(multiset(a.tags), multiset(b.tags));
        if (lostTags.length) s.add('error', `${it.label}: mất thẻ HTML ${lostTags.slice(0, 8).map((x) => '<' + x + '>').join(' ')}`, it.id);
      }
    }
    s.summary = `${n} mục đã so cấu trúc` + (s.level === 'ok' ? ', không mất thành phần nào' : '');
  }

  const totals = { error: 0, warn: 0, info: 0 };
  for (const s of sections) { for (const f of s.findings) totals[f.level] = (totals[f.level] || 0) + 1; delete s.add; }
  return { sections, totals, han, ms: Date.now() - t0 };
}
