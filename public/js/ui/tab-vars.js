// Tab Biến & Đồng bộ: bảng ánh xạ tên biến / giá trị / nhãn / thuật ngữ, kiểm tra schema Zod với InitVar
import { h, clear, toast, field, select, confirmBox, add } from './dom.js';
import { NAMING_STYLES, makeDictIndex, applyStyle, stripAccents } from '../core/dict.js';
import { NAME_RULES } from '../core/translate.js';
import { runDictSuggest } from '../app.js';
import { load as yamlLoad } from '../../vendor/js-yaml.mjs';
import { validateSchema } from '../preview/sandbox.js';

const KIND_NAMES = { key: 'Tên biến', value: 'Giá trị', marker: 'Nhãn regex', term: 'Thuật ngữ' };

/** Chuẩn hóa để tìm: chữ thường, bỏ dấu tiếng Việt (gõ "do hao cam" vẫn ra "Độ hảo cảm") */
const normQ = (s) => stripAccents(String(s || '').toLowerCase()).trim();
function entryMatches(src, v, idx, nq) {
  if (normQ(src).includes(nq)) return true;
  const hay = [v.dst, idx.lookup(src), ...(v.parents || []), ...(v.samples || [])];
  return hay.some((x) => x && normQ(x).includes(nq));
}

export function create(app, el) {
  const self = { render };
  let kindFilter = 'all';
  let q = '';
  let page = 0;
  const PAGE = 150;

  function render() {
    clear(el);
    const p = app.project;
    const ts = app.ts();
    if (!p) { el.append(h('h2', null, '🧬 Biến & Đồng bộ'), h('div', { class: 'empty' }, 'Hãy nhập card trước.')); return; }
    const save = () => { app.saveSettings(); p.bump(); };

    const reanalyze = () => { p.analyze(ts); app.saveProject(); render(); app.refresh('card'); app.updateTopbar(); };

    const modes = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Chế độ đồng bộ'),
      h('div', { class: 'grid2' },
        field('Tên biến MVU & giá trị enum', select({ translate: 'Dịch sang tiếng Việt & đồng bộ toàn card', keep: 'Giữ nguyên tiếng Trung (an toàn nhất)' }, ts.varMode, (v) => { ts.varMode = v; save(); render(); }),
          'Áp dụng đồng thời cho: InitVar, schema Zod, quy tắc cập nhật ([mvu_update]), đường dẫn stat_data trong HTML/JS, macro {{getvar::}}, EJS, JSON Patch.'),
        field('Kiểu đặt tên biến', select(NAMING_STYLES, ts.namingStyle, (v) => { ts.namingStyle = v; save(); render(); }),
          'Tên có dấu cách vẫn an toàn: mã JS tự chuyển sang dạng obj[\'tên\'] và khóa object được đặt trong nháy.'),
        field('Nhãn trong find regex (vd 【开场白】)', select({ translate: 'Dịch & cập nhật regex tương ứng', keep: 'Giữ nguyên' }, ts.markerMode, (v) => { ts.markerMode = v; save(); render(); })),
        field('Cách dịch tên riêng', select({ auto: 'Tự động (Trung→Hán Việt, Nhật→romaji)', hanviet: 'Hán Việt toàn bộ', original: 'Phiên âm gốc (pinyin/romaji)' }, ts.nameStyle, (v) => { ts.nameStyle = v; save(); }), NAME_RULES[ts.nameStyle]),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !!app.running, onclick: () => suggest(false) }, '✨ AI gợi ý mục chưa có bản dịch'),
        h('button', { class: 'btn', disabled: !!app.running, onclick: async () => { if (await confirmBox('Gợi ý lại TẤT CẢ (trừ mục bạn đã sửa tay)?', 'Gợi ý lại')) suggest(true); } }, '↻ Gợi ý lại tất cả'),
        h('button', { class: 'btn', onclick: () => { p.rescan(ts); app.saveProject(); render(); app.refresh('card'); toast('Đã quét lại biến', 'ok'); } }, '🔍 Quét lại card'),
        h('span', { class: 'muted small' }, 'Bấm "Dịch toàn bộ" cũng tự gợi ý các mục còn trống trước khi dịch.')),
    );

    // ---------------------------------------------------------- xung đột
    const conflicts = p.conflicts(ts);
    const conflictBox = conflicts.length ? h('div', { class: 'card-box' },
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('h3', { class: 'err', style: { margin: 0, flex: 1 } }, `⚠ ${conflicts.length} xung đột tên biến`),
        h('button', { class: 'btn primary small', disabled: !!app.running || ts.varMode === 'keep', title: 'Gửi các biến bị trùng tên cho AI đặt lại tên khác nhau (giữ nguyên mục bạn đã sửa tay nếu được)', onclick: () => app.fixConflicts() }, `🤖 Tự dịch lại ${conflicts.reduce((n, c) => n + c.srcs.length, 0)} biến trùng`)),
      h('div', { class: 'muted small', style: { marginBottom: '8px' } }, '2 biến khác nhau trong cùng object cha bị dịch thành cùng một tên → dữ liệu ghi đè lên nhau. App tự sửa sau khi gợi ý từ điển (tắt/bật ở tab Cài đặt dịch); nếu AI vẫn đặt trùng, app thêm hậu tố số để chắc chắn khác nhau.'),
      conflicts.slice(0, 20).map((c) => h('div', { class: 'conflict small' }, `Trong "${c.parent || '(gốc)'}": ${c.srcs.join(', ')} → cùng thành "${c.dst}".`)),
      conflicts.length > 20 ? h('div', { class: 'muted small' }, `… và ${conflicts.length - 20} xung đột khác`) : null) : null;

    // ---------------------------------------------------------- bảng từ điển
    const entries = Object.entries(p.data.dict);
    const counts = { all: entries.length };
    for (const [, v] of entries) counts[v.kind] = (counts[v.kind] || 0) + 1;
    const tableWrap = h('div', { class: 'table-wrap' });
    const pager = h('div', { class: 'row', style: { marginTop: '6px' } });
    const foundEl = h('span', { class: 'muted small' });
    const renderTable = () => {
      clear(tableWrap); clear(pager);
      const idx = makeDictIndex(p.data.dict, ts);
      const nq = normQ(q);
      const filtered = entries.filter(([src, v]) => (kindFilter === 'all' || v.kind === kindFilter) && (!nq || entryMatches(src, v, idx, nq)));
      foundEl.textContent = nq ? `${filtered.length} kết quả` : '';
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
      if (page >= pages) page = pages - 1;
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Gốc'), h('th', null, 'Loại'), h('th', { style: { width: '34%' } }, 'Bản dịch (sửa được)'), h('th', null, 'Kết quả dùng'), h('th', null, 'Giữ'), h('th', null, 'Ngữ cảnh')));
      const slice = filtered.slice(page * PAGE, (page + 1) * PAGE);
      for (const [src, v] of slice) {
        const res = h('span', { class: 'mono small' }, idx.lookup(src));
        const inp = h('input', { type: 'text', value: v.dst || '', placeholder: v.keep ? '(giữ nguyên)' : '(trống = giữ nguyên)' });
        inp.addEventListener('change', () => {
          v.dst = inp.value.trim(); v.manual = true; v.auto = false;
          p.bump(); p.touch(); app.saveProject();
          res.textContent = makeDictIndex(p.data.dict, ts).lookup(src);
          app.refresh('card');
        });
        const keep = h('input', { type: 'checkbox', checked: !!v.keep, title: 'Giữ nguyên tiếng Trung' });
        keep.addEventListener('change', () => { v.keep = keep.checked; v.manual = true; p.bump(); p.touch(); app.saveProject(); res.textContent = makeDictIndex(p.data.dict, ts).lookup(src); });
        const kindSel = select(KIND_NAMES, v.kind, (k) => { v.kind = k; v.manual = true; reanalyze(); });
        kindSel.style.width = '110px'; kindSel.style.padding = '3px 5px';
        tbl.appendChild(h('tr', null,
          h('td', { class: 'src' }, src, v.manual ? h('span', { class: 'muted small', title: 'Đã sửa tay' }, ' ✎') : null),
          h('td', null, kindSel),
          h('td', null, inp),
          h('td', null, res),
          h('td', null, keep),
          h('td', { class: 'muted small' }, `${v.count}×`, v.parents?.length ? ' · ' + v.parents.slice(0, 2).join(' | ') : '', v.samples?.length && !v.parents?.length ? ' · ' + v.samples[0] : '')));
      }
      if (!slice.length) tbl.appendChild(h('tr', null, h('td', { colspan: 6, class: 'muted' }, nq ? `Không có mục nào khớp "${q}"` : 'Không có mục nào')));
      tableWrap.appendChild(tbl);
      if (pages > 1) {
        pager.append(h('span', { class: 'muted small' }, `Trang ${page + 1}/${pages}`),
          h('button', { class: 'btn small', disabled: page === 0, onclick: () => { page--; renderTable(); } }, '‹'),
          h('button', { class: 'btn small', disabled: page >= pages - 1, onclick: () => { page++; renderTable(); } }, '›'));
      }
    };
    // Ô tìm kiếm: chỉ vẽ lại bảng (không vẽ lại cả tab -> không mất focus, gõ tiếng Việt/bộ gõ IME không bị ngắt)
    const search = h('input', { type: 'search', placeholder: 'Tìm gốc / bản dịch / ngữ cảnh…', value: q, style: { maxWidth: '260px' } });
    let composing = false, timer = 0;
    const applySearch = () => { clearTimeout(timer); timer = setTimeout(() => { if (search.value.trim() === q) return; q = search.value.trim(); page = 0; renderTable(); }, 150); };
    search.addEventListener('compositionstart', () => { composing = true; });
    search.addEventListener('compositionend', () => { composing = false; applySearch(); });
    search.addEventListener('input', () => { if (!composing) applySearch(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; applySearch(); } });
    const addRow = h('button', { class: 'btn small', onclick: () => {
      const src = prompt('Từ/cụm tiếng Trung cần thêm vào từ điển:');
      if (!src || !src.trim()) return;
      p.data.dict[src.trim()] = { kind: 'term', dst: '', keep: false, manual: true, userAdded: true, count: 0, parents: [], samples: [] };
      reanalyze();
    } }, '➕ Thêm thuật ngữ');
    renderTable();

    const dictBox = h('div', { class: 'card-box' },
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('h3', { style: { margin: 0, flex: 1 } }, 'Bảng đồng bộ (biến · giá trị · nhãn · thuật ngữ)'),
        ...['all', 'key', 'value', 'marker', 'term'].map((k) => h('button', { class: 'btn small' + (kindFilter === k ? ' primary' : ''), onclick: () => { kindFilter = k; page = 0; render(); } }, `${k === 'all' ? 'Tất cả' : KIND_NAMES[k]} (${counts[k] || 0})`)),
        search, foundEl, addRow),
      h('div', { class: 'muted small', style: { marginBottom: '8px' } },
        'Mỗi mục được thay đồng loạt ở mọi nơi trong card (thay theo vị trí đã phân tích, không thay chuỗi mù). Đổi bản dịch ở đây → bản dịch card cập nhật ngay, không cần gọi lại AI. ',
        h('b', null, 'Kết quả dùng'), ' = tên sau khi áp dụng kiểu đặt tên.'),
      tableWrap, pager,
    );

    // ---------------------------------------------------------- InitVar & schema
    const ivBox = h('div', { class: 'card-box' }, h('h3', { style: { marginTop: 0 } }, 'Biến khởi tạo (InitVar) — gốc ⇄ sau dịch'));
    const ivItems = p.allInitVarItems();
    if (!ivItems.length) ivBox.append(h('div', { class: 'muted' }, 'Card không có mục lorebook [InitVar].'));
    for (const it of ivItems) {
      let o0 = null, o1 = null, e0 = '', e1 = '';
      try { o0 = yamlLoad(it.text); } catch (e) { e0 = e.message.split('\n')[0]; }
      try { o1 = yamlLoad(p.output(it.id)); } catch (e) { e1 = e.message.split('\n')[0]; }
      ivBox.append(h('h4', null, it.meta?.title || it.label),
        h('div', { class: 'split' },
          h('div', null, h('div', { class: 'muted small' }, 'Gốc'), h('div', { class: 'tree-json' }, e0 ? '✗ ' + e0 : JSON.stringify(o0, null, 2))),
          h('div', null, h('div', { class: 'muted small' }, 'Sau dịch'), h('div', { class: 'tree-json' }, e1 ? '✗ YAML lỗi: ' + e1 : JSON.stringify(o1, null, 2)))));
    }
    const schemaItems = p.schemaItems();
    if (schemaItems.length && ivItems.length) {
      const out = h('div', { class: 'small', style: { marginTop: '8px' } });
      const btn = h('button', { class: 'btn primary', onclick: async () => {
        btn.disabled = true; clear(out); out.append('Đang chạy schema trong sandbox (cần mạng nếu schema import thư viện ngoài)…');
        try {
          const iv = ivItems[0];
          const runs = [
            ['Gốc', schemaItems[0].text, yamlLoad(iv.text)],
            ['Sau dịch', p.output(schemaItems[0].id), yamlLoad(p.output(iv.id))],
          ];
          clear(out);
          for (const [label, code, data] of runs) {
            const r = await validateSchema(code, data);
            add(out, h('div', { class: r.ok ? 'ok' : 'err' }, `${label}: ${r.ok ? '✓ schema chấp nhận InitVar' : '✗ ' + (r.error || 'không hợp lệ')}`),
              r.issues?.length ? h('pre', { class: 'code-view' }, JSON.stringify(r.issues.slice(0, 8), null, 1)) : null);
          }
        } catch (e) { clear(out); out.append(h('div', { class: 'err' }, '✗ ' + e.message)); }
        finally { btn.disabled = false; }
      } }, '🧪 Kiểm tra schema Zod với InitVar (gốc & sau dịch)');
      ivBox.append(h('hr'), h('div', { class: 'row' }, btn, h('span', { class: 'muted small' }, 'Chạy script schema trong iframe cô lập để chắc chắn tên biến đã đồng bộ.')), out);
    }

    // ---------------------------------------------------------- glossary bổ sung
    const gl = p.data.glossary;
    const glText = h('textarea', { rows: 5, placeholder: '高松灯 = Takamatsu Tomori\n羽丘女子学园 = Học viện nữ sinh Haneoka' }, gl.map((g) => `${g.src} = ${g.dst}`).join('\n'));
    glText.addEventListener('change', () => {
      p.data.glossary = glText.value.split('\n').map((l) => l.split(/\s*(?:=|→|->)\s*/)).filter((x) => x.length >= 2 && x[0].trim()).map(([src, ...r]) => ({ src: src.trim(), dst: r.join('=').trim() }));
      p.touch(); app.saveProject(); toast('Đã lưu bảng thuật ngữ bổ sung', 'ok', 1800);
    });
    const glBox = h('div', { class: 'card-box' }, h('h3', { style: { marginTop: 0 } }, 'Thuật ngữ bổ sung (chỉ gợi ý cho AI, mỗi dòng: gốc = dịch)'), glText);

    add(el, h('h2', null, '🧬 Biến & Đồng bộ'), modes, conflictBox, dictBox, ivBox, glBox);
    void applyStyle;
  }

  async function suggest(all) {
    const p = app.project;
    const ts = app.ts();
    const need = Object.entries(p.data.dict)
      .filter(([, v]) => !v.keep && !v.manual && (all || !v.dst))
      .filter(([, v]) => !((v.kind === 'key' || v.kind === 'value') && ts.varMode === 'keep') && !(v.kind === 'marker' && ts.markerMode === 'keep'))
      .map(([src, v]) => ({ src, kind: v.kind, parents: v.parents }));
    if (!need.length) return toast('Không có mục nào cần gợi ý', 'info');
    const conn = app.conn();
    if (!conn.url || !conn.model) { toast('Cấu hình proxy & model trước', 'warn'); app.showTab('connect'); return; }
    toast(`Đang gợi ý ${need.length} mục…`, 'info');
    try { await runDictSuggest(need); toast('Đã gợi ý xong — hãy kiểm tra lại bảng', 'ok'); }
    catch (e) { toast('Lỗi: ' + e.message, 'err'); }
    render();
    app.refresh('card');
  }

  return self;
}
