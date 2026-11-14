// Điều khiển chính của app
import { h, clear, toast, modal, confirmBox, download, readFileBytes, fmtTime } from './ui/dom.js';
import { store, safeId } from './ui/store.js';
import { parseCardFile } from './core/card.js';
import { DEFAULT_PRESET, importPreset } from './core/preset.js';
import { runTranslation, suggestDict } from './core/translate.js';
import { Project, DEFAULT_TRANSLATE_SETTINGS } from './project.js';
import { uuid, debounce, deepClone } from './core/util.js';
import * as TabConnect from './ui/tab-connect.js';
import * as TabPreset from './ui/tab-preset.js';
import * as TabCard from './ui/tab-card.js';
import * as TabVars from './ui/tab-vars.js';
import * as TabPreview from './ui/tab-preview.js';
import * as TabSettings from './ui/tab-settings.js';
import * as TabLog from './ui/tab-log.js';

const DEFAULT_CONN = () => ({
  id: uuid(), name: 'Proxy mặc định', provider: 'openai', url: '', key: '', model: '', models: [],
  headers: '', extraBody: '', postProcessing: 'none', extendedSamplers: true, sendReasoningEffort: false, stripThinking: true, claudeBearer: false,
});

export const app = {
  settings: null,
  preset: null,
  presetList: [],
  project: null,
  running: null,
  logs: [],
  streams: new Map(),
  tabs: {},
  currentTab: 'connect',

  conn() {
    const s = this.settings;
    return s.connections.find((c) => c.id === s.activeConnection) || s.connections[0];
  },
  ts() { return this.settings.translate; },

  log(msg, level = 'info') {
    this.logs.push({ t: Date.now(), msg, level });
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    if (level === 'error' && this.currentTab !== 'log') {
      const b = document.getElementById('logBadge');
      b.hidden = false; b.textContent = String(Number(b.textContent || 0) + 1);
    }
    this.tabs.log?.append?.(this.logs[this.logs.length - 1]);
  },
  toast,

  saveSettings: null,
  savePreset: null,
  saveProject: null,

  refresh(name) {
    const t = this.tabs[name];
    if (t && this.currentTab === name) t.render();
    else if (t) t.stale = true;
  },
  refreshAll() { for (const n of Object.keys(this.tabs)) this.refresh(n); updateTopbar(); },
};
window.__app = app;

// ====================================================================== khởi động
async function boot() {
  let s = null;
  try { s = await store.get('settings', 'app'); } catch (e) { toast('Không đọc được cài đặt: ' + e.message, 'err'); }
  s ||= {};
  s.connections = Array.isArray(s.connections) && s.connections.length ? s.connections : [DEFAULT_CONN()];
  s.activeConnection ||= s.connections[0].id;
  s.translate = { ...DEFAULT_TRANSLATE_SETTINGS, ...(s.translate || {}) };
  s.translate.prompts ||= {};
  app.settings = s;

  app.saveSettings = debounce(() => store.put('settings', 'app', app.settings).catch((e) => toast('Lưu cài đặt lỗi: ' + e.message, 'err')), 500);
  app.savePreset = debounce(() => { if (app.preset) store.put('presets', safeId(app.preset.name), { name: app.preset.name, data: app.preset.data }).catch((e) => toast('Lưu preset lỗi: ' + e.message, 'err')); }, 600);
  app.saveProject = debounce(saveProjectNow, 1500);

  await loadPresets();

  const tabDefs = { connect: TabConnect, preset: TabPreset, card: TabCard, vars: TabVars, preview: TabPreview, settings: TabSettings, log: TabLog };
  for (const [name, mod] of Object.entries(tabDefs)) {
    const el = document.getElementById('tab-' + name);
    app.tabs[name] = mod.create(app, el);
  }
  app.tabs.connect.render();
  app.tabs.connect.stale = false;
  for (const n of Object.keys(app.tabs)) if (n !== 'connect') app.tabs[n].stale = true;

  bindChrome();
  if (s.lastProject) {
    try { await openProject(s.lastProject, true); } catch { /* dự án cũ có thể đã bị xóa */ }
  }
  updateTopbar();
  if (!app.conn().url) showTab('connect');
  else if (app.project) showTab('card');
}

export async function loadPresets() {
  try { app.presetList = (await store.list('presets')).map((x) => x.id); } catch { app.presetList = []; }
  const want = app.settings.activePreset;
  let p = null;
  if (want) { try { p = await store.get('presets', safeId(want)); } catch { /* */ } }
  app.preset = p && p.data ? { name: p.name || want, data: p.data } : { name: 'Mặc định', data: deepClone(DEFAULT_PRESET) };
}

function showTab(name) {
  app.currentTab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  const t = app.tabs[name];
  if (t && (t.stale || !t.rendered)) { t.render(); t.stale = false; t.rendered = true; }
  t?.onShow?.();
  if (name === 'log') { const b = document.getElementById('logBadge'); b.hidden = true; b.textContent = '0'; }
}
app.showTab = showTab;

function bindChrome() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  const fileInp = document.getElementById('fileCard');
  document.getElementById('btnImport').addEventListener('click', () => { fileInp.value = ''; fileInp.click(); });
  fileInp.addEventListener('change', () => { if (fileInp.files[0]) importFile(fileInp.files[0]); });
  document.getElementById('btnTranslateAll').addEventListener('click', () => translateAll());
  document.getElementById('btnStop').addEventListener('click', () => stopRun());
  document.getElementById('btnProjects').addEventListener('click', () => projectsDialog());
  const dd = document.getElementById('btnExport').parentElement;
  document.getElementById('btnExport').addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
  document.addEventListener('click', () => dd.classList.remove('open'));
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => exportCard(b.dataset.export)));
  // kéo thả
  const ov = document.getElementById('dropOverlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; ov.hidden = false; e.preventDefault(); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; ov.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) importFile(f);
  });
  window.addEventListener('beforeunload', (e) => {
    if (app.project?.dirty) { saveProjectNow(); }
    if (app.running) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProjectNow(); toast('Đã lưu dự án', 'ok', 1500); }
  });
}

// ====================================================================== nhập file
export async function importFile(file) {
  try {
    const bytes = await readFileBytes(file);
    const isJson = /\.json$/i.test(file.name) || bytes[0] === 0x7b;
    if (isJson) {
      let j;
      try { j = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, '')); } catch (e) { throw new Error('JSON lỗi: ' + e.message); }
      const looksPreset = Array.isArray(j.prompts) || 'openai_max_tokens' in j || ('temp' in j && 'rep_pen' in j);
      const looksCard = j.spec || j.data?.name !== undefined || 'first_mes' in j;
      if (looksPreset && !looksCard) { await importPresetObject(j, file.name); return; }
    }
    const card = parseCardFile(file.name, bytes);
    if (app.project?.dirty) await saveProjectNow();
    const p = Project.fromFile(card, file.name);
    p.rescan(app.ts());
    app.project = p;
    app.settings.lastProject = p.id;
    app.saveSettings();
    await saveProjectNow();
    const st = p.stats();
    toast(`Đã nhập card "${p.cardName}": ${p.items.length} mục, ${st.total} đoạn cần dịch, ${Object.keys(p.data.dict).length} mục từ điển`, 'ok', 6000);
    app.log(`Nhập card ${file.name} (${card.spec.toUpperCase()}, ${card.format.toUpperCase()})`, 'ok');
    app.refreshAll();
    showTab('card');
  } catch (e) {
    console.error(e);
    toast('Không nhập được file: ' + e.message, 'err', 7000);
  }
}

export async function importPresetObject(json, fileName) {
  const p = importPreset(json, fileName);
  let name = p.name;
  if (app.presetList.includes(safeId(name))) {
    const ok = await confirmBox(`Preset "${name}" đã tồn tại. Ghi đè?`, 'Ghi đè');
    if (!ok) name = name + ' (' + new Date().toLocaleTimeString('vi-VN') + ')';
  }
  app.preset = { name, data: p.data };
  await store.put('presets', safeId(name), { name, data: p.data });
  if (!app.presetList.includes(safeId(name))) app.presetList.push(safeId(name));
  app.settings.activePreset = name;
  // preset có prompt nội dung đang bật -> tự dùng khi dịch (người dùng nhập preset để dùng nó)
  const order = (p.data.prompt_order || []).find((x) => Number(x.character_id) === 100001)?.order || p.data.prompt_order?.[0]?.order || [];
  const hasContent = order.some((o) => o.enabled && (p.data.prompts || []).some((pr) => pr.identifier === o.identifier && !pr.marker && String(pr.content || '').trim()));
  if (hasContent && !app.ts().usePresetPrompts) {
    app.ts().usePresetPrompts = true;
    toast('Đã bật "Dùng prompt của preset khi dịch". Có thể tắt ở tab Preset nếu preset nhập vai làm bản dịch kém đi.', 'info', 7000);
  }
  app.saveSettings();
  toast(`Đã nhập preset "${name}" (${(p.data.prompts || []).length} prompt)`, 'ok');
  app.refresh('preset');
  showTab('preset');
}

// ====================================================================== dự án
async function saveProjectNow() {
  const p = app.project;
  if (!p) return;
  try {
    await store.put('projects', p.id, p.toJSON());
    p.dirty = false;
  } catch (e) { toast('Lưu dự án lỗi: ' + e.message, 'err'); }
}
app.saveProjectNow = saveProjectNow;

async function openProject(id, silent) {
  const data = await store.get('projects', id);
  if (!data) throw new Error('Không tìm thấy dự án');
  if (app.project?.dirty) await saveProjectNow();
  const p = new Project(data);
  p.rescan(app.ts());
  app.project = p;
  app.settings.lastProject = id;
  app.saveSettings();
  if (!silent) toast('Đã mở dự án: ' + p.name, 'ok');
  app.refreshAll();
}

async function projectsDialog() {
  let items = [];
  try { items = await store.list('projects'); } catch (e) { toast(e.message, 'err'); return; }
  const list = h('div');
  const render = () => {
    clear(list);
    if (!items.length) { list.appendChild(h('div', { class: 'empty' }, 'Chưa có dự án nào. Hãy nhập một card.')); return; }
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Dự án'), h('th', null, 'Cập nhật'), h('th', null, 'Dung lượng'), h('th', null, '')));
    for (const it of items) {
      tbl.appendChild(h('tr', null,
        h('td', null, it.id === app.project?.id ? '▶ ' : '', it.name || it.id),
        h('td', { class: 'muted small' }, fmtTime(it.mtime)),
        h('td', { class: 'muted small' }, (it.size / 1024).toFixed(0) + ' KB'),
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button', { class: 'btn small primary', onclick: async () => { back(); try { await openProject(it.id); showTab('card'); } catch (e) { toast(e.message, 'err'); } } }, 'Mở'), ' ',
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmBox('Xóa dự án này? (bản dịch đã lưu sẽ mất)', 'Xóa', 'danger'))) return;
            await store.del('projects', it.id);
            items = items.filter((x) => x !== it);
            if (app.project?.id === it.id) { app.project = null; app.settings.lastProject = null; app.saveSettings(); app.refreshAll(); }
            render();
          } }, 'Xóa'))));
    }
    list.appendChild(tbl);
  };
  // lấy tên dự án
  await Promise.all(items.map(async (it) => { try { const d = await store.get('projects', it.id); it.name = d?.name; } catch { /* */ } }));
  render();
  let back = () => {};
  const pr = modal('Dự án đã lưu', list, [{ label: 'Đóng', value: null }]);
  back = () => document.querySelector('.modal-back')?.remove();
  await pr;
}

// ====================================================================== dịch
function needsDict(kind, ts) {
  if (kind === 'key' || kind === 'value') return ts.varMode === 'translate';
  if (kind === 'marker') return ts.markerMode === 'translate';
  return true;
}

export async function runDictSuggest(entries) {
  const p = app.project;
  if (!p || !entries.length) return;
  const ac = app.running || new AbortController();
  const own = !app.running;
  if (own) { app.running = ac; updateTopbar(); }
  setProgress(0, entries.length, 'Gợi ý từ điển');
  try {
    await suggestDict({
      settings: app.ts(), conn: app.conn(), preset: app.preset.data, cardName: p.cardName, signal: ac.signal,
      onItem: (src, dst) => { const e = p.data.dict[src]; if (e && !e.manual) { e.dst = dst; e.auto = true; } p.bump(); p.touch(); app.saveProject(); },
      onLog: (m, l) => app.log(m, l),
      onProgress: ({ done, total }) => setProgress(done, total, 'Gợi ý từ điển'),
      onStream: (wid, t) => app.tabs.log?.stream?.('dict', t),
    }, entries);
  } finally {
    if (own) { app.running = null; updateTopbar(); }
    app.refresh('vars');
  }
}

export async function translateAll(itemIds, { force = false } = {}) {
  const p = app.project;
  if (!p) return toast('Hãy nhập card trước', 'warn');
  if (app.running) return toast('Đang dịch...', 'warn');
  const conn = app.conn();
  if (!conn.url || !conn.model) { toast('Hãy cấu hình proxy và chọn model ở tab Kết nối', 'warn'); showTab('connect'); return; }
  const ts = app.ts();
  const ac = new AbortController();
  app.running = ac;
  updateTopbar();
  const t0 = Date.now();
  try {
    if (ts.autoSuggestDict && !itemIds) {
      const need = Object.entries(p.data.dict).filter(([, v]) => !v.dst && !v.keep && needsDict(v.kind, ts)).map(([src, v]) => ({ src, kind: v.kind, parents: v.parents }));
      if (need.length) {
        app.log(`Bước 1: gợi ý ${need.length} mục từ điển (biến, giá trị, nhãn, thuật ngữ)`, 'info');
        await runDictSuggest(need);
        if (ac.signal.aborted) return;
      }
    }
    const segs = p.segmentsFor(itemIds);
    if (force) p.clearTranslations(segs.map((s) => s.key));
    const todo = segs.filter((s) => !p.tm.has(s.key));
    app.log(`Bước 2: dịch ${todo.length} đoạn (${todo.reduce((n, s) => n + s.key.length, 0)} ký tự)`, 'info');
    let lastRefresh = 0;
    const res = await runTranslation({
      segments: todo, tm: new Map(p.tm), settings: ts, conn, preset: app.preset.data, dict: p.data.dict, cardName: p.cardName,
      glossary: p.data.glossary, signal: ac.signal,
      onResult: (key, text, warn) => {
        p.setTranslation(key, text, warn);
        app.saveProject();
        const now = Date.now();
        if (now - lastRefresh > 1200) { lastRefresh = now; app.tabs.card?.liveUpdate?.(); }
      },
      onProgress: ({ done, total, failed }) => setProgress(done, total, failed ? `lỗi ${failed}` : ''),
      onLog: (m, l) => app.log(m, l),
      onStream: (wid, t) => app.tabs.log?.stream?.(wid, t),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (res.aborted) toast('Đã dừng dịch', 'warn');
    else if (res.failed) toast(`Xong với ${res.failed} đoạn lỗi (${secs}s). Xem tab Nhật ký, có thể bấm Dịch toàn bộ lần nữa để thử lại phần lỗi.`, 'warn', 9000);
    else toast(`Dịch xong ${res.done} đoạn trong ${secs}s ✓`, 'ok', 6000);
    app.log(`Hoàn tất: ${res.done} xong, ${res.failed} lỗi, ${secs}s`, res.failed ? 'warn' : 'ok');
  } catch (e) {
    console.error(e);
    toast('Lỗi dịch: ' + e.message, 'err', 9000);
    app.log('Lỗi: ' + e.message, 'error');
  } finally {
    app.running = null;
    await saveProjectNow();
    updateTopbar();
    app.refreshAll();
  }
}
app.translateAll = translateAll;

function stopRun() {
  if (app.running) { app.running.abort(); app.log('Người dùng dừng dịch', 'warn'); }
}

function setProgress(done, total, extra) {
  const wrap = document.getElementById('progressWrap');
  wrap.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 100;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${done}/${total} (${pct}%) ${extra || ''}`;
}

export function updateTopbar() {
  const p = app.project;
  document.getElementById('projectName').textContent = p ? p.name : '(chưa mở card)';
  document.getElementById('btnTranslateAll').disabled = !p || !!app.running;
  document.getElementById('btnExport').disabled = !p;
  document.getElementById('btnStop').hidden = !app.running;
  if (!app.running) {
    if (p) {
      const st = p.stats();
      setProgress(st.done, st.total, st.done < st.total ? `· còn ~${st.remainingChars} ký tự` : '✓ đã dịch hết');
    } else document.getElementById('progressWrap').hidden = true;
  }
}
app.updateTopbar = updateTopbar;

// ====================================================================== xuất
async function placeholderPng(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 768;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 512, 768);
  grad.addColorStop(0, '#2b3350'); grad.addColorStop(1, '#5a3d6e');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 768);
  g.fillStyle = '#fff'; g.font = 'bold 34px Segoe UI, Arial'; g.textAlign = 'center';
  const words = String(name).split(/(?<=\S{12})|\s+/);
  let y = 360;
  for (const w of words.slice(0, 5)) { g.fillText(w, 256, y); y += 44; }
  g.font = '22px Segoe UI, Arial'; g.fillStyle = '#cdd6f4'; g.fillText('Bản dịch tiếng Việt', 256, y + 20);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportCard(type) {
  const p = app.project;
  if (!p) return;
  const ts = app.ts();
  const st = p.stats();
  const conflicts = p.conflicts(ts);
  const notes = [];
  if (st.done < st.total) notes.push(`• Còn ${st.total - st.done}/${st.total} đoạn chưa dịch (sẽ giữ nguyên tiếng Trung).`);
  if (conflicts.length) notes.push(`• Có ${conflicts.length} xung đột tên biến (2 biến khác nhau trùng tên mới) — xem tab Biến & Đồng bộ.`);
  if (notes.length && !(await confirmBox('Lưu ý trước khi xuất:\n' + notes.join('\n') + '\n\nVẫn xuất card?', 'Xuất'))) return;
  try {
    const name = (p.buildCard(ts).data?.name || p.cardName || 'card').replace(/[\\/:*?"<>|]+/g, '_');
    if (type === 'json') {
      download(name + '_VI.json', p.exportJson(ts), 'application/json');
    } else {
      const fallback = p.card.image ? null : await placeholderPng(p.buildCard(ts).data?.name || p.cardName);
      if (!p.card.image) toast('Card gốc là JSON nên dùng ảnh nền tạm. Có thể đổi ảnh trong SillyTavern sau khi nhập.', 'warn', 6000);
      download(name + '_VI.png', p.exportPng(ts, fallback), 'image/png');
    }
    app.log('Đã xuất card ' + type.toUpperCase(), 'ok');
  } catch (e) {
    console.error(e);
    toast('Xuất card lỗi: ' + e.message, 'err');
  }
}
app.exportCard = exportCard;

boot().catch((e) => { console.error(e); toast('Lỗi khởi động: ' + e.message, 'err', 10000); });
