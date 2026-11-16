// Tab Tài nguyên: tệp đi kèm card (gói bản đồ .gz, HTML, JS, JSON…), link ngoài (GitHub / jsDelivr…) và nội dung nhúng
// (base64 / gzip) — tất cả được bóc thành từng "lớp", dịch bằng cùng từ điển + bộ nhớ dịch với card, rồi đóng gói lại.
import { h, clear, toast, add, pickFile, select } from './dom.js';
import { formatBytes, truncate } from '../core/util.js';
import { RESOURCE_ACCEPT, KIND_NAMES } from '../core/resource.js';
import { KIND_LABEL } from '../core/links.js';

const MODE_LABELS = {
  inline: 'Nhúng thẳng bản dịch vào card (data: URL)',
  remap: 'Đổi sang URL khác (tự đăng tải bản dịch)',
  keep: 'Giữ link gốc (không dịch)',
};

export function create(app, el) {
  const self = { render };
  const openFields = new Set(); // itemId đang mở bảng trường dữ liệu
  let showLibs = false;

  const goto = (itemId) => { app.showTab('card'); app.tabs.card.select(itemId); };

  /** Số đoạn / ký tự còn phải dịch của một mục */
  function progress(it) {
    const p = app.project;
    const st = p.status(it.id);
    const a = p.analyses.get(it.id);
    let chars = 0;
    const seen = new Set();
    for (const s of a?.segments || []) if (!p.tm.has(s.key) && !seen.has(s.key)) { seen.add(s.key); chars += s.key.length; }
    return { ...st, chars };
  }

  function toggleItem(it, on) {
    const p = app.project;
    if (on) delete p.data.excluded[it.id]; else p.data.excluded[it.id] = true;
    p.bump(); p.touch(); app.saveProject(); app.updateTopbar(); app.refresh('card');
    render();
  }

  /** Bảng các lớp của một nhóm mục (lớp gốc + lớp nhúng bên trong) */
  function layerTable(items) {
    const p = app.project;
    const tbl = h('table', { class: 'tbl' }, h('tr', null,
      h('th', { title: 'Gửi lớp này đi dịch' }, 'Dịch'), h('th', null, 'Lớp nội dung'), h('th', null, 'Loại'), h('th', null, 'Mã hóa'), h('th', null, 'Kích thước'), h('th', null, 'Đoạn dịch'), h('th', null, 'Còn phải dịch'), h('th', null, '')));
    for (const it of items) {
      const pr = progress(it);
      const a = p.analyses.get(it.id);
      const inc = h('input', { type: 'checkbox', checked: !p.data.excluded[it.id] });
      inc.addEventListener('change', () => toggleItem(it, inc.checked));
      const depth = it.meta.root ? 0 : 1 + depthOf(it);
      const hasFields = !!a?.fields?.length;
      tbl.appendChild(h('tr', null,
        h('td', null, pr.total ? inc : ''),
        h('td', null, h('span', { style: { paddingLeft: depth * 16 + 'px' } }, depth ? '└ ' : '', truncate(it.meta.root ? it.meta.title : it.label.split(' › ').pop(), 70)),
          a?.warnings?.length ? h('span', { class: 'warn small', title: a.warnings.slice(0, 8).join('\n') }, ` ⚠ ${a.warnings.length}`) : null),
        h('td', { class: 'small' }, KIND_NAMES[it.kind] || it.kind),
        h('td', { class: 'small muted' }, it.meta.enc || ''),
        h('td', { class: 'small muted' }, formatBytes(it.meta.size || it.text.length).replace(' B', ' ký tự')),
        h('td', { class: 'small' }, pr.total ? h('span', { class: pr.done === pr.total ? 'ok' : '' }, `${pr.done}/${pr.total}`) : h('span', { class: 'muted' }, 'không có')),
        h('td', { class: 'small' }, pr.chars ? `${pr.chars.toLocaleString('vi-VN')} ký tự` : (pr.total ? h('span', { class: 'ok' }, '✓') : '')),
        h('td', { style: { whiteSpace: 'nowrap' } },
          h('button', { class: 'btn small', onclick: () => goto(it.id) }, 'Mở'), ' ',
          hasFields ? h('button', { class: 'btn small' + (openFields.has(it.id) ? ' primary' : ''), title: 'Chọn trường dữ liệu (tên khóa JSON) nào không cần dịch', onclick: () => { openFields.has(it.id) ? openFields.delete(it.id) : openFields.add(it.id); render(); } }, `Trường dữ liệu (${a.fields.length})`) : null)));
      if (hasFields && openFields.has(it.id)) tbl.appendChild(h('tr', null, h('td', { colspan: 8 }, fieldsBox(it, a.fields))));
    }
    return h('div', { class: 'table-wrap' }, tbl);
  }

  function depthOf(it) {
    const p = app.project;
    let d = 0, cur = it;
    while (cur?.meta?.parent && !p.itemById.get(cur.meta.parent)?.meta?.root && d < 8) { cur = p.itemById.get(cur.meta.parent); if (!cur?.meta?.layer) break; d++; }
    return d;
  }

  /** Bảng trường dữ liệu của một lớp: tích "không dịch" để bỏ cả trường (vd trích dẫn nguyên văn, ghi chú nguồn) */
  function fieldsBox(it, fields) {
    const p = app.project;
    const rows = fields.slice().sort((a, b) => b.chars - a.chars);
    const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Không dịch'), h('th', null, 'Trường (tên khóa)'), h('th', null, 'Số lần'), h('th', null, 'Chuỗi khác nhau'), h('th', null, 'Ký tự'), h('th', null, 'Ví dụ')));
    for (const f of rows.slice(0, 120)) {
      const chk = h('input', { type: 'checkbox', checked: !!f.kept });
      chk.addEventListener('change', () => {
        p.setKeepField(it.id, f.name, chk.checked);
        p.analyze(app.ts());
        app.saveProject(); app.updateTopbar(); app.refresh('card');
        render();
      });
      tbl.appendChild(h('tr', null,
        h('td', null, chk),
        h('td', { class: 'mono small' }, f.name || '(phần tử mảng)'),
        h('td', { class: 'small muted' }, f.n.toLocaleString('vi-VN')),
        h('td', { class: 'small muted' }, f.distinct.toLocaleString('vi-VN')),
        h('td', { class: 'small' }, f.chars.toLocaleString('vi-VN')),
        h('td', { class: 'small muted' }, truncate(f.sample, 60))));
    }
    return h('div', { class: 'card-box tight' },
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, 'Mỗi dòng là một trường trong khối dữ liệu của lớp này. Tích "Không dịch" để giữ nguyên mọi giá trị của trường (tiết kiệm lượt gọi AI với các trường không hiển thị hoặc không cần dịch, vd trích dẫn nguyên văn). Chuỗi là URL / mã định danh lẫn chữ Hán (pref-nanjing-松江府, 明史/卷6) luôn được giữ nguyên.'),
      h('div', { class: 'table-wrap', style: { maxHeight: '340px', overflow: 'auto' } }, tbl),
      rows.length > 120 ? h('div', { class: 'muted small' }, `… và ${rows.length - 120} trường nhỏ khác`) : null);
  }

  function resourceBox(r) {
    const p = app.project;
    const m = r.meta;
    const items = p.resourceItems(m.id);
    const ids = items.map((it) => it.id);
    const tot = items.map(progress).reduce((x, s) => ({ total: x.total + s.total, done: x.done + s.done, chars: x.chars + s.chars }), { total: 0, done: 0, chars: 0 });
    const head = h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('b', { style: { flex: 1, wordBreak: 'break-all' } }, (m.origin === 'url' ? '🔗 ' : '📦 ') + m.name),
      h('span', { class: 'pill' }, formatBytes(m.size)),
      r.open ? h('span', { class: 'pill' }, r.open.container === 'gzip' ? 'nén gzip' : 'văn bản') : null,
      r.open ? h('span', { class: 'pill ' + (tot.done === tot.total ? 'ok' : 'warn') }, `${tot.done}/${tot.total} đoạn`) : null,
      tot.chars ? h('span', { class: 'pill' }, `còn ${tot.chars.toLocaleString('vi-VN')} ký tự`) : null);
    const box = h('div', { class: 'card-box' }, head);
    if (m.origin === 'url') box.append(h('div', { class: 'muted small mono', style: { marginBottom: '8px', wordBreak: 'break-all' } }, m.url));
    if (r.error) { box.append(h('div', { class: 'err' }, '✗ ' + r.error)); }
    if (r.open) box.append(layerTable(items));
    const acts = h('div', { class: 'row', style: { marginTop: '10px' } });
    if (r.open) {
      acts.append(
        h('button', { class: 'btn primary small', disabled: !!app.running || !tot.total || tot.done === tot.total, onclick: () => app.translateAll(ids.filter((id) => p.isIncluded(p.itemById.get(id)))) }, '▶ Dịch tệp này'),
        h('button', { class: 'btn success small', title: 'Tải về tệp đã dịch, đúng dạng gốc (.gz vẫn là .gz; payload base64 / gzip bên trong được mã hóa lại)', onclick: () => app.exportResource(m.id) }, '💾 Xuất tệp đã dịch'));
    }
    if (m.origin === 'url') {
      const modeSel = select(MODE_LABELS, m.mode || 'inline', (v) => { m.mode = v; p.packed.clear(); p.bump(); p.touch(); app.saveProject(); render(); });
      modeSel.style.maxWidth = '330px';
      acts.append(h('span', { class: 'muted small' }, 'Trong card:'), modeSel);
      if ((m.mode || 'inline') === 'remap') {
        const inp = h('input', { type: 'text', value: m.remapUrl || '', placeholder: 'https://… (địa chỉ bạn đăng tải tệp đã dịch)', style: { minWidth: '320px', flex: 1 } });
        inp.addEventListener('change', () => { m.remapUrl = inp.value.trim(); p.packed.clear(); p.bump(); p.touch(); app.saveProject(); });
        acts.append(inp);
      }
      acts.append(h('button', { class: 'btn small', disabled: !!app.running, title: 'Tải lại từ link (tác giả cập nhật) — bản dịch cũ được dùng lại cho phần không đổi', onclick: () => app.downloadLink({ url: m.url, klass: 'code' }) }, '↻ Tải lại'));
    }
    acts.append(h('button', { class: 'btn danger small', disabled: !!app.running, style: { marginLeft: 'auto' }, onclick: () => app.removeResource(m.id) }, '🗑 Gỡ'));
    box.append(acts);
    if (m.origin === 'url' && r.open) {
      const mode = m.mode || 'inline';
      box.append(h('div', { class: 'muted small', style: { marginTop: '6px' } },
        mode === 'inline' ? (r.open.container !== 'plain' ? '⚠ Tệp ở link này là tệp nén nên không nhúng lại được bằng data: URL — hãy chọn "Đổi sang URL khác".' : 'Khi xuất card, link này được thay bằng chính nội dung đã dịch (data: URL) nên card không còn phụ thuộc link gốc. Đường dẫn tương đối trong mã (import \'./x.js\', import.meta.url) đã được đổi thành địa chỉ tuyệt đối.')
          : mode === 'remap' ? 'Bấm "Xuất tệp đã dịch", đăng tải tệp đó lên nơi của bạn (GitHub của bạn + jsDelivr, v.v.) rồi dán địa chỉ mới vào ô bên trên — card sẽ trỏ tới đó.'
            : 'Card giữ nguyên link gốc; nội dung ở link không được dịch.'));
    }
    return box;
  }

  function linksSection() {
    const p = app.project;
    const links = p.links();
    const cand = links.filter((l) => l.klass === 'code' && !l.resource);
    const libs = links.filter((l) => l.klass === 'lib' && !l.resource);
    const downloaded = p.resources.filter((r) => r.meta.origin === 'url');
    const box = h('div', null);
    box.append(h('h3', null, `🔗 Link ngoài (${downloaded.length} đã tải · ${cand.length} chưa tải)`),
      h('div', { class: 'muted small', style: { marginBottom: '10px' } },
        'Nhiều card chỉ chứa một dòng nạp mã từ bên ngoài (', h('span', { class: 'mono' }, "import 'https://…jsdelivr.net/gh/tác-giả/kho/dist/index.js'"), ', ', h('span', { class: 'mono' }, "$('body').load('https://…/index.html')"),
        ') — giao diện và chữ thật nằm ở link đó. Tải về để dịch; khi xuất, link trong card được thay bằng bản dịch.'));
    for (const r of downloaded) box.append(resourceBox(r));
    if (cand.length) {
      const tbl = h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Link (mã / dữ liệu riêng của card)'), h('th', null, 'Loại'), h('th', null, 'Dùng ở'), h('th', null, '')));
      for (const l of cand) {
        tbl.appendChild(h('tr', null,
          h('td', { class: 'mono small', style: { wordBreak: 'break-all' }, title: l.url }, truncate(l.url, 130)),
          h('td', { class: 'small' }, KIND_LABEL[l.kind] || l.kind),
          h('td', { class: 'small muted' }, l.uses.slice(0, 2).map((u) => (u.how ? u.how + ' · ' : '') + truncate(u.label, 40)).join(' | '), l.uses.length > 2 ? ` (+${l.uses.length - 2})` : ''),
          h('td', null, h('button', { class: 'btn small primary', disabled: !!app.running, onclick: () => app.downloadLink(l) }, '⬇ Tải về & dịch'))));
      }
      box.append(h('div', { class: 'card-box' }, h('div', { class: 'table-wrap' }, tbl)));
    } else if (!downloaded.length) box.append(h('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Không thấy link nào tới mã / dữ liệu riêng của card.'));
    if (libs.length) {
      const det = h('details', { open: showLibs }, h('summary', { class: 'small', style: { cursor: 'pointer' } }, `Thư viện / framework dùng chung (${libs.length}) — không phải nội dung của card, không nên dịch`));
      det.addEventListener('toggle', () => { showLibs = det.open; });
      const tbl = h('table', { class: 'tbl' });
      for (const l of libs) {
        tbl.appendChild(h('tr', null,
          h('td', { class: 'mono small muted', style: { wordBreak: 'break-all' } }, truncate(l.url, 130)),
          h('td', { class: 'small muted' }, KIND_LABEL[l.kind] || l.kind),
          h('td', null, h('button', { class: 'btn small ghost', disabled: !!app.running, title: 'Chỉ dùng khi bạn chắc chắn muốn dịch cả thư viện này', onclick: () => app.downloadLink(l) }, 'Vẫn tải'))));
      }
      det.append(h('div', { class: 'table-wrap' }, tbl));
      box.append(det);
    }
    return box;
  }

  function render() {
    clear(el);
    const p = app.project;
    el.append(h('h2', null, '📦 Tài nguyên · link ngoài · nội dung nhúng'));
    if (!p) { el.append(h('div', { class: 'empty' }, 'Hãy nhập card trước.')); return; }
    el.append(h('div', { class: 'muted small', style: { marginBottom: '14px' } },
      'Mọi thứ ở đây dùng CHUNG từ điển biến và bộ nhớ dịch với card: tên biến trong mã của tài nguyên (stat.地图系统, row.控制状态…) được đổi đúng như trong card, ',
      'chuỗi lặp lại hàng nghìn lần chỉ dịch một lần. Nội dung được bóc theo từng lớp (gzip → HTML → base64 + gzip → HTML…), khi xuất tự mã hóa lại đúng dạng cũ.'));

    // ---------------------------------------------------------- tệp đi kèm
    const files = p.resources.filter((r) => r.meta.origin !== 'url');
    const addBtn = h('button', { class: 'btn primary', disabled: !!app.running, onclick: async () => {
      const f = await pickFile(RESOURCE_ACCEPT);
      if (f) app.addResourceFile(f);
    } }, '➕ Thêm tệp tài nguyên');
    el.append(h('div', { class: 'row', style: { marginBottom: '8px' } },
      h('h3', { style: { margin: 0, flex: 1 } }, `📦 Tệp đi kèm card (${files.length})`), addBtn),
    h('div', { class: 'muted small', style: { marginBottom: '10px' } }, 'Gói bản đồ / giao diện tác giả phát kèm card (.gz), trang .html, tệp .js / .json / .css… Kéo-thả tệp vào cửa sổ cũng được. Sau khi dịch, bấm "Xuất tệp đã dịch" rồi nhập tệp đó vào SillyTavern thay cho tệp gốc.'));
    if (!files.length) el.append(h('div', { class: 'empty', style: { marginBottom: '14px' } }, 'Chưa có tệp tài nguyên nào.'));
    for (const r of files) el.append(resourceBox(r));

    // ---------------------------------------------------------- link ngoài
    el.append(linksSection());

    // ---------------------------------------------------------- nhúng trong card
    const emb = p.items.filter((it) => it.group === 'embedded');
    el.append(h('h3', null, `🧬 Nội dung nhúng trong card (${emb.length})`),
      h('div', { class: 'muted small', style: { marginBottom: '10px' } }, 'Chuỗi base64 / base64 + gzip / data: URI chứa HTML, mã hay JSON bên trong các mục của card. App tự bóc ra khi nhập card; bản dịch được mã hóa lại và đặt về đúng chỗ khi xuất. Chữ Hán viết dạng \\uXXXX trong mã cũng được đổi về chữ thật để dịch.'));
    if (emb.length) el.append(h('div', { class: 'card-box' }, layerTable(emb)));
    else el.append(h('div', { class: 'muted' }, 'Card này không có nội dung nhúng dạng base64 / nén cần dịch.'));
    void toast; void add;
  }

  return self;
}
