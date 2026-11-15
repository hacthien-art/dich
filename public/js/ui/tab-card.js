// Tab Card: cây các phần của card, so sánh gốc/bản dịch, sửa từng đoạn, dịch từng mục
import { h, clear, toast, confirmBox, add, pickFile, imageToPng } from './dom.js';
import { GROUPS } from '../core/card.js';
import { PH_RE } from '../core/analyze.js';
import { validateSegment, allowedHanSet } from '../core/translate.js';
import { formatBytes } from '../core/util.js';

const KIND_LABEL = { name: 'tên', auto: 'văn bản/HTML', initvar: 'InitVar (biến khởi tạo)', code: 'mã script', schema: 'schema Zod', regexFind: 'find regex', keys: 'từ khóa', comment: 'tên mục', list: 'danh sách', button: 'nút script (đồng bộ getButtonEvent)', json: 'dữ liệu JSON (biến Tavern Helper)', trimList: 'trim strings của regex' };
const STATE_LABEL = { done: 'đã dịch', partial: 'dịch một phần', todo: 'chưa dịch', warn: 'đã dịch (có cảnh báo)', manual: 'chỉnh tay', sync: 'chỉ đồng bộ biến', excluded: 'không dịch', none: 'không cần dịch' };

export function create(app, el) {
  const self = { render, liveUpdate, select: selectItem };
  let selected = null;
  let filter = '';
  let onlyTodo = false;
  const collapsed = new Set(['scripts']);
  let treeEl, editorEl;
  // URL ảnh đại diện gắn với đúng mảng byte ảnh của card hiện tại (nhập card khác / đổi ảnh -> tạo lại)
  let avatarUrl = null, avatarOf = null;
  function avatarFor(p) {
    const img = p?.card?.image || null;
    if (img !== avatarOf) {
      if (avatarUrl) URL.revokeObjectURL(avatarUrl);
      avatarUrl = img ? URL.createObjectURL(new Blob([img], { type: 'image/png' })) : null;
      avatarOf = img;
    }
    return avatarUrl;
  }

  async function changeImage() {
    const p = app.project;
    if (!p) return;
    const file = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp');
    if (!file) return;
    try {
      const bytes = await imageToPng(file);
      p.setImage(bytes);
      app.saveProject();
      toast('Đã đổi ảnh card — ảnh này sẽ được dùng khi xuất PNG', 'ok');
      if (!selected) renderEditor();
    } catch (e) { toast('Không dùng được ảnh này: ' + e.message, 'err', 6000); }
  }

  function render() {
    clear(el);
    const p = app.project;
    if (!p) {
      el.classList.remove('fill');
      el.append(
        h('h2', null, '📇 Card & Bản dịch'),
        h('div', { class: 'drop', onclick: () => document.getElementById('btnImport').click() },
          h('div', { style: { fontSize: '40px' } }, '📥'),
          h('div', { style: { fontSize: '16px', margin: '8px 0' } }, 'Bấm hoặc kéo-thả file card SillyTavern (.png / .json) vào đây'),
          h('div', { class: 'small' }, 'Hỗ trợ card V1/V2/V3, card MVU / MVU Zod (InitVar, schema, quy tắc cập nhật), lorebook nhúng, regex, script Tavern Helper, EJS.')),
      );
      return;
    }
    el.classList.add('fill');
    treeEl = h('div', { class: 'tree' });
    editorEl = h('div', { class: 'editor' });
    el.append(h('div', { class: 'card-layout', style: { width: '100%' } }, treeEl, editorEl));
    renderTree();
    renderEditor();
  }

  function renderTree() {
    const p = app.project;
    clear(treeEl);
    const search = h('input', { type: 'search', placeholder: 'Tìm mục…', value: filter });
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); renderGroups(); });
    const todoChk = h('input', { type: 'checkbox', checked: onlyTodo });
    todoChk.addEventListener('change', () => { onlyTodo = todoChk.checked; renderGroups(); });
    treeEl.append(
      h('div', { style: { padding: '4px 6px 8px' } }, search,
        h('label', { class: 'check small' }, todoChk, 'Chỉ hiện mục chưa dịch xong / có lỗi'),
        h('div', { class: 'row', style: { gap: '6px', fontSize: '11px' } },
          ...['done', 'partial', 'todo', 'sync', 'manual'].map((s) => h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'dot ' + s }), STATE_LABEL[s])))),
    );
    const groupsWrap = h('div');
    treeEl.append(groupsWrap);
    const renderGroups = () => {
      clear(groupsWrap);
      for (const [g, gl] of Object.entries(GROUPS)) {
        const items = p.items.filter((it) => it.group === g);
        if (!items.length) continue;
        const shown = items.filter((it) => {
          if (filter && !it.label.toLowerCase().includes(filter)) return false;
          if (onlyTodo) { const st = p.status(it.id).state; return st === 'todo' || st === 'partial' || st === 'warn'; }
          return true;
        });
        const sts = items.map((it) => p.status(it.id));
        const tot = sts.reduce((n, s) => n + s.total, 0), dn = sts.reduce((n, s) => n + s.done, 0);
        const grp = h('div', { class: 'tree-group' + (collapsed.has(g) && !filter ? ' collapsed' : '') },
          h('div', { class: 'gh', onclick: () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); renderGroups(); } },
            h('span', null, collapsed.has(g) && !filter ? '▸' : '▾'), h('span', { style: { flex: 1 } }, gl), h('span', { class: 'pill' }, `${dn}/${tot}`)),
          h('div', { class: 'items' }, shown.map((it) => treeRow(it))));
        groupsWrap.appendChild(grp);
      }
    };
    renderGroups();
  }

  function treeRow(it) {
    const p = app.project;
    const st = p.status(it.id);
    const inc = h('input', { type: 'checkbox', checked: !p.data.excluded[it.id], title: 'Gửi mục này đi dịch' });
    inc.addEventListener('click', (e) => e.stopPropagation());
    inc.addEventListener('change', () => {
      if (inc.checked) delete p.data.excluded[it.id]; else p.data.excluded[it.id] = true;
      p.bump(); p.touch(); app.saveProject(); liveUpdate();
    });
    const disabled = it.kind === 'regexFind' || (!st.total && st.state === 'none');
    return h('div', { class: 'tree-item' + (selected === it.id ? ' sel' : ''), dataset: { id: it.id }, onclick: () => selectItem(it.id) },
      disabled ? h('span', { style: { width: '13px' } }) : inc,
      h('span', { class: 'dot ' + st.state, title: STATE_LABEL[st.state] }),
      h('span', { class: 'lbl', title: it.label }, it.label),
      st.total ? h('span', { class: 'muted small' }, `${st.done}/${st.total}`) : null);
  }

  function selectItem(id) {
    selected = id;
    treeEl?.querySelectorAll('.tree-item').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
    renderEditor();
  }

  function cardSummary() {
    const p = app.project;
    const d = p.card.raw.data;
    const avatar = avatarFor(p);
    const st = p.stats();
    const dictN = Object.keys(p.data.dict).length;
    const book = d.character_book?.entries?.length || 0;
    const rx = d.extensions?.regex_scripts?.length || 0;
    const scripts = p.items.filter((it) => it.group === 'scripts' && it.kind !== 'name').length;
    const warns = [...new Set([...p.analyses.values()].flatMap((a) => a.warnings))];
    return h('div', null,
      h('div', { class: 'summary card-box' },
        h('div', { class: 'avatar-box' },
          avatar ? h('img', { src: avatar, alt: '', title: 'Ảnh dùng khi xuất PNG' }) : h('div', { class: 'avatar-empty', title: 'Card gốc là JSON — xuất PNG sẽ dùng ảnh tạm' }, '🖼', h('div', { class: 'small' }, 'Chưa có ảnh')),
          h('button', { class: 'btn small', onclick: changeImage, title: 'Chọn ảnh PNG/JPG/WebP để dùng khi xuất card PNG' }, avatar ? '🖼 Đổi ảnh' : '🖼 Thêm ảnh'),
          avatar && p.card.format !== 'png' ? h('button', { class: 'btn small ghost', onclick: () => { p.setImage(null); app.saveProject(); renderEditor(); } }, '✕ Bỏ ảnh') : null),
        h('div', { style: { flex: 1 } },
          h('h2', null, d.name || '(không tên)'),
          h('div', { class: 'muted small' }, `${p.card.spec.toUpperCase()} · ${p.card.format.toUpperCase()} · ${p.data.fileName}`),
          h('div', { class: 'stats' },
            h('span', { class: 'pill' }, `${p.items.length} mục`),
            h('span', { class: 'pill' }, `${book} mục lorebook`),
            h('span', { class: 'pill' }, `${rx} regex`),
            h('span', { class: 'pill' }, `${scripts} script`),
            h('span', { class: 'pill key' }, `${dictN} mục từ điển`),
            h('span', { class: 'pill ' + (st.done === st.total ? 'ok' : 'warn') }, `Đã dịch ${st.done}/${st.total} đoạn`),
            st.remainingChars ? h('span', { class: 'pill' }, `còn ${formatBytes(st.remainingChars).replace(' B', '')} ký tự`) : null),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn primary', disabled: !!app.running, onclick: () => app.translateAll() }, '▶ Dịch toàn bộ'),
            h('button', { class: 'btn', disabled: !!app.running || !p.problemSegments().length, onclick: () => app.translateAll(null, { problems: true }) }, `🔁 Dịch chỗ thiếu/lỗi (${p.problemSegments().length})`),
            h('button', { class: 'btn', onclick: () => app.showTab('vars') }, '🧬 Xem bảng biến'),
            h('button', { class: 'btn', onclick: () => app.showTab('preview') }, '🧩 Xem trước regex/HTML')),
        )),
      warns.length ? h('div', { class: 'card-box tight' }, h('b', { class: 'warn' }, '⚠ Cần kiểm tra thủ công:'), h('ul', { class: 'small' }, warns.slice(0, 12).map((w) => h('li', null, w)))) : null,
      h('div', { class: 'muted' }, '← Chọn một mục bên trái để xem bản gốc / bản dịch và sửa từng đoạn.'),
    );
  }

  function renderEditor() {
    const p = app.project;
    if (!editorEl) return;
    clear(editorEl);
    if (!selected || !p.itemById.has(selected)) { editorEl.append(cardSummary()); return; }
    const it = p.itemById.get(selected);
    const a = p.analyses.get(it.id);
    const st = p.status(it.id);
    const isArr = Array.isArray(it.text);
    const toText = (v) => (Array.isArray(v) ? v.join('\n') : String(v ?? ''));
    const manual = p.data.overrides[it.id] !== undefined;

    const orig = h('textarea', { readonly: true }, toText(it.text));
    const out = h('textarea', { spellcheck: 'false' }, toText(p.output(it.id)));
    out.addEventListener('change', () => {
      const v = isArr ? out.value.split('\n').map((x) => x.trim()).filter(Boolean) : out.value;
      p.setOverride(it.id, v);
      app.saveProject();
      toast('Đã lưu chỉnh tay cho mục này (ghi đè bản dịch tự động)', 'ok', 2500);
      renderEditor(); liveUpdate();
    });
    // cuộn đồng bộ
    let syncing = false;
    const sync = (a1, b1) => a1.addEventListener('scroll', () => { if (syncing) return; syncing = true; b1.scrollTop = (a1.scrollTop / Math.max(1, a1.scrollHeight - a1.clientHeight)) * (b1.scrollHeight - b1.clientHeight); requestAnimationFrame(() => { syncing = false; }); });
    sync(orig, out); sync(out, orig);

    const keys = [...new Set(a.segments.map((s) => s.key))];
    const isHtml = typeof it.text === 'string' && /```|<\/?(div|html|body|style|script|span|details)\b/i.test(it.text);
    add(editorEl,
      h('div', { class: 'editor-head' },
        h('h2', null, it.label),
        h('span', { class: 'pill' }, KIND_LABEL[it.kind] || it.kind),
        h('span', { class: 'pill ' + (st.state === 'done' ? 'ok' : st.state === 'todo' ? '' : 'warn') }, STATE_LABEL[st.state]),
      ),
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('button', { class: 'btn primary small', disabled: !keys.length || !!app.running, onclick: () => app.translateAll([it.id]) }, '▶ Dịch mục này'),
        h('button', { class: 'btn small', disabled: !keys.some((k) => !p.tm.has(k) || p.data.warnings[k]) || !!app.running, title: 'Chỉ dịch lại các đoạn chưa dịch hoặc bị lỗi/còn sót chữ Hán của mục này', onclick: () => app.translateAll([it.id], { problems: true }) }, '🔁 Dịch đoạn lỗi'),
        h('button', { class: 'btn small', disabled: !keys.length || !!app.running, onclick: async () => { if (await confirmBox('Dịch lại toàn bộ đoạn của mục này (ghi đè bản dịch hiện có)?', 'Dịch lại')) app.translateAll([it.id], { force: true }); } }, '↻ Dịch lại'),
        h('button', { class: 'btn small', disabled: !keys.some((k) => p.tm.has(k)), onclick: async () => { if (await confirmBox('Xóa bản dịch các đoạn của mục này?', 'Xóa', 'danger')) { p.clearTranslations(keys); app.saveProject(); renderEditor(); liveUpdate(); } } }, '✕ Xóa bản dịch'),
        manual ? h('button', { class: 'btn small', onclick: () => { p.setOverride(it.id, undefined); app.saveProject(); renderEditor(); liveUpdate(); } }, '⟲ Bỏ chỉnh tay') : null,
        isHtml && it.group !== 'scripts' ? h('button', { class: 'btn small', onclick: () => { app.tabs.preview.focusItem?.(it); app.showTab('preview'); } }, '👁 Xem trước') : null,
        h('span', { class: 'muted small' }, keys.length ? `${st.done}/${st.total} đoạn đã dịch` : (it.kind === 'regexFind' ? 'Mục này chỉ đồng bộ nhãn (marker) theo từ điển, không dịch bằng AI' : 'Không có đoạn cần dịch — chỉ đồng bộ biến')),
      ),
      a.warnings.length ? h('div', { class: 'card-box tight' }, a.warnings.map((w) => h('div', { class: 'warn small' }, '⚠ ' + w))) : null,
      manual ? h('div', { class: 'card-box tight warn small' }, 'Mục này đang dùng bản chỉnh tay. Thay đổi bảng biến/đoạn dịch sẽ không tự áp dụng cho tới khi bấm "Bỏ chỉnh tay".') : null,
      h('div', { class: 'split' },
        h('div', null, h('h4', null, 'Bản gốc'), orig),
        h('div', null, h('h4', null, 'Bản dịch (sửa trực tiếp = chỉnh tay)'), out)),
    );

    if (keys.length) {
      const segWrap = h('div');
      const renderSegs = () => {
        clear(segWrap);
        const tbl = h('table', { class: 'tbl seg-table' }, h('tr', null, h('th', null, '#'), h('th', null, 'Đoạn gốc (⟦n⟧ = mã/thẻ/biến được giữ nguyên)'), h('th', null, 'Bản dịch'), h('th', null, '')));
        keys.forEach((k, i) => {
          const seg = a.segments.find((s) => s.key === k);
          const tr = p.tm.get(k);
          const ta = h('textarea', { rows: Math.min(8, Math.max(1, Math.ceil(k.length / 60))), placeholder: '(chưa dịch)' }, tr ?? '');
          const stEl = h('span', { class: 'small ' + (tr == null ? 'muted' : p.data.warnings[k] ? 'warn' : 'ok') }, tr == null ? '—' : p.data.warnings[k] ? '⚠ ' + p.data.warnings[k] : '✓');
          ta.addEventListener('change', () => {
            const v = ta.value;
            if (!v.trim()) { p.clearTranslations([k]); app.saveProject(); renderEditor(); liveUpdate(); return; }
            const val = validateSegment(seg, v, allowedHanSet(p.data.dict, app.ts(), p.data.glossary));
            if (!val.ok && !val.soft) { toast('Không lưu: ' + val.reason + '. Bản dịch phải giữ đủ các ⟦n⟧.', 'err', 5000); return; }
            p.setTranslation(k, val.out ?? v, val.ok ? val.warn : val.reason);
            app.saveProject();
            out.value = toText(p.output(it.id));
            stEl.textContent = '✓ (sửa tay)'; stEl.className = 'small ok';
            liveUpdate();
          });
          const phs = (k.match(PH_RE) || []).length;
          tbl.appendChild(h('tr', null,
            h('td', { class: 'muted small' }, String(i + 1)),
            h('td', { class: 'k' }, h('div', { class: 'src' }, k), phs ? h('div', { class: 'muted small' }, seg.holes.map((hh, j) => `⟦${j + 1}⟧ ${describeHole(hh)}`).join(' · ').slice(0, 300)) : null),
            h('td', null, ta),
            h('td', null, stEl)));
        });
        segWrap.appendChild(h('div', { class: 'table-wrap' }, tbl));
      };
      const det = h('details', { open: keys.length <= 40 }, h('summary', { style: { cursor: 'pointer', margin: '16px 0 8px', fontWeight: 600 } }, `Các đoạn dịch (${keys.length}) — sửa từng đoạn, bảng biến vẫn tự đồng bộ`), segWrap);
      det.addEventListener('toggle', () => { if (det.open && !segWrap.firstChild) renderSegs(); });
      if (det.open) renderSegs();
      editorEl.append(det);
    }
  }

  function describeHole(hh) {
    if (!hh) return '';
    if (hh.type === 'dict') return 'biến/thuật ngữ: ' + hh.src;
    if (hh.type === 'path') return 'đường dẫn biến: ' + hh.src;
    if (hh.type === 'macro') return 'macro: ' + hh.src;
    if (hh.type === 'entry') return 'tên mục: ' + hh.src;
    if (hh.type === 'raw') return JSON.stringify(hh.text).slice(0, 40);
    if (hh.type === 'multi') return 'thẻ/mã';
    return 'mã';
  }

  function liveUpdate() {
    if (!app.project || app.currentTab !== 'card' || !treeEl) { self.stale = true; return; }
    const scroll = treeEl.scrollTop;
    renderTree();
    treeEl.scrollTop = scroll;
    if (!selected) { const es = editorEl.scrollTop; renderEditor(); editorEl.scrollTop = es; }
    app.updateTopbar();
  }

  return self;
}
