// Tab Nhật ký: log + luồng phản hồi trực tiếp của từng lô
import { h, clear } from './dom.js';

export function create(app, el) {
  const self = { render, append, stream };
  let listEl = null;
  const streams = new Map();
  let streamWrap = null;

  function render() {
    clear(el);
    listEl = h('div', { class: 'log-list' });
    streamWrap = h('div', { class: 'grid2' });
    el.append(
      h('div', { class: 'row' }, h('h2', { style: { flex: 1, margin: 0 } }, '📜 Nhật ký'),
        h('button', { class: 'btn small', onclick: () => { app.logs.length = 0; render(); } }, 'Xóa log')),
      h('h3', null, 'Phản hồi đang nhận (stream)'), streamWrap,
      h('h3', null, 'Sự kiện'), listEl);
    for (const [k, t] of streams) addStreamBox(k, t);
    for (const l of app.logs.slice(-500)) append(l, true);
  }

  function append(l, bulk) {
    if (!listEl) return;
    const t = new Date(l.t).toLocaleTimeString('vi-VN');
    listEl.prepend(h('div', { class: 'l ' + (l.level || '') }, `[${t}] ${l.msg}`));
    if (!bulk && listEl.childNodes.length > 600) listEl.lastChild.remove();
  }

  function addStreamBox(key, text) {
    const box = h('div', { class: 'stream-box' }, text);
    const wrap = h('div', null, h('div', { class: 'muted small' }, key === 'dict' ? 'Gợi ý từ điển' : 'Luồng #' + key), box);
    streamWrap?.append(wrap);
    return box;
  }

  function stream(key, text) {
    streams.set(key, text);
    if (!streamWrap) return;
    let box = streamWrap.querySelector(`[data-k="${key}"] .stream-box`);
    if (!box) {
      const b = addStreamBox(key, '');
      b.parentElement.dataset.k = key;
      box = b;
    }
    box.textContent = text.slice(-6000);
    box.scrollTop = box.scrollHeight;
  }

  return self;
}
