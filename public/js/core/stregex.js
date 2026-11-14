// Engine regex giống extension Regex của SillyTavern (placement, markdownOnly/promptOnly, depth, trimStrings, $1, {{match}})
import { evaluateMacros } from './macros.js';
import { escapeRegex } from './util.js';

export const PLACEMENT = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const PLACEMENT_LABELS = { 1: 'Đầu vào người dùng', 2: 'Đầu ra AI', 3: 'Lệnh slash', 5: 'World Info', 6: 'Suy luận (reasoning)' };

/** Giống regexFromString của ST */
export function regexFromString(input) {
  try {
    const m = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return null;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJd]+$/.test(m[3])) return new RegExp(input);
    return new RegExp(m[2], m[3].replace(/[xXUAJ]/g, ''));
  } catch {
    return null;
  }
}

function filterString(raw, trimStrings, macro) {
  let out = raw;
  for (const t of trimStrings || []) {
    const s = evaluateMacros(String(t), macro);
    if (s) out = out.split(s).join('');
  }
  return out;
}

export function runRegexScript(script, rawString, macro = {}) {
  if (!script || script.disabled || !script.findRegex || !rawString) return rawString;
  let findStr = script.findRegex;
  const sub = Number(script.substituteRegex || 0);
  if (sub === 1) findStr = evaluateMacros(findStr, macro);
  else if (sub === 2) findStr = findStr.replace(/\{\{[^{}]+\}\}/g, (m) => escapeRegex(evaluateMacros(m, macro)));
  const re = regexFromString(findStr);
  if (!re) return rawString;
  return rawString.replace(re, function (match, ...rest) {
    const args = [match, ...rest];
    const hasGroups = typeof args[args.length - 1] === 'object';
    const groups = hasGroups ? args[args.length - 1] : undefined;
    const replaceString = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0');
    const replaced = replaceString.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
      let v;
      if (num) v = args[Number(num)];
      else if (name) v = groups && groups[name];
      if (!v || typeof v !== 'string') return '';
      return filterString(v, script.trimStrings, macro);
    });
    return evaluateMacros(replaced, macro);
  });
}

/**
 * Áp dụng danh sách regex theo vị trí — giống getRegexedString của ST.
 * opts: { isMarkdown, isPrompt, isEdit, depth, macro }
 */
export function applyRegexes(scripts, raw, placement, opts = {}) {
  let s = raw;
  for (const script of scripts || []) {
    if (!script || script.disabled) continue;
    const ok = (script.markdownOnly && opts.isMarkdown) || (script.promptOnly && opts.isPrompt) || (!script.markdownOnly && !script.promptOnly && !opts.isMarkdown && !opts.isPrompt);
    if (!ok) continue;
    if (opts.isEdit && !script.runOnEdit) continue;
    if (typeof opts.depth === 'number') {
      const minD = script.minDepth, maxD = script.maxDepth;
      if (minD !== null && minD !== undefined && minD !== '' && !isNaN(minD) && Number(minD) >= -1 && opts.depth < Number(minD)) continue;
      if (maxD !== null && maxD !== undefined && maxD !== '' && !isNaN(maxD) && Number(maxD) >= 0 && opts.depth > Number(maxD)) continue;
    }
    if (!(script.placement || []).includes(placement)) continue;
    s = runRegexScript(script, s, opts.macro);
  }
  return s;
}

/** Nội dung hiển thị của 1 tin nhắn: regex "lưu" (không markdown/prompt) rồi regex markdownOnly */
export function displayText(scripts, text, { isUser, depth, macro }) {
  const placement = isUser ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT;
  const stored = applyRegexes(scripts, text, placement, { macro, depth });
  return applyRegexes(scripts, stored, placement, { isMarkdown: true, depth, macro });
}

/** Tìm đoạn mẫu khớp regex trong các văn bản của card (để xem trước) */
export function findSampleFor(script, texts) {
  const re = regexFromString(script.findRegex);
  if (!re) return null;
  const r = new RegExp(re.source, re.flags.replace('g', ''));
  for (const t of texts) {
    if (typeof t !== 'string' || !t) continue;
    const m = r.exec(t);
    if (m && m[0].length < 20000) return m[0];
  }
  return null;
}

/** Tạo chuỗi mẫu đơn giản cho regex dạng <tag>(...)</tag> */
export function syntheticSample(script) {
  const src = String(script.findRegex || '').replace(/^\/|\/[a-z]*$/gi, '');
  const lit = src
    .replace(/\\s\*|\\s\+|\\n|\\r/g, '')
    .replace(/\((?:\?:)?\[\\s\\S\]\*\??\)|\[\\s\\S\]\*\??|\.\*\??|\(\.\*\??\)/g, 'Nội dung mẫu')
    .replace(/\(\{\[\\s\\S\]\*\?\}\)/g, '{}')
    .replace(/\\(.)/g, '$1')
    .replace(/[()^$?*+]/g, '');
  if (/[[\]|{}]/.test(lit)) return null;
  return lit;
}
