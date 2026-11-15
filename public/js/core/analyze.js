// Bộ phân tích: tách nội dung card thành "đoạn cần dịch" (segment) + phần giữ nguyên/ánh xạ biến (hole).
// Nguyên tắc: chỉ thay thế đúng vị trí — mã HTML/JS/CSS ngoài phần chữ được giữ nguyên từng ký tự.
// Bản dịch lưu theo khóa = văn bản nguồn có placeholder ⟦n⟧ (bộ nhớ dịch / TM), nên đổi bảng biến
// không cần dịch lại: chỉ cần render lại.
import { lexJs, lexHtml, lexCss, significant, cssPropertyBefore } from './lexer.js';
import { hasCJK, isIdentifier, escapeRegex, HAN_CLASS } from './util.js';
import { splitCompositeKnown } from './dict.js';

export const PH_RE = /⟦\s*(\d+)\s*⟧/g;
export const ph = (n) => `⟦${n}⟧`;

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'label', 'nobr']);
const TRANSLATE_ATTRS = new Set(['title', 'alt', 'placeholder', 'aria-label', 'aria-placeholder', 'aria-description', 'aria-roledescription', 'label', 'data-tooltip', 'data-title', 'data-placeholder', 'data-tip', 'tooltip']);
const HTML_HINT_RE = /<!doctype|<\/?(?:html|head|body|div|span|p|br|hr|style|script|table|tr|td|th|ul|ol|li|details|summary|button|img|section|article|header|footer|nav|main|h[1-6]|strong|em|b|i|u|small|font|center|label|input|select|option|textarea|canvas|svg|iframe|blockquote|pre|figure|audio|video|dl|dt|dd|sub|sup|mark|ruby|progress)\b[^>]*>/i;
const OBJECT_PREV = new Set(['(', ',', '=', ':', '[', '?', '??', '||', '&&', '!', '+', '-', '*', '/', '%', '...', '=>{', 'return', 'const', 'let', 'var', 'typeof', 'await', 'yield', 'case', 'in', 'of', '==', '===', '!=', '!==', '+=', '||=', '&&=', '??=', 'export', 'default', '<', '>', '<=', '>=']);
const KEEP_ARG_FUNCS = new Set(['getButtonEvent', 'eventOn', 'eventOnce', 'eventEmit', 'eventMakeFirst', 'eventMakeLast', 'eventRemoveListener', 'eventClearEvent', 'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByName', 'getItem', 'setItem', 'removeItem', 'require', 'import', 'getwi', 'getWorldInfo', 'getEntry', 'getLorebookEntries', 'getChatLorebook', 'activewi', 'activateWorldInfo', 'getCharLorebooks', 'getLorebookSettings', 'getScriptButtons', 'registerMvuSchema', 'waitGlobalInitialized', 'attr', 'prop', 'hasClass', 'addClass', 'removeClass', 'toggleClass', 'closest', 'find', 'is', 'on', 'off', 'trigger', 'data', 'setAttribute', 'getAttribute', 'createElement', 'matches', 'fetch', 'postMessage', 'loadScript']);
const PATH_FUNCS = new Set(['getvar', 'setvar', 'incvar', 'decvar', 'addvar', 'delvar', 'getVariable', 'setVariable', 'get', 'set', 'has', 'unset', 'update', 'getMvuVariable', 'setMvuVariable', 'getLocalVar', 'setLocalVar', 'getGlobalVar', 'setGlobalVar', 'getMessageVar', 'setMessageVar', 'getChatVar', 'setChatVar', 'deleteVariable', 'insert', 'remove', 'add', 'assign', 'delete', 'move', 'patchVariables']);
const MACRO_PATH_RE = /^\{\{\s*(getvar|setvar|addvar|incvar|decvar|getglobalvar|setglobalvar|addglobalvar|incglobalvar|decglobalvar|get_message_variable|get_chat_variable|get_character_variable|get_preset_variable|get_global_variable|format_message_variable|format_chat_variable|format_character_variable|format_global_variable|format_preset_variable)\s*::\s*/i;
const YAML_PLAIN_BAD = /^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|^\s|\s$|^$/;

/** Văn bản có vẻ là HTML (có thẻ chuẩn) */
export function looksLikeHtml(s) { return HTML_HINT_RE.test(s); }

// ====================================================================== cấu trúc dữ liệu
class Node {
  constructor(start, end) { this.start = start; this.end = end; this.reps = []; }
}
function renderNode(src, node, env) {
  const reps = node.reps.slice().sort((a, b) => a.start - b.start);
  let out = '', pos = node.start;
  for (const r of reps) {
    if (r.start < pos) continue; // chồng lấn (không nên xảy ra)
    out += src.slice(pos, r.start) + r.render(env);
    pos = r.end;
  }
  return out + src.slice(pos, node.end);
}

const identity = (s) => s;
const compose = (inner, outer) => (outer === identity ? inner : inner === identity ? outer : (s) => outer(inner(s)));
const jsEsc = (q) => (s) => {
  let o = s.replace(/\\/g, '\\\\');
  if (q === '`') o = o.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  else o = o.split(q).join('\\' + q).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return o.replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
};
const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
const attrEsc = (q) => (s) => (q === '"' ? s.replace(/"/g, '&quot;') : q === "'" ? s.replace(/'/g, '&#39;') : s);
const htmlTextEsc = (s) => s.replace(/<(?=[A-Za-z\/!?])/g, '&lt;');
const cssEsc = (q) => (s) => s.replace(/\\/g, '\\\\').split(q).join('\\' + q).replace(/\n/g, '\\A ');
const yamlEsc = (q) => (s) => {
  if (q === '"') return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  if (q === "'") return s.replace(/'/g, "''").replace(/\s*\r?\n\s*/g, ' ');
  return s;
};
const yamlPlainEsc = (s) => (YAML_PLAIN_BAD.test(s) || /[\r\n]/.test(s) || /^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.eE+-]*)$/i.test(s) ? JSON.stringify(s) : s);
// tên / tiêu đề / dòng chú thích YAML: luôn 1 dòng
const oneLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ');
const jsonEsc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
// chú thích: bản dịch không được làm "thoát" khỏi chú thích
const lineCommentEsc = (s) => s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
const blockCommentEsc = (s) => s.replace(/\*\//g, '* /');
const htmlCommentEsc = (s) => s.replace(/--!?>/g, '- ->').replace(/<!--/g, '<!- -');
// mã bên trong <% %> (EJS / ST-Prompt-Template): "%>" hay "<%" trong chuỗi/chú thích sẽ cắt ngang thẻ EJS
// -> viết thành "%\>" / "<\%" (trong chuỗi JS vẫn ra đúng "%>" / "<%")
const ejsCodeEsc = (s) => s.replace(/%>/g, '%\\>').replace(/<%/g, '<\\%');
const ejsTextEsc = (s) => s.replace(/%>/g, '% >').replace(/<%/g, '< %');
/** Thẻ EJS điều khiển (<% if … { %>, <%_ … _%>) — không phải thẻ xuất giá trị (<%= / <%-) hay chú thích (<%#) */
export function isEjsScriptlet(src, start) {
  return src.startsWith('<%', start) && !/[=\-#%]/.test(src[start + 2] || '');
}

// ====================================================================== bối cảnh phân tích
/**
 * ctx = {
 *   dict: { kindOf(src) -> 'key'|'value'|'marker'|'term'|null, markers: string[] },
 *   entryNames: Set<string>, bookNames: Set<string>,
 *   opts: { codeStrings: 'smart'|'all'|'none', ejsStrings: bool, comments: bool, chunkSize: number, translateKeysMode }
 * }
 */
class Analyzer {
  constructor(src, ctx) {
    this.src = src;
    this.ctx = ctx;
    this.opts = { codeStrings: 'smart', ejsStrings: false, comments: false, chunkSize: 1800, ...(ctx.opts || {}) };
    this.dict = ctx.dict || { kindOf: () => null, markers: [] };
    this.entryNames = ctx.entryNames || new Set();
    this.bookNames = ctx.bookNames || new Set();
    this.segments = [];
    this.warnings = [];
    this.markerRe = buildMarkerRe(this.dict.markers || []);
  }

  warn(msg) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }

  /** loại khớp chính xác trong từ điển (gồm cả tên mục lorebook) */
  exactKind(text) {
    const k = this.dict.kindOf(text);
    if (k) return k;
    if (this.entryNames.has(text)) return 'entry';
    if (this.bookNames.has(text)) return 'book';
    return null;
  }

  /** Chuỗi ghép "A、B、C" mà mọi nhãn đều có trong từ điển -> hole ánh xạ từng nhãn, giữ dấu phân cách */
  compositeHole(text) {
    const parts = splitCompositeKnown(text, (x) => !!this.dict.kindOf(x));
    return parts ? { type: 'composite', parts, esc: true } : null;
  }

  /** rep cho chuỗi khớp nguyên văn (từ điển / tên mục / chuỗi ghép / đường dẫn) — null nếu không khớp */
  exactRep(s, e, text, esc) {
    const k = this.exactKind(text);
    if (k) return this.dictRep(s, e, text, k, esc);
    const comp = this.compositeHole(text);
    if (comp) return { start: s, end: e, render: (env) => esc(renderHole(comp, env)) };
    return null;
  }

  isPathSeg(seg) {
    if (!seg) return false;
    if (/^\u0001+$/.test(seg) || /^\$\{[^}]*\}$/.test(seg) || /^\d+$/.test(seg) || seg === '*' || seg === '-' || /^<[a-z_]+>$/i.test(seg) || /^\{\{[a-z_]+\}\}$/i.test(seg)) return 'wild';
    const k = this.dict.kindOf(seg);
    if (k === 'key' || k === 'value' || k === 'term') return 'key';
    if (/^stat_data$|^display_data$|^delta_data$/.test(seg)) return 'root';
    return false;
  }

  /** Chuỗi có phải đường dẫn biến (a.b.c, /a/b, .b) chỉ gồm khóa đã biết? */
  pathInfo(text) {
    if (!text || !hasCJK(text)) return null;
    let sep = null;
    if (/^\/|^[^/]*\/[^/]/.test(text) && !text.includes('.')) sep = '/';
    else if (text.includes('.')) sep = '.';
    else return null;
    // tách cả dạng [0] / ['x']
    const norm = text.replace(/\[(\d+)\]/g, sep + '$1');
    const parts = norm.split(sep);
    let keys = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '' && (i === 0 || i === parts.length - 1)) continue;
      const t = this.isPathSeg(p);
      if (!t) return null;
      if (t === 'key') keys++;
    }
    if (!keys) return null;
    return { sep };
  }

  newSeg(key, holes, kind, esc) {
    const seg = { key, holes, kind, esc };
    this.segments.push(seg);
    return seg;
  }

  // ------------------------------------------------------------------ hole renderers
  dictHole(text, kind) { return { type: 'dict', src: text, kind, esc: true }; }
  pathHole(text) { return { type: 'path', src: text, esc: true }; }
  rawHole(start, end) { return { type: 'raw', text: this.src.slice(start, end), esc: false }; }
  nodeHole(node) { return { type: 'node', node, esc: false }; }

  // ====================================================================== văn bản (đoạn văn / text node / chuỗi)
  /**
   * Tạo segment cho [start,end). holes: [{start,end,hole}] đã xác định trước (thẻ inline, ${expr}...)
   * opts: { esc, kind: 'prose'|'ui'|'name'|'desc'|'keyword', entities, jsEscapes, regexRefs, yamlKeys, chunk, exact }
   */
  textRun(parent, start, end, o = {}) {
    const src = this.src;
    const esc = o.esc || identity;
    const given = (o.holes || []).filter((h) => h.start >= start && h.end <= end);
    // cắt khoảng trắng 2 đầu (không cắt vào hole)
    let s = start, e = end;
    const inHole = (p) => given.some((h) => p >= h.start && p < h.end);
    while (s < e && /\s/.test(src[s]) && !inHole(s)) s++;
    while (e > s && /\s/.test(src[e - 1]) && !inHole(e - 1)) e--;
    if (s >= e) { this.flushHoles(parent, given); return; }
    const text = src.slice(s, e);

    // 1) khớp nguyên văn với từ điển biến / tên mục / chuỗi ghép
    if (o.exact !== false && !given.length) {
      const rep = this.exactRep(s, e, text, esc);
      if (rep) { parent.reps.push(rep); return; }
    }
    // 2) tìm phần cần bảo vệ trong đoạn
    const found = this.findProtections(s, e, o, given);
    const holes = mergeHoles(given, found);
    // 2b) thẻ EJS điều khiển (<% if (…) { %> … <% } %>) là ranh giới: tách đoạn tại đó để AI không thể
    //     đảo vị trí lệnh điều khiển (đảo ⟦n⟧ của thẻ inline thì được, đảo lệnh if/else thì hỏng logic)
    const barriers = holes.filter((h) => isEjsScriptlet(src, h.start));
    if (barriers.length) {
      let pos = s;
      const sub = (a, b) => { if (b > a) this.textRun(parent, a, b, { ...o, holes: given.filter((g) => g.start >= a && g.end <= b) }); };
      for (const b of barriers) {
        sub(pos, b.start);
        this.flushHoles(parent, [b], esc);
        pos = b.end;
      }
      sub(pos, e);
      return;
    }
    // phần chữ ngoài hole có CJK?
    let outside = '', pos = s;
    for (const h of holes) { outside += src.slice(pos, h.start); pos = h.end; }
    outside += src.slice(pos, e);
    if (!hasCJK(outside)) { this.flushHoles(parent, holes, esc); return; }

    // 3) chia nhỏ văn bản dài
    const limit = o.chunk === false ? Infinity : (this.opts.chunkSize || 1800);
    const pieces = e - s > limit ? splitRange(src, s, e, holes, limit) : [[s, e]];
    for (const [ps, pe0] of pieces) {
      let a = ps, b = pe0;
      while (a < b && /\s/.test(src[a]) && !holes.some((h) => a >= h.start && a < h.end)) a++;
      while (b > a && /\s/.test(src[b - 1]) && !holes.some((h) => b - 1 >= h.start && b - 1 < h.end)) b--;
      if (a >= b) continue;
      const hs = mergeAdjacent(src, holes.filter((h) => h.start >= a && h.end <= b));
      let key = '', p = a;
      const segHoles = [];
      for (const h of hs) {
        key += src.slice(p, h.start);
        segHoles.push(h.hole);
        key += ph(segHoles.length);
        p = h.end;
      }
      key += src.slice(p, b);
      const out2 = key.replace(PH_RE, '');
      if (!hasCJK(out2)) { this.flushHoles(parent, hs, esc); continue; }
      const seg = this.newSeg(key, segHoles, o.kind || 'prose', esc);
      parent.reps.push({ start: a, end: b, render: (env) => renderSegment(seg, env) });
    }
  }

  dictRep(s, e, text, kind, esc) {
    const hole = kind === 'entry' ? { type: 'entry', src: text, esc: true } : kind === 'book' ? { type: 'book', src: text, esc: true } : this.dictHole(text, kind);
    return { start: s, end: e, render: (env) => esc(renderHole(hole, env)) };
  }

  /** Thêm rep cho các hole động (dict/path/node) khi không tạo segment */
  flushHoles(parent, holes, ctxEsc) {
    for (const h of holes) {
      if (h.hole.type === 'raw') continue;
      const hole = h.hole;
      const esc = h.esc || ctxEsc || identity;
      parent.reps.push({ start: h.start, end: h.end, render: (env) => (hole.esc ? esc(renderHole(hole, env)) : renderHole(hole, env)) });
    }
  }

  /** Tìm các vùng cần giữ nguyên trong [s,e): macro đường dẫn, EJS, $1, entity, escape JS, đường dẫn biến, marker */
  findProtections(s, e, o, given) {
    const src = this.src;
    const text = src.slice(s, e);
    const out = [];
    const add = (a, b, hole) => { out.push({ start: s + a, end: s + b, hole }); };
    let m;
    // EJS <% ... %>
    if (text.includes('<%')) {
      const re = /<%[\s\S]*?%>/g;
      while ((m = re.exec(text))) {
        const node = this.ejsNode(s + m.index, s + m.index + m[0].length);
        add(m.index, m.index + m[0].length, this.nodeHole(node));
      }
    }
    // macro {{...}}
    if (text.includes('{{')) {
      const re = /\{\{[\s\S]*?\}\}/g;
      while ((m = re.exec(text))) {
        const mm = m[0];
        if (/^\{\{\s*match\s*\}\}$/i.test(mm) && o.regexRefs) { add(m.index, m.index + mm.length, this.rawHole(s + m.index, s + m.index + mm.length)); continue; }
        const pm = MACRO_PATH_RE.exec(mm);
        if (pm && hasCJK(mm)) add(m.index, m.index + mm.length, { type: 'macro', src: mm, esc: true });
      }
    }
    // $1 / $<name> / $& trong replaceString
    if (o.regexRefs) {
      const re = /\$(\d+|<[^>]+>|&)/g;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    if (o.entities) {
      const re = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
      // "<chữ" lạc trong văn bản HTML (thẻ hỏng) -> giữ nguyên, tránh bị escape thành &lt;
      const re2 = /<[A-Za-z\/!?][^<>\s]*/g;
      while ((m = re2.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    if (o.jsEscapes) {
      const re = /\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    if (o.yamlEscapes) {
      const re = /\\(?:u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])|''/g;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    // stat_data.xxx.yyy hoặc stat_data['xx']
    if (text.includes('stat_data') || text.includes('display_data') || text.includes('delta_data')) {
      const re = /(?:stat_data|display_data|delta_data)((?:\.[^\s.,;:'"`()\[\]{}<>，。；：！？、]+|\[\s*['"][^'"\]]+['"]\s*\]|\[\d+\])+)/g;
      while ((m = re.exec(text))) {
        if (hasCJK(m[0])) add(m.index, m.index + m[0].length, this.pathHole(m[0]));
      }
    }
    // chuỗi trong nháy là khóa/đường dẫn: '基础信息' "a.b" 「a.b」 “a.b” `a.b`
    {
      const re = /(['"`「『“‘])([^'"`」』”’\n]{1,120})(['"`」』”’])/g;
      while ((m = re.exec(text))) {
        const inner = m[2];
        if (!hasCJK(inner)) continue;
        const a = m.index + 1, b = a + inner.length;
        const k = this.dict.kindOf(inner);
        if (k && k !== 'term') add(a, b, this.dictHole(inner, k));
        else if (this.entryNames.has(inner)) add(a, b, { type: 'entry', src: inner, esc: true });
        else if (this.pathInfo(inner)) add(a, b, this.pathHole(inner));
        else if (!k) {
          const comp = this.compositeHole(inner);
          if (comp && comp.parts.some((p) => hasCJK(p.text) && this.dict.kindOf(p.text) !== 'term')) add(a, b, comp);
        }
      }
    }
    // decorator của ST-Prompt-Template ở đầu dòng: @@generate_before, @@render_after, @@dont_activate…
    if (text.includes('@@')) {
      const re = /^([ \t]*)(@@[A-Za-z_][\w:-]*)/gm;
      while ((m = re.exec(text))) add(m.index + m[1].length, m.index + m[0].length, this.rawHole(s + m.index + m[1].length, s + m.index + m[0].length));
    }
    // đường dẫn trần a.b.c (>=2 đoạn, toàn khóa đã biết)
    if (text.includes('.')) {
      const re = new RegExp('(?:\\$\\{[^}]*\\}|[^\\s.,;:\'"`()\\[\\]{}<>，。；：！？、]+)(?:\\.(?:\\$\\{[^}]*\\}|[^\\s.,;:\'"`()\\[\\]{}<>，。；：！？、]+))+', 'g');
      while ((m = re.exec(text))) {
        if (!hasCJK(m[0])) continue;
        // bỏ tiền tố không phải đường dẫn (vd "更新世界.时间" -> chỉ lấy phần khớp từ điển)
        const r = this.trimPathMatch(m[0]);
        if (r) add(m.index + r.offset, m.index + r.offset + r.text.length, this.pathHole(r.text));
      }
    }
    // dòng khóa YAML:  "  世界.时间:"  /  "  好感度:"
    if (o.yamlKeys) {
      const re = /^([ \t]*(?:-[ \t]+)?)([^\s:#\-'"][^:\n]*?)(?=:(?:[ \t]|$))/gm;
      while ((m = re.exec(text))) {
        const key = m[2].trim();
        if (!hasCJK(key)) continue;
        const a = m.index + m[1].length, b = a + m[2].length;
        const k = this.dict.kindOf(key);
        if (k === 'key' || k === 'value') add(a, a + key.length, this.dictHole(key, k));
        else if (this.pathInfo(key)) add(a, a + key.length, this.pathHole(key));
        void b;
      }
    }
    // marker trong ngoặc: 【开场白】 【/开场白】 <开场白>
    if (this.markerRe) {
      this.markerRe.lastIndex = 0;
      while ((m = this.markerRe.exec(text))) {
        const a = m.index + m[1].length + m[2].length;
        add(a, a + m[3].length, this.dictHole(m[3], 'marker'));
      }
    }
    // bỏ các vùng nằm trong hole đã có
    return out.filter((h) => !given.some((g) => h.start < g.end && h.end > g.start));
  }

  trimPathMatch(text) {
    const parts = text.split('.');
    // tìm dãy liên tiếp dài nhất toàn đoạn hợp lệ, cho phép đoạn đầu chỉ khớp ở phần đuôi
    let first = parts[0];
    let offset = 0;
    if (!this.isPathSeg(first)) {
      // thử cắt đầu: tìm hậu tố của đoạn đầu là khóa
      let found = null;
      for (let i = 1; i < first.length; i++) {
        const suf = first.slice(i);
        if (this.isPathSeg(suf) === 'key' || this.isPathSeg(suf) === 'root') { found = i; break; }
      }
      if (found == null) return null;
      offset = found;
      first = first.slice(found);
    }
    const segs = [first];
    for (let i = 1; i < parts.length; i++) {
      if (this.isPathSeg(parts[i])) { segs.push(parts[i]); continue; }
      // đoạn cuối dính chữ thường: "时间更新" -> lấy tiền tố "时间"
      const p = parts[i];
      for (let j = p.length - 1; j > 0; j--) {
        if (this.isPathSeg(p.slice(0, j)) === 'key') { segs.push(p.slice(0, j)); break; }
      }
      break;
    }
    if (segs.length < 2) return null;
    const t = segs.join('.');
    if (!this.pathInfo(t)) return null;
    return { text: t, offset };
  }

  // ====================================================================== EJS
  /**
   * Thẻ EJS (ST-Prompt-Template): <% mã %>, <%_ _%>, <%= xuất %>, <%- xuất thô %>, <%# chú thích %>, <%% = chữ "<%".
   * - thẻ xuất (<%= / <%-): chuỗi hiển thị được dịch theo quy tắc "thông minh" (giữ khóa/so sánh/tham số API)
   * - thẻ mã: chỉ đồng bộ biến/tên mục; chuỗi giữ nguyên (trừ tham số print()), trừ khi bật "Dịch cả chuỗi trong EJS"
   */
  ejsNode(start, end) {
    const node = new Node(start, end);
    const src = this.src;
    const mod = src[start + 2];
    if (mod === '%') return node; // <%% -> chữ "<%" thường
    let a = start + 2;
    while (a < end && /[_\-=#]/.test(src[a])) a++;
    let b = end - 2;
    while (b > a && /[_\-]/.test(src[b - 1])) b--;
    if (mod === '#') { // chú thích EJS
      if (this.opts.comments && hasCJK(src.slice(a, b))) this.textRun(node, a, b, { esc: ejsTextEsc, kind: 'comment' });
      return node;
    }
    this.jsRange(node, a, b, { mode: mod === '=' || mod === '-' ? 'ejs-out' : 'ejs', esc: ejsCodeEsc });
    return node;
  }

  // ====================================================================== HTML
  htmlRange(parent, start, end, o = {}) {
    const src = this.src;
    const outerEsc = o.esc || identity;
    // che EJS và ${expr} để lexer HTML không bị nhiễu
    const masks = (o.masks || []).slice();
    if (src.slice(start, end).includes('<%')) {
      let m;
      const local = src.slice(start, end);
      const re = /<%[\s\S]*?%>/g;
      while ((m = re.exec(local))) {
        const s0 = start + m.index, e0 = s0 + m[0].length;
        if (masks.some((k) => s0 < k.end && e0 > k.start)) continue;
        masks.push({ start: s0, end: e0, hole: this.nodeHole(this.ejsNode(s0, e0)) });
      }
    }
    let lexSrc = src, base = 0, lexStart = start, lexEnd = end;
    if (masks.length) {
      let local = src.slice(start, end);
      for (const k of masks) local = local.slice(0, k.start - start) + '\u0001'.repeat(k.end - k.start) + local.slice(k.end - start);
      lexSrc = local; base = start; lexStart = 0; lexEnd = local.length;
    }
    const toks = lexHtml(lexSrc, lexStart, lexEnd).map((t) => shiftTok(t, base));
    // mảnh HTML trong chuỗi JS bắt đầu giữa thẻ: '" title="x">chữ' -> phần tới '>' là đuôi thẻ, giữ nguyên
    if ((o.jsEscapes || o.masks) && toks[0]?.type === 'text') {
      const t0 = toks[0];
      const txt = src.slice(t0.start, t0.end);
      const gt = txt.indexOf('>');
      if (gt >= 0) {
        const pre = txt.slice(0, gt);
        if (!pre.includes('<') && (/["']\s*\/?$/.test(pre) || /^\s*\/?$/.test(pre))) {
          const rest = gt + 1 < txt.length ? [{ type: 'text', start: t0.start + gt + 1, end: t0.end }] : [];
          toks.splice(0, 1, { type: 'partial', start: t0.start, end: t0.start + gt + 1 }, ...rest);
        }
      }
    }
    const used = new Set();
    let run = [];
    const flush = () => { this.htmlRun(parent, run, masks, used, outerEsc, o); run = []; };
    for (const t of toks) {
      if (t.type === 'text') { run.push({ t }); continue; }
      if (t.type === 'tag') {
        const tagNode = new Node(t.start, t.end);
        this.htmlAttrs(tagNode, t, outerEsc, masks, used, o.jsEscapes);
        if (INLINE_TAGS.has(t.lower)) { run.push({ t, node: tagNode }); continue; }
        flush();
        parent.reps.push(...tagNode.reps);
        continue;
      }
      flush();
      // văn bản chỉ "nhắc tới" thẻ <style>/<script> (vd "dùng thẻ <style>，không được bỏ sót…"): phần sau không phải mã
      // -> dấu câu tiếng Trung nằm ngoài chuỗi/chú thích là dấu hiệu chắc chắn -> phân tích lại như HTML thường
      if (t.type === 'raw' && (t.tag === 'style' || t.tag === 'script') && rawIsProse(src, t.start, t.end, t.tag)) {
        const inner = masks.filter((k) => k.start >= t.start && k.end <= t.end);
        inner.forEach((k) => used.add(k));
        this.htmlRange(parent, t.start, t.end, { ...o, masks: inner });
        continue;
      }
      if (t.type === 'raw') {
        if (t.tag === 'script') {
          const typeAttr = (t.attrs || []).find((a) => a.name.toLowerCase() === 'type');
          const typeVal = typeAttr && typeAttr.vStart >= 0 ? src.slice(typeAttr.vStart, typeAttr.vEnd).toLowerCase() : '';
          if (!typeVal || /javascript|module|babel|jsx/.test(typeVal)) this.jsRange(parent, t.start, t.end, { mode: 'script', esc: outerEsc });
          else if (/json/.test(typeVal)) this.jsRange(parent, t.start, t.end, { mode: 'json', esc: outerEsc });
          else if (/html|template/.test(typeVal)) this.htmlRange(parent, t.start, t.end, { ...o, masks: [] });
        } else if (t.tag === 'style') {
          this.cssRange(parent, t.start, t.end, outerEsc);
        } else {
          this.textRun(parent, t.start, t.end, { esc: compose(htmlTextEsc, outerEsc), kind: 'ui', entities: true, regexRefs: o.regexRefs, jsEscapes: o.jsEscapes });
        }
      } else if (t.type === 'comment' && this.opts.comments && hasCJK(src.slice(t.start, t.end))) {
        const ce = src.startsWith('-->', t.end - 3) && t.end - 3 >= t.start + 4 ? t.end - 3 : t.end;
        this.textRun(parent, t.start + 4, ce, { esc: compose(htmlCommentEsc, outerEsc), kind: 'comment' });
      }
    }
    flush();
    // hole che (EJS/expr) chưa nằm trong segment nào -> vẫn phải render
    for (const k of masks) if (!used.has(k)) this.flushHoles(parent, [k]);
  }

  htmlRun(parent, run, masks, used, outerEsc, o) {
    if (!run.length) return;
    // bỏ thẻ ở 2 đầu
    let a = 0, b = run.length - 1;
    const isText = (x) => x.t.type === 'text';
    const lift = (x) => { if (x.node) parent.reps.push(...x.node.reps); };
    while (a <= b && !isText(run[a])) lift(run[a++]);
    while (b >= a && !isText(run[b])) lift(run[b--]);
    if (a > b) return;
    const start = run[a].t.start, end = run[b].t.end;
    const holes = [];
    for (let i = a; i <= b; i++) {
      const x = run[i];
      if (x.t.type === 'tag') holes.push({ start: x.t.start, end: x.t.end, hole: x.node.reps.length ? this.nodeHole(x.node) : this.rawHole(x.t.start, x.t.end) });
    }
    for (const k of masks) if (k.start >= start && k.end <= end) { holes.push(k); used.add(k); }
    holes.sort((x, y) => x.start - y.start);
    this.textRun(parent, start, end, { holes, esc: compose(htmlTextEsc, outerEsc), kind: 'ui', entities: true, regexRefs: o.regexRefs, yamlKeys: o.yamlKeys, jsEscapes: o.jsEscapes });
  }

  htmlAttrs(node, t, outerEsc, masks, used, jsEscapes) {
    const src = this.src;
    for (const at of t.attrs) {
      if (at.vStart < 0) continue;
      const name = at.name.toLowerCase();
      const raw = src.slice(at.vStart, at.vEnd);
      const inMask = masks.filter((k) => k.start >= at.vStart && k.end <= at.vEnd);
      inMask.forEach((k) => used.add(k));
      const esc = compose(attrEsc(at.quote || '"'), outerEsc);
      if (name.startsWith('on')) {
        if (/[㐀-鿿]|stat_data/.test(raw)) this.jsRange(node, at.vStart, at.vEnd, { mode: 'attr', esc: compose(attrEsc(at.quote || '"'), outerEsc) });
        continue;
      }
      if (name === 'style') { if (hasCJK(raw)) this.cssRange(node, at.vStart, at.vEnd, esc); continue; }
      if (name === 'class' || name === 'id' || name === 'src' || name === 'href' || name === 'name' || name === 'for' || name === 'type' || name === 'rel' || name === 'lang' || name === 'xmlns') {
        this.flushHoles(node, inMask);
        continue;
      }
      if (!hasCJK(raw) && !raw.includes('{{') && !inMask.length) continue;
      const tagIsButton = t.lower === 'input' && t.attrs.some((x) => x.name.toLowerCase() === 'type' && /button|submit|reset/i.test(src.slice(x.vStart, x.vEnd)));
      if (TRANSLATE_ATTRS.has(name) || (name === 'value' && tagIsButton)) {
        this.textRun(node, at.vStart, at.vEnd, { holes: inMask, esc, kind: 'ui', entities: true, jsEscapes });
        continue;
      }
      // value, data-*…: trước hết ánh xạ theo từ điển (giá trị/khóa dùng trong mã phải khớp nhau)
      const text = raw.trim();
      const s0 = at.vStart + raw.indexOf(text);
      if (!inMask.length) {
        const rep = this.exactRep(s0, s0 + text.length, text, esc);
        if (rep) { node.reps.push(rep); continue; }
        if (this.pathInfo(text)) { const hole = this.pathHole(text); node.reps.push({ start: s0, end: s0 + text.length, render: (env) => esc(renderHole(hole, env)) }); continue; }
      }
      // data-* chứa JSON thô: data-cfg='{"名字":"…"}'
      if (name.startsWith('data-') && /^[{[]/.test(text) && text.includes('"') && at.quote === "'" && !inMask.length) {
        this.jsRange(node, at.vStart, at.vEnd, { mode: 'json', esc });
        continue;
      }
      // data-* là câu chữ hiển thị / prompt gửi đi (data-prompt="【开始】# 场景生成指令…", data-close="点击查看 ▶")
      if (name.startsWith('data-') && looksLikeProseAttr(text)) {
        this.textRun(node, at.vStart, at.vEnd, { holes: inMask, esc, kind: /\n/.test(text) || text.length > 80 ? 'prose' : 'ui', entities: true, jsEscapes, exact: false });
        continue;
      }
      this.flushHoles(node, [...inMask, ...this.findProtections(at.vStart, at.vEnd, {}, inMask)], esc);
    }
  }

  // ====================================================================== CSS
  cssRange(parent, start, end, outerEsc = identity) {
    const src = this.src;
    for (const t of lexCss(src, start, end)) {
      if (t.type === 'str' && hasCJK(src.slice(t.cStart, t.cEnd))) {
        const prop = cssPropertyBefore(src, t.start, start);
        if (prop === 'content' || (prop && prop.startsWith('--') && !/font/.test(prop))) {
          this.textRun(parent, t.cStart, t.cEnd, { esc: compose(cssEsc(t.quote), outerEsc), kind: 'ui', jsEscapes: true, exact: true });
        }
      } else if (t.type === 'comment' && this.opts.comments && hasCJK(src.slice(t.start, t.end))) {
        const ce = src.startsWith('*/', t.end - 2) && t.end - 2 >= t.start + 2 ? t.end - 2 : t.end;
        this.textRun(parent, t.start + 2, ce, { esc: compose(blockCommentEsc, outerEsc), kind: 'comment' });
      }
    }
  }

  // ====================================================================== JS
  /** mode: script | attr | ejs | ejs-out | code | schema | json */
  jsRange(parent, start, end, o = {}) {
    const src = this.src;
    const toks = o.tokens || lexJs(src, start, end);
    const sig = significant(toks);
    const outerEsc = o.esc || identity;
    const mode = o.mode || 'script';
    const braceStack = []; // 'obj' | 'class' | false (khối lệnh)
    for (let i = 0; i < sig.length; i++) {
      const t = sig[i];
      const prev = sig[i - 1];
      if (t.type === 'punct') {
        if (t.value === '{' || t.value === '${') {
          let kind = false;
          if (mode === 'json') kind = 'obj';
          else if (!prev) kind = false;
          else if (isClassHead(sig, i)) kind = 'class';
          else if (prev.type === 'punct') kind = OBJECT_PREV.has(prev.value) && prev.value !== ')' ? 'obj' : false;
          else if (prev.type === 'ident') kind = OBJECT_PREV.has(prev.value) ? 'obj' : false;
          if (prev && prev.type === 'punct' && prev.value === '=>') kind = false;
          braceStack.push(kind);
        } else if (t.value === '}') braceStack.pop();
        continue;
      }
      if (t.type === 'ident') {
        this.jsIdent(parent, sig, i, braceStack, outerEsc, mode);
        continue;
      }
      if (t.type === 'str') { this.jsString(parent, sig, i, braceStack, outerEsc, mode); continue; }
      if (t.type === 'tmpl') { this.jsTemplate(parent, t, outerEsc, mode, sig, i); continue; }
      if (t.type === 'regex' && hasCJK(src.slice(t.start, t.end))) {
        if (this.regexLiteral(parent, t.start, t.end, outerEsc)) {
          this.warn('Có biểu thức regex chứa tiếng Trung trong mã (không tự dịch được): ' + src.slice(t.start, Math.min(t.end, t.start + 60)));
        }
      }
    }
    if (this.opts.comments) {
      for (const t of toks) if (t.type === 'comment' && hasCJK(src.slice(t.start, t.end))) {
        const block = src[t.start + 1] === '*';
        const a = t.start + 2;
        const b = block ? (src.startsWith('*/', t.end - 2) && t.end - 2 >= a ? t.end - 2 : t.end) : t.end;
        this.textRun(parent, a, Math.max(a, b), { esc: compose(block ? blockCommentEsc : lineCommentEsc, outerEsc), kind: 'comment', chunk: block ? undefined : false });
      }
    }
  }

  /** Regex literal trong mã: ánh xạ các cụm chữ Hán là mục từ điển (nhãn/biến). Trả về true nếu còn chữ Hán không ánh xạ được */
  regexLiteral(parent, start, end, outerEsc) {
    const src = this.src;
    const close = src.lastIndexOf('/', end - 1);
    if (close <= start) return true;
    const runRe = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]');
    let left = false, inClass = false;
    for (let i = start + 1; i < close;) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (inClass) { if (c === ']') inClass = false; else if (runRe.test(c)) left = true; i++; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (runRe.test(c)) {
        let j = i;
        while (j < close && runRe.test(src[j])) j++;
        const word = src.slice(i, j);
        const k = this.dict.kindOf(word);
        if (k === 'marker' || k === 'key' || k === 'value') {
          const hole = this.dictHole(word, k);
          parent.reps.push({ start: i, end: j, render: (env) => outerEsc(escapeRegex(renderHole(hole, env))) });
        } else left = true;
        i = j; continue;
      }
      i++;
    }
    return left;
  }

  jsIdent(parent, sig, i, braceStack, outerEsc, mode) {
    const t = sig[i];
    if (!hasCJK(t.value)) return;
    const k = this.dict.kindOf(t.value);
    if (k !== 'key' && k !== 'value' && k !== 'term') return;
    const prev = sig[i - 1], next = sig[i + 1];
    const name = t.value;
    const quoteFor = (dst) => (dst.includes("'") ? JSON.stringify(dst) : "'" + dst.replace(/\\/g, '\\\\') + "'");
    const asKey = (env) => { const dst = lookupDict(env, name); return isIdentifier(dst) ? dst : outerEsc(quoteFor(dst)); };
    // truy cập thành viên: a.名 / a?.名
    if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.')) {
      const dot = prev.value;
      parent.reps.push({
        start: prev.start, end: t.end, render: (env) => {
          const dst = lookupDict(env, name);
          if (isIdentifier(dst)) return dot + dst;
          return (dot === '?.' ? '?.' : '') + '[' + outerEsc(quoteFor(dst)) + ']';
        },
      });
      return;
    }
    const top = braceStack.length ? braceStack[braceStack.length - 1] : false;
    const nv = next && next.type === 'punct' ? next.value : null;
    // get 名() {} / set 名(v) {} / async 名() {} / static 名 / *名() trong object hoặc class
    const modifier = prev && ((prev.type === 'ident' && /^(get|set|async|static)$/.test(prev.value)) || (prev.type === 'punct' && prev.value === '*'));
    if ((top === 'obj' || top === 'class') && modifier && (nv === '(' || (top === 'class' && (nv === '=' || nv === ';')))) {
      parent.reps.push({ start: t.start, end: t.end, render: asKey });
      return;
    }
    // thành viên class: 名() {} / 名 = 1;
    if (top === 'class' && (!prev || (prev.type === 'punct' && ['{', '}', ';'].includes(prev.value))) && (nv === '(' || nv === '=' || nv === ';' || nv === '}')) {
      parent.reps.push({ start: t.start, end: t.end, render: asKey });
      return;
    }
    if (top === 'obj' && prev && prev.type === 'punct' && (prev.value === '{' || prev.value === ',')) {
      if (nv === ':' || nv === '(') {
        parent.reps.push({ start: t.start, end: t.end, render: asKey });
        return;
      }
      if (nv === ',' || nv === '}' || nv === '=') {
        parent.reps.push({ start: t.start, end: t.end, render: (env) => { const dst = lookupDict(env, name); if (dst === name) return name; return (isIdentifier(dst) ? dst : outerEsc(quoteFor(dst))) + ': ' + name; } });
        return;
      }
    }
    void mode;
  }

  /** Chính sách dịch chuỗi trong mã theo ngữ cảnh: 'smart' | 'all' | 'none' */
  stringPolicy(mode, sig, i) {
    if (mode === 'ejs-out') return this.opts.ejsStrings || this.opts.codeStrings !== 'none' ? 'smart' : 'none';
    if (mode === 'ejs') {
      if (this.opts.ejsStrings) return 'smart';
      // <% print('…') %> in ra văn bản -> dịch
      return enclosingCall(sig, i) === 'print' ? 'smart' : 'none';
    }
    return this.opts.codeStrings;
  }

  jsString(parent, sig, i, braceStack, outerEsc, mode) {
    const t = sig[i];
    const src = this.src;
    const content = src.slice(t.cStart, t.cEnd);
    if (!hasCJK(content)) return;
    const prev = sig[i - 1], next = sig[i + 1];
    const esc = compose(jsEsc(t.quote), outerEsc);
    const jsonMode = mode === 'json';
    const escFor = jsonMode ? compose(jsonEsc, outerEsc) : esc;
    // chuỗi không có escape -> so khớp nguyên văn (từ điển / tên mục / chuỗi ghép "A、B" / đường dẫn)
    const plain = !content.includes('\\');
    if (plain) {
      const rep = this.exactRep(t.cStart, t.cEnd, content, escFor);
      if (rep) { parent.reps.push(rep); return; }
      if (this.pathInfo(content)) { const hole = this.pathHole(content); parent.reps.push({ start: t.cStart, end: t.cEnd, render: (env) => escFor(renderHole(hole, env)) }); return; }
    }
    // .describe('...') trong schema -> mô tả cho AI, dịch
    const isDescribe = prev && prev.type === 'punct' && prev.value === '(' && sig[i - 2]?.type === 'ident' && /^(describe|meta|message|error|description)$/.test(sig[i - 2].value);
    if (mode === 'schema' && !isDescribe) {
      // chuỗi trong schema không có trong từ điển: chỉ dịch nếu là câu dài
      if (content.length < 16 && !/[，。！？；,.!?]/.test(content)) return;
    }
    if (mode === 'json') {
      if (next && next.type === 'punct' && next.value === ':') return; // khóa JSON không có trong từ điển
      this.textRun(parent, t.cStart, t.cEnd, { esc: escFor, kind: 'prose', jsEscapes: true });
      return;
    }
    const policy = this.stringPolicy(mode, sig, i);
    // chuỗi giữ nguyên: vẫn đồng bộ nhãn 【…】, khóa trong nháy lồng, đường dẫn biến… (có escape đúng kiểu chuỗi)
    if ((policy === 'none' || (policy === 'smart' && this.keepJsString(sig, i, braceStack))) && !isDescribe) {
      this.flushHoles(parent, this.findProtections(t.cStart, t.cEnd, { jsEscapes: true }, []), escFor);
      return;
    }
    // chuỗi có HTML bên trong
    if (/<[a-zA-Z\/!]/.test(content)) { this.htmlRange(parent, t.cStart, t.cEnd, { esc, jsEscapes: true }); return; }
    this.textRun(parent, t.cStart, t.cEnd, { esc, kind: isDescribe ? 'desc' : 'ui', jsEscapes: true });
  }

  /** Quy tắc "thông minh": chuỗi dùng như khóa / so sánh / tham số API thì giữ nguyên */
  keepJsString(sig, i, braceStack) {
    const prev = sig[i - 1], next = sig[i + 1];
    const pv = prev?.type === 'punct' ? prev.value : prev?.type === 'ident' ? prev.value : null;
    const nv = next?.type === 'punct' ? next.value : next?.type === 'ident' ? next.value : null;
    // khóa object 'abc': ...
    const inObj = braceStack.length && braceStack[braceStack.length - 1];
    if (inObj && (pv === '{' || pv === ',') && nv === ':') return true;
    // so sánh
    if (['===', '!==', '==', '!='].includes(pv) || ['===', '!==', '==', '!='].includes(nv) || pv === 'case' || nv === 'in') return true;
    // truy cập obj['abc']
    if (pv === '[' && sig[i - 2] && (sig[i - 2].type === 'ident' || (sig[i - 2].type === 'punct' && [')', ']'].includes(sig[i - 2].value))) && nv === ']') return true;
    // tham số của hàm API (đối số đầu)
    if (pv === '(' && sig[i - 2]?.type === 'ident' && (KEEP_ARG_FUNCS.has(sig[i - 2].value) || PATH_FUNCS.has(sig[i - 2].value))) return true;
    // chuỗi nằm trong lời gọi hàm API, kể cả khi được nối: getwi(null, sách + ' / 第' + n + '章'), querySelector('#a' + id)
    const call = enclosingCall(sig, i);
    if (call && (KEEP_ARG_FUNCS.has(call) || (PATH_FUNCS.has(call) && call.length > 3))) return true;
    // import 'xxx'
    if (pv === 'import' || pv === 'from') return true;
    // includes / startsWith / indexOf / match / split / replace(第一参数)
    if (pv === '(' && sig[i - 2]?.type === 'ident' && /^(includes|startsWith|endsWith|indexOf|lastIndexOf|split|search|match|matchAll|replace|replaceAll|test|has|get|delete)$/.test(sig[i - 2].value)) return true;
    return false;
  }

  jsTemplate(parent, t, outerEsc, mode, sig, ti) {
    const src = this.src;
    const exprHoles = [];
    let anyCJK = false;
    for (const p of t.parts) {
      if (p.type === 'expr') {
        const node = new Node(p.start - 2, p.end + 1);
        this.jsRange(node, p.start, p.end, { tokens: p.tokens, mode, esc: outerEsc });
        exprHoles.push({ start: p.start - 2, end: p.end + 1, hole: this.nodeHole(node), node });
      } else if (hasCJK(src.slice(p.start, p.end))) anyCJK = true;
    }
    const cStart = t.start + 1, cEnd = t.unterminated ? t.end : t.end - 1;
    if (!anyCJK) {
      for (const h of exprHoles) parent.reps.push(...h.node.reps);
      return;
    }
    const esc = compose(jsEsc('`'), outerEsc);
    // đường dẫn: `stat_data.${a}.好感度`
    const masked = maskRanges(src.slice(cStart, cEnd), exprHoles.map((h) => ({ start: h.start - cStart, end: h.end - cStart })));
    if (!/[<>]/.test(masked) && /^[^\s]*$/.test(masked) && masked.includes('.')) {
      // thử coi là đường dẫn: ánh xạ các đoạn tĩnh
      const statics = t.parts.filter((p) => p.type === 'str');
      let isPath = true;
      for (const p of statics) {
        for (const seg of src.slice(p.start, p.end).split('.')) {
          if (seg === '' || !hasCJK(seg)) continue;
          if (this.isPathSeg(seg) !== 'key') { isPath = false; break; }
        }
      }
      if (isPath) {
        for (const p of statics) {
          const txt = src.slice(p.start, p.end);
          if (!hasCJK(txt)) continue;
          const hole = { type: 'path', src: txt, esc: true };
          parent.reps.push({ start: p.start, end: p.end, render: (env) => esc(renderHole(hole, env)) });
        }
        for (const h of exprHoles) parent.reps.push(...h.node.reps);
        return;
      }
    }
    const policy = mode === 'schema' ? 'smart' : this.stringPolicy(mode, sig || [], ti ?? -1);
    if (policy === 'none') {
      for (const h of exprHoles) parent.reps.push(...h.node.reps);
      // phần tĩnh vẫn đồng bộ nhãn/khóa/đường dẫn
      for (const p of t.parts) if (p.type === 'str' && hasCJK(src.slice(p.start, p.end))) this.flushHoles(parent, this.findProtections(p.start, p.end, { jsEscapes: true }, []), esc);
      return;
    }
    if (/<[a-zA-Z\/!]/.test(masked)) {
      this.htmlRange(parent, cStart, cEnd, { esc, jsEscapes: true, masks: exprHoles.map((h) => ({ start: h.start, end: h.end, hole: h.hole })) });
    } else {
      this.textRun(parent, cStart, cEnd, { holes: exprHoles.map((h) => ({ start: h.start, end: h.end, hole: h.hole })), esc, kind: 'ui', jsEscapes: true });
    }
  }

  // ====================================================================== văn xuôi
  proseRange(parent, start, end, o = {}) {
    // tách khối mã ```...```
    const src = this.src;
    const text = src.slice(start, end);
    const fenceRe = /(^|\n)([ \t]*)(```+|~~~+)([^\n`]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;
    let m, pos = start;
    const pieces = [];
    while ((m = fenceRe.exec(text))) {
      const fStart = start + m.index + m[1].length;
      const contentStart = fStart + m[2].length + m[3].length + m[4].length + 1;
      const contentEnd = contentStart + m[5].length;
      pieces.push({ type: 'text', start: pos, end: fStart });
      pieces.push({ type: 'fence', lang: m[4].trim().toLowerCase(), start: contentStart, end: contentEnd });
      pos = start + m.index + m[0].length;
    }
    pieces.push({ type: 'text', start: pos, end });
    for (const p of pieces) {
      if (p.end <= p.start) continue;
      if (p.type === 'fence') {
        const body = src.slice(p.start, p.end);
        if (/^(html|xml|htm|svg|vue)$/.test(p.lang) || (!p.lang && looksLikeHtml(body))) this.htmlRange(parent, p.start, p.end, { regexRefs: o.regexRefs });
        else if (/^(js|javascript|ts|typescript|mjs)$/.test(p.lang)) this.jsRange(parent, p.start, p.end, { mode: 'code' });
        else if (/^(css)$/.test(p.lang)) this.cssRange(parent, p.start, p.end);
        else if (looksLikeHtml(body)) this.htmlRange(parent, p.start, p.end, { regexRefs: o.regexRefs });
        else this.plainProse(parent, p.start, p.end, o);
      } else {
        const body = src.slice(p.start, p.end);
        if (looksLikeHtml(body)) this.htmlRange(parent, p.start, p.end, { regexRefs: o.regexRefs });
        else this.plainProse(parent, p.start, p.end, o);
      }
    }
  }

  /** Văn xuôi thuần: tách theo khối EJS đứng riêng dòng, phần còn lại là segment */
  plainProse(parent, start, end, o = {}) {
    const src = this.src;
    const text = src.slice(start, end);
    // khối EJS nhiều dòng / đứng riêng dòng -> tách đoạn
    const blocks = [];
    const re = /<%[\s\S]*?%>/g;
    let m;
    while ((m = re.exec(text))) {
      const a = start + m.index, b = a + m[0].length;
      const lineStart = src.lastIndexOf('\n', a - 1) + 1;
      const before = src.slice(Math.max(lineStart, start), a);
      let lineEnd = src.indexOf('\n', b); if (lineEnd < 0 || lineEnd > end) lineEnd = end;
      const after = src.slice(b, lineEnd);
      if (!before.trim() && !after.trim()) blocks.push({ start: a, end: b });
    }
    let pos = start;
    for (const blk of blocks) {
      if (blk.start > pos) this.textRun(parent, pos, blk.start, { kind: 'prose', regexRefs: o.regexRefs, yamlKeys: true });
      const node = this.ejsNode(blk.start, blk.end);
      parent.reps.push({ start: blk.start, end: blk.end, render: (env) => renderNode(src, node, env) });
      pos = blk.end;
    }
    if (end > pos) this.textRun(parent, pos, end, { kind: 'prose', regexRefs: o.regexRefs, yamlKeys: true });
  }

  // ====================================================================== InitVar (YAML / JSON)
  initVarRange(parent, start, end) {
    const src = this.src;
    const text = src.slice(start, end);
    const trimmed = text.trim();
    if (/^[{[]/.test(trimmed)) { this.jsRange(parent, start, end, { mode: 'json' }); return; }
    // YAML theo dòng
    let pos = start;
    let blockIndent = -1; // đang trong block scalar |, >
    const lines = text.split(/(?<=\n)/);
    for (const lineRaw of lines) {
      const lineStart = pos;
      pos += lineRaw.length;
      const line = lineRaw.replace(/\r?\n$/, '');
      const lineEnd = lineStart + line.length;
      const indent = line.match(/^[ \t]*/)[0].length;
      if (blockIndent >= 0) {
        if (!line.trim() || indent > blockIndent) {
          if (hasCJK(line)) { const pad = ' '.repeat(Math.max(indent, blockIndent + 1)); this.textRun(parent, lineStart + indent, lineEnd, { kind: 'prose', chunk: false, esc: (x) => x.replace(/\r?\n/g, '\n' + pad) }); }
          continue;
        }
        blockIndent = -1;
      }
      if (!line.trim()) continue;
      if (/^\s*#/.test(line)) {
        if (hasCJK(line)) { const c = line.indexOf('#'); this.textRun(parent, lineStart + c + 1, lineEnd, { kind: 'prose', chunk: false, esc: oneLine }); }
        continue;
      }
      let p = indent;
      while (line.slice(p).match(/^-[ \t]+/)) p += line.slice(p).match(/^-[ \t]+/)[0].length;
      const rest = line.slice(p);
      // khóa
      let keyM = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[][^:#]*?|[^\s#'"{[])\s*:(?=\s|$)/);
      let valStart = p;
      if (keyM) {
        const rawKey = keyM[1];
        const ks = lineStart + p;
        if (hasCJK(rawKey)) {
          const q = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey[0] : '';
          const inner = q ? rawKey.slice(1, -1) : rawKey.trim();
          const kind = this.dict.kindOf(inner) || 'key';
          const hole = this.dictHole(inner, kind);
          const a = ks + (q ? 1 : 0), b = a + inner.length;
          parent.reps.push({ start: a, end: b, render: (env) => { const v = renderHole(hole, env); return q ? yamlEsc(q)(v) : yamlPlainKey(v); } });
        }
        valStart = p + keyM[0].length;
      }
      // giá trị
      let vs = valStart;
      while (vs < line.length && /[ \t]/.test(line[vs])) vs++;
      if (vs >= line.length) continue;
      let ve = line.length;
      // bỏ chú thích cuối dòng
      const hashIdx = findYamlComment(line, vs);
      if (hashIdx >= 0) {
        if (hasCJK(line.slice(hashIdx))) this.textRun(parent, lineStart + hashIdx + 1, lineEnd, { kind: 'prose', chunk: false, esc: oneLine });
        ve = hashIdx;
      }
      while (ve > vs && /[ \t]/.test(line[ve - 1])) ve--;
      const val = line.slice(vs, ve);
      if (/^[|>][-+0-9]*$/.test(val)) { blockIndent = indent; continue; }
      if (!hasCJK(val)) continue;
      const a = lineStart + vs, b = lineStart + ve;
      if (val[0] === '{' || val[0] === '[') { this.jsRange(parent, a, b, { mode: 'json' }); this.yamlFlowBare(parent, a, b); continue; }
      if ((val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
        const q = val[0];
        const inner = val.slice(1, -1);
        this.yamlScalar(parent, a + 1, b - 1, inner, yamlEsc(q), q === '"');
        continue;
      }
      this.yamlScalar(parent, a, b, val, yamlPlainEsc, false);
    }
  }

  yamlScalar(parent, a, b, val, esc, dq) {
    const rep = this.exactRep(a, b, val, esc);
    if (rep) { parent.reps.push(rep); return; }
    if (this.pathInfo(val)) { const hole = this.pathHole(val); parent.reps.push({ start: a, end: b, render: (env) => esc(renderHole(hole, env)) }); return; }
    this.textRun(parent, a, b, { esc, kind: 'prose', chunk: false, yamlEscapes: dq, exact: false });
  }

  /** từ trần trong flow YAML [红, 蓝] (lexer JS coi là ident) */
  yamlFlowBare(parent, a, b) {
    const toks = significant(lexJs(this.src, a, b));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'ident' || !hasCJK(t.value)) continue;
      // gom các ident liền nhau (có khoảng trắng) đến dấu , ] }
      let j = i;
      while (j + 1 < toks.length && toks[j + 1].type !== 'punct') j++;
      const s0 = t.start, e0 = toks[j].end;
      const text = this.src.slice(s0, e0);
      const nextTok = toks[j + 1];
      const isKey = nextTok && nextTok.value === ':';
      const k = this.exactKind(text) || (isKey ? 'key' : null);
      if (k) { const hole = this.dictHole(text, k); parent.reps.push({ start: s0, end: e0, render: (env) => yamlPlainEsc(renderHole(hole, env)) }); }
      else this.textRun(parent, s0, e0, { esc: yamlPlainEsc, kind: 'prose', chunk: false, exact: false });
      i = j;
    }
  }

  // ====================================================================== regex find
  regexFind(parent, start, end) {
    const src = this.src;
    let inClass = false;
    let i = start;
    const runRe = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]');
    while (i < end) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if ((n === 'u' || n === 'p' || n === 'P') && src[i + 2] === '{') { const close = src.indexOf('}', i); i = close > 0 ? close + 1 : i + 2; }
        else if (n === 'u') i += 6;
        else if (n === 'x') i += 4;
        else i += 2;
        continue;
      }
      if (inClass) { if (c === ']') inClass = false; i++; continue; }
      if (c === '[') { inClass = true; i++; continue; }
      if (runRe.test(c)) {
        let j = i;
        while (j < end && runRe.test(src[j])) j++;
        const word = src.slice(i, j);
        const k = this.dict.kindOf(word);
        // nhãn, hoặc tên biến/giá trị xuất hiện trong regex (vd 好感度:(\d+)) -> cùng bản dịch với nơi khác
        if (k === 'marker' || k === 'key' || k === 'value') {
          const hole = this.dictHole(word, k);
          parent.reps.push({ start: i, end: j, render: (env) => escapeRegex(renderHole(hole, env)) });
        }
        i = j; continue;
      }
      i++;
    }
  }

  regexTrim(parent, start, end) {
    const src = this.src;
    const runRe = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]+', 'g');
    const text = src.slice(start, end);
    let m;
    while ((m = runRe.exec(text))) {
      if (this.dict.kindOf(m[0]) === 'marker') {
        const hole = this.dictHole(m[0], 'marker');
        parent.reps.push({ start: start + m.index, end: start + m.index + m[0].length, render: (env) => renderHole(hole, env) });
      }
    }
  }

  // ====================================================================== tên / tiêu đề mục
  commentRange(parent, start, end) {
    const src = this.src;
    // giữ tiền tố [mvu_update] [InitVar] [EJS] @@xxx
    const text = src.slice(start, end);
    const pre = text.match(/^(?:\s*(?:\[[^\]㐀-鿿]*\]|@@?\S+|<[^>㐀-鿿]*>|\{\{[^}]*\}\}))+\s*/);
    const s = start + (pre ? pre[0].length : 0);
    // tên mục trùng một mục từ điển (vd mục "学校" và giá trị địa điểm "学校", mục "高松灯" và khóa "高松灯")
    // -> dùng đúng bản dịch từ điển để getwi(null, địa_điểm) / getwi(null, '高松灯') vẫn tìm thấy mục
    let e = end;
    while (e > s && /\s/.test(src[e - 1])) e--;
    const name = src.slice(s, e);
    const k = this.dict.kindOf(name);
    if (k) { parent.reps.push(this.dictRep(s, e, name, k, identity)); return; }
    this.textRun(parent, s, end, { kind: 'name', chunk: false, exact: false, esc: oneLine });
  }
}

/** Dấu { tại sig[i] mở thân class: class X {, class X extends Y {, (class {) */
function isClassHead(sig, i) {
  for (let j = i - 1; j >= Math.max(0, i - 16); j--) {
    const s = sig[j];
    if (s.type === 'punct' && (s.value === '{' || s.value === '}' || s.value === ';')) return false;
    if (s.type === 'ident' && s.value === 'class') {
      const p = sig[j - 1];
      return !(p && p.type === 'punct' && (p.value === '.' || p.value === '?.'));
    }
  }
  return false;
}

/** Tên hàm của lời gọi gần nhất bao quanh token sig[i] (vd print('…' + x) -> 'print') */
function enclosingCall(sig, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0 && j >= i - 200; j--) {
    const s = sig[j];
    if (s.type !== 'punct') continue;
    if (s.value === ')' || s.value === ']') depth++;
    else if (s.value === '(' || s.value === '[') {
      if (depth === 0) return s.value === '(' && sig[j - 1]?.type === 'ident' ? sig[j - 1].value : null;
      depth--;
    } else if (depth === 0 && (s.value === ';' || s.value === '{' || s.value === '}')) return null;
  }
  return null;
}

/** Nội dung <style>/<script> thực ra là văn xuôi: có dấu câu CJK nằm ngoài chuỗi/chú thích (mã hợp lệ không thể có) */
function rawIsProse(src, a, b, tag) {
  if (b <= a || !hasCJK(src.slice(a, b))) return false;
  const PUNCT = /[，。！？；：、]/;
  if (tag === 'script') return lexJs(src, a, b).some((t) => t.type === 'punct' && PUNCT.test(t.value));
  return lexCss(src, a, b).some((t) => t.type === 'other' && PUNCT.test(src.slice(t.start, t.end)));
}

/** Giá trị thuộc tính data-* trông như câu chữ hiển thị/prompt (không phải mã định danh) */
function looksLikeProseAttr(t) {
  if (!hasCJK(t)) return false;
  if (/^(?:https?:|\/\/|data:|#|\.\/|\/[\w-])/i.test(t)) return false;
  if (/^[\w$.]+\s*\(/.test(t)) return false; // gọi hàm
  return /[\s，。！？；：、…,.!?;:()（）【】「」『』]/.test(t) || t.length > 12;
}

function shiftTok(t, base) {
  if (!base) return t;
  const n = { ...t, start: t.start + base, end: t.end + base };
  if (t.attrs) n.attrs = t.attrs.map((a) => ({ ...a, nStart: a.nStart + base, nEnd: a.nEnd + base, vStart: a.vStart < 0 ? -1 : a.vStart + base, vEnd: a.vEnd < 0 ? -1 : a.vEnd + base }));
  return n;
}

function maskRanges(text, ranges) {
  let out = text;
  for (const r of ranges) out = out.slice(0, r.start) + '\u0001'.repeat(Math.max(0, r.end - r.start)) + out.slice(r.end);
  return out;
}

/** Gộp các hole tĩnh (thẻ/mã) liền nhau thành 1 placeholder để AI dễ đọc: ⟦1⟧⟦2⟧⟦3⟧ -> ⟦1⟧ */
function mergeAdjacent(src, hs) {
  const out = [];
  const isStatic = (h) => h.hole.type === 'raw' || h.hole.type === 'node' || h.hole.type === 'multi';
  for (const h of hs) {
    const last = out[out.length - 1];
    if (last && isStatic(last) && isStatic(h) && /^\s*$/.test(src.slice(last.end, h.start))) {
      const parts = last.hole.type === 'multi' ? last.hole.parts.slice() : [{ hole: last.hole }];
      const gap = src.slice(last.end, h.start);
      if (gap) parts.push({ text: gap });
      parts.push({ hole: h.hole });
      out[out.length - 1] = { start: last.start, end: h.end, hole: { type: 'multi', parts, esc: false } };
      continue;
    }
    out.push(h);
  }
  return out;
}

function mergeHoles(a, b) {
  const all = [...a, ...b].sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
  const out = [];
  let lastEnd = -1;
  for (const h of all) {
    if (h.start < lastEnd) continue;
    out.push(h);
    lastEnd = h.end;
  }
  return out;
}

function findYamlComment(line, from) {
  let q = null;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== '\\') q = null; continue; }
    if ((c === '"' || c === "'") && i === from) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

function yamlPlainKey(v) {
  return /[:#{}[\],&*!|>'"%@`]|^\s|\s$|^-|^\?/.test(v) ? JSON.stringify(v) : v;
}

/** Chia [s,e) thành các khúc <= limit tại ranh giới dòng, không cắt giữa hole */
function splitRange(src, s, e, holes, limit) {
  const inHole = (p) => holes.some((h) => p > h.start && p < h.end);
  const pieces = [];
  let a = s;
  while (e - a > limit) {
    let cut = -1;
    // ưu tiên dòng trống, rồi xuống dòng, rồi dấu câu
    for (const re of [/\n\s*\n/g, /\n/g, /[。！？!?；;]/g]) {
      const seg = src.slice(a, a + limit);
      let m, best = -1;
      re.lastIndex = 0;
      while ((m = re.exec(seg))) { const p = a + m.index + m[0].length; if (p - a > limit * 0.3 && !inHole(p)) best = p; }
      if (best > a) { cut = best; break; }
    }
    if (cut < 0) cut = a + limit;
    while (inHole(cut) && cut < e) cut++;
    pieces.push([a, cut]);
    a = cut;
  }
  pieces.push([a, e]);
  return pieces;
}

function buildMarkerRe(markers) {
  const list = (markers || []).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const alt = list.map(escapeRegex).join('|');
  return new RegExp('([【\\[<「『〖〔（(])(\\/?)(' + alt + ')(?=[】\\]>」』〗〕）)])', 'g');
}

// ====================================================================== render
function lookupDict(env, src) {
  const v = env.dict?.lookup ? env.dict.lookup(src) : undefined;
  return v == null || v === '' ? src : v;
}

export function renderHole(h, env) {
  switch (h.type) {
    case 'raw': return h.text;
    case 'node': return renderNode(env.src, h.node, env);
    case 'dict': return lookupDict(env, h.src);
    case 'entry': return env.entryName ? env.entryName(h.src) ?? h.src : h.src;
    case 'book': return env.bookName ? env.bookName(h.src) ?? h.src : h.src;
    case 'path': return renderPath(h.src, env);
    case 'macro': return renderMacro(h.src, env);
    case 'multi': return h.parts.map((p) => (p.hole ? renderHole(p.hole, env) : p.text)).join('');
    case 'composite': return h.parts.map((p) => (hasCJK(p.text) ? lookupDict(env, p.text) : p.text) + p.sep).join('');
    default: return '';
  }
}

export function renderPath(text, env) {
  // giữ nguyên dấu phân cách, chỉ thay các đoạn có trong từ điển; ${a|b|c} (khóa thay thế trong quy tắc MVU) -> thay từng khóa
  return text.replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, (m, q, k) => `[${q}${lookupDict(env, k)}${q}]`)
    .replace(/[^.\/\[\]'"]+/g, (seg) => {
      if (!hasCJK(seg)) return seg;
      const ph = /^\$\{([^{}]*)\}$/.exec(seg);
      if (ph) return '${' + ph[1].split('|').map((x) => { const t = x.trim(); return hasCJK(t) ? x.replace(t, lookupDict(env, t)) : x; }).join('|') + '}';
      return lookupDict(env, seg);
    });
}

function renderMacro(text, env) {
  const m = MACRO_PATH_RE.exec(text);
  if (!m) return text;
  const head = m[0];
  const body = text.slice(head.length, -2);
  const parts = body.split('::');
  parts[0] = renderPath(parts[0], env);
  return head + parts.join('::') + '}}';
}

export function renderSegment(seg, env) {
  let t = env.tm ? env.tm.get(seg.key) : undefined;
  if (t == null) t = seg.key;
  let out = '', last = 0, m;
  const re = new RegExp(PH_RE.source, 'g');
  const used = new Set();
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    const h = seg.holes[n - 1];
    out += seg.esc(t.slice(last, m.index));
    if (h) {
      const v = renderHole(h, env);
      out += h.esc ? seg.esc(v) : v;
      used.add(n);
    }
    last = m.index + m[0].length;
  }
  out += seg.esc(t.slice(last));
  // hole bị AI làm mất -> nối vào cuối để không mất mã
  if (used.size < seg.holes.length) {
    seg.holes.forEach((h, idx) => {
      if (!used.has(idx + 1) && (h.type === 'raw' || h.type === 'node' || h.type === 'multi')) {
        const v = renderHole(h, env);
        if (v.trim()) out += v;
      }
    });
  }
  return out;
}

// ====================================================================== API chính
/**
 * Phân tích một item của card.
 * Trả về { segments, warnings, render(env) }
 */
export function analyzeItem(item, ctx) {
  const kind = item.kind;
  if (kind === 'keys' || kind === 'list') return analyzeList(item, ctx);
  if (kind === 'trimList') return analyzeTrimList(item, ctx);
  const src = String(item.text ?? '');
  const an = new Analyzer(src, ctx);
  const root = new Node(0, src.length);
  const isReplace = !!item.meta?.isReplace;
  switch (kind) {
    case 'name': an.textRun(root, 0, src.length, { kind: 'name', chunk: false, exact: false, esc: src.includes('\n') ? identity : oneLine }); break;
    case 'comment': an.commentRange(root, 0, src.length); break;
    case 'regexFind': an.regexFind(root, 0, src.length); break;
    case 'regexTrim': an.regexTrim(root, 0, src.length); break;
    case 'initvar': an.initVarRange(root, 0, src.length); break;
    case 'schema': an.jsRange(root, 0, src.length, { mode: 'schema' }); break;
    case 'code': an.jsRange(root, 0, src.length, { mode: 'code' }); break;
    case 'json': an.jsRange(root, 0, src.length, { mode: 'json' }); break;
    // tên nút script Tavern Helper: chỉ đổi theo từ điển (cùng bản dịch với getButtonEvent('…') trong mã)
    case 'button': { const rep = an.exactRep(0, src.length, src, identity); if (rep) root.reps.push(rep); break; }
    default: an.proseRange(root, 0, src.length, { regexRefs: isReplace }); break;
  }
  return {
    segments: an.segments,
    warnings: an.warnings,
    render(env) { return renderNode(src, root, { ...env, src }); },
  };
}

/** trimStrings của regex: chỉ đồng bộ nhãn theo từ điển */
function analyzeTrimList(item, ctx) {
  const arr = Array.isArray(item.text) ? item.text : [];
  const parts = arr.map((s) => {
    const str = String(s ?? '');
    return { str, a: hasCJK(str) ? analyzeItem({ kind: 'regexTrim', text: str }, ctx) : null };
  });
  return {
    segments: [],
    warnings: [],
    render(env) { return parts.map((p) => (p.a ? p.a.render(env) : p.str)); },
  };
}

/**
 * Tìm tên mục lorebook bị EJS / script ghép động, vd getwi(null, bookName + ' / 第' + n + '章')
 * hoặc e.comment.includes('事件') — các mục này phải GIỮ NGUYÊN tên, nếu không mã sẽ không tìm thấy.
 * (Tên mục được gọi nguyên văn như getwi(null, '▶️开局流程') thì vẫn dịch được: lời gọi được đổi theo.)
 * Trả về { pinned: Set<tên mục>, dynamic: [biểu thức tên lấy hoàn toàn từ biến] }
 */
export function findDynamicEntryRefs(texts, entryNames) {
  const pinned = new Set();
  const dynamic = [];
  const names = [...entryNames].filter(Boolean);
  if (!names.length) return { pinned, dynamic };
  const callRe = /\b(?:getwi|getWI|getWorldInfo|activewi|activateWorldInfo|activateWI|getEntry|getLorebookEntry)\s*\(/g;
  const cmpRe = /\.comment\s*\??\.?\s*(?:includes|startsWith|endsWith|indexOf|search|match)\s*\(\s*(['"`])([^'"`\n]+)\1/g;
  for (const text of texts) {
    if (typeof text !== 'string' || !/getwi|getWorldInfo|activewi|activateWorldInfo|activateWI|getEntry|getLorebookEntry|\.comment/i.test(text)) continue;
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(text))) {
      const args = splitCallArgs(text, m.index + m[0].length);
      if (!args || !args.length) continue;
      const title = (args.length >= 2 ? args[1] : args[0]).trim();
      if (!title) continue;
      if (/^(['"])(?:(?!\1)[^\\]|\\.)*\1$/.test(title) || (/^`[^`]*`$/.test(title) && !title.includes('${'))) continue; // tên cố định
      const frags = stringFragments(title).filter(hasCJK);
      if (!frags.length) { if (/[A-Za-z_$]/.test(title) && !/^\d+$/.test(title)) dynamic.push(title.slice(0, 80)); continue; }
      for (const n of names) if (frags.every((f) => n.includes(f))) pinned.add(n);
    }
    cmpRe.lastIndex = 0;
    while ((m = cmpRe.exec(text))) {
      const f = m[2];
      if (!hasCJK(f)) continue;
      for (const n of names) if (n !== f && n.includes(f)) pinned.add(n);
    }
  }
  return { pinned, dynamic };
}

/** Tách các đối số cấp cao nhất của lời gọi hàm, bắt đầu ngay sau dấu '(' */
function splitCallArgs(text, pos) {
  const args = [];
  let depth = 0, q = null, cur = '';
  for (let i = pos; i < text.length && i < pos + 4000; i++) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += text[++i] ?? ''; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { if (c === ')') { args.push(cur); return args; } return null; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null;
}

/** Các mảnh chuỗi tĩnh trong một biểu thức JS ('…', "…", phần tĩnh của `…${}…`) */
function stringFragments(expr) {
  const out = [];
  for (const t of lexJs(expr)) {
    if (t.type === 'str') out.push(expr.slice(t.cStart, t.cEnd));
    else if (t.type === 'tmpl') for (const p of t.parts) if (p.type === 'str' && p.end > p.start) out.push(expr.slice(p.start, p.end));
  }
  return out.filter((s) => s.trim());
}

function analyzeList(item, ctx) {
  const arr = Array.isArray(item.text) ? item.text : [];
  const parts = arr.map((s) => {
    const str = String(s ?? '');
    if (/^\/.+\/[a-z]*$/i.test(str) || !hasCJK(str) || /^\[\s*init\s*var\s*\]$/i.test(str)) return { str, a: null };
    const k = ctx.dict?.kindOf ? ctx.dict.kindOf(str.trim()) : null;
    if (k) return { str, a: { segments: [], render: (env) => lookupDict(env, str.trim()) } };
    const a = analyzeItem({ kind: 'name', text: str }, ctx);
    return { str, a };
  });
  return {
    segments: parts.flatMap((p) => (p.a ? p.a.segments.map((s) => ({ ...s, kind: item.kind === 'keys' ? 'keyword' : 'name' })) : [])),
    warnings: [],
    render(env) {
      const mode = item.kind === 'keys' ? (env.keysMode || 'append') : 'replace';
      const out = [];
      for (const p of parts) {
        const tr = p.a ? p.a.render(env) : p.str;
        if (mode === 'keep') out.push(p.str);
        else if (mode === 'replace') out.push(tr);
        else { out.push(p.str); if (tr !== p.str) out.push(tr); }
      }
      return [...new Set(out.filter((x) => x !== ''))];
    },
  };
}
