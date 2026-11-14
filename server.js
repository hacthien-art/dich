// Tavern Card Translator — máy chủ cục bộ
// - Phục vụ giao diện web (public/)
// - Chuyển tiếp yêu cầu tới proxy/API LLM (tránh lỗi CORS giống SillyTavern)
// - Lưu cài đặt / preset / dự án vào thư mục data/
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(argVal('--port') || process.env.PORT || 8686);
const HOST = argVal('--host') || process.env.HOST || '127.0.0.1';
const NO_OPEN = args.includes('--no-open') || process.env.NO_OPEN === '1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY = 80 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body quá lớn')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

const SAFE_NAME = /^[\p{L}\p{N}_\-. ()\[\]【】]{1,160}$/u;
function safeName(s) {
  if (typeof s !== 'string' || !SAFE_NAME.test(s) || s.includes('..') || s.startsWith('.')) throw new Error('Tên không hợp lệ: ' + s);
  return s;
}

// ---------------------------------------------------------------- LLM proxy
function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }

function normalizeBase(provider, url) {
  let u = trimSlash(url);
  if (!u) throw new Error('Chưa nhập URL proxy');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (provider === 'openai') u = u.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '').replace(/\/models$/i, '');
  if (provider === 'claude') u = u.replace(/\/messages$/i, '').replace(/\/models$/i, '');
  if (provider === 'gemini') u = u.replace(/\/v1(beta|alpha)?(\/models.*)?$/i, '');
  return u;
}

function authHeaders(provider, key, extra = {}) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'TavernCardTranslator/1.0' };
  if (provider === 'openai') { if (key) h['Authorization'] = 'Bearer ' + key; }
  else if (provider === 'claude') { if (key) { h['x-api-key'] = key; if (extra.claudeBearer) h['Authorization'] = 'Bearer ' + key; } h['anthropic-version'] = '2023-06-01'; }
  else if (provider === 'gemini') { if (key) h['x-goog-api-key'] = key; }
  if (extra.headers && typeof extra.headers === 'object') {
    for (const [k, v] of Object.entries(extra.headers)) if (k && v != null) h[k] = String(v);
  }
  return h;
}

function withKeyQuery(provider, url, key) {
  if (provider !== 'gemini' || !key) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, contentType: r.headers.get('content-type') || '' };
}

function parseModels(provider, json) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (Array.isArray(json?.data)) list = json.data;
  else if (Array.isArray(json?.models)) list = json.models;
  return list.map((m) => {
    if (typeof m === 'string') return { id: m };
    let id = m.id || m.name || m.model || '';
    if (provider === 'gemini') id = String(id).replace(/^models\//, '');
    return { id, name: m.display_name || m.displayName || m.name || undefined, owned_by: m.owned_by, context: m.context_length || m.inputTokenLimit || undefined };
  }).filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}

async function handleModels(req, res) {
  const { provider = 'openai', url, key, headers, claudeBearer } = await readJson(req);
  const base = normalizeBase(provider, url);
  const tries = [];
  if (provider === 'gemini') tries.push(base + '/v1beta/models?pageSize=1000');
  else {
    tries.push(base + '/models');
    if (!/\/v1$/i.test(base)) tries.push(base + '/v1/models');
  }
  let last;
  for (const t of tries) {
    try {
      const r = await fetchText(withKeyQuery(provider, t, key), { headers: authHeaders(provider, key, { headers, claudeBearer }) });
      last = r;
      if (!r.ok) continue;
      let json; try { json = JSON.parse(r.text); } catch { continue; }
      const models = parseModels(provider, json);
      const suggestedBase = provider === 'gemini' ? base : t.replace(/\/models(\?.*)?$/, '');
      return send(res, 200, { models, base: suggestedBase, tried: t });
    } catch (e) { last = { ok: false, status: 0, text: String(e?.cause?.message || e.message || e) }; }
  }
  send(res, 502, { error: `Không lấy được danh sách model (HTTP ${last?.status}): ${String(last?.text || '').slice(0, 600)}` });
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const { provider = 'openai', url, key, payload, stream, model, headers, claudeBearer } = body;
  const base = normalizeBase(provider, url);
  let target;
  if (provider === 'openai') target = base + '/chat/completions';
  else if (provider === 'claude') target = base + '/messages';
  else if (provider === 'gemini') target = `${base}/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  else return send(res, 400, { error: 'provider không hỗ trợ' });

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  let upstream;
  try {
    upstream = await fetch(withKeyQuery(provider, target, key), {
      method: 'POST',
      headers: authHeaders(provider, key, { headers, claudeBearer }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return send(res, 502, { error: 'Không kết nối được tới proxy: ' + (e?.cause?.message || e.message) });
  }
  const ct = upstream.headers.get('content-type') || 'application/json';
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return send(res, upstream.status, { error: `Proxy trả lỗi HTTP ${upstream.status}: ${text.slice(0, 2000)}`, status: upstream.status });
  }
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    if (!controller.signal.aborted) console.error('[chat] stream error:', e.message);
  }
  res.end();
}

// ---------------------------------------------------------------- storage
async function handleStore(req, res, parts) {
  const col = safeName(parts[0] || '');
  const dir = path.join(DATA_DIR, col);
  if (parts.length === 1) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    await fsp.mkdir(dir, { recursive: true });
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f));
      items.push({ id: f.slice(0, -5), size: st.size, mtime: st.mtimeMs });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, { items });
  }
  const id = safeName(decodeURIComponent(parts[1]));
  const file = path.join(dir, id + '.json');
  if (req.method === 'GET') {
    try { return send(res, 200, await fsp.readFile(file, 'utf8'), { 'Content-Type': 'application/json; charset=utf-8' }); }
    catch { return send(res, 200, 'null', { 'Content-Type': 'application/json; charset=utf-8' }); }
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const buf = await readBody(req);
    JSON.parse(buf.toString('utf8')); // kiểm tra hợp lệ
    await fsp.mkdir(dir, { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') {
    await fsp.rm(file, { force: true });
    return send(res, 200, { ok: true });
  }
  send(res, 405, { error: 'method' });
}

// ---------------------------------------------------------------- static
let indexCache = null;
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error('not file');
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (rel.startsWith('/vendor/') || rel.startsWith('/js/preview/')) headers['Access-Control-Allow-Origin'] = '*';
    if (rel === '/index.html') {
      if (!indexCache || indexCache.mtime !== st.mtimeMs) indexCache = { mtime: st.mtimeMs, html: await fsp.readFile(file, 'utf8') };
      const html = indexCache.html.replace('__APP_TOKEN__', TOKEN);
      res.writeHead(200, { ...headers, 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (req.headers['x-app-token'] !== TOKEN) return send(res, 403, { error: 'Token không hợp lệ — hãy tải lại trang (F5).' });
      if (p === '/api/llm/models' && req.method === 'POST') return await handleModels(req, res);
      if (p === '/api/llm/chat' && req.method === 'POST') return await handleChat(req, res);
      if (p === '/api/ping') return send(res, 200, { ok: true, version: '1.0.0' });
      if (p.startsWith('/api/store/')) return await handleStore(req, res, p.slice('/api/store/'.length).split('/').filter(Boolean));
      return send(res, 404, { error: 'API không tồn tại' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method');
    return await serveStatic(req, res, p);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const link = `http://${shown}:${PORT}/`;
  console.log('===============================================');
  console.log('  Tavern Card Translator đang chạy tại: ' + link);
  console.log('  (Đóng cửa sổ này để tắt app)');
  console.log('===============================================');
  if (!NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Cổng ${PORT} đang bị dùng. Chạy với cổng khác: node server.js --port 8687`);
  else console.error(e);
  process.exit(1);
});
