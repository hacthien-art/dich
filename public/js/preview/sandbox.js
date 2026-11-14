// Chạy schema Zod (script MVU Zod của card) trong iframe cô lập để kiểm tra InitVar
import { vendorSources, inlineScript } from './render.js';

let seq = 0;

function rewriteImports(code) {
  return String(code)
    .replace(/^\s*import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]*(?:mvu_zod|MagVarUpdate|tavern_resource)[^'"]*)\2\s*;?/gm, (m, names) => `const {${names}} = window.__stub;`)
    .replace(/^\s*import\s*(['"])[^'"]*(?:MagVarUpdate|bundle\.js)[^'"]*\1\s*;?/gm, '')
    .replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s*(['"])[^'"]*(?:mvu_zod)[^'"]*\2\s*;?/gm, (m, n) => `const ${n} = window.__stub;`);
}

const LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
function safeJson(o) {
  return JSON.stringify(o ?? null).replace(/</g, '\\u003c').replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029');
}

/** Trả về { ok, data, issues, error } */
export async function validateSchema(code, data, { timeout = 20000 } = {}) {
  let libs;
  try { libs = await vendorSources(['lodash', 'jquery', 'zod', 'yaml']); } catch (e) { return { ok: false, error: e.message }; }
  return new Promise((resolve) => {
    const id = 'sb' + (++seq) + '_' + Date.now();
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    const done = (r) => { window.removeEventListener('message', onMsg); clearTimeout(timer); iframe.remove(); resolve(r); };
    const onMsg = (ev) => { if (ev.data && ev.data.__sb === id) done(ev.data.result); };
    window.addEventListener('message', onMsg);
    const timer = setTimeout(() => done({ ok: false, error: 'Hết thời gian chờ (có thể schema cần tải thư viện qua mạng)' }), timeout);
    const body = rewriteImports(code);
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8">
${inlineScript(libs.lodash)}
${inlineScript(libs.jquery)}
${inlineScript(libs.zod)}
${inlineScript(libs.yaml)}
<script>
  window.__reg = null;
  window.registerMvuSchema = function (s) { window.__reg = s; };
  window.__stub = { registerMvuSchema: window.registerMvuSchema };
  var __send = function (r) { parent.postMessage({ __sb: ${JSON.stringify(id)}, result: r }, '*'); };
  window.addEventListener('error', function (e) { __send({ ok: false, error: 'Lỗi script: ' + e.message }); });
  window.__DATA__ = ${safeJson(data)};
<\/script>
<script type="module">
${body.replace(/<\/script/gi, '<\\/script')}
;(async () => {
  try {
    await new Promise((r) => setTimeout(r, 80));
    const S = (typeof Schema !== 'undefined' && Schema) || window.__reg;
    if (!S || typeof S.safeParse !== 'function') { __send({ ok: false, error: 'Không tìm thấy Schema (export const Schema / registerMvuSchema)' }); return; }
    const r = S.safeParse(window.__DATA__);
    if (r.success) __send({ ok: true, data: JSON.parse(JSON.stringify(r.data)) });
    else __send({ ok: false, error: 'Schema từ chối dữ liệu', issues: (r.error.issues || []).map((i) => ({ path: (i.path || []).join('.'), message: i.message, code: i.code })) });
  } catch (e) { __send({ ok: false, error: String(e && e.message || e) }); }
})();
<\/script></head><body></body></html>`;
    document.body.appendChild(iframe);
  });
}
