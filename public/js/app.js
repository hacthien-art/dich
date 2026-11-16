// Điều khiển chính của app
import { h, clear, toast, modal, confirmBox, download, readFileBytes, fmtTime, pickFile } from './ui/dom.js';
import { store, safeId } from './ui/store.js';
import { parseCardFile } from './core/card.js';
import { DEFAULT_PRESET, importPreset } from './core/preset.js';
import { runTranslation, suggestDict, resolveConflicts } from './core/translate.js';
import { Project, DEFAULT_TRANSLATE_SETTINGS, unpackCardItems } from './project.js';
import { uuid, debounce, deepClone, hasCJK, formatBytes } from './core/util.js';
import { looksLikeResourceName } from './core/resource.js';
import { mirrorUrls } from './core/links.js';
import * as TabConnect from './ui/tab-connect.js';
import * as TabPreset from './ui/tab-preset.js';
import * as TabCard from './ui/tab-card.js';
import * as TabResources from './ui/tab-resources.js';
import * as TabVars from './ui/tab-vars.js';
import * as TabPreview from './ui/tab-preview.js';
import * as TabSettings from './ui/tab-settings.js';
import * as TabCheck from './ui/tab-check.js';
import * as TabLog from './ui/tab-log.js';
import { createUpdater } from './ui/update.js';

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
  // nâng cấp cài đặt cũ: bản 1.1 dịch cả chú thích trong mã (trước đây tắt -> còn sót nhiều chữ Hán trong regex/script)
  if ((s.settingsVersion || 1) < 2) { s.translate.comments = true; s.translate.autoFixConflicts = true; s.settingsVersion = 2; }
  app.settings = s;

  app.saveSettings = debounce(() => store.put('settings', 'app', app.settings).catch((e) => toast('Lưu cài đặt lỗi: ' + e.message, 'err')), 500);
  app.savePreset = debounce(() => { if (app.preset) store.put('presets', safeId(app.preset.name), { name: app.preset.name, data: app.preset.data }).catch((e) => toast('Lưu preset lỗi: ' + e.message, 'err')); }, 600);
  app.saveProject = debounce(saveProjectNow, 1500);

  await loadPresets();

  const tabDefs = { connect: TabConnect, preset: TabPreset, card: TabCard, resources: TabResources, vars: TabVars, preview: TabPreview, check: TabCheck, settings: TabSettings, log: TabLog };
  for (const [name, mod] of Object.entries(tabDefs)) {
    const el = document.getElementById('tab-' + name);
    app.tabs[name] = mod.create(app, el);
  }
  app.tabs.connect.render();
  app.tabs.connect.stale = false;
  for (const n of Object.keys(app.tabs)) if (n !== 'connect') app.tabs[n].stale = true;

  bindChrome();
  // cập nhật từ GitHub: hiện phiên bản, tự kiểm tra bản mới (nút "⬆ Cập nhật" chỉ hiện khi có bản mới)
  app.updater = createUpdater(app);
  const verEl = document.getElementById('appVersion');
  fetch('/api/ping', { headers: { 'X-App-Token': document.querySelector('meta[name="app-token"]')?.content || '' } })
    .then((r) => r.json()).then((j) => { app.version = j.version; verEl.textContent = 'v' + j.version + ' · kiểm tra cập nhật'; }).catch(() => {});
  verEl.title = 'Bấm để kiểm tra bản mới trên GitHub';
  verEl.addEventListener('click', () => app.updater.check(true, { silent: false }));
  if (s.autoUpdateCheck !== false) setTimeout(() => app.updater.check(false), 2500);
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
  document.getElementById('btnUpdateCard').addEventListener('click', () => updateCardDialog());
  document.getElementById('btnTranslateAll').addEventListener('click', () => translateAll());
  document.getElementById('btnRetry').addEventListener('click', () => translateAll(null, { problems: true }));
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
    // tệp tài nguyên đi kèm (gói bản đồ .gz, trang .html, tệp .js…) -> thêm vào dự án đang mở
    if (looksLikeResourceName(file.name)) {
      if (!app.project) return toast('Đây là tệp tài nguyên đi kèm card — hãy nhập card trước, rồi thả tệp này vào (hoặc dùng tab 📦 Tài nguyên).', 'warn', 8000);
      await addResourceFile(file);
      return;
    }
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
    // card trùng tên với một dự án đã dịch -> hỏi có muốn CẬP NHẬT dự án đó (giữ bản dịch) thay vì dịch lại từ đầu
    const cardName = card.raw.data?.name || '';
    const same = cardName ? await findProjectsByCard(cardName) : [];
    if (same.length) {
      const target = same[0];
      const choice = await modal('Card này đã có dự án dịch', h('div', null,
        h('p', null, `Card "${cardName}" trùng tên với dự án `, h('b', null, target.name || target.id), target.updatedAt ? ` (sửa lần cuối ${fmtTime(target.updatedAt)})` : '', '.'),
        h('p', { class: 'muted small' }, 'Cập nhật dự án: thay card gốc bằng file mới nhưng GIỮ toàn bộ bản dịch, từ điển biến, chỉnh tay — chỉ phần nội dung mới / bị sửa mới cần dịch. Tạo dự án mới: dịch lại từ đầu.')),
      [{ label: 'Hủy', value: null }, { label: 'Tạo dự án mới', value: 'new' }, { label: '🔄 Cập nhật dự án cũ', cls: 'primary', value: 'update' }]);
      if (!choice) return;
      if (choice === 'update') {
        if (app.project?.id !== target.id) await openProject(target.id, true);
        await applyCardUpdate(card);
        return;
      }
    }
    if (app.project?.dirty) await saveProjectNow();
    const p = Project.fromFile(card, file.name);
    await p.prepare(null); // bóc nội dung nhúng (base64 / gzip…) trong card
    p.rescan(app.ts());
    app.project = p;
    app.settings.lastProject = p.id;
    app.saveSettings();
    await saveProjectNow();
    const st = p.stats();
    const nEmb = p.items.filter((it) => it.group === 'embedded').length;
    const nLinks = p.links().filter((l) => l.klass === 'code').length;
    toast(`Đã nhập card "${p.cardName}": ${p.items.length} mục, ${st.total} đoạn cần dịch, ${Object.keys(p.data.dict).length} mục từ điển`, 'ok', 6000);
    app.log(`Nhập card ${file.name} (${card.spec.toUpperCase()}, ${card.format.toUpperCase()})`, 'ok');
    if (nEmb) app.log(`Card có ${nEmb} lớp nội dung nhúng (base64 / nén) — đã bóc ra để dịch, khi xuất sẽ tự mã hóa lại`, 'info');
    if (nLinks) {
      app.log(`Card nạp ${nLinks} link ngoài tới mã / dữ liệu riêng (GitHub, jsDelivr…) — tải về để dịch ở tab 📦 Tài nguyên`, 'info');
      toast(`Card này nạp ${nLinks} link ngoài (mã / giao diện đặt trên GitHub…). Mở tab 📦 Tài nguyên để tải về và dịch.`, 'info', 9000);
    }
    app.refreshAll();
    showTab('card');
  } catch (e) {
    console.error(e);
    toast('Không nhập được file: ' + e.message, 'err', 7000);
  }
}

// ====================================================================== cập nhật card (giữ bản dịch)
/** Các dự án đã lưu có cùng tên card (dùng chỉ mục nhỏ trong cài đặt, không phải đọc từng dự án) */
async function findProjectsByCard(cardName) {
  const index = app.settings.projectIndex || {};
  let ids = [];
  try { ids = (await store.list('projects')).map((x) => x.id); } catch { return []; }
  const alive = new Set(ids);
  for (const id of Object.keys(index)) if (!alive.has(id)) delete index[id];
  const out = Object.entries(index).filter(([, v]) => v.cardName === cardName).map(([id, v]) => ({ id, ...v }));
  if (app.project && app.project.cardName === cardName && !out.some((x) => x.id === app.project.id)) out.unshift({ id: app.project.id, name: app.project.name, cardName, updatedAt: app.project.data.updatedAt });
  return out.sort((a, b) => (b.id === app.project?.id) - (a.id === app.project?.id) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Nút "🔄 Cập nhật card": chọn file phiên bản mới của card đang mở */
export async function updateCardDialog() {
  const p = app.project;
  if (!p) return toast('Hãy mở dự án (card) cần cập nhật trước', 'warn');
  if (app.running) return toast('Đang dịch — hãy đợi xong hoặc bấm Dừng', 'warn');
  const file = await pickFile('.png,.json,image/png,application/json');
  if (!file) return;
  try {
    const card = parseCardFile(file.name, await readFileBytes(file));
    const newName = card.raw.data?.name || '';
    if (newName && p.cardName && newName !== p.cardName && !(await confirmBox(`Card mới tên "${newName}" khác card đang mở "${p.cardName}".\nVẫn cập nhật dự án này bằng file đó?`, 'Vẫn cập nhật'))) return;
    await applyCardUpdate(card);
  } catch (e) {
    console.error(e);
    toast('Không cập nhật được card: ' + e.message, 'err', 8000);
  }
}
app.updateCardDialog = updateCardDialog;

async function applyCardUpdate(card) {
  const p = app.project;
  const ts = app.ts();
  card.embeds = await unpackCardItems(card); // nội dung nhúng của bản card mới
  const { stats, undo } = p.updateCard(card, ts);
  await saveProjectNow();
  app.refreshAll();
  const s = stats;
  app.log(`Cập nhật card từ ${s.fileName}: ${s.items.same} mục giữ nguyên, ${s.items.changed.length} mục sửa, ${s.items.added.length} mục mới, ${s.items.removed.length} mục bị xóa; dùng lại ${s.segs.done}/${s.segs.total} đoạn đã dịch, còn ${s.segs.todo} đoạn mới`, 'ok');
  const list = (title, arr) => (arr.length ? h('details', null, h('summary', { class: 'small' }, `${title} (${arr.length})`), h('ul', { class: 'small' }, arr.slice(0, 80).map((x) => h('li', null, x)), arr.length > 80 ? h('li', { class: 'muted' }, `… và ${arr.length - 80} mục khác`) : null)) : null);
  const body = h('div', null,
    s.similarity < 0.3 ? h('div', { class: 'card-box tight warn small' }, `⚠ Chỉ ${Math.round(s.similarity * 100)}% mục của file mới khớp với card cũ — có thể bạn chọn nhầm card khác. Bấm "Hoàn tác" nếu không đúng.`) : null,
    h('div', { class: 'stats', style: { marginBottom: '10px' } },
      h('span', { class: 'pill ok' }, `${s.items.same} mục không đổi`),
      h('span', { class: 'pill warn' }, `${s.items.changed.length} mục bị sửa`),
      h('span', { class: 'pill' }, `${s.items.added.length} mục mới`),
      h('span', { class: 'pill' }, `${s.items.removed.length} mục bị xóa`)),
    h('p', null, h('b', null, `Đã dùng lại ${s.segs.done}/${s.segs.total} đoạn dịch`),
      ` — ${s.segs.exact} đoạn y hệt bản cũ` + (s.segs.composed ? `, ${s.segs.composed} đoạn ghép lại từ các đoạn văn/dòng đã dịch` : '') + (s.segs.legacy ? `, ${s.segs.legacy} đoạn chuyển từ khóa cũ` : '') + '.'),
    s.segs.todo ? h('p', null, `Còn `, h('b', null, `${s.segs.todo} đoạn mới / bị sửa`), ` cần dịch — chỉ gửi AI ~${s.segs.todoChars} ký tự` + (s.segs.parts ? ` (với đoạn dài chỉ bị sửa vài dòng, chỉ dịch ${s.segs.parts} khối dòng mới rồi ghép với bản dịch cũ)` : '') + '.') : h('p', { class: 'ok' }, 'Không có đoạn nào cần dịch thêm ✓'),
    h('p', { class: 'small muted' }, `Từ điển: ${s.dict.total} mục (${s.dict.added} mục mới, ${s.dict.removed} mục không còn dùng — được cất lại để dùng nếu xuất hiện lại)` + (s.dict.needTranslation ? `, ${s.dict.needTranslation} mục chưa có bản dịch.` : '.') +
      (s.overrides.kept ? ` Giữ ${s.overrides.kept} chỉnh tay.` : '')),
    s.overrides.dropped.length ? h('div', { class: 'card-box tight warn small' }, `${s.overrides.dropped.length} mục có chỉnh tay nhưng nội dung gốc đã bị tác giả sửa nên chỉnh tay không được áp dụng (đã lưu lại trong dự án): ${s.overrides.dropped.slice(0, 6).join(' · ')}`) : null,
    list('Mục bị sửa', s.items.changed), list('Mục mới', s.items.added), list('Mục bị xóa', s.items.removed));
  const actions = [{ label: '↶ Hoàn tác', value: 'undo' }, { label: 'Đóng', value: 'close' }];
  if (s.segs.todo || s.dict.needTranslation) actions.push({ label: `▶ Dịch phần mới (${s.segs.todo} đoạn)`, cls: 'primary', value: 'translate' });
  const choice = await modal(`Đã cập nhật card: ${p.cardName}`, body, actions, { wide: true });
  if (choice === 'undo') {
    undo();
    await saveProjectNow();
    app.refreshAll();
    toast('Đã hoàn tác — dự án trở về card cũ', 'ok');
    app.log('Hoàn tác cập nhật card', 'warn');
    return;
  }
  showTab('card');
  if (choice === 'translate') translateAll();
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
    // chỉ mục nhỏ (tên dự án / tên card) để nhận ra card đã từng dịch khi nhập lại bản cập nhật
    const index = (app.settings.projectIndex ||= {});
    const prev = index[p.id];
    if (!prev || prev.name !== p.name || prev.cardName !== p.cardName) { index[p.id] = { name: p.name, cardName: p.cardName, updatedAt: p.data.updatedAt }; app.saveSettings(); }
    else prev.updatedAt = p.data.updatedAt;
  } catch (e) { toast('Lưu dự án lỗi: ' + e.message, 'err'); }
}
app.saveProjectNow = saveProjectNow;

// ====================================================================== tài nguyên đi kèm · link ngoài
const appToken = () => document.querySelector('meta[name="app-token"]')?.content || '';
const blobUrl = (projectId, resId) => '/api/blob/resources/' + encodeURIComponent(`${projectId}.${resId}`);

/** Dữ liệu tệp tài nguyên lưu riêng (data/resources/…) — không nằm trong file dự án vì có thể tới hàng chục MB */
async function loadResBlob(projectId, meta) {
  const r = await fetch(blobUrl(projectId, meta.id), { headers: { 'X-App-Token': appToken() } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}
async function saveResBlob(projectId, meta, bytes) {
  const r = await fetch(blobUrl(projectId, meta.id), { method: 'PUT', headers: { 'X-App-Token': appToken(), 'Content-Type': 'application/octet-stream' }, body: bytes });
  if (!r.ok) throw new Error('Không lưu được tệp tài nguyên (HTTP ' + r.status + ')');
}
async function deleteResBlob(projectId, resId) {
  await fetch(blobUrl(projectId, resId), { method: 'DELETE', headers: { 'X-App-Token': appToken() } }).catch(() => {});
}

function afterResourcesChanged() {
  const p = app.project;
  p.rescan(app.ts());
  app.saveProject();
  app.refreshAll();
}

/** Thêm một tệp tài nguyên đi kèm (gói .gz, .html, .js, .json…) vào dự án đang mở */
export async function addResourceFile(file) {
  const p = app.project;
  if (!p) return toast('Hãy nhập card trước', 'warn');
  if (app.running) return toast('Đang dịch — hãy đợi xong hoặc bấm Dừng', 'warn');
  const note = toast(`Đang mở "${file.name}" (${formatBytes(file.size)})…`, 'info', 60000);
  try {
    const bytes = await readFileBytes(file);
    const before = p.stats().total;
    const r = await p.addResource({ name: file.name, origin: 'file' }, bytes);
    await saveResBlob(p.id, r.meta, bytes);
    afterResourcesChanged();
    const layers = p.resourceItems(r.meta.id);
    const added = p.stats().total - before;
    note.remove();
    toast(`Đã thêm tài nguyên "${file.name}": ${layers.length} lớp nội dung, thêm ${added} đoạn cần dịch`, 'ok', 7000);
    app.log(`Thêm tài nguyên ${file.name} (${formatBytes(bytes.length)}): ${layers.map((it) => `${it.meta.title} [${it.meta.enc}, ${formatBytes(it.meta.size)}]`).join(' · ')}`, 'ok');
    showTab('resources');
  } catch (e) {
    console.error(e);
    note.remove();
    toast('Không thêm được tài nguyên: ' + e.message, 'err', 9000);
  }
}
app.addResourceFile = addResourceFile;

export async function removeResource(resId) {
  const p = app.project;
  const r = p?.resources.find((x) => x.meta.id === resId);
  if (!r) return;
  if (!(await confirmBox(`Gỡ "${r.meta.name}" khỏi dự án?\n(Bản dịch các đoạn của nó vẫn nằm trong bộ nhớ dịch — thêm lại tệp sẽ dùng lại được.)`, 'Gỡ', 'danger'))) return;
  p.removeResource(resId);
  await deleteResBlob(p.id, resId);
  afterResourcesChanged();
  app.log('Đã gỡ tài nguyên ' + r.meta.name, 'warn');
}
app.removeResource = removeResource;

/** Xuất một tệp tài nguyên đã dịch (đúng dạng vỏ gốc: .gz vẫn là .gz, payload base64 / gzip bên trong được mã hóa lại) */
export async function exportResource(resId) {
  const p = app.project;
  if (!p) return;
  const note = toast('Đang đóng gói tài nguyên đã dịch…', 'info', 120000);
  try {
    const ex = await p.exportResource(resId, app.ts());
    note.remove();
    if (!ex.changed) toast('Tài nguyên này chưa có gì được dịch — tệp xuất ra giống bản gốc.', 'warn', 6000);
    download(ex.name, ex.bytes, 'application/octet-stream');
    app.log(`Đã xuất tài nguyên ${ex.name} (${formatBytes(ex.bytes.length)})`, 'ok');
  } catch (e) {
    console.error(e);
    note.remove();
    toast('Xuất tài nguyên lỗi: ' + e.message, 'err', 9000);
  }
}
app.exportResource = exportResource;

/** Tải một link ngoài của card (qua máy chủ cục bộ) rồi thêm vào dự án như một tài nguyên để dịch */
export async function downloadLink(link) {
  const p = app.project;
  if (!p) return;
  if (app.running) return toast('Đang dịch — hãy đợi xong hoặc bấm Dừng', 'warn');
  const note = toast('Đang tải ' + link.url + ' …', 'info', 120000);
  try {
    let bytes = null, mime = '', lastErr = '';
    for (const u of mirrorUrls(link.url)) {
      const r = await fetch('/api/fetch', { method: 'POST', headers: { 'X-App-Token': appToken(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
      if (r.ok) { bytes = new Uint8Array(await r.arrayBuffer()); mime = decodeURIComponent(r.headers.get('X-Content-Type') || ''); break; }
      lastErr = (await r.json().catch(() => ({}))).error || 'HTTP ' + r.status;
    }
    if (!bytes) throw new Error(lastErr || 'không tải được');
    let name = link.url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || 'link';
    try { name = decodeURIComponent(name); } catch { /* giữ nguyên */ }
    const r = await p.addResource({ name, origin: 'url', url: link.url, mime, mode: link.klass === 'lib' ? 'keep' : 'inline' }, bytes);
    await saveResBlob(p.id, r.meta, bytes);
    afterResourcesChanged();
    note.remove();
    const items = p.resourceItems(r.meta.id);
    const segs = items.reduce((n, it) => n + p.status(it.id).total, 0);
    toast(`Đã tải "${name}" (${formatBytes(bytes.length)}): ${segs} đoạn cần dịch` + (segs ? '' : ' — không có chữ Hán nào để dịch'), segs ? 'ok' : 'warn', 7000);
    app.log(`Tải link ${link.url} → ${name} (${formatBytes(bytes.length)}, ${items.length} lớp, ${segs} đoạn)`, 'ok');
  } catch (e) {
    console.error(e);
    note.remove();
    toast('Không tải được link: ' + e.message, 'err', 9000);
    app.log(`Tải link thất bại ${link.url}: ${e.message}`, 'error');
  }
}
app.downloadLink = downloadLink;

async function openProject(id, silent) {
  const data = await store.get('projects', id);
  if (!data) throw new Error('Không tìm thấy dự án');
  if (app.project?.dirty) await saveProjectNow();
  const p = new Project(data);
  await p.prepare((meta) => loadResBlob(id, meta));
  p.rescan(app.ts());
  for (const r of p.resources) if (r.error) app.log(`Tài nguyên "${r.meta.name}" không mở được: ${r.error}`, 'error');
  app.project = p;
  app.settings.lastProject = id;
  app.saveSettings();
  if (!silent) toast('Đã mở dự án: ' + p.name, 'ok');
  // dự án dịch bằng bản cũ: báo những gì đã được tự sửa khi mở
  const r = p.lastRepair || {};
  const fixed = [];
  if (r.tmTags || r.dictTags) fixed.push(`gỡ nhãn [biến]/[giá trị] lọt vào ${r.tmTags || 0} đoạn dịch và ${r.dictTags || 0} mục từ điển`);
  if (r.legacy || r.composed) fixed.push(`chuyển ${(r.legacy || 0) + (r.composed || 0)} bản dịch cũ sang cách phân tích mới`);
  if (fixed.length) {
    app.log('Tự sửa dự án khi mở: ' + fixed.join('; '), 'ok');
    toast('Đã tự sửa dự án cũ: ' + fixed.join('; ') + '. Xem tab 🩺 Kiểm tra để rà lại.', 'info', 9000);
    p.dirty = true;
    saveProjectNow();
  }
  app.refreshAll();
}
app.openProject = openProject;

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
            // xóa luôn dữ liệu các tệp tài nguyên của dự án (lưu riêng trong data/resources)
            try { const d = await store.get('projects', it.id); for (const r of d?.resources || []) await deleteResBlob(it.id, r.id); } catch { /* bỏ qua */ }
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
    // gợi ý xong -> tự dịch lại các biến bị trùng tên
    if (!ac.signal.aborted && app.ts().autoFixConflicts !== false) await fixConflicts({ quiet: true });
  } finally {
    if (own) { app.running = null; updateTopbar(); }
    app.refresh('vars');
  }
}

/**
 * Tự sửa xung đột tên biến (2 biến khác nhau trong cùng object cha bị dịch cùng một tên):
 * nhờ AI đặt lại tên khác nhau, nếu vẫn trùng thì thêm hậu tố số.
 */
export async function fixConflicts({ quiet = false } = {}) {
  const p = app.project;
  if (!p) return null;
  const ts = app.ts();
  const before = p.conflicts(ts);
  if (!before.length) { if (!quiet) toast('Không có xung đột tên biến ✓', 'ok'); return null; }
  const conn = app.conn();
  const useAI = !!(conn.url && conn.model);
  const ac = app.running || new AbortController();
  const own = !app.running;
  if (own) { app.running = ac; updateTopbar(); }
  setProgress(0, before.length, 'Sửa tên biến trùng');
  try {
    const res = await resolveConflicts({
      settings: ts, conn, preset: app.preset.data, cardName: p.cardName, signal: ac.signal,
      onLog: (m, l) => app.log(m, l),
      onStream: (wid, t) => app.tabs.log?.stream?.('conflict', t),
    }, p.data.dict, { useAI });
    p.bump(); p.touch(); app.saveProject();
    for (const r of res.renamed) app.log(`Đổi tên biến ${r.src}: "${r.from}" → "${r.to}"`, 'ok');
    for (const r of res.suffixed) app.log(`Thêm hậu tố cho biến ${r.src}: "${r.from}" → "${r.to}" (AI vẫn đặt trùng)`, 'warn');
    const msg = `Đã sửa ${before.length} xung đột tên biến: ` + (useAI ? `AI đặt lại ${res.renamed.length} tên` : 'chưa kết nối AI (tab Kết nối) nên chỉ thêm hậu tố số') + (useAI && res.suffixed.length ? `, thêm hậu tố số cho ${res.suffixed.length} tên` : '') + (res.remaining.length ? ` — còn ${res.remaining.length} xung đột` : ' ✓');
    if (!quiet || res.remaining.length || res.suffixed.length) toast(msg, res.remaining.length ? 'warn' : 'ok', 7000);
    app.log(msg, res.remaining.length ? 'warn' : 'ok');
    return res;
  } catch (e) {
    toast('Lỗi khi sửa tên biến trùng: ' + e.message, 'err', 7000);
    app.log('Lỗi sửa tên biến trùng: ' + e.message, 'error');
    return null;
  } finally {
    if (own) { app.running = null; updateTopbar(); }
    app.refresh('vars');
    app.refresh('card');
  }
}
app.fixConflicts = fixConflicts;

/** problems=true: chỉ dịch các đoạn chưa dịch hoặc có lỗi/cảnh báo (vd còn sót chữ Hán) — giữ bản cũ nếu dịch lại thất bại */
export async function translateAll(itemIds, { force = false, problems = false } = {}) {
  const p = app.project;
  if (!p) return toast('Hãy nhập card trước', 'warn');
  if (app.running) return toast('Đang dịch...', 'warn');
  const conn = app.conn();
  if (!conn.url || !conn.model) { toast('Hãy cấu hình proxy và chọn model ở tab Kết nối', 'warn'); showTab('connect'); return; }
  const ts = app.ts();
  // khối lượng lớn (thường do tệp tài nguyên / bản đồ hàng trăm nghìn chữ): báo trước để người dùng chủ động chọn phần cần dịch
  if (!force) {
    const pend = p.segmentsFor(itemIds).filter((s) => (problems ? !p.tm.has(s.key) || p.data.warnings[s.key] : !p.tm.has(s.key)));
    const chars = pend.reduce((n, s) => n + s.key.length, 0);
    if (chars > 150000) {
      const ids = itemIds || p.items.filter((it) => p.isIncluded(it)).map((it) => it.id);
      const rows = ids.map((id) => {
        const it = p.itemById.get(id), a = p.analyses.get(id);
        let c = 0;
        const seen = new Set();
        for (const s of a?.segments || []) if (!p.tm.has(s.key) && !seen.has(s.key)) { seen.add(s.key); c += s.key.length; }
        return { label: it?.label || id, c };
      }).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
      const batches = Math.ceil(chars / (ts.batchChars || 3000));
      const ok = await confirmBox(`Sắp gửi AI khoảng ${chars.toLocaleString('vi-VN')} ký tự (${pend.length.toLocaleString('vi-VN')} đoạn, ước chừng ${batches}+ yêu cầu).\n\nNhiều nhất:\n${rows.slice(0, 6).map((r) => `• ${r.label}: ${r.c.toLocaleString('vi-VN')} ký tự`).join('\n')}\n\nMuốn bớt: bỏ tích mục ở cây bên trái tab Card, hoặc ở tab 📦 Tài nguyên chọn "không dịch" cho các trường dữ liệu không cần (vd trích dẫn nguyên văn sử liệu). Bản dịch được lưu dần — có thể bấm Dừng rồi dịch tiếp sau.\n\nTiếp tục dịch?`, 'Dịch');
      if (!ok) return;
    }
  }
  const ac = new AbortController();
  app.running = ac;
  updateTopbar();
  const t0 = Date.now();
  try {
    if (ts.autoSuggestDict && !itemIds) {
      // mục chưa dịch + mục AI gợi ý trước đây mà vẫn còn chữ Hán (không tính mục người dùng sửa tay)
      const need = Object.entries(p.data.dict).filter(([, v]) => (!v.dst || (!v.manual && hasCJK(v.dst))) && !v.keep && needsDict(v.kind, ts)).map(([src, v]) => ({ src, kind: v.kind, parents: v.parents }));
      if (need.length) {
        app.log(`Bước 1: gợi ý ${need.length} mục từ điển (biến, giá trị, nhãn, thuật ngữ)`, 'info');
        await runDictSuggest(need);
        if (ac.signal.aborted) return;
      }
    }
    // tên biến bị trùng sẽ làm hỏng dữ liệu MVU -> sửa trước khi dịch
    if (!itemIds && ts.autoFixConflicts !== false && ts.varMode !== 'keep' && p.conflicts(ts).length) {
      await fixConflicts({ quiet: true });
      if (ac.signal.aborted) return;
    }
    p.recheckWarnings(ts);
    const segs = p.segmentsFor(itemIds);
    if (force) p.clearTranslations(segs.map((s) => s.key));
    const todo = problems ? segs.filter((s) => !p.tm.has(s.key) || p.data.warnings[s.key]) : segs.filter((s) => !p.tm.has(s.key));
    // ghi chú lỗi cũ (vd "còn sót chữ Hán: ...") gửi kèm để AI sửa đúng chỗ
    const notes = new Map();
    for (const s of todo) if (p.data.warnings[s.key]) notes.set(s.key, p.data.warnings[s.key]);
    if (!todo.length) { toast(problems ? 'Không còn đoạn nào chưa dịch hoặc bị lỗi ✓' : 'Đã dịch hết ✓', 'ok'); return; }
    // card được cập nhật: đoạn dài chỉ bị sửa/thêm vài dòng -> chỉ gửi AI các dòng mới rồi ghép với bản dịch cũ
    let send = todo, delta = null;
    if (!force) {
      delta = p.deltaPlan(todo.filter((s) => !p.tm.has(s.key)));
      if (delta.parts) {
        send = [...todo.filter((s) => p.tm.has(s.key)), ...delta.send];
        app.log(`Chỉ dịch phần thay đổi: ${delta.parts} khối dòng mới thay cho việc dịch lại cả đoạn dài (bớt ~${delta.savedChars} ký tự)`, 'info');
      }
    }
    app.log(`Bước 2: dịch ${send.length} đoạn${problems ? ` (gồm ${notes.size} đoạn lỗi/cảnh báo)` : ''} (${send.reduce((n, s) => n + s.key.length, 0)} ký tự)`, 'info');
    let lastRefresh = 0;
    const res = await runTranslation({
      segments: send, tm: new Map(p.tm), settings: ts, conn, preset: app.preset.data, dict: p.data.dict, cardName: p.cardName,
      glossary: p.data.glossary, guard: p.guard, signal: ac.signal, force: problems, notes,
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
    // ghép bản dịch các khối dòng mới với phần đã dịch -> đoạn dài hoàn chỉnh
    if (delta?.parts) {
      const r = p.reuseTranslations();
      if (r.composed) app.log(`Đã ghép ${r.composed} đoạn từ phần dịch mới + bản dịch cũ`, 'ok');
      const left = todo.filter((s) => !p.tm.has(s.key)).length;
      if (left && !res.aborted) app.log(`${left} đoạn chưa ghép được (khối dòng mới bị lỗi) — bấm "🔁 Dịch chỗ thiếu/lỗi" để dịch lại nguyên đoạn`, 'warn');
    }
    const warned = todo.filter((s) => p.data.warnings[s.key]).length;
    if (res.aborted) toast('Đã dừng dịch', 'warn');
    else if (res.failed || warned) toast(`Xong: ${res.failed} đoạn lỗi, ${warned} đoạn còn cảnh báo (${secs}s). Bấm "🔁 Dịch chỗ thiếu/lỗi" để thử lại riêng các đoạn này.`, 'warn', 9000);
    else toast(`Dịch xong ${res.done} đoạn trong ${secs}s ✓`, 'ok', 6000);
    app.log(`Hoàn tất: ${res.done} xong, ${res.failed} lỗi, ${warned} cảnh báo, ${secs}s`, res.failed || warned ? 'warn' : 'ok');
    // kiểm tra tổng thể ngay sau khi dịch (chữ Hán sót, EJS, đồng bộ biến, regex) — chi tiết ở tab Kiểm tra
    if (!res.aborted && !itemIds) {
      try {
        const rep = p.check(ts, { deadlineMs: 4000 });
        app.tabs.check?.setReport?.(rep);
        const bad = rep.sections.filter((s) => s.level === 'error' || s.level === 'warn');
        app.log('Kiểm tra sau dịch: ' + (bad.length ? bad.map((s) => `${s.title}: ${s.summary}`).join(' | ') : 'không phát hiện vấn đề ✓'), bad.some((s) => s.level === 'error') ? 'error' : bad.length ? 'warn' : 'ok');
      } catch (e) { console.error('check', e); }
    }
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
  document.getElementById('btnUpdateCard').disabled = !p || !!app.running;
  document.getElementById('btnExport').disabled = !p;
  document.getElementById('btnStop').hidden = !app.running;
  const retry = document.getElementById('btnRetry');
  const probs = p ? p.problemSegments() : [];
  const warned = p ? probs.filter((s) => p.tm.has(s.key)).length : 0;
  retry.disabled = !p || !!app.running || !probs.length;
  retry.textContent = `🔁 Dịch chỗ thiếu/lỗi (${probs.length})`;
  retry.title = p ? `${probs.length - warned} đoạn chưa dịch + ${warned} đoạn lỗi/còn sót chữ Hán` : '';
  if (!app.running) {
    if (p) {
      const st = p.stats();
      setProgress(st.done, st.total, (st.done < st.total ? `· còn ~${st.remainingChars} ký tự` : '✓ đã dịch hết') + (warned ? ` · ⚠ ${warned} đoạn cần dịch lại` : ''));
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
  try {
    const rep = p.check(ts, { deadlineMs: 3000 });
    app.tabs.check?.setReport?.(rep);
    for (const s of rep.sections) if (s.level === 'error' && s.id !== 'dict') notes.push(`• ${s.title}: ${s.summary} — xem tab 🩺 Kiểm tra.`);
  } catch (e) { console.error('check', e); }
  if (notes.length && !(await confirmBox('Lưu ý trước khi xuất:\n' + notes.join('\n') + '\n\nVẫn xuất card?', 'Xuất'))) return;
  try {
    // mã hóa lại các lớp nhúng (base64 / gzip) và link ngoài đã dịch để ghép vào card
    if (p.needsPack()) await p.pack(ts);
    const name = (p.buildCard(ts).data?.name || p.cardName || 'card').replace(/[\\/:*?"<>|]+/g, '_');
    if (type === 'json') {
      download(name + '_VI.json', p.exportJson(ts), 'application/json');
    } else {
      const fallback = p.card.image ? null : await placeholderPng(p.buildCard(ts).data?.name || p.cardName);
      if (!p.card.image) toast('Card chưa có ảnh nên dùng ảnh tạm. Bấm "🖼 Thêm ảnh" ở trang tóm tắt của tab Card để chọn ảnh riêng.', 'warn', 7000);
      download(name + '_VI.png', p.exportPng(ts, fallback), 'image/png');
    }
    app.log('Đã xuất card ' + type.toUpperCase(), 'ok');
    const files = p.resources.filter((r) => r.open && r.meta.origin === 'file');
    const remap = p.resources.filter((r) => r.open && r.meta.origin === 'url' && r.meta.mode === 'remap');
    if (files.length || remap.length) {
      toast(`Card này còn ${files.length + remap.length} tệp tài nguyên đi kèm (${[...files, ...remap].slice(0, 3).map((r) => r.meta.name).join(', ')}${files.length + remap.length > 3 ? '…' : ''}) — xuất bản dịch của chúng ở tab 📦 Tài nguyên.`, 'info', 9000);
    }
  } catch (e) {
    console.error(e);
    toast('Xuất card lỗi: ' + e.message, 'err');
  }
}
app.exportCard = exportCard;

boot().catch((e) => { console.error(e); toast('Lỗi khởi động: ' + e.message, 'err', 10000); });
