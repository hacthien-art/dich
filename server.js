// Tavern Card Translator — máy chủ cục bộ
// - Phục vụ giao diện web (public/)
// - Chuyển tiếp yêu cầu tới proxy/API LLM (tránh lỗi CORS giống SillyTavern)
// - Lưu cài đặt / preset / dự án vào thư mục data/
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import net from 'node:net';
import dns from 'node:dns/promises';
import { exec, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PKG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return {}; } })();
const APP_VERSION = PKG.version || '0.0.0';
const STARTED_AT = Date.now();
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(argVal('--port') || process.env.PORT || 8686);
// Cổng phụ phục vụ iframe xem trước: origin khác app nên code của card không đọc được dữ liệu/khóa API của app,
// nhưng vẫn có localStorage / IndexedDB thật như khi chạy trong SillyTavern.
const FRAME_PORT = Number(argVal('--frame-port') || process.env.FRAME_PORT || PORT + 1);
const HOST = argVal('--host') || process.env.HOST || '127.0.0.1';
const NO_OPEN = args.includes('--no-open') || process.env.NO_OPEN === '1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY = 512 * 1024 * 1024;
let frameReady = false;

// ---------------------------------------------------------------- nhật ký lỗi (data/server.log)
function logError(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts.map((p) => (p instanceof Error ? p.stack || p.message : String(p))).join(' ') + '\n';
  console.error(line.trim());
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const f = path.join(DATA_DIR, 'server.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, line);
  } catch { /* bỏ qua */ }
}
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

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
    // kiểm tra JSON hợp lệ (file rất lớn chỉ kiểm tra ký tự đầu để tiết kiệm RAM)
    if (buf.length < 64 * 1024 * 1024) JSON.parse(buf.toString('utf8'));
    else if (!['{', '['].includes(String.fromCharCode(buf[0]))) throw new Error('Dữ liệu JSON không hợp lệ');
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

/** File nhị phân (ảnh card...) — data/<col>/<id> */
async function handleBlob(req, res, parts) {
  const col = safeName(parts[0] || '');
  const id = safeName(decodeURIComponent(parts[1] || ''));
  const file = path.join(DATA_DIR, col, id);
  if (req.method === 'GET') {
    let st;
    try { st = await fsp.stat(file); } catch { return send(res, 404, { error: 'not found' }); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (req.method === 'PUT') {
    const buf = await readBody(req);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + '.tmp', buf);
    await fsp.rename(file + '.tmp', file);
    return send(res, 200, { ok: true, size: buf.length });
  }
  if (req.method === 'DELETE') {
    await fsp.rm(file, { force: true });
    return send(res, 200, { ok: true });
  }
  send(res, 405, { error: 'method' });
}

// ---------------------------------------------------------------- tải link ngoài của card (mã / dữ liệu trên GitHub, jsDelivr…)
// Trình duyệt không tải thẳng được vì CORS, nên máy chủ cục bộ tải hộ. URL lấy từ nội dung card (không tin cậy), vì vậy:
// chỉ http/https, chặn địa chỉ nội bộ (card không được mượn app để đọc dịch vụ trong mạng riêng của máy), giới hạn dung lượng.
const FETCH_MAX = 128 * 1024 * 1024;
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Không tải từ địa chỉ nội bộ: ' + host);
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('Không phân giải được tên miền: ' + host);
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('Không tải từ địa chỉ nội bộ: ' + host);
}
async function handleFetch(req, res) {
  const { url } = await readJson(req);
  let cur = String(url || '').trim();
  try {
    for (let hop = 0; hop < 6; hop++) {
      let u;
      try { u = new URL(cur); } catch { return send(res, 400, { error: 'URL không hợp lệ' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return send(res, 400, { error: 'Chỉ tải được link http / https' });
      await assertPublicHost(u.hostname);
      const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'TavernCardTranslator/1.3', Accept: '*/*' }, signal: AbortSignal.timeout(90000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) return send(res, 502, { error: `Máy chủ của link trả lỗi HTTP ${r.status}` });
      if (Number(r.headers.get('content-length') || 0) > FETCH_MAX) return send(res, 413, { error: 'Tệp quá lớn (trên 128 MB)' });
      const chunks = [];
      let size = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > FETCH_MAX) { reader.cancel().catch(() => {}); return send(res, 413, { error: 'Tệp quá lớn (trên 128 MB)' }); }
        chunks.push(Buffer.from(value));
      }
      return send(res, 200, Buffer.concat(chunks), { 'X-Final-Url': encodeURIComponent(cur), 'X-Content-Type': encodeURIComponent(r.headers.get('content-type') || '') });
    }
    return send(res, 502, { error: 'Link chuyển hướng quá nhiều lần' });
  } catch (e) {
    return send(res, 502, { error: 'Không tải được link: ' + (e?.cause?.message || e.message || e) });
  }
}

// ---------------------------------------------------------------- iframe xem trước (origin riêng)
const frameStore = new Map(); // id -> { html: Buffer, t, size }
let frameBytes = 0;
const FRAME_TTL = 3 * 3600 * 1000, FRAME_MAX_BYTES = 400 * 1024 * 1024, FRAME_MAX = 500;
function pruneFrames() {
  const now = Date.now();
  for (const [id, f] of frameStore) {
    if (now - f.t > FRAME_TTL || frameBytes > FRAME_MAX_BYTES || frameStore.size > FRAME_MAX) { frameStore.delete(id); frameBytes -= f.size; }
    else break;
  }
}
async function handleFramePost(req, res) {
  const buf = await readBody(req);
  const id = crypto.randomBytes(16).toString('hex');
  frameStore.set(id, { html: buf, t: Date.now(), size: buf.length });
  frameBytes += buf.length;
  pruneFrames();
  send(res, 200, { id, port: frameReady ? FRAME_PORT : 0 });
}
const frameServer = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method');
    const m = p.match(/^\/f\/([0-9a-f]{32})$/);
    if (m) {
      const f = frameStore.get(m[1]);
      if (!f) return send(res, 404, 'Khung xem trước đã hết hạn — bấm "Vẽ lại" trong app.');
      f.t = Date.now();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(f.html);
    }
    if (p.startsWith('/vendor/') || p === '/js/preview/th-env.js') return await serveStatic(req, res, p);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    send(res, 404, 'Not found');
  } catch (e) {
    logError('[frame]', e);
    if (!res.headersSent) send(res, 500, 'error'); else res.end();
  }
});

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
      const html = indexCache.html.replace('__APP_TOKEN__', TOKEN).replace('__FRAME_PORT__', frameReady ? String(FRAME_PORT) : '0');
      res.writeHead(200, { ...headers, 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------- cập nhật từ GitHub
// Cài bằng git clone -> git fetch + merge --ff-only; tải zip -> tải zip nhánh main và chép đè (giữ nguyên data/).
const UPDATE_BRANCH = 'main';
const VERSION_FILE = path.join(ROOT, 'version.json'); // sha của bản zip đã cài (không có trong repo)
let updateCache = null; // { t, result }

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

function repoOf(url) {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

async function gitInfo() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { git: false };
  const v = await run('git', ['--version'], { timeout: 8000 });
  if (v.code) return { git: false, noGitBinary: true };
  const [sha, branch, remote, status] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    run('git', ['remote', 'get-url', 'origin']), run('git', ['status', '--porcelain', '--untracked-files=no']),
  ]);
  return { git: true, sha: sha.stdout.trim(), branch: branch.stdout.trim(), remote: remote.stdout.trim(), dirty: !!status.stdout.trim() };
}

function localZipSha() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).sha || null; } catch { return null; }
}

function semverGt(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0), pb = String(b || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function ghJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'TavernCardTranslator-Updater', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GitHub trả lỗi HTTP ${r.status}${r.status === 403 ? ' (có thể vượt giới hạn truy vấn, thử lại sau ít phút)' : ''}`);
  return r.json();
}

async function checkUpdate(force) {
  if (!force && updateCache && Date.now() - updateCache.t < 20 * 60 * 1000) return updateCache.result;
  const info = await gitInfo();
  const repo = repoOf(PKG.repository?.url || PKG.repository) || repoOf(info.remote);
  if (!repo) throw new Error('Không xác định được kho GitHub của app (thiếu "repository" trong package.json)');
  const base = { repo: `${repo.owner}/${repo.name}`, branch: UPDATE_BRANCH, current: { version: APP_VERSION, sha: info.sha || localZipSha() } };
  let result = null;
  if (info.git) {
    const f = await run('git', ['fetch', '--quiet', 'origin', UPDATE_BRANCH], { timeout: 60000 });
    if (!f.code) {
      const ref = `origin/${UPDATE_BRANCH}`;
      const [behind, ahead, log, pkg, rsha] = await Promise.all([
        run('git', ['rev-list', '--count', `HEAD..${ref}`]), run('git', ['rev-list', '--count', `${ref}..HEAD`]),
        run('git', ['log', '--format=%h%x09%cI%x09%s', `HEAD..${ref}`, '-n', '40']),
        run('git', ['show', `${ref}:package.json`]), run('git', ['rev-parse', ref]),
      ]);
      let latestVersion = null;
      try { latestVersion = JSON.parse(pkg.stdout).version; } catch { /* */ }
      const nBehind = parseInt(behind.stdout, 10) || 0;
      const commits = log.stdout.split('\n').filter(Boolean).map((l) => { const [sha, date, ...msg] = l.split('\t'); return { sha, date, message: msg.join('\t') }; });
      result = {
        ...base, method: 'git', latest: { version: latestVersion, sha: rsha.stdout.trim() }, behind: nBehind, ahead: parseInt(ahead.stdout, 10) || 0,
        available: nBehind > 0, commits, dirty: info.dirty, onBranch: info.branch === UPDATE_BRANCH,
        canApply: nBehind > 0 && info.branch === UPDATE_BRANCH,
        note: info.branch !== UPDATE_BRANCH ? `Thư mục app đang ở nhánh "${info.branch}" — chỉ tự cập nhật được trên nhánh ${UPDATE_BRANCH}.` : info.dirty ? 'Có file trong app bị sửa tay (git status) — nếu trùng với bản mới, cập nhật sẽ dừng để không ghi đè.' : '',
      };
    }
  }
  if (!result) {
    // không có git (cài bằng zip) hoặc git fetch lỗi -> hỏi GitHub API
    const api = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
    const head = await ghJson(`${api}/commits/${UPDATE_BRANCH}`);
    let latestVersion = null;
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${head.sha}/package.json`, { headers: { 'User-Agent': 'TavernCardTranslator-Updater' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) latestVersion = (await r.json()).version || null;
    } catch { /* */ }
    const cur = base.current.sha;
    const available = cur ? head.sha !== cur && !head.sha.startsWith(cur) : semverGt(latestVersion, APP_VERSION);
    let commits = [];
    try {
      if (cur && available) {
        const cmp = await ghJson(`${api}/compare/${cur}...${head.sha}`);
        commits = (cmp.commits || []).reverse().slice(0, 40).map((c) => ({ sha: c.sha.slice(0, 7), date: c.commit?.committer?.date, message: String(c.commit?.message || '').split('\n')[0] }));
      } else if (available) {
        commits = [{ sha: head.sha.slice(0, 7), date: head.commit?.committer?.date, message: String(head.commit?.message || '').split('\n')[0] }];
      }
    } catch { /* */ }
    result = {
      ...base, method: info.git && !info.noGitBinary ? 'git-api' : 'zip', latest: { version: latestVersion, sha: head.sha }, available, commits,
      canApply: available && !(info.git && !info.noGitBinary),
      note: info.git && !info.noGitBinary ? 'Không chạy được "git fetch" (mạng/quyền truy cập?) — hãy chạy "git pull" trong thư mục app.' : '',
    };
  }
  updateCache = { t: Date.now(), result };
  return result;
}

/** Giải nén zip (đủ cho file zip GitHub tạo: stored/deflate) -> [{ name, data }] */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('File zip hỏng (không tìm thấy End of Central Directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Central directory của zip hỏng');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Local header của zip hỏng: ' + name);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error('Kiểu nén zip không hỗ trợ: ' + method);
    if (data.length !== usize) throw new Error('Giải nén sai kích thước: ' + name);
    out.push({ name, data });
  }
  return out;
}

async function applyUpdate() {
  const st = await checkUpdate(true);
  if (!st.available) return { updated: false, message: 'Đang dùng bản mới nhất.' };
  if (st.method === 'git') {
    if (!st.onBranch) throw new Error(st.note);
    const r = await run('git', ['merge', '--ff-only', `origin/${UPDATE_BRANCH}`], { timeout: 120000 });
    if (r.code) throw new Error('git không cập nhật được (thường do file trong app bị sửa tay). Chi tiết: ' + (r.stderr || r.stdout).trim().slice(0, 800));
    updateCache = null;
    return { updated: true, method: 'git', message: `Đã cập nhật ${st.behind} thay đổi (${st.current.sha?.slice(0, 7)} → ${st.latest.sha.slice(0, 7)}).` };
  }
  if (st.method !== 'zip') throw new Error(st.note || 'Không tự cập nhật được — hãy chạy "git pull" trong thư mục app.');
  const [owner, name] = st.repo.split('/');
  const r = await fetch(`https://codeload.github.com/${owner}/${name}/zip/${st.latest.sha}`, { headers: { 'User-Agent': 'TavernCardTranslator-Updater' }, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`Không tải được bản mới (HTTP ${r.status})`);
  const entries = unzip(Buffer.from(await r.arrayBuffer()));
  // chép đè file của app; không đụng tới dữ liệu người dùng
  const SKIP = /^(data|node_modules|\.git)(\/|$)/;
  let n = 0;
  const writes = [];
  for (const e of entries) {
    const rel = e.name.split('/').slice(1).join('/'); // bỏ thư mục gốc "dich-<sha>/"
    if (!rel || SKIP.test(rel) || rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) continue;
    const dest = path.join(ROOT, rel);
    if (!dest.startsWith(ROOT + path.sep)) continue;
    writes.push({ dest, data: e.data });
  }
  if (!writes.some((w) => w.dest === path.join(ROOT, 'server.js'))) throw new Error('File zip không giống mã nguồn app (thiếu server.js) — dừng cập nhật');
  for (const w of writes) {
    await fsp.mkdir(path.dirname(w.dest), { recursive: true });
    await fsp.writeFile(w.dest + '.upd-tmp', w.data);
    await fsp.rename(w.dest + '.upd-tmp', w.dest);
    n++;
  }
  await fsp.writeFile(VERSION_FILE, JSON.stringify({ sha: st.latest.sha, version: st.latest.version, updatedAt: new Date().toISOString() }, null, 2));
  updateCache = null;
  return { updated: true, method: 'zip', message: `Đã tải bản mới (${n} file) — ${st.latest.version || st.latest.sha.slice(0, 7)}.` };
}

/** Khởi động lại: đóng cổng, chạy tiến trình máy chủ mới dùng chung cửa sổ console; tiến trình này đợi tới khi nó thoát */
let restarting = false;
function restartSelf() {
  if (restarting) return;
  restarting = true;
  console.log('Đang khởi động lại để dùng bản mới…');
  const args = process.argv.slice(1).filter((a) => a !== '--no-open');
  args.push('--no-open');
  let pending = 2;
  const go = () => {
    if (--pending > 0) return;
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TCT_RESTART: '1' } });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (e) => { logError('Không khởi động lại được', e); process.exit(1); });
  };
  for (const srv of [server, frameServer]) {
    srv.closeAllConnections?.();
    if (srv.listening) srv.close(() => go()); else go();
  }
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // kiểm tra sống (không cần token) — trang dùng để biết máy chủ đã khởi động lại xong sau khi cập nhật
    if (p === '/healthz') return send(res, 200, { ok: true, version: APP_VERSION, started: STARTED_AT });
    if (p.startsWith('/api/')) {
      if (req.headers['x-app-token'] !== TOKEN) return send(res, 403, { error: 'Token không hợp lệ — hãy tải lại trang (F5).' });
      if (p === '/api/llm/models' && req.method === 'POST') return await handleModels(req, res);
      if (p === '/api/llm/chat' && req.method === 'POST') return await handleChat(req, res);
      if (p === '/api/ping') return send(res, 200, { ok: true, version: APP_VERSION, started: STARTED_AT });
      if (p === '/api/update/check' && req.method === 'POST') {
        const { force } = await readJson(req);
        try { return send(res, 200, await checkUpdate(!!force)); } catch (e) { return send(res, 200, { error: String(e.message || e), current: { version: APP_VERSION } }); }
      }
      if (p === '/api/update/apply' && req.method === 'POST') {
        try { return send(res, 200, await applyUpdate()); } catch (e) { logError('[update]', e); return send(res, 500, { error: String(e.message || e) }); }
      }
      if (p === '/api/update/restart' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(restartSelf, 300);
        return;
      }
      if (p.startsWith('/api/store/')) return await handleStore(req, res, p.slice('/api/store/'.length).split('/').filter(Boolean));
      if (p.startsWith('/api/blob/')) return await handleBlob(req, res, p.slice('/api/blob/'.length).split('/').filter(Boolean));
      if (p === '/api/frame' && req.method === 'POST') return await handleFramePost(req, res);
      if (p === '/api/fetch' && req.method === 'POST') return await handleFetch(req, res);
      return send(res, 404, { error: 'API không tồn tại' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method');
    return await serveStatic(req, res, p);
  } catch (e) {
    logError('[api]', req.method, p, e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

// sau khi tự cập nhật, tiến trình mới có thể phải đợi tiến trình cũ nhả cổng -> thử lại vài lần
const RESTARTED = process.env.TCT_RESTART === '1';
function listenOnce(srv, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { srv.off('listening', onOk); reject(e); };
    const onOk = () => { srv.off('error', onErr); resolve(); };
    srv.once('error', onErr);
    srv.once('listening', onOk);
    srv.listen(port, HOST);
  });
}
async function listenRetry(srv, port) {
  for (let i = 0; ; i++) {
    try { return await listenOnce(srv, port); } catch (e) {
      if (e.code !== 'EADDRINUSE' || !RESTARTED || i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

(async () => {
  try { await listenRetry(frameServer, FRAME_PORT); frameReady = true; } catch (e) {
    frameReady = false;
    logError(`Không mở được cổng ${FRAME_PORT} cho iframe xem trước (${e.code}) — dùng chế độ sandbox dự phòng.`);
  }
  try { await listenRetry(server, PORT); } catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`Cổng ${PORT} đang bị dùng (có thể app đã đang chạy). Chạy với cổng khác: node server.js --port 8690`);
    else logError(e);
    process.exit(1);
  }
  server.on('error', (e) => logError('[server]', e));
  frameServer.on('error', (e) => logError('[frame]', e));
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const link = `http://${shown}:${PORT}/`;
  console.log('===============================================');
  console.log(`  Tavern Card Translator v${APP_VERSION} đang chạy tại: ` + link);
  console.log(frameReady ? `  Xem trước iframe: cổng ${FRAME_PORT}` : '  (Xem trước iframe dùng chế độ sandbox dự phòng)');
  console.log('  (Đóng cửa sổ này để tắt app)');
  console.log('===============================================');
  if (!NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
})();
