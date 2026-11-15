// Tiện ích DOM nhỏ gọn: h(), toast, modal, tải file

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'hidden') el.hidden = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** append bỏ qua null/false (Element.append sẽ in chữ "null") */
export function add(el, ...children) { append(el, children); return el; }

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function toast(message, level = 'info', ms = 4200) {
  const root = document.getElementById('toasts');
  const cls = { ok: 'ok', success: 'ok', warn: 'warn', warning: 'warn', err: 'err', error: 'err' }[level] || '';
  const el = h('div', { class: 'toast ' + cls }, message);
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
  return el;
}

/** Hộp thoại. buttons: [{label, cls, value}] -> Promise<value> */
export function modal(title, body, buttons = [{ label: 'Đóng', value: null }], { wide = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(null); } },
      h('div', { class: 'modal', style: wide ? { width: 'min(1200px, 100%)' } : null },
        h('div', { class: 'modal-head' }, h('span', { style: { flex: 1 } }, title), h('button', { class: 'btn small ghost', onclick: () => close(null) }, '✕')),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label))),
      ));
    root.appendChild(back);
    document.addEventListener('keydown', onKey);
    const first = back.querySelector('input,textarea,select');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export async function confirmBox(message, okLabel = 'Đồng ý', cls = 'primary') {
  return !!(await modal('Xác nhận', h('div', { style: { whiteSpace: 'pre-wrap' } }, message), [{ label: 'Hủy', value: false }, { label: okLabel, cls, value: true }]));
}

export async function promptBox(title, label, value = '') {
  const input = h('input', { type: 'text', value });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.closest('.modal').querySelector('.btn.primary').click(); });
  const r = await modal(title, h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), input), [{ label: 'Hủy', value: null }, { label: 'OK', cls: 'primary', value: () => input.value }]);
  return r;
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, hidden: true });
    inp.addEventListener('change', () => { resolve(inp.files?.[0] || null); inp.remove(); });
    document.body.appendChild(inp);
    inp.click();
  });
}

export async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** Đọc file ảnh bất kỳ (PNG/JPG/WebP/GIF...) -> byte PNG (PNG giữ nguyên, định dạng khác vẽ lại qua canvas) */
export async function imageToPng(file) {
  const bytes = await readFileBytes(file);
  const isPngSig = bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (isPngSig) return bytes;
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: file.type || 'image/*' })); } catch { throw new Error('không đọc được định dạng ảnh'); }
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('không chuyển được sang PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function checkbox(label, checked, onchange, hint) {
  const inp = h('input', { type: 'checkbox', checked });
  inp.addEventListener('change', () => onchange(inp.checked));
  return h('label', { class: 'check' }, inp, h('span', null, label, hint ? h('div', { class: 'hint muted small' }, hint) : null));
}

export function select(options, value, onchange) {
  const s = h('select', null, Object.entries(options).map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('vi-VN');
}
