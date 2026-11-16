// Mô hình card SillyTavern: đọc (PNG/JSON, V1/V2/V3), liệt kê các phần cần dịch, ghép lại card đã dịch
import { readCardFromPng, writeCardToPng, isPng } from './png.js';
import { deepClone, getPath, setPath, hasCJK } from './util.js';

export const GROUPS = {
  basic: 'Thông tin cơ bản',
  greetings: 'Lời chào (Greetings)',
  lorebook: 'Lorebook / World Info',
  regex: 'Regex',
  scripts: 'Script Tavern Helper',
  embedded: 'Nội dung nhúng (base64 / nén)',
  resources: 'Tài nguyên đi kèm & link ngoài',
};

const BASIC_FIELDS = [
  ['name', 'Tên nhân vật (name)', 'name'],
  ['description', 'Mô tả (description)', 'auto'],
  ['personality', 'Tính cách (personality)', 'auto'],
  ['scenario', 'Bối cảnh (scenario)', 'auto'],
  ['first_mes', 'Lời chào đầu (first_mes)', 'auto'],
  ['mes_example', 'Ví dụ hội thoại (mes_example)', 'auto'],
  ['creator_notes', 'Ghi chú tác giả (creator_notes)', 'auto'],
  ['system_prompt', 'System prompt', 'auto'],
  ['post_history_instructions', 'Post-history instructions', 'auto'],
];

/** Phân tích file -> card */
export function parseCardFile(fileName, bytes) {
  let jsonText, format, image = null;
  if (isPng(bytes)) {
    jsonText = readCardFromPng(bytes).json;
    format = 'png';
    image = bytes;
  } else {
    jsonText = new TextDecoder('utf-8').decode(bytes);
    if (jsonText.charCodeAt(0) === 0xfeff) jsonText = jsonText.slice(1);
    format = 'json';
  }
  let raw;
  try { raw = JSON.parse(jsonText); } catch (e) { throw new Error('JSON của card không hợp lệ: ' + e.message); }
  return makeCard(raw, { fileName, format, image });
}

export function makeCard(raw, { fileName = 'card.json', format = 'json', image = null } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Card không hợp lệ');
  let card = raw;
  let spec = 'v1';
  if (raw.data && typeof raw.data === 'object') {
    spec = String(raw.spec || '').includes('v3') ? 'v3' : 'v2';
  } else if (raw.entries && !raw.name && !raw.first_mes) {
    throw new Error('File này là World Info (lorebook) riêng, không phải card nhân vật. Hãy dùng card có lorebook nhúng.');
  } else {
    // V1 -> bọc thành V2 để xử lý thống nhất (giữ nguyên trường gốc ở cấp trên)
    card = deepClone(raw);
    card.spec = 'chara_card_v2';
    card.spec_version = '2.0';
    card.data = {
      name: raw.name || '', description: raw.description || '', personality: raw.personality || '',
      scenario: raw.scenario || '', first_mes: raw.first_mes || '', mes_example: raw.mes_example || '',
      creator_notes: raw.creatorcomment || '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: raw.tags || [], creator: '', character_version: '', extensions: {},
    };
  }
  card.data.extensions ||= {};
  return { raw: card, spec, fileName, format, image };
}

function thScriptList(ext) {
  const out = [];
  const walk = (arr, prefix) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const p = [...prefix, i];
      if (Array.isArray(s.scripts)) walk(s.scripts, [...p, 'scripts']);
      if (s.type === 'folder') { out.push({ script: s, path: p, folder: true }); return; }
      out.push({ script: s, path: p });
    });
  };
  if (ext?.tavern_helper?.scripts) walk(ext.tavern_helper.scripts, ['data', 'extensions', 'tavern_helper', 'scripts']);
  if (Array.isArray(ext?.TavernHelper_scripts)) walk(ext.TavernHelper_scripts, ['data', 'extensions', 'TavernHelper_scripts']);
  return out;
}

export function isInitVarEntry(entry) {
  const c = String(entry?.comment || '');
  const keys = [...(entry?.keys || []), ...(entry?.secondary_keys || [])].map(String);
  return /\[\s*init\s*var\s*\]/i.test(c) || keys.some((k) => /\[\s*init\s*var\s*\]/i.test(k));
}
export function isSchemaScript(content) {
  return /registerMvuSchema|z\s*\.\s*object\s*\(/.test(String(content || ''));
}

/**
 * Liệt kê tất cả phần có thể dịch của card.
 * Mỗi item: { id, path, group, label, kind, text, meta }
 * kind: name | auto | initvar | code | schema | regexFind | keys | comment | list
 */
export function listItems(card) {
  const d = card.raw.data;
  const items = [];
  const add = (it) => { it.id = it.path.join('.'); items.push(it); };

  for (const [k, label, kind] of BASIC_FIELDS) {
    if (typeof d[k] === 'string' && d[k].trim()) add({ path: ['data', k], group: k === 'first_mes' ? 'greetings' : 'basic', label, kind, text: d[k] });
  }
  if (typeof d.extensions?.depth_prompt?.prompt === 'string' && d.extensions.depth_prompt.prompt.trim()) {
    add({ path: ['data', 'extensions', 'depth_prompt', 'prompt'], group: 'basic', label: 'Depth prompt (Character\'s Note)', kind: 'auto', text: d.extensions.depth_prompt.prompt });
  }
  if (Array.isArray(d.tags) && d.tags.some(hasCJK)) {
    add({ path: ['data', 'tags'], group: 'basic', label: 'Thẻ (tags)', kind: 'list', text: d.tags.slice() });
  }
  (d.alternate_greetings || []).forEach((g, i) => {
    if (typeof g === 'string') add({ path: ['data', 'alternate_greetings', i], group: 'greetings', label: `Lời chào thay thế #${i + 1}`, kind: 'auto', text: g, meta: { swipe: i + 1 } });
  });
  (d.group_only_greetings || []).forEach((g, i) => {
    if (typeof g === 'string') add({ path: ['data', 'group_only_greetings', i], group: 'greetings', label: `Lời chào nhóm #${i + 1}`, kind: 'auto', text: g });
  });

  const book = d.character_book;
  if (book && Array.isArray(book.entries)) {
    if (typeof book.name === 'string' && book.name) add({ path: ['data', 'character_book', 'name'], group: 'lorebook', label: 'Tên lorebook', kind: 'name', text: book.name });
    book.entries.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const base = ['data', 'character_book', 'entries', i];
      const title = e.comment || e.name || (e.keys || []).join(', ') || `#${i}`;
      const initvar = isInitVarEntry(e);
      const meta = { entryIndex: i, title, enabled: e.enabled !== false, initvar };
      if (typeof e.comment === 'string' && e.comment) add({ path: [...base, 'comment'], group: 'lorebook', label: `Tên mục: ${title}`, kind: 'comment', text: e.comment, meta });
      if (typeof e.content === 'string' && e.content.trim()) add({ path: [...base, 'content'], group: 'lorebook', label: `Nội dung: ${title}`, kind: initvar ? 'initvar' : 'auto', text: e.content, meta });
      if (Array.isArray(e.keys) && e.keys.some(hasCJK)) add({ path: [...base, 'keys'], group: 'lorebook', label: `Từ khóa: ${title}`, kind: 'keys', text: e.keys.slice(), meta });
      if (Array.isArray(e.secondary_keys) && e.secondary_keys.some(hasCJK)) add({ path: [...base, 'secondary_keys'], group: 'lorebook', label: `Từ khóa phụ: ${title}`, kind: 'keys', text: e.secondary_keys.slice(), meta });
    });
  }

  (d.extensions?.regex_scripts || []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const base = ['data', 'extensions', 'regex_scripts', i];
    const title = r.scriptName || `Regex #${i + 1}`;
    const meta = { regexIndex: i, title };
    if (r.scriptName) add({ path: [...base, 'scriptName'], group: 'regex', label: `Tên regex: ${title}`, kind: 'name', text: r.scriptName, meta });
    if (typeof r.findRegex === 'string') add({ path: [...base, 'findRegex'], group: 'regex', label: `Find regex: ${title}`, kind: 'regexFind', text: r.findRegex, meta });
    if (typeof r.replaceString === 'string') add({ path: [...base, 'replaceString'], group: 'regex', label: `Replace: ${title}`, kind: 'auto', text: r.replaceString, meta: { ...meta, isReplace: true } });
  });

  for (const { script, path, folder } of thScriptList(d.extensions)) {
    const title = script.name || 'script';
    const meta = { title, folder: !!folder };
    if (script.name) add({ path: [...path.slice(0), 'name'], group: 'scripts', label: `${folder ? 'Thư mục' : 'Tên script'}: ${title}`, kind: 'name', text: script.name, meta });
    if (folder) continue;
    if (typeof script.content === 'string') add({ path: [...path, 'content'], group: 'scripts', label: `Mã script: ${title}`, kind: isSchemaScript(script.content) ? 'schema' : 'code', text: script.content, meta });
    if (typeof script.info === 'string' && script.info) add({ path: [...path, 'info'], group: 'scripts', label: `Mô tả script: ${title}`, kind: 'auto', text: script.info, meta });
    // nút của script: chỉ đổi tên nút mà chính script này lắng nghe bằng getButtonEvent('tên') — tên nút và lời gọi
    // được đổi cùng nhau theo từ điển. Nút của MVU (重新处理变量…) do bundle từ xa xử lý -> giữ nguyên.
    const btnList = Array.isArray(script.button?.buttons) ? script.button.buttons : Array.isArray(script.buttons) ? script.buttons : null;
    const btnBase = Array.isArray(script.button?.buttons) ? [...path, 'button', 'buttons'] : [...path, 'buttons'];
    (btnList || []).forEach((b, j) => {
      if (b && typeof b.name === 'string' && hasCJK(b.name) && scriptListensButton(script.content, b.name)) {
        add({ path: [...btnBase, j, 'name'], group: 'scripts', label: `Nút: ${b.name} (${title})`, kind: 'button', text: b.name, meta: { ...meta, button: true } });
      }
    });
    // dữ liệu riêng của script (biến script)
    if (isPlainObject(script.data) && hasCJK(JSON.stringify(script.data))) {
      add({ path: [...path, 'data'], group: 'scripts', label: `Dữ liệu script: ${title}`, kind: 'json', text: JSON.stringify(script.data, null, 2), meta: { ...meta, json: true, root: 'script.data' } });
    }
  }
  // biến nhân vật của Tavern Helper
  const thVars = d.extensions?.tavern_helper?.variables;
  if (isPlainObject(thVars) && hasCJK(JSON.stringify(thVars))) {
    add({ path: ['data', 'extensions', 'tavern_helper', 'variables'], group: 'scripts', label: 'Biến nhân vật (Tavern Helper)', kind: 'json', text: JSON.stringify(thVars, null, 2), meta: { json: true, root: 'tavern_helper.variables' } });
  }
  // trimStrings của regex (đồng bộ nhãn)
  (d.extensions?.regex_scripts || []).forEach((r, i) => {
    if (r && Array.isArray(r.trimStrings) && r.trimStrings.some(hasCJK)) {
      add({ path: ['data', 'extensions', 'regex_scripts', i, 'trimStrings'], group: 'regex', label: `Trim: ${r.scriptName || `Regex #${i + 1}`}`, kind: 'trimList', text: r.trimStrings.slice(), meta: { regexIndex: i } });
    }
  });
  return items;
}

function isPlainObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0; }

/** Script có gọi getButtonEvent('tên nút') với đúng tên này không */
export function scriptListensButton(content, name) {
  if (typeof content !== 'string' || !content.includes('getButtonEvent')) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('getButtonEvent\\s*\\(\\s*([\'"`])' + esc + '\\1\\s*\\)').test(content);
}

/** Ghép card đã dịch. outputs: Map(itemId -> giá trị mới) */
export function buildTranslatedCard(card, outputs) {
  const out = deepClone(card.raw);
  const items = listItems(card);
  for (const it of items) {
    if (!outputs.has(it.id)) continue;
    let v = outputs.get(it.id);
    if (it.kind === 'json') {
      // dữ liệu JSON (biến Tavern Helper…): đọc lại object; lỗi thì giữ bản gốc
      try { v = JSON.parse(v); } catch { continue; }
    }
    setPath(out, it.path, v);
  }
  const d = out.data;
  // đồng bộ tên lorebook với extensions.world
  const origBook = card.raw.data.character_book?.name;
  if (origBook && d.extensions?.world === card.raw.data.extensions?.world && card.raw.data.extensions?.world === origBook) {
    d.extensions.world = d.character_book.name;
  }
  // các trường V1 ở cấp trên (ST vẫn ghi cả hai)
  for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    if (k in out && typeof d[k] === 'string') out[k] = d[k];
  }
  if ('creatorcomment' in out && typeof d.creator_notes === 'string') out.creatorcomment = d.creator_notes;
  if (Array.isArray(out.tags) && Array.isArray(d.tags)) out.tags = d.tags.slice();
  return out;
}

export function exportCardJson(cardObj) {
  return JSON.stringify(cardObj, null, 4);
}

export function exportCardPng(imageBytes, cardObj) {
  const v2 = deepClone(cardObj);
  // ST ghi chunk "chara" bằng JSON v2 và "ccv3" bằng v3
  if (String(v2.spec || '').includes('v3')) { v2.spec = 'chara_card_v2'; v2.spec_version = '2.0'; }
  return writeCardToPng(imageBytes, JSON.stringify(v2));
}

export function getItemValue(cardObj, item) { return getPath(cardObj, item.path); }
