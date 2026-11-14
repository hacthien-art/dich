// Mô phỏng cập nhật biến MVU trong xem trước: đọc <UpdateVariable> (JSON Patch mở rộng hoặc lệnh _.set)
import { deepClone } from './util.js';

function ptrToPath(ptr) {
  return String(ptr || '').replace(/^\//, '').split('/').filter((s) => s !== '').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function dotToPath(p) {
  return String(p || '').replace(/^stat_data\./, '').replace(/\[(\d+)\]/g, '.$1').replace(/\[['"]([^'"\]]+)['"]\]/g, '.$1').split('.').filter(Boolean);
}
function getAt(obj, path) { let o = obj; for (const k of path) { if (o == null) return undefined; o = o[k]; } return o; }
function parentOf(obj, path, create = true) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null) { if (!create) return null; o[path[i]] = /^\d+$/.test(path[i + 1]) ? [] : {}; }
    o = o[path[i]];
  }
  return o;
}
function unwrap(v) { return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && typeof v[0] !== 'object' ? v[0] : v; }
function setAt(obj, path, value) {
  if (!path.length) return;
  const p = parentOf(obj, path);
  const k = path[path.length - 1];
  const cur = p[k];
  if (Array.isArray(cur) && cur.length === 2 && typeof cur[1] === 'string' && typeof cur[0] !== 'object' && typeof value !== 'object') cur[0] = value; // [giá trị, mô tả]
  else p[k] = value;
}
function removeAt(obj, path) {
  const p = parentOf(obj, path, false);
  if (!p) return;
  const k = path[path.length - 1];
  if (Array.isArray(p)) p.splice(Number(k), 1); else delete p[k];
}

export function applyPatch(data, ops) {
  for (const op of Array.isArray(ops) ? ops : [ops]) {
    if (!op || typeof op !== 'object') continue;
    const path = ptrToPath(op.path);
    switch (String(op.op || '').toLowerCase()) {
      case 'replace': case 'add': {
        const p = parentOf(data, path);
        const k = path[path.length - 1];
        if (Array.isArray(p) && op.op === 'add') { if (k === '-') p.push(op.value); else p.splice(Number(k), 0, op.value); }
        else setAt(data, path, op.value);
        break;
      }
      case 'insert': {
        const p = parentOf(data, path);
        const k = path[path.length - 1];
        if (Array.isArray(p)) { if (k === '-') p.push(op.value); else p.splice(Number(k), 0, op.value); }
        else p[k] = op.value;
        break;
      }
      case 'delta': {
        const cur = Number(unwrap(getAt(data, path))) || 0;
        setAt(data, path, cur + Number(op.value || 0));
        break;
      }
      case 'remove': removeAt(data, path); break;
      case 'move': {
        const from = ptrToPath(op.from);
        const v = getAt(data, from);
        removeAt(data, from);
        setAt(data, path, v);
        break;
      }
      default: break;
    }
  }
}

function parseArgs(s) {
  const args = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if ('[{('.includes(c)) depth++;
    if (']})'.includes(c)) depth--;
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args.map(parseValue);
}
function parseValue(t) {
  if (/^(['"`])([\s\S]*)\1$/.test(t)) return t.slice(1, -1).replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === 'undefined') return null;
  try { return JSON.parse(t); } catch { /* */ }
  try { return JSON.parse(t.replace(/'/g, '"')); } catch { return t; }
}

/** Áp dụng các lệnh cập nhật trong tin nhắn -> stat_data mới (bản sao) */
export function applyMvuUpdates(statData, text) {
  const data = deepClone(statData || {});
  if (!text) return data;
  const blocks = [...String(text).matchAll(/<(UpdateVariable|update)>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  for (const b of blocks) {
    const jp = b.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i)?.[1] ?? b.match(/\[\s*\{[\s\S]*\}\s*\]/)?.[0];
    if (jp) { try { applyPatch(data, JSON.parse(jp)); } catch { /* JSON lỗi */ } }
    for (const m of b.matchAll(/_\.(set|add|insert|assign|remove|unset|delete)\s*\(([\s\S]*?)\)\s*;/g)) {
      const fn = m[1];
      const args = parseArgs(m[2]);
      const path = dotToPath(args[0]);
      if (!path.length) continue;
      if (fn === 'set') setAt(data, path, args.length >= 3 ? args[2] : args[1]);
      else if (fn === 'add') {
        const cur = unwrap(getAt(data, path));
        if (typeof cur === 'number' || typeof args[1] === 'number') setAt(data, path, (Number(cur) || 0) + Number(args[1] || 0));
        else if (Array.isArray(cur)) cur.push(args[1]);
      } else if (fn === 'insert' || fn === 'assign') {
        const cur = getAt(data, path);
        if (Array.isArray(cur)) { if (args.length >= 3) cur.splice(Number(args[1]), 0, args[2]); else cur.push(args[1]); }
        else if (cur && typeof cur === 'object') { if (args.length >= 3) cur[args[1]] = args[2]; else Object.assign(cur, args[1]); }
        else setAt(data, path, args.length >= 3 ? { [args[1]]: args[2] } : args[1]);
      } else if (fn === 'remove' || fn === 'unset' || fn === 'delete') {
        if (args.length >= 2) {
          const cur = getAt(data, path);
          if (Array.isArray(cur)) { const i = typeof args[1] === 'number' ? args[1] : cur.indexOf(args[1]); if (i >= 0) cur.splice(i, 1); }
          else if (cur && typeof cur === 'object') delete cur[args[1]];
        } else removeAt(data, path);
      }
    }
  }
  return data;
}
