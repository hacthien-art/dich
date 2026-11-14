// Lưu trữ phía máy chủ (data/<collection>/<id>.json)
const token = () => document.querySelector('meta[name="app-token"]')?.content || '';

async function req(method, path, body) {
  const r = await fetch('/api/store/' + path, {
    method,
    headers: { 'X-App-Token': token(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* */ }
    throw new Error(msg || 'HTTP ' + r.status);
  }
  return text ? JSON.parse(text) : null;
}

const enc = (s) => encodeURIComponent(s);
export const store = {
  list: (col) => req('GET', enc(col)).then((r) => r?.items || []),
  get: (col, id) => req('GET', enc(col) + '/' + enc(id)),
  put: (col, id, data) => req('PUT', enc(col) + '/' + enc(id), data),
  del: (col, id) => req('DELETE', enc(col) + '/' + enc(id)),
};

export function safeId(name) {
  return String(name || 'item').replace(/[^\p{L}\p{N}_\-. ()\[\]【】]/gu, '_').replace(/^\.+/, '').slice(0, 120) || 'item';
}
