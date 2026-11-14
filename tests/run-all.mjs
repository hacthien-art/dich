// Kiểm thử bất biến của bộ phân tích trên các card mẫu trong thư mục gốc.
// 1) Không dịch + từ điển giữ nguyên  => render phải trả lại đúng 100% văn bản gốc
// 2) Dịch giả (chuỗi "khó": nháy, ${}, <, :, #) + đổi tên biến => schema/JS/YAML vẫn hợp lệ, InitVar qua được schema
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as yaml from 'js-yaml';
import { makeCard, listItems } from '../public/js/core/card.js';
import { scanCard, mergeScan, makeDictIndex } from '../public/js/core/dict.js';
import { analyzeItem, PH_RE } from '../public/js/core/analyze.js';
import { lexHtml } from '../public/js/core/lexer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cards = fs.readdirSync(ROOT).filter((f) => f.endsWith('.json') && !['package.json', 'package-lock.json'].includes(f));
let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

function scriptsOf(html) {
  const out = [];
  for (const t of lexHtml(html)) if (t.type === 'raw' && t.tag === 'script') {
    const attrs = html.slice(t.start - 200 > 0 ? t.start - 200 : 0, t.start);
    const isModule = /type\s*=\s*["']?module/i.test(attrs.slice(attrs.lastIndexOf('<script')));
    out.push({ code: html.slice(t.start, t.end), isModule });
  }
  return out;
}
function compiles(code, isModule) {
  try {
    let c = code;
    if (isModule || /^\s*(import|export)\s/m.test(c)) c = c.replace(/^\s*import\s[^\n]*$/gm, '').replace(/^(\s*)export\s+(default\s+)?/gm, '$1');
    new vm.Script('(async function(){' + c + '\n})');
    return null;
  } catch (e) { return e.message; }
}

function runSchema(code, data) {
  // bỏ import, chuyển export const -> const, bắt registerMvuSchema
  let captured = null;
  const body = code.replace(/^\s*import\s[^;\n]*;?/gm, '').replace(/^\s*export\s+(const|let|var|function)/gm, '$1');
  const fn = new Function('z', '_', '$', 'registerMvuSchema', body + '\n;return typeof Schema!=="undefined"?Schema:null;');
  const S = fn(z, {}, (cb) => cb(), (s) => { captured = s; }) || captured;
  if (!S) throw new Error('Không tìm thấy Schema');
  return S.safeParse(data);
}

const nastyTranslate = (key) => {
  // bản dịch giả: giữ placeholder, thêm ký tự nguy hiểm
  const phs = key.match(PH_RE) || [];
  return `Việt'"\`\${x}<b>&: # ` + key.replace(/[㐀-鿿]+/g, 'chữ') + (phs.length ? '' : '');
};

for (const file of cards) {
  console.log('\n=== ' + file);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  let card;
  try { card = makeCard(raw, { fileName: file }); } catch (e) { console.log('  (bỏ qua) ' + e.message); continue; }
  const items = listItems(card);
  const scan = scanCard(card, items);
  const dict = mergeScan({}, scan.entries);
  console.log(`  items=${items.length} dict=${scan.entries.length} (key=${scan.entries.filter((e) => e.kind === 'key').length}, value=${scan.entries.filter((e) => e.kind === 'value').length}, marker=${scan.entries.filter((e) => e.kind === 'marker').length}, term=${scan.entries.filter((e) => e.kind === 'term').length}) initvar=${scan.initVars.length} schema=${scan.schemas.length}`);
  for (const iv of scan.initVars) if (iv.error) fail('InitVar lỗi YAML: ' + iv.error);

  const settings = { varMode: 'translate', namingStyle: 'natural' };
  const idIndex = makeDictIndex(dict, settings);
  const entryNames = new Set((card.raw.data.character_book?.entries || []).map((e) => e.comment).filter(Boolean));
  const ctx = { dict: idIndex, entryNames, opts: { codeStrings: 'smart', chunkSize: 1800 } };

  // ---------- 1) bất biến đồng nhất
  let segCount = 0, segChars = 0;
  const analyses = new Map();
  let t0 = Date.now();
  for (const it of items) {
    const a = analyzeItem(it, ctx);
    analyses.set(it.id, a);
    segCount += a.segments.length;
    segChars += a.segments.reduce((n, s) => n + s.key.length, 0);
    const out = a.render({ tm: new Map(), dict: idIndex });
    const same = Array.isArray(it.text) ? JSON.stringify(out) === JSON.stringify([...new Set(it.text)]) : out === it.text;
    if (!same) {
      let i = 0; const a1 = String(it.text), b1 = String(out);
      while (i < a1.length && a1[i] === b1[i]) i++;
      fail(`Render không đồng nhất: ${it.label} @${i}: «${a1.slice(Math.max(0, i - 30), i + 40)}» vs «${b1.slice(Math.max(0, i - 30), i + 40)}»`);
    }
  }
  ok(`đồng nhất OK — ${segCount} đoạn, ${segChars} ký tự cần dịch, ${Date.now() - t0}ms`);
  const warns = [...new Set([...analyses.values()].flatMap((a) => a.warnings))];
  if (warns.length) console.log('  ! cảnh báo: ' + warns.slice(0, 5).join(' | '));

  // ---------- 2) dịch giả + đổi tên biến có dấu cách
  const fakeDict = JSON.parse(JSON.stringify(dict));
  let n = 0;
  for (const [src, v] of Object.entries(fakeDict)) v.dst = (v.kind === 'key' ? `Khóa ${++n} ${src.length}` : v.kind === 'value' ? `Giá trị ${++n}` : `Từ ${++n}`);
  const fIndex = makeDictIndex(fakeDict, settings);
  const tm = new Map();
  for (const a of analyses.values()) for (const s of a.segments) tm.set(s.key, nastyTranslate(s.key));
  const env = { tm, dict: fIndex, entryName: (s) => 'Mục ' + s.length, keysMode: 'append' };
  const outputs = new Map();
  for (const it of items) outputs.set(it.id, analyses.get(it.id).render(env));

  // a) script trong HTML vẫn biên dịch được (nếu bản gốc biên dịch được)
  let jsChecked = 0, jsBad = 0;
  for (const it of items) {
    if (typeof it.text !== 'string' || !/<script/i.test(it.text)) continue;
    const before = scriptsOf(it.text), after = scriptsOf(outputs.get(it.id));
    if (before.length !== after.length) { fail(`${it.label}: số thẻ <script> thay đổi ${before.length} -> ${after.length}`); continue; }
    before.forEach((b, i) => {
      if (/\$\d|\{\{/.test(b.code)) return; // có $1 / macro: chỉ hợp lệ sau khi thay thế
      const e0 = compiles(b.code, b.isModule);
      if (e0) return;
      jsChecked++;
      const e1 = compiles(after[i].code, after[i].isModule);
      if (e1) { jsBad++; fail(`${it.label}: script #${i} hỏng sau dịch: ${e1}`); }
    });
  }
  if (!jsBad) ok(`${jsChecked} script HTML vẫn biên dịch được sau khi dịch giả`);

  // b) script Tavern Helper
  for (const it of items) {
    if (it.kind !== 'schema' && it.kind !== 'code') continue;
    const e0 = compiles(it.text, true), e1 = compiles(outputs.get(it.id), true);
    if (!e0 && e1) fail(`${it.label}: hỏng sau dịch: ${e1}`); else ok(`${it.label}: biên dịch OK`);
  }

  // c) InitVar YAML parse + schema
  const ivItems = items.filter((it) => it.kind === 'initvar');
  const schemaItem = items.find((it) => it.kind === 'schema');
  for (const it of ivItems) {
    let d0, d1;
    try { d0 = yaml.load(it.text); } catch (e) { fail('InitVar gốc lỗi: ' + e.message); continue; }
    try { d1 = yaml.load(outputs.get(it.id)); } catch (e) { fail('InitVar sau dịch lỗi YAML: ' + e.message.split('\n')[0]); console.log(outputs.get(it.id).slice(0, 600)); continue; }
    const k0 = JSON.stringify(Object.keys(d0 || {})), k1 = JSON.stringify(Object.keys(d1 || {}));
    ok(`InitVar YAML OK: ${k0.slice(0, 80)} -> ${k1.slice(0, 80)}`);
    if (schemaItem) {
      try {
        const r0 = runSchema(schemaItem.text, d0);
        const r1 = runSchema(outputs.get(schemaItem.id), d1);
        if (!r0.success) console.log('  ! schema gốc không qua InitVar gốc: ' + JSON.stringify(r0.error.issues.slice(0, 2)));
        if (r0.success && !r1.success) fail('Schema sau dịch từ chối InitVar sau dịch: ' + JSON.stringify(r1.error.issues.slice(0, 3)).slice(0, 600));
        else if (r1.success) ok('Schema (sau dịch) chấp nhận InitVar (sau dịch) — đồng bộ biến OK');
        // so sánh cấu trúc sau parse
        const shape = (o) => (o && typeof o === 'object' ? Object.values(o).map(shape) : typeof o);
        if (r0.success && r1.success && JSON.stringify(shape(r0.data)) !== JSON.stringify(shape(r1.data))) fail('Cấu trúc dữ liệu sau schema khác nhau');
      } catch (e) { fail('Chạy schema lỗi: ' + e.message); }
    }
  }

  // d) placeholder không lọt ra ngoài
  for (const it of items) {
    const o = outputs.get(it.id);
    const s = Array.isArray(o) ? o.join('\n') : o;
    if (/⟦\d+⟧/.test(s)) fail(`${it.label}: còn placeholder trong kết quả`);
  }
  // e) khóa biến đã đổi trong regex HTML
  const statusRegex = items.filter((it) => it.meta?.isReplace && /stat_data/.test(it.text));
  for (const it of statusRegex) {
    const o = outputs.get(it.id);
    const left = (o.match(/stat_data[.\w'"[\]㐀-鿿]*/g) || []).filter((p) => /[㐀-鿿]/.test(p));
    if (left.length) console.log(`  ! ${it.label}: còn đường dẫn tiếng Trung: ${left.slice(0, 3).join(', ')}`);
    else ok(`${it.label}: đường dẫn stat_data đã đồng bộ`);
  }
}

console.log(failures ? `\n${failures} lỗi` : '\nTất cả kiểm thử đều qua ✓');
process.exit(failures ? 1 : 0);
