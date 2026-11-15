// Tab Kiểm tra: kiểm tra tổng thể card SAU DỊCH — chữ Hán còn sót, từ điển, EJS, script, đồng bộ biến, regex, tên mục
import { h, clear, toast, add, confirmBox } from './dom.js';
import { HAN_CATEGORIES } from '../core/check.js';
import { runDictSuggest } from '../app.js';
import { validateSchema } from '../preview/sandbox.js';
import { load as yamlLoad } from '../../vendor/js-yaml.mjs';

const ICON = { ok: '✓', info: 'ℹ', warn: '⚠', error: '✗' };
const CLS = { ok: 'ok', info: 'muted', warn: 'warn', error: 'err' };

export function create(app, el) {
  const self = { render, setReport, onShow };
  let report = null;     // kết quả runChecks gần nhất
  let reportVer = -1;    // p.version lúc chạy (cũ hơn -> nhắc chạy lại)
  let reportPid = null;
  // phần có lỗi / cảnh báo tự mở; người dùng bấm tiêu đề để đóng/mở
  const opened = new Set(), closed = new Set();
  const isOpen = (s) => opened.has(s.id) || ((s.level === 'error' || s.level === 'warn') && !closed.has(s.id));
  const toggle = (s) => { if (isOpen(s)) { opened.delete(s.id); closed.add(s.id); } else { closed.delete(s.id); opened.add(s.id); } };

  function setReport(r) {
    report = r; reportVer = app.project?.version ?? -1; reportPid = app.project?.id ?? null;
    updateBadge();
    if (app.currentTab === 'check') render(); else self.stale = true;
  }

  function onShow() {
    // mở tab lần đầu với dự án -> tự chạy (nhanh, không gọi AI)
    if (app.project && (!report || reportPid !== app.project.id)) run();
  }

  function updateBadge() {
    const b = document.getElementById('checkBadge');
    if (!b) return;
    const n = report ? report.sections.filter((s) => s.level === 'error').length : 0;
    b.hidden = !n; b.textContent = String(n);
  }

  function run() {
    const p = app.project;
    if (!p) return;
    try {
      const t0 = performance.now();
      const r = p.check(app.ts());
      r.ms = Math.round(performance.now() - t0);
      setReport(r);
    } catch (e) {
      console.error(e);
      toast('Lỗi khi kiểm tra: ' + e.message, 'err', 8000);
    }
  }

  function goto(itemId) {
    if (!itemId || !app.project?.itemById.has(itemId)) return;
    app.showTab('card');
    app.tabs.card.select(itemId);
  }

  // ------------------------------------------------------------------ hành động sửa nhanh
  async function suggestMissing(srcs) {
    const p = app.project;
    const conn = app.conn();
    if (!conn.url || !conn.model) { toast('Cấu hình proxy & model ở tab Kết nối trước', 'warn'); app.showTab('connect'); return; }
    const entries = srcs.filter((s) => p.data.dict[s]).map((src) => ({ src, kind: p.data.dict[src].kind, parents: p.data.dict[src].parents }));
    // mục AI trả về vẫn còn chữ Hán: xóa bản dịch hỏng để gợi ý lại
    for (const e of entries) { const v = p.data.dict[e.src]; if (!v.manual) v.dst = ''; }
    await runDictSuggest(entries);
    p.analyze(app.ts()); p.recheckWarnings(app.ts());
    app.saveProject(); app.refreshAll(); run();
  }

  async function addLiterals(lits) {
    const p = app.project;
    if (!lits.length) return;
    const ok = await confirmBox(`Thêm ${lits.length} chuỗi tiếng Trung còn sót (nằm trong mã / chuỗi được giữ nguyên) vào từ điển dưới dạng "Thuật ngữ"?\n\nSau khi thêm, mọi chỗ trong card có ĐÚNG chuỗi đó (kể cả trong mã, so sánh, dữ liệu) sẽ được thay bằng cùng một bản dịch, nên mã vẫn khớp với nhau. Chỉ nên thêm chuỗi là chữ hiển thị; chuỗi bị mã ghép động hoặc so với dữ liệu bên ngoài card thì nên giữ.\n\n${lits.slice(0, 20).map((x) => '• ' + x.text).join('\n')}${lits.length > 20 ? '\n…' : ''}`, 'Thêm & gợi ý bản dịch');
    if (!ok) return;
    for (const l of lits) if (!p.data.dict[l.text]) p.data.dict[l.text] = { kind: 'term', dst: '', keep: false, manual: false, userAdded: true, count: l.count, parents: [], samples: [] };
    p.analyze(app.ts());
    app.saveProject();
    const conn = app.conn();
    if (conn.url && conn.model) await suggestMissing(lits.map((l) => l.text));
    else { toast('Đã thêm vào từ điển. Kết nối API rồi bấm "AI gợi ý" ở tab Biến để dịch các mục này.', 'info', 7000); app.refreshAll(); run(); }
  }

  async function schemaCheck(out) {
    const p = app.project;
    const iv = p.allInitVarItems()[0], sc = p.schemaItems()[0];
    clear(out);
    if (!iv || !sc) { out.append(h('div', { class: 'muted small' }, 'Card không có InitVar và schema Zod để kiểm tra.')); return; }
    out.append(h('div', { class: 'muted small' }, 'Đang chạy schema trong sandbox…'));
    const rows = [];
    for (const [label, code, text] of [['Gốc', sc.text, iv.text], ['Sau dịch', p.output(sc.id), p.output(iv.id)]]) {
      let data;
      try { data = yamlLoad(String(text)); } catch (e) { rows.push(h('div', { class: 'err small' }, `${label}: ✗ InitVar không phải YAML hợp lệ — ${String(e.message).split('\n')[0]}`)); continue; }
      const r = await validateSchema(code, data);
      rows.push(h('div', { class: (r.ok ? 'ok' : 'err') + ' small' }, `${label}: ${r.ok ? '✓ schema chấp nhận InitVar' : '✗ ' + (r.error || 'không hợp lệ')}`),
        r.issues?.length ? h('pre', { class: 'code-view' }, r.issues.slice(0, 8).map((i) => `${i.path}: ${i.message}`).join('\n')) : null);
    }
    clear(out);
    add(out, ...rows);
  }

  // ------------------------------------------------------------------ giao diện
  function render() {
    clear(el);
    const p = app.project;
    el.append(h('h2', null, '🩺 Kiểm tra tổng thể sau dịch'));
    if (!p) { el.append(h('div', { class: 'empty' }, 'Hãy nhập card trước.')); return; }
    const staleNote = report && (reportPid !== p.id || reportVer !== p.version);
    el.append(h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn primary', onclick: run }, report ? '⟳ Chạy lại kiểm tra' : '▶ Chạy kiểm tra'),
      h('button', { class: 'btn', disabled: !!app.running || !p.problemSegments().length, onclick: () => app.translateAll(null, { problems: true }) }, `🔁 Dịch chỗ thiếu/lỗi (${p.problemSegments().length})`),
      p.conflicts().length ? h('button', { class: 'btn', disabled: !!app.running, onclick: async () => { await app.fixConflicts(); run(); } }, `🤖 Sửa ${p.conflicts().length} nhóm biến trùng tên`) : null,
      h('span', { class: 'muted small' }, report ? `Lần chạy gần nhất: ${report.ms || 0} ms` + (staleNote ? ' — card/bản dịch đã thay đổi, nên chạy lại' : '') : 'Không gọi AI — chỉ phân tích card sau dịch.')));
    el.append(h('div', { class: 'muted small', style: { marginBottom: '12px' } },
      'Kiểm tra card XUẤT RA (không chỉ các đoạn đã gửi AI): chữ Hán còn sót ở mọi nơi, từ điển chưa dịch / trùng tên (kể cả khác chữ hoa-thường), ',
      'EJS và script còn biên dịch được, InitVar YAML, đường dẫn biến khớp từ điển, find regex còn khớp văn bản sau dịch, getwi() trỏ đúng tên mục, $1 / macro / thẻ HTML không bị mất.'));
    if (!report || reportPid !== p.id) { el.append(h('div', { class: 'empty' }, 'Bấm "Chạy kiểm tra".')); return; }

    const t = report.totals;
    el.append(h('div', { class: 'stats', style: { marginBottom: '12px' } },
      h('span', { class: 'pill ' + (t.error ? 'err' : 'ok') }, `${t.error || 0} lỗi`),
      h('span', { class: 'pill ' + (t.warn ? 'warn' : 'ok') }, `${t.warn || 0} cảnh báo`),
      h('span', { class: 'pill' }, `${t.info || 0} ghi chú`)));

    for (const s of report.sections) {
      const box = h('div', { class: 'card-box check-sec ' + s.level });
      const head = h('div', { class: 'check-head', onclick: () => { toggle(s); render(); } },
        h('span', { class: 'check-icon ' + CLS[s.level] }, ICON[s.level]),
        h('b', { style: { flex: 1 } }, s.title),
        h('span', { class: 'muted small' }, s.summary),
        s.findings.length ? h('span', { class: 'muted' }, isOpen(s) ? '▾' : '▸') : null);
      box.append(head);
      if (isOpen(s) && s.findings.length) {
        const list = h('div', { class: 'check-list' });
        for (const f of s.findings) {
          const row = h('div', { class: 'check-row ' + CLS[f.level] },
            h('span', { class: 'check-icon' }, ICON[f.level]),
            h('div', { style: { flex: 1, minWidth: 0 } }, f.text, f.detail ? h('pre', { class: 'code-view' }, f.detail) : null),
            f.itemId ? h('button', { class: 'btn small', onclick: () => goto(f.itemId) }, 'Mở mục') : null);
          list.append(row);
        }
        if (s.more) list.append(h('div', { class: 'muted small' }, `… và ${s.more} mục khác`));
        box.append(list);
      }
      // hành động theo từng phần
      const acts = h('div', { class: 'row', style: { marginTop: '8px' } });
      if (s.id === 'dict' && s.data) {
        const miss = [...s.data.untranslated, ...s.data.hanLeft];
        if (miss.length) acts.append(h('button', { class: 'btn small primary', disabled: !!app.running, onclick: () => suggestMissing(miss) }, `✨ AI dịch ${miss.length} mục còn thiếu / còn chữ Hán`));
        if (miss.length || s.data.conflicts.length) acts.append(h('button', { class: 'btn small', onclick: () => app.showTab('vars') }, '🧬 Mở bảng biến'));
      }
      if (s.id === 'han' && s.data) {
        const cats = s.data.byCat || {};
        acts.append(h('span', { class: 'muted small' }, Object.entries(cats).map(([k, n]) => `${HAN_CATEGORIES[k] || k}: ${n}`).join(' · ')));
        const lits = (s.data.literals || []).filter((l) => !app.project.data.dict[l.text]);
        if (lits.length) acts.append(h('button', { class: 'btn small', disabled: !!app.running, title: 'Chuỗi tiếng Trung nằm trong mã / chuỗi được giữ nguyên (không gửi AI theo quy tắc "thông minh"). Thêm vào từ điển để thay đồng loạt ở mọi nơi.', onclick: () => addLiterals(lits) }, `➕ Thêm ${lits.length} chuỗi còn sót vào từ điển`));
      }
      if (s.id === 'sync') {
        const out = h('div', { style: { marginTop: '6px', width: '100%' } });
        if (p.schemaItems().length && p.allInitVarItems().length) acts.append(h('button', { class: 'btn small', onclick: () => schemaCheck(out) }, '🧪 Chạy schema Zod với InitVar (gốc & sau dịch)'));
        acts.append(out);
      }
      if (s.id === 'regex') acts.append(h('button', { class: 'btn small', onclick: () => app.showTab('preview') }, '🧩 Xem trước regex'));
      if (acts.childNodes.length) box.append(acts);
      el.append(box);
    }
  }

  return self;
}
