// Cập nhật app từ GitHub: kiểm tra bản mới, xem danh sách thay đổi, cài & tự khởi động lại máy chủ
import { h, toast, modal } from './dom.js';

const token = () => document.querySelector('meta[name="app-token"]')?.content || '';
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token() }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) => { try { return new Date(d).toLocaleString('vi-VN'); } catch { return d || ''; } };

export function createUpdater(app) {
  const btn = document.getElementById('btnUpdate');
  let last = null;
  let busy = false;
  btn?.addEventListener('click', () => openDialog());

  function show(r) {
    if (!btn) return;
    btn.hidden = !r?.available;
    if (r?.available) {
      const v = r.latest?.version && r.latest.version !== r.current?.version ? ` v${r.latest.version}` : '';
      btn.textContent = `⬆ Cập nhật${v}`;
      btn.title = `Có bản mới trên GitHub (${r.repo}): ${r.commits?.length || r.behind || 1} thay đổi — bấm để xem và cập nhật`;
    }
  }

  /** force=true: hỏi lại GitHub ngay (bỏ qua bộ nhớ đệm 20 phút của máy chủ) */
  async function check(force = false, { silent = true } = {}) {
    let r;
    try { r = await post('/api/update/check', { force }); } catch (e) { r = { error: e.message }; }
    last = r;
    if (r.error) {
      if (!silent) toast('Không kiểm tra được cập nhật: ' + r.error, 'err', 8000);
      return r;
    }
    show(r);
    if (!silent) {
      if (r.available) openDialog();
      else toast(`Đang dùng bản mới nhất (v${r.current?.version}${r.current?.sha ? ' · ' + r.current.sha.slice(0, 7) : ''}) ✓`, 'ok', 5000);
    }
    return r;
  }

  async function openDialog() {
    const r = last;
    if (!r || r.error) return check(true, { silent: false });
    if (!r.available) { toast('Đang dùng bản mới nhất ✓', 'ok'); return; }
    const list = (r.commits || []).map((c) => h('li', null, h('code', null, c.sha), ' ', c.message, c.date ? h('span', { class: 'muted small' }, ' · ' + fmtDate(c.date)) : null));
    const body = h('div', null,
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('span', { class: 'pill' }, `Hiện tại: v${r.current?.version}${r.current?.sha ? ' · ' + r.current.sha.slice(0, 7) : ''}`),
        h('span', null, '→'),
        h('span', { class: 'pill ok' }, `Bản mới: ${r.latest?.version ? 'v' + r.latest.version : ''} · ${String(r.latest?.sha || '').slice(0, 7)}`),
        h('span', { class: 'muted small' }, `${r.repo} · nhánh ${r.branch} · ${r.method === 'git' ? 'cập nhật bằng git' : 'tải bản zip'}`)),
      list.length ? h('div', null, h('b', null, `Các thay đổi (${list.length}):`), h('ul', { class: 'small', style: { maxHeight: '300px', overflow: 'auto' } }, list)) : null,
      r.note ? h('div', { class: 'card-box tight warn small' }, '⚠ ' + r.note) : null,
      h('div', { class: 'muted small' }, 'Dữ liệu của bạn trong thư mục data/ (dự án, preset, cài đặt, khóa API) được giữ nguyên. App sẽ tự khởi động lại và tải lại trang sau khi cập nhật.'));
    const go = await modal('⬆ Có bản cập nhật mới', body, [
      { label: 'Để sau', value: false },
      { label: '⬆ Cập nhật ngay', cls: 'primary', value: true },
    ]);
    if (go) await apply();
  }

  async function apply() {
    if (busy) return;
    if (app.running) { toast('Đang dịch — hãy dừng hoặc đợi dịch xong rồi cập nhật.', 'warn', 6000); return; }
    if (last && last.available && last.canApply === false) { toast(last.note || 'Không tự cập nhật được — hãy chạy "git pull" trong thư mục app.', 'warn', 9000); return; }
    busy = true;
    const overlay = h('div', { class: 'modal-back' }, h('div', { class: 'modal', style: { width: 'min(460px, 100%)' } },
      h('div', { class: 'modal-head' }, '⬆ Đang cập nhật…'),
      h('div', { class: 'modal-body' }, h('div', { class: 'update-status' }, 'Đang tải bản mới từ GitHub…'))));
    const status = overlay.querySelector('.update-status');
    document.getElementById('modalRoot').appendChild(overlay);
    try {
      await app.saveProjectNow?.();
      const res = await post('/api/update/apply', {});
      if (res.error) throw new Error(res.error);
      if (!res.updated) { overlay.remove(); toast(res.message || 'Đang dùng bản mới nhất ✓', 'ok'); btn.hidden = true; return; }
      status.textContent = (res.message || 'Đã cập nhật.') + ' Đang khởi động lại app…';
      const before = await fetch('/healthz', { cache: 'no-store' }).then((x) => x.json()).catch(() => ({}));
      await post('/api/update/restart', {});
      const t0 = Date.now();
      for (;;) {
        await sleep(900);
        try {
          const j = await fetch('/healthz', { cache: 'no-store' }).then((x) => x.json());
          if (j.started && j.started !== before.started) { status.textContent = `Xong — đang mở phiên bản v${j.version}…`; await sleep(400); location.reload(); return; }
        } catch { /* máy chủ đang khởi động lại */ }
        if (Date.now() - t0 > 60000) throw new Error('Đã cập nhật nhưng app chưa tự khởi động lại được — hãy đóng cửa sổ console rồi chạy lại Start.bat.');
      }
    } catch (e) {
      overlay.remove();
      toast('Cập nhật lỗi: ' + e.message, 'err', 12000);
      app.log?.('Cập nhật lỗi: ' + e.message, 'error');
    } finally { busy = false; }
  }

  return { check, openDialog, get last() { return last; } };
}
