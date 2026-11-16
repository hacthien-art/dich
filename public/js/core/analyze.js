// Bộ phân tích: tách nội dung card thành "đoạn cần dịch" (segment) + phần giữ nguyên/ánh xạ biến (hole).
// Nguyên tắc: chỉ thay thế đúng vị trí — mã HTML/JS/CSS ngoài phần chữ được giữ nguyên từng ký tự.
// Bản dịch lưu theo khóa = văn bản nguồn có placeholder ⟦n⟧ (bộ nhớ dịch / TM), nên đổi bảng biến
// không cần dịch lại: chỉ cần render lại.
import { lexJs, lexHtml, lexCss, significant, cssPropertyBefore, walkData } from './lexer.js';
import { hasCJK, isIdentifier, escapeRegex, HAN_CLASS, forEachDotChain } from './util.js';
import { splitCompositeKnown } from './dict.js';

export const PH_RE = /⟦\s*(\d+)\s*⟧/g;
export const ph = (n) => `⟦${n}⟧`;

// token của nội dung nhúng / link ngoài (xem embed.js): ⟪emb:id⟫ ⟪url:id⟫ — luôn giữ nguyên
const EMBED_TOKEN_RE = /⟪(?:emb|url):[0-9a-z]+⟫/g;

/** Chuỗi là URL / data URI — không bao giờ dịch (dịch là hỏng link) */
export function isUrlLike(s) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s]+$/i.test(s) || /^(?:data|blob|mailto|javascript):/i.test(s) || /^⟪url:[0-9a-z]+⟫/.test(s);
}

const SLUG_STOP = /[\s·、，。：；！？（）《》「」『』【】…—]/;
/**
 * Chuỗi là mã định danh / tham chiếu / tên tệp lẫn chữ Hán: "pref-nanjing-松江府", "yuan-zhongshu-大都路-0", "明史/卷6",
 * "research/明史-卷6.txt". Loại này được mã ghép, tra bảng, dựng link nên phải giữ NGUYÊN (không hiển thị cho người đọc).
 */
export function isSlugLike(s) {
  if (s.length > 200 || SLUG_STOP.test(s) || !hasCJK(s)) return false;
  return /^[A-Za-z0-9]+[-_/:.][^\s]+$/.test(s) || /^[^\s]+[-_/:.][A-Za-z0-9]+$/.test(s);
}

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'label', 'nobr']);
const TRANSLATE_ATTRS = new Set(['title', 'alt', 'placeholder', 'aria-label', 'aria-placeholder', 'aria-description', 'aria-roledescription', 'label', 'data-tooltip', 'data-title', 'data-placeholder', 'data-tip', 'tooltip']);
const HTML_HINT_RE = /<!doctype|<\/?(?:html|head|body|div|span|p|br|hr|style|script|table|tr|td|th|ul|ol|li|details|summary|button|img|section|article|header|footer|nav|main|h[1-6]|strong|em|b|i|u|small|font|center|label|input|select|option|textarea|canvas|svg|iframe|blockquote|pre|figure|audio|video|dl|dt|dd|sub|sup|mark|ruby|progress)\b[^>]*>/i;
const OBJECT_PREV = new Set(['(', ',', '=', ':', '[', '?', '??', '||', '&&', '!', '+', '-', '*', '/', '%', '...', '=>{', 'return', 'const', 'let', 'var', 'typeof', 'await', 'yield', 'case', 'in', 'of', '==', '===', '!=', '!==', '+=', '||=', '&&=', '??=', 'export', 'default', '<', '>', '<=', '>=']);
const KEEP_ARG_FUNCS = new Set(['getButtonEvent', 'eventOn', 'eventOnce', 'eventEmit', 'eventMakeFirst', 'eventMakeLast', 'eventRemoveListener', 'eventClearEvent', 'addEventListener', 'removeEventListener', 'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByName', 'getItem', 'setItem', 'removeItem', 'require', 'import', 'getwi', 'getWorldInfo', 'getEntry', 'getLorebookEntries', 'getChatLorebook', 'activewi', 'activateWorldInfo', 'getCharLorebooks', 'getLorebookSettings', 'getScriptButtons', 'registerMvuSchema', 'waitGlobalInitialized', 'attr', 'prop', 'hasClass', 'addClass', 'removeClass', 'toggleClass', 'closest', 'find', 'is', 'on', 'off', 'trigger', 'data', 'setAttribute', 'getAttribute', 'createElement', 'matches', 'fetch', 'postMessage', 'loadScript']);
const PATH_FUNCS = new Set(['getvar', 'setvar', 'incvar', 'decvar', 'addvar', 'delvar', 'getVariable', 'setVariable', 'get', 'set', 'has', 'unset', 'update', 'getMvuVariable', 'setMvuVariable', 'getLocalVar', 'setLocalVar', 'getGlobalVar', 'setGlobalVar', 'getMessageVar', 'setMessageVar', 'getChatVar', 'setChatVar', 'deleteVariable', 'insert', 'remove', 'add', 'assign', 'delete', 'move', 'patchVariables']);
const MACRO_PATH_RE = /^\{\{\s*(getvar|setvar|addvar|incvar|decvar|getglobalvar|setglobalvar|addglobalvar|incglobalvar|decglobalvar|get_message_variable|get_chat_variable|get_character_variable|get_preset_variable|get_global_variable|format_message_variable|format_chat_variable|format_character_variable|format_global_variable|format_preset_variable)\s*::\s*/i;
const YAML_PLAIN_BAD = /^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|^\s|\s$|^$/;
// thẻ giả tên tiếng Trung trong khóa đoạn dịch: "<正文", "</姬悠馨_id40", hoặc "<⟦1⟧" / "</⟦1⟧" (tên là hole)
const PSEUDO_TAG_RE = /<\/?(?:[⺀-鿿豈-﫿]|⟦)/;
// dấu câu toàn độ rộng mà bản dịch tiếng Việt thường đổi sang dấu ASCII (kèm khoảng trắng) -> dạng "nới" cho regex
const REGEX_PUNCT = {
  '：': '[：:]\\s*', '，': '[，,]\\s*', '；': '[；;]\\s*', '。': '[。.]\\s*', '！': '[！!]\\s*', '？': '[？?]\\s*', '、': '[、,]\\s*',
  '（': '\\s*[（(]', '）': '[）)]', '“': '["“”]', '”': '["“”]', '‘': "['‘’]", '’': "['‘’]",
};
// dấu ASCII tương ứng để thêm vào trong lớp ký tự [...] (không thêm "." cạnh "。": lớp như [。！？] dùng để tách câu
// sẽ cắt nhầm số thập phân "3.5")
const REGEX_PUNCT_ASCII = { '：': ':', '，': ',', '；': ';', '！': '!', '？': '?', '、': ',', '（': '\\(', '）': '\\)', '“': '"', '”': '"', '‘': "'", '’': "'" };

/** Văn bản có vẻ là HTML (có thẻ chuẩn) */
export function looksLikeHtml(s) { return HTML_HINT_RE.test(s); }

const CSS_HINT_RE = /(?:@(?:font-face|keyframes|media|import|supports|charset|layer)\b|:root\s*\{|[.#a-zA-Z][\w\s.#*:>+~[\]="'()-]{0,120}\{\s*(?:--[\w-]+|[a-zA-Z-]{3,})\s*:)/;
/** Văn bản có vẻ là bảng kiểu CSS (nhúng trong chuỗi JS) */
export function looksLikeCss(s) {
  return s.length > 24 && s.includes('{') && s.includes('}') && s.includes(':') && !/<[a-zA-Z\/!]/.test(s) && CSS_HINT_RE.test(s);
}

// ====================================================================== cấu trúc dữ liệu
class Node {
  constructor(start, end) { this.start = start; this.end = end; this.reps = []; }
}
function renderNode(src, node, env) {
  const reps = node.sorted ? node.reps : node.reps.slice().sort((a, b) => a.start - b.start);
  if (reps.length > 20000) {
    // rất nhiều mảnh: gom vào mảng rồi nối 1 lần (nối chuỗi dần tạo "rope" sâu, chậm khi làm phẳng)
    const parts = [];
    let pos = node.start;
    for (const r of reps) {
      if (r.start < pos) continue;
      parts.push(src.slice(pos, r.start), r.render(env));
      pos = r.end;
    }
    parts.push(src.slice(pos, node.end));
    return parts.join('');
  }
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
// chuỗi nháy kép trong khối dữ liệu (JSON nghiêm ngặt): escape mọi ký tự điều khiển
const JSON_CTRL = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
// eslint-disable-next-line no-control-regex
const JSON_CTRL_RE = new RegExp('[\\\\"' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f, 0x2028, 0x2029) + ']', 'g');
const jsonStrEsc = (s) => s.replace(JSON_CTRL_RE, (ch) => JSON_CTRL[ch] || '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
// chuỗi đơn giản trong khối dữ liệu: không có gì cần bảo vệ (escape, thẻ, macro, nháy lồng, đường dẫn, nhãn, token…)
const DATA_COMPLEX_RE = /[\\<{$&.@'"`「『“‘【[〖〔（(⟪]|_data|;base64,/;
const SENTENCE_RE = /[\n，。！？；…]|[.!?;]\s/;
// chú thích: bản dịch không được làm "thoát" khỏi chú thích
const lineCommentEsc = (s) => s.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
const blockCommentEsc = (s) => s.replace(/\*\//g, '* /');
const htmlCommentEsc = (s) => s.replace(/--!?>/g, '- ->').replace(/<!--/g, '<!- -');
// mã bên trong <% %> (EJS / ST-Prompt-Template): "%>" hay "<%" trong chuỗi/chú thích sẽ cắt ngang thẻ EJS
// -> viết thành "%\>" / "<\%" (trong chuỗi JS vẫn ra đúng "%>" / "<%")
const scriptEndEsc = (s) => (s.includes('</') ? s.replace(/<\/(script)/gi, '<\\/$1') : s);
const styleEndEsc = (s) => (s.includes('</') ? s.replace(/<\/(style)/gi, '<\\/$1') : s);
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
    // lớp tài nguyên / nội dung nhúng: dịch NHẤT QUÁN mọi chuỗi (khóa dữ liệu ngoài từ điển cũng dịch qua bộ nhớ dịch),
    // giữ nguyên mã định danh lẫn chữ Hán. Card thường: giữ hành vi cũ.
    this.uniform = !!ctx.uniform;
    this.keepFields = ctx.keepFields || null;
    this.fields = new Map(); // tên trường dữ liệu -> { n, chars, distinct, sample, kept }
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
    // o.htmlText: đây là chữ trong HTML -> "<chữ" do bản dịch sinh ra phải thành &lt; (không tạo thẻ mới).
    // Riêng đoạn mà bản gốc có thẻ giả tên tiếng Trung (<正文>, </姬悠馨_id40>) thì KHÔNG escape: bản dịch
    // <Chính văn> phải giữ nguyên dấu < — trước đây thành "&lt;Chính văn>" làm regex/cấu trúc prompt mất ký tự.
    const baseEsc = o.esc || identity;
    const esc = o.htmlText ? compose(htmlTextEsc, baseEsc) : baseEsc;
    const given = (o.holes || []).filter((h) => h.start >= start && h.end <= end);
    // cắt khoảng trắng 2 đầu (không cắt vào hole)
    let s = start, e = end;
    while (s < e && /\s/.test(src[s]) && !holeAt(given, s, false)) s++;
    while (e > s && /\s/.test(src[e - 1]) && !holeAt(given, e - 1, false)) e--;
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
      const sub = (a, b) => { if (b > a) this.textRun(parent, a, b, { ...o, holes: sliceHoles(given, a, b) }); };
      for (const b of barriers) {
        sub(pos, b.start);
        this.flushHoles(parent, [b], esc);
        pos = b.end;
      }
      sub(pos, e);
      return;
    }
    // phần chữ ngoài hole có CJK? (kiểm tra từng khoảng trống thay vì nối chuỗi lớn)
    let outsideHasCJK = false, pos = s;
    for (const h of holes) {
      if (h.start > pos && hasCJK(src.slice(pos, h.start))) { outsideHasCJK = true; break; }
      pos = h.end;
    }
    if (!outsideHasCJK && pos < e && hasCJK(src.slice(pos, e))) outsideHasCJK = true;
    if (!outsideHasCJK) { this.flushHoles(parent, holes, esc); return; }

    // 3) chia nhỏ văn bản dài
    const limit = o.chunk === false ? Infinity : (this.opts.chunkSize || 1800);
    const pieces = e - s > limit ? splitRange(src, s, e, holes, limit) : [[s, e]];
    let hi = 0;
    for (const [ps, pe0] of pieces) {
      while (hi < holes.length && holes[hi].end <= ps) hi++;
      let hj = hi;
      while (hj < holes.length && holes[hj].start < pe0) hj++;
      const pieceHoles = holes.slice(hi, hj);
      let a = ps, b = pe0;
      while (a < b && /\s/.test(src[a]) && !holeAt(pieceHoles, a, false)) a++;
      while (b > a && /\s/.test(src[b - 1]) && !holeAt(pieceHoles, b - 1, false)) b--;
      if (a >= b) continue;
      const hs = mergeAdjacent(src, pieceHoles.filter((h) => h.start >= a && h.end <= b));
      let key = '', p = a, segHasCJK = false;
      const segHoles = [];
      for (const h of hs) {
        const gap = src.slice(p, h.start);
        if (!segHasCJK && hasCJK(gap)) segHasCJK = true;
        key += gap;
        segHoles.push(h.hole);
        key += ph(segHoles.length);
        p = h.end;
      }
      const tail = src.slice(p, b);
      if (!segHasCJK && hasCJK(tail)) segHasCJK = true;
      key += tail;
      if (!segHasCJK) { this.flushHoles(parent, hs, esc); continue; }
      const seg = this.newSeg(key, segHoles, o.kind || 'prose', o.htmlText && PSEUDO_TAG_RE.test(key) ? baseEsc : esc);
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
    const refs = o.regexRefs || this.regexRefs;
    let m;
    // token của nội dung nhúng / link ngoài: giữ nguyên từng ký tự
    if (text.includes('⟪')) {
      EMBED_TOKEN_RE.lastIndex = 0;
      while ((m = EMBED_TOKEN_RE.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    // data URI dạng base64 dài (nhúng font/ảnh/âm thanh): giữ nguyên, không cắt nhỏ hay gửi AI
    if (text.includes(';base64,')) {
      const re = /data:[\w.+/-]+;base64,[A-Za-z0-9+/=\s]+/g;
      while ((m = re.exec(text))) {
        if (m[0].length >= 64) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
      }
    }
    // EJS <% ... %> (chỉ có trong nội dung card — tệp tài nguyên / lớp nhúng không qua ST-Prompt-Template)
    if (!this.noEjs && text.includes('<%')) {
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
        if (/^\{\{\s*match\s*\}\}$/i.test(mm) && refs) { add(m.index, m.index + mm.length, this.rawHole(s + m.index, s + m.index + mm.length)); continue; }
        const pm = MACRO_PATH_RE.exec(mm);
        if (pm && hasCJK(mm)) add(m.index, m.index + mm.length, { type: 'macro', src: mm, esc: true });
      }
    }
    // $1 / $<name> / $& trong replaceString — ở MỌI ngữ cảnh của mục (chữ HTML, thuộc tính, chuỗi JS, CSS):
    // ST thay $1 trên toàn bộ replaceString, nên model làm mất/đổi $1 ở đâu cũng hỏng
    if (refs && text.includes('$')) {
      const re = /\$(\d+|<[^>]+>|&)/g;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
    }
    if (o.entities) {
      const re = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
      while ((m = re.exec(text))) add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
      // "<chữ" lạc trong văn bản HTML (thẻ hỏng) -> giữ nguyên, tránh bị escape thành &lt;.
      // Dừng trước chữ Hán: "</状态栏" chỉ còn "</" và được bỏ qua -> tên thẻ vẫn được đổi theo nhãn / được dịch
      // cùng với thẻ mở (trước đây "</状态栏" bị giữ nguyên trong khi "<状态栏>" được dịch -> cặp thẻ lệch nhau).
      const re2 = /<[A-Za-z\/!?][^<>\s⺀-鿿豈-﫿]*/g;
      while ((m = re2.exec(text))) {
        if (m[0] === '</') continue;
        add(m.index, m.index + m[0].length, this.rawHole(s + m.index, s + m.index + m[0].length));
      }
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
    // đường dẫn trần a.b.c (>=2 đoạn, toàn khóa đã biết) — quét tuyến tính O(N) tránh treo với base64/CSS dài
    if (text.includes('.')) {
      forEachDotChain(text, (chain, startIdx) => {
        if (!hasCJK(chain)) return;
        // bỏ tiền tố không phải đường dẫn (vd "更新世界.时间" -> chỉ lấy phần khớp từ điển)
        const r = this.trimPathMatch(chain);
        if (r) add(startIdx + r.offset, startIdx + r.offset + r.text.length, this.pathHole(r.text));
      });
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
    // marker trong ngoặc: 【开场白】 【/开场白】 <开场白> — hole bao CẢ cặp ngoặc để model không thể đổi/làm mất
    // ngoặc (【】 -> [], bỏ dấu <>…), vì find regex khớp đúng từng ký tự đó
    if (this.markerRe) {
      this.markerRe.lastIndex = 0;
      while ((m = this.markerRe.exec(text))) {
        if (m[1] === '<' && isGroupNameAt(src, s + m.index)) continue; // $<tên>, (?<tên>, \k<tên> của regex — không phải nhãn
        const b = m.index + m[0].length + 1; // + ngoặc đóng (regex chỉ nhìn trước)
        add(m.index, b, { type: 'marker', open: m[1] + m[2], src: m[3], close: text[b - 1], esc: false });
      }
    }
    // bỏ các vùng nằm trong hole đã có (dùng tìm kiếm nhị phân O(log G) thay vì O(G))
    return given.length ? out.filter((h) => !overlapsAny(given, h.start, h.end)) : out;
  }

  trimPathMatch(text) {
    const parts = text.split('.');
    // tìm dãy liên tiếp dài nhất toàn đoạn hợp lệ, cho phép đoạn đầu chỉ khớp ở phần đuôi (tối đa 60 ký tự)
    let first = parts[0];
    let offset = 0;
    if (!this.isPathSeg(first)) {
      // thử cắt đầu: tìm hậu tố của đoạn đầu là khóa
      let found = null;
      const startIdx = Math.max(1, first.length - 60);
      for (let i = startIdx; i < first.length; i++) {
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
      // đoạn cuối dính chữ thường: "时间更新" -> lấy tiền tố "时间" (tối đa 60 ký tự)
      const p = parts[i];
      for (let j = Math.min(p.length - 1, 60); j > 0; j--) {
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
    if (!this.noEjs && src.slice(start, end).includes('<%')) {
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
      masks.sort((a, b) => a.start - b.start);
      const local = maskRanges(src.slice(start, end), masks.map((k) => ({ start: k.start - start, end: k.end - start })));
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
          // bản dịch chứa "</script" sẽ đóng thẻ sớm -> viết thành "<\/script" (trong chuỗi JS / JSON vẫn là "</script")
          const sEsc = compose(scriptEndEsc, outerEsc);
          if (!typeVal || /javascript|module|babel|jsx/.test(typeVal)) this.jsRange(parent, t.start, t.end, { mode: 'script', esc: sEsc });
          else if (/json/.test(typeVal)) this.jsRange(parent, t.start, t.end, { mode: 'json', esc: sEsc });
          else if (/html|template/.test(typeVal)) this.htmlRange(parent, t.start, t.end, { ...o, masks: [] });
        } else if (t.tag === 'style') {
          this.cssRange(parent, t.start, t.end, compose(styleEndEsc, outerEsc));
        } else {
          // <title>, <textarea>…: ${biểu thức} của template literal / thẻ EJS nằm bên trong phải là hole, nếu không
          // chúng bị coi là chữ và bị escape thành "\${…}" (tooltip <title> của SVG hiện nguyên văn "${…}")
          const inner = masks.filter((k) => k.start >= t.start && k.end <= t.end);
          inner.forEach((k) => used.add(k));
          this.textRun(parent, t.start, t.end, { holes: inner, esc: outerEsc, htmlText: true, kind: 'ui', entities: true, regexRefs: o.regexRefs, jsEscapes: o.jsEscapes });
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
    this.textRun(parent, start, end, { holes, esc: outerEsc, htmlText: true, kind: 'ui', entities: true, regexRefs: o.regexRefs, yamlKeys: o.yamlKeys, jsEscapes: o.jsEscapes });
  }

  htmlAttrs(node, t, outerEsc, masks, used, jsEscapes) {
    const src = this.src;
    for (const at of t.attrs) {
      if (at.vStart < 0) continue;
      const name = at.name.toLowerCase();
      const raw = src.slice(at.vStart, at.vEnd);
      let inMask = masks.filter((k) => k.start >= at.vStart && k.end <= at.vEnd);
      inMask.forEach((k) => used.add(k));
      // giá trị có nháy lồng không escape (lexer đã kéo tới nháy đóng thật): giữ nguyên từng dấu nháy lồng
      if (at.recovered) {
        const inner = [];
        for (let p = at.vStart; p < at.vEnd; p++) if (src[p] === at.quote && !inMask.some((k) => p >= k.start && p < k.end)) inner.push({ start: p, end: p + 1, hole: this.rawHole(p, p + 1) });
        inMask = [...inMask, ...inner].sort((a, b) => a.start - b.start);
      }
      const esc = compose(attrEsc(at.quote || '"'), outerEsc);
      if (name.startsWith('on')) {
        if (/[㐀-鿿]|stat_data/.test(raw)) this.jsRange(node, at.vStart, at.vEnd, { mode: 'attr', esc: compose(attrEsc(at.quote || '"'), outerEsc) });
        continue;
      }
      if (name === 'style') { if (hasCJK(raw)) this.cssRange(node, at.vStart, at.vEnd, esc); continue; }
      // <iframe srcdoc="…"> chứa cả một trang HTML
      if (name === 'srcdoc' && hasCJK(raw) && /<[a-zA-Z\/!]/.test(raw)) { this.htmlRange(node, at.vStart, at.vEnd, { esc, jsEscapes }); continue; }
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
    const mode = o.mode || 'script';
    // khối dữ liệu thuần lớn thành 1 token 'data' (trừ schema Zod và JSON của card: giữ cách phân tích cũ)
    const useData = mode !== 'schema' && (mode !== 'json' || this.uniform);
    const toks = o.tokens || lexJs(src, start, end, useData ? { data: true } : null);
    const sig = significant(toks);
    const outerEsc = o.esc || identity;
    const braceStack = []; // 'obj' | 'class' | false (khối lệnh)
    for (let i = 0; i < sig.length; i++) {
      const t = sig[i];
      const prev = sig[i - 1];
      if (t.type === 'data') {
        const policy = mode === 'json' ? 'smart' : this.stringPolicy(mode, sig, i);
        this.dataRange(parent, t.start, t.end, { esc: outerEsc, translate: policy !== 'none' });
        continue;
      }
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
    return this.regexBody(parent, start + 1, close, outerEsc);
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
      if (enclosingCall(sig, i) === 'print') return 'smart';
      // chuỗi là CÂU VĂN (có dấu câu tiếng Trung, hoặc dài) trong mã EJS hầu như luôn là chữ hiển thị / đưa vào prompt
      // (vd notes.push('有机缘的槐叶、神仙钱…'), { khai: '他的因果起于贫寒，…' }) -> dịch theo quy tắc "thông minh"
      // (chuỗi dùng làm khóa / so sánh / tham số getwi, setvar… vẫn giữ). Chuỗi ngắn (trạng thái, tên) vẫn giữ nguyên.
      if (this.opts.codeStrings !== 'none' && proseLike(stringContent(this.src, sig[i]))) return 'smart';
      return 'none';
    }
    return this.opts.codeStrings;
  }

  jsString(parent, sig, i, braceStack, outerEsc, mode) {
    const t = sig[i];
    const src = this.src;
    const content = src.slice(t.cStart, t.cEnd);
    if (!hasCJK(content)) return;
    // URL có chữ Hán trong đường dẫn (…/dist/界面/index.html): dịch là hỏng link -> luôn giữ nguyên
    if (isUrlLike(content)) return;
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
    // lớp tài nguyên: mã định danh lẫn chữ Hán ("pref-nanjing-松江府", "明史/卷6") được mã ghép / tra bảng -> giữ nguyên
    if (this.uniform && isSlugLike(content)) return;
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
      this.flushHoles(parent, this.findProtections(t.cStart, t.cEnd, {}, []), escFor);
      return;
    }
    // chuỗi có HTML bên trong
    if (/<[a-zA-Z\/!]/.test(content)) { this.htmlRange(parent, t.cStart, t.cEnd, { esc, jsEscapes: true }); return; }
    // chuỗi là bảng kiểu CSS (vd nhúng @font-face base64 + rule CSS trong script) -> chỉ dịch chuỗi content/comment CSS
    if (looksLikeCss(content)) { this.cssRange(parent, t.cStart, t.cEnd, esc); return; }
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
    // el.setAttribute('aria-label', '收起摘要') / $(x).attr('title', '…'): đối số sau tên thuộc tính HIỂN THỊ là chữ cho
    // người đọc -> dịch (trước đây bị giữ nguyên như mọi tham số của setAttribute)
    if (call && ATTR_SETTERS.has(call) && this.labelAttrCall(sig, i)) return false;
    if (call && (KEEP_ARG_FUNCS.has(call) || (PATH_FUNCS.has(call) && call.length > 3))) return true;
    // import 'xxx'
    if (pv === 'import' || pv === 'from') return true;
    // includes / startsWith / indexOf / match / split / replace(第一参数)
    if (pv === '(' && sig[i - 2]?.type === 'ident' && /^(includes|startsWith|endsWith|indexOf|lastIndexOf|split|search|match|matchAll|replace|replaceAll|test|has|get|delete)$/.test(sig[i - 2].value)) return true;
    return false;
  }

  /** sig[i] nằm trong setAttribute('<thuộc tính hiển thị>', …) và không phải chính tên thuộc tính */
  labelAttrCall(sig, i) {
    const open = enclosingCallOpen(sig, i);
    const first = open >= 0 ? sig[open + 1] : null;
    if (!first || first.type !== 'str' || open + 1 === i) return false;
    const name = this.src.slice(first.cStart, first.cEnd).toLowerCase();
    return TRANSLATE_ATTRS.has(name) || /^aria-(?:label|description|placeholder|roledescription|valuetext)$/.test(name);
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
      for (const p of t.parts) if (p.type === 'str' && hasCJK(src.slice(p.start, p.end))) this.flushHoles(parent, this.findProtections(p.start, p.end, {}, []), esc);
      return;
    }
    if (/<[a-zA-Z\/!]/.test(masked)) {
      this.htmlRange(parent, cStart, cEnd, { esc, jsEscapes: true, masks: exprHoles.map((h) => ({ start: h.start, end: h.end, hole: h.hole })) });
    } else if (!exprHoles.length && looksLikeCss(masked)) {
      this.cssRange(parent, cStart, cEnd, esc);
    } else {
      this.textRun(parent, cStart, cEnd, { holes: exprHoles.map((h) => ({ start: h.start, end: h.end, hole: h.hole })), esc, kind: 'ui', jsEscapes: true });
    }
  }

  // ====================================================================== khối dữ liệu thuần (token 'data')
  /**
   * JSON / literal chỉ gồm hằng, duyệt bằng walkData (không tạo token) — bảng dữ liệu nhúng cỡ lớn (bản đồ, bảng tra…).
   * - khóa / giá trị có trong từ điển -> ánh xạ như mọi nơi khác trong card
   * - URL, và (lớp tài nguyên) mã định danh lẫn chữ Hán -> giữ nguyên
   * - giá trị còn lại -> đoạn dịch; mọi lần xuất hiện của cùng một chuỗi dùng chung MỘT đoạn (nên cùng một bản dịch)
   * - khóa ngoài từ điển: card thường giữ nguyên (hành vi cũ); lớp tài nguyên dịch qua bộ nhớ dịch, cùng bản dịch với
   *   giá trị trùng tên -> mã tra theo khóa vẫn khớp
   * - trường (tên khóa chứa giá trị) nằm trong keepFields -> giữ nguyên mọi giá trị của trường đó
   */
  dataRange(parent, start, end, o = {}) {
    const src = this.src;
    const outerEsc = o.esc || identity;
    const translate = o.translate !== false;
    const plans = new Map(), escs = new Map();
    const escOf = (q) => { let e = escs.get(q); if (!e) { e = compose(q === '"' ? jsonStrEsc : jsEsc(q), outerEsc); escs.set(q, e); } return e; };
    const self = this;
    walkData(src, start, end, {
      key(kS, kE, quote) {
        const name = src.slice(kS, kE);
        const pk = 'k' + quote + name;
        let plan = plans.get(pk);
        if (plan === undefined) { plan = self.planDataKey(name, quote, quote ? escOf(quote) : outerEsc, translate); plans.set(pk, plan); }
        self.applyDataPlan(parent, plan, kS, kE, quote ? escOf(quote) : outerEsc);
      },
      value(vS, vE, quote, han, keyS, keyE) {
        const content = src.slice(vS, vE);
        const pk = 'v' + quote + content;
        let plan = plans.get(pk);
        if (plan === undefined) { plan = self.planDataValue(content, escOf(quote), translate); plans.set(pk, plan); }
        if (plan.count && self.noteField(keyS >= 0 ? src.slice(keyS, keyE) : '', content)) return; // trường được giữ nguyên
        self.applyDataPlan(parent, plan, vS, vE, escOf(quote));
      },
    });
  }

  /** Thống kê theo tên trường dữ liệu (để người dùng chọn trường nào không dịch). Trả về true nếu trường đang bị giữ */
  noteField(field, content) {
    let f = this.fields.get(field);
    if (!f) { f = { name: field, n: 0, chars: 0, distinct: 0, sample: content.slice(0, 80), kept: !!this.keepFields?.has(field), seen: new Set() }; this.fields.set(field, f); }
    f.n++;
    if (!f.seen.has(content)) { f.seen.add(content); f.distinct++; f.chars += content.length; }
    return f.kept;
  }

  /** rep dùng chung cho mọi lần xuất hiện của cùng một chuỗi; kết quả được nhớ trong một lượt render */
  sharedRender(compute) {
    let lastEnv = null, lastVal = '';
    return (env) => { if (env !== lastEnv) { lastVal = compute(env); lastEnv = env; } return lastVal; };
  }

  dictPlan(content, esc) {
    const k = this.exactKind(content);
    let hole = null;
    if (k) hole = k === 'entry' ? { type: 'entry', src: content, esc: true } : k === 'book' ? { type: 'book', src: content, esc: true } : this.dictHole(content, k);
    else hole = this.compositeHole(content) || (this.pathInfo(content) ? this.pathHole(content) : null);
    return hole ? { t: 'rep', render: this.sharedRender((env) => esc(renderHole(hole, env))) } : null;
  }

  planDataValue(content, esc, translate) {
    const plain = !content.includes('\\');
    if (plain) { const d = this.dictPlan(content, esc); if (d) return d; }
    if (!translate) return { t: 'sync' };
    if (isUrlLike(content) || (this.uniform && isSlugLike(content))) return { t: 'skip' };
    const kind = content.length <= 24 && !SENTENCE_RE.test(content) ? 'name' : 'prose';
    if (/<[a-zA-Z\/!]/.test(content)) return { t: 'html', count: true };
    if (looksLikeCss(content)) return { t: 'css' };
    if (this.uniform && plain) { const list = this.listPlan(content, esc); if (list) return list; }
    if (DATA_COMPLEX_RE.test(content) || content.length > (this.opts.chunkSize || 1800)) return { t: 'text', count: true, kind };
    // chuỗi đơn giản: cắt khoảng trắng 2 đầu như textRun, một đoạn dịch cho mọi lần xuất hiện
    const lead = content.length - content.trimStart().length, trail = content.length - content.trimEnd().length;
    const key = content.slice(lead, content.length - trail);
    if (!hasCJK(key)) return { t: 'skip' };
    const seg = this.newSeg(key, [], kind, esc);
    return { t: 'rep', count: true, lead, trail, render: this.sharedRender((env) => renderSegment(seg, env)) };
  }

  /**
   * Chuỗi gói cả một DANH SÁCH tên ngắn ("出羽国 后醍醐朝廷 建武政权 …", "甲|乙|丙", "甲、乙、丙、丁"): dịch từng tên
   * như một đoạn riêng rồi ghép lại bằng đúng dấu phân cách cũ. Mỗi tên chỉ dịch MỘT lần dù lặp lại ở hàng trăm danh
   * sách, và cùng bản dịch với nơi tên đó đứng riêng (mã tìm tên trong danh sách vẫn khớp).
   */
  listPlan(content, esc) {
    const parts = splitNameList(content);
    if (!parts) return null;
    const atoms = this.atomPlans || (this.atomPlans = new Map());
    const items = parts.map((p) => {
      if (!p.text || !hasCJK(p.text)) return p.text + p.sep;
      let a = atoms.get(p.text);
      if (a === undefined) {
        const k = this.exactKind(p.text);
        if (k) {
          const hole = k === 'entry' ? { type: 'entry', src: p.text, esc: true } : k === 'book' ? { type: 'book', src: p.text, esc: true } : this.dictHole(p.text, k);
          a = this.sharedRender((env) => renderHole(hole, env));
        } else if (isUrlLike(p.text) || isSlugLike(p.text)) a = null;
        else { const seg = this.newSeg(p.text, [], 'name', identity); a = this.sharedRender((env) => renderSegment(seg, env)); }
        atoms.set(p.text, a);
      }
      return a ? { render: a, sep: p.sep } : p.text + p.sep;
    });
    return { t: 'rep', count: true, render: this.sharedRender((env) => esc(items.map((x) => (typeof x === 'string' ? x : x.render(env) + x.sep)).join(''))) };
  }

  planDataKey(name, quote, esc, translate) {
    const quoteFor = (dst) => { const d = oneLine(dst); return d.includes("'") ? JSON.stringify(d) : "'" + d.replace(/\\/g, '\\\\') + "'"; };
    if (!quote) { // khóa là định danh trần: { 战争: … }
      const k = this.dict.kindOf(name);
      if (k === 'key' || k === 'value' || k === 'term') return { t: 'rep', render: this.sharedRender((env) => { const dst = lookupDict(env, name); return isIdentifier(dst) ? dst : esc(quoteFor(dst)); }) };
      if (!this.uniform || !translate || isSlugLike(name)) return { t: 'skip' };
      const seg = this.newSeg(name, [], 'name', identity);
      return { t: 'rep', render: this.sharedRender((env) => { if (!env.tm || env.tm.get(seg.key) == null) return name; const v = renderSegment(seg, env); return isIdentifier(v) ? v : esc(quoteFor(v)); }) };
    }
    const plain = !name.includes('\\');
    if (plain) { const d = this.dictPlan(name, esc); if (d) return d; }
    // khóa ngoài từ điển: card thường giữ nguyên; lớp tài nguyên dịch nhất quán với giá trị trùng tên
    if (!this.uniform || !translate || !plain || isUrlLike(name) || isSlugLike(name)) return { t: 'skip' };
    if (DATA_COMPLEX_RE.test(name) || name !== name.trim() || name.length > 80) return { t: 'skip' };
    const seg = this.newSeg(name, [], 'name', (s) => esc(oneLine(s)));
    return { t: 'rep', render: this.sharedRender((env) => renderSegment(seg, env)) };
  }

  applyDataPlan(parent, plan, s, e, esc) {
    switch (plan.t) {
      case 'rep': parent.reps.push({ start: s + (plan.lead || 0), end: e - (plan.trail || 0), render: plan.render }); break;
      case 'text': this.textRun(parent, s, e, { esc, kind: plan.kind || 'prose', jsEscapes: true }); break;
      case 'html': this.htmlRange(parent, s, e, { esc, jsEscapes: true }); break;
      case 'css': this.cssRange(parent, s, e, esc); break;
      case 'sync': this.flushHoles(parent, this.findProtections(s, e, {}, []), esc); break;
      default: break;
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
    if (esc === yamlPlainEsc) {
      // giá trị trần: dựng xong CẢ giá trị rồi mới quyết định có cần bọc nháy không. Trước đây từng mảnh giữa các
      // placeholder bị bọc nháy riêng -> giá trị có biến/đường dẫn ở giữa mà bản dịch chứa ": " hay " #" làm hỏng YAML.
      const node = new Node(a, b);
      this.textRun(node, a, b, { esc: identity, kind: 'prose', chunk: false, exact: false });
      if (node.reps.length) parent.reps.push({ start: a, end: b, render: (env) => { const out = renderNode(this.src, node, env); return out === val ? out : yamlPlainEsc(out); } });
      return;
    }
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
  regexFind(parent, start, end) { this.regexBody(parent, start, end, identity); }

  /**
   * Thân biểu thức regex (find regex của ST hoặc regex literal trong mã): đổi các cụm chữ Hán là mục từ điển.
   * - Tên nhóm (?<名字>…) và tham chiếu \k<名字> được GIỮ NGUYÊN: tên nhóm không được có dấu cách, và $<名字> trong
   *   replace cũng giữ nguyên nên hai bên vẫn khớp (trước đây tên nhóm bị dịch -> regex không hợp lệ, mất tác dụng).
   * - Dấu câu toàn độ rộng ngoài [...] (： ， （ ）…) được nới thành dạng nhận cả dấu ASCII + khoảng trắng khi
   *   env.widenRegex bật: bản dịch tiếng Việt viết "Độ hảo cảm: 50" chứ không phải "Độ hảo cảm：50".
   * Trả về true nếu còn chữ Hán không ánh xạ được.
   */
  regexBody(parent, start, end, esc) {
    const src = this.src;
    let inClass = false, left = false, classBody = '';
    let i = start;
    const runRe = new RegExp('[' + HAN_CLASS + '\\u3040-\\u30FF]');
    while (i < end) {
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if ((n === 'u' || n === 'p' || n === 'P') && src[i + 2] === '{') { const close = src.indexOf('}', i); i = close > 0 ? close + 1 : i + 2; }
        else if (n === 'k' && src[i + 2] === '<') { const close = src.indexOf('>', i); i = close > 0 && close < end ? close + 1 : i + 2; }
        else if (n === 'u') i += 6;
        else if (n === 'x') i += 4;
        else i += 2;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        else if (runRe.test(c)) left = true;
        else if (REGEX_PUNCT_ASCII[c] && !classBody.includes(REGEX_PUNCT_ASCII[c].slice(-1))) {
          // trong [...]: thêm dấu ASCII tương ứng cạnh dấu toàn độ rộng ([^：] -> [^：:])
          const both = c + REGEX_PUNCT_ASCII[c];
          parent.reps.push({ start: i, end: i + 1, render: (env) => (env.widenRegex ? esc(both) : c) });
        }
        i++; continue;
      }
      if (c === '[') {
        inClass = true;
        let j = i + 1;
        while (j < end && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
        classBody = src.slice(i + 1, Math.min(j, end));
        i++; continue;
      }
      // (?<tên>…): bỏ qua tên nhóm; (?<=…) / (?<!…) là lookbehind, không phải tên nhóm
      if (c === '(' && src[i + 1] === '?' && src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!') {
        const close = src.indexOf('>', i + 3);
        if (close > 0 && close < end) { i = close + 1; continue; }
      }
      if (runRe.test(c)) {
        let j = i;
        while (j < end && runRe.test(src[j])) j++;
        const word = src.slice(i, j);
        const k = this.dict.kindOf(word);
        // nhãn, hoặc tên biến/giá trị xuất hiện trong regex (vd 好感度:(\d+)) -> cùng bản dịch với nơi khác
        if (k === 'marker' || k === 'key' || k === 'value') {
          const hole = this.dictHole(word, k);
          parent.reps.push({ start: i, end: j, render: (env) => esc(escapeRegex(renderHole(hole, env))) });
        } else left = true;
        i = j; continue;
      }
      const wide = REGEX_PUNCT[c];
      if (wide) {
        const quant = /[?*+{]/.test(src[i + 1] || '');
        const text = quant ? '(?:' + wide + ')' : wide;
        parent.reps.push({ start: i, end: i + 1, render: (env) => (env.widenRegex ? esc(text) : c) });
      }
      i++;
    }
    return left;
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

const LIST_STOP = /[，。！？；：,;!?]/; // có dấu câu -> là câu văn, không phải danh sách tên
const LIST_SEPS = [/[ \t]+/g, /\s*\|\s*/g, /、/g, /\r?\n/g];
/** Tách chuỗi là danh sách ≥ 4 tên ngắn ngăn bằng khoảng trắng, "|", "、" hoặc xuống dòng: [{ text, sep }] — không phải thì null */
function splitNameList(s) {
  if (s.length < 40) return null;
  for (const re of LIST_SEPS) {
    const out = [];
    let pos = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out.push({ text: s.slice(pos, m.index), sep: m[0] });
      pos = m.index + m[0].length;
    }
    if (out.length < 3) continue;
    out.push({ text: s.slice(pos), sep: '' });
    let ok = true, han = 0;
    for (const p of out) {
      if (p.text.length > 24 || LIST_STOP.test(p.text)) { ok = false; break; }
      if (hasCJK(p.text)) han++;
    }
    if (ok && han >= out.length * 0.6) return out;
  }
  return null;
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
  const j = enclosingCallOpen(sig, i);
  return j >= 0 ? sig[j - 1].value : null;
}

/** Vị trí dấu "(" của lời gọi hàm gần nhất bao quanh sig[i]; -1 nếu không nằm trong lời gọi tên(…) */
function enclosingCallOpen(sig, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0 && j >= i - 200; j--) {
    const s = sig[j];
    if (s.type !== 'punct') continue;
    if (s.value === ')' || s.value === ']') depth++;
    else if (s.value === '(' || s.value === '[') {
      if (depth === 0) return s.value === '(' && sig[j - 1]?.type === 'ident' ? j : -1;
      depth--;
    } else if (depth === 0 && (s.value === ';' || s.value === '{' || s.value === '}')) return -1;
  }
  return -1;
}
const ATTR_SETTERS = new Set(['setAttribute', 'attr', 'prop']);

/** Nội dung tĩnh của token chuỗi / template literal */
function stringContent(src, t) {
  if (!t) return '';
  if (t.type === 'str') return src.slice(t.cStart, t.cEnd);
  if (t.type === 'tmpl') return (t.parts || []).filter((p) => p.type === 'str').map((p) => src.slice(p.start, p.end)).join(' ');
  return '';
}

const HAN_COUNT_RE = new RegExp('[' + HAN_CLASS + ']', 'g');
/** Chuỗi trông như câu văn hiển thị (không phải mã định danh / giá trị trạng thái ngắn) */
function proseLike(s) {
  const han = (String(s).match(HAN_COUNT_RE) || []).length;
  if (han < 4) return false;
  return /[，。！？；：、…—「」『』（）]/.test(s) || han >= 10;
}

/** Nội dung <style>/<script> thực ra là văn xuôi: có dấu câu CJK nằm ngoài chuỗi/chú thích (mã hợp lệ không thể có) */
function rawIsProse(src, a, b, tag) {
  if (b <= a || !hasCJK(src.slice(a, b))) return false;
  const PUNCT = /[，。！？；：、]/;
  // data: true -> khối dữ liệu lớn trong script không bị tách thành hàng triệu token chỉ để kiểm tra
  if (tag === 'script') return lexJs(src, a, b, { data: true }).some((t) => t.type === 'punct' && PUNCT.test(t.value));
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
  if (!ranges.length) return text;
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (const r of sorted) {
    const s = Math.max(pos, r.start), e = Math.max(s, Math.min(text.length, r.end));
    if (s > pos) out += text.slice(pos, s);
    if (e > s) out += '\u0001'.repeat(e - s);
    pos = e;
  }
  if (pos < text.length) out += text.slice(pos);
  return out;
}

/** Tìm hole chứa vị trí p trong mảng holes đã sắp xếp. strictInterior=true: h.start < p < h.end */
function holeAt(holes, p, strictInterior = false) {
  let lo = 0, hi = holes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const h = holes[mid];
    if (p < h.start || (strictInterior && p === h.start)) hi = mid - 1;
    else if (p >= h.end) lo = mid + 1;
    else return h;
  }
  return null;
}

/** Kiểm tra đoạn [start, end) có giao với bất kỳ hole nào trong mảng đã sắp xếp không */
function overlapsAny(holes, start, end) {
  let lo = 0, hi = holes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const h = holes[mid];
    if (h.end <= start) lo = mid + 1;
    else if (h.start >= end) hi = mid - 1;
    else return true;
  }
  return false;
}

/** Lấy các hole nằm gọn trong [start, end] từ mảng holes đã sắp xếp */
function sliceHoles(holes, start, end) {
  if (!holes.length) return [];
  let lo = 0, hi = holes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (holes[mid].start < start) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < holes.length && holes[i].start < end; i++) {
    if (holes[i].end <= end) out.push(holes[i]);
  }
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
  const inHole = (p) => !!holeAt(holes, p, true);
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
    // nếu điểm cắt rơi vào giữa một hole (vd base64 / EJS / thẻ dài), nhảy thẳng qua cuối hole thay vì cộng từng ký tự
    for (;;) {
      const h = holeAt(holes, cut, true);
      if (!h || cut >= e) break;
      cut = Math.min(e, h.end);
    }
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
    case 'marker': return h.open + lookupDict(env, h.src) + h.close;
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
  // lớp tài nguyên / nội dung nhúng (base64, gzip, tệp đi kèm, link ngoài): dịch nhất quán, không có EJS
  const layer = !!item.meta?.layer;
  const an = new Analyzer(src, layer ? { ...ctx, uniform: true, keepFields: item.meta.keepFields || null } : ctx);
  an.noEjs = layer;
  const root = new Node(0, src.length);
  const isReplace = !!item.meta?.isReplace;
  an.regexRefs = isReplace;
  switch (kind) {
    case 'html': an.htmlRange(root, 0, src.length, {}); break;
    case 'js': an.jsRange(root, 0, src.length, { mode: 'code' }); break;
    case 'css': an.cssRange(root, 0, src.length); break;
    case 'text': an.proseRange(root, 0, src.length, {}); break;
    case 'data': {
      // JSON thuần: duyệt thẳng bằng walkData; không phải dữ liệu thuần thì phân tích như JSON thường
      let a = 0, b = src.length;
      while (a < b && (/\s/.test(src[a]) || src.charCodeAt(a) === 0xfeff)) a++;
      while (b > a && /\s/.test(src[b - 1])) b--;
      if ((src[a] === '{' || src[a] === '[') && walkData(src, a, b, null) === b) an.dataRange(root, a, b, {});
      else an.jsRange(root, 0, src.length, { mode: 'json' });
      break;
    }
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
  // quét nhãn lần cuối: bỏ qua với lớp rất lớn (regex toàn văn trên hàng chục MB mỗi lần render)
  const markerRe = kind === 'regexFind' || kind === 'regexTrim' || kind === 'button' || src.length > 4e6 ? null : an.markerRe;
  // các rep của khối dữ liệu được thêm theo thứ tự tăng dần -> sắp xếp 1 lần ở đây, renderNode khỏi sắp lại mỗi lượt
  if (root.reps.length > 5000) { root.reps.sort((a, b) => a.start - b.start); root.sorted = true; }
  const fields = an.fields.size ? [...an.fields.values()].map(({ seen, ...f }) => f) : null;
  return {
    segments: dedupeSegments(an.segments),
    warnings: an.warnings,
    fields,
    render(env) { return sweepMarkers(renderNode(src, root, { ...env, src }), markerRe, env); },
  };
}

/** Lớp dữ liệu lớn sinh rất nhiều đoạn trùng khóa (cùng một chuỗi lặp lại) — chỉ giữ mỗi khóa một đoạn */
function dedupeSegments(segs) {
  if (segs.length < 2000) return segs;
  const seen = new Set(), out = [];
  for (const s of segs) { if (seen.has(s.key)) continue; seen.add(s.key); out.push(s); }
  return out;
}

/**
 * Quét cuối: nhãn trong ngoặc (【开场白】, </状态栏>…) còn nguyên tiếng Trung ở những vùng bộ phân tích không đụng tới
 * (thuộc tính HTML hỏng nháy, chú thích không dịch, CSS, khối mã lạ…) vẫn phải đổi theo từ điển — regex của ST chạy
 * trên văn bản thô nên nhãn mở/đóng ở MỌI nơi phải cùng một tên, nếu không regex sau dịch không khớp nữa.
 */
function sweepMarkers(out, markerRe, env) {
  if (!markerRe || typeof out !== 'string' || !hasCJK(out)) return out;
  markerRe.lastIndex = 0;
  return out.replace(markerRe, (m, open, slash, word, offset, str) => {
    if (open === '<' && isGroupNameAt(str, offset)) return m; // $<tên>, (?<tên>, \k<tên> của regex — không phải nhãn
    const dst = lookupDict(env, word);
    return dst === word ? m : open + slash + dst;
  });
}

/** Dấu "<" tại vị trí i mở tên nhóm của regex: $<tên> (replace), (?<tên>…) (khai báo), \k<tên> (tham chiếu) */
function isGroupNameAt(s, i) {
  const p = s[i - 1];
  return p === '$' || (p === '?' && s[i - 2] === '(') || (p === 'k' && s[i - 2] === '\\');
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
