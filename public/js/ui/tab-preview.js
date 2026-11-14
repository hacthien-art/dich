// Tab Regex & Xem trước: danh sách regex gốc/dịch, chat mô phỏng 2 cột (gốc | bản dịch) có iframe tương tác như ST
import { h, clear, toast } from './dom.js';
import { displayText, findSampleFor, syntheticSample, PLACEMENT_LABELS } from '../core/stregex.js';
import { evaluateMacros } from '../core/macros.js';
import { applyMvuUpdates } from '../core/mvu.js';
import { analyzeItem } from '../core/analyze.js';
import { runTranslation } from '../core/translate.js';
import { formatMessage, buildFrameDoc, FRAME_SANDBOX, MESSAGE_CSS, vendorSources } from '../preview/render.js';
import { validateSchema } from '../preview/sandbox.js';
import { load as yamlLoad } from '../../vendor/js-yaml.mjs';
import { hasCJK, truncate } from '../core/util.js';

const SIDES = { orig: 'Bản gốc (tiếng Trung)', tr: 'Bản dịch (tiếng Việt)' };

export function create(app, el) {
  const self = { render, onShow, focusItem };
  let chat = null;           // [{role, swipes:[{orig,tr}], swipe:{orig,tr}} | {role, orig, tr}]
  let projectId = null;
  let selRegex = -1;
  let sampleText = '';
  let sampleTr = null;
  let sync = true;
  let showVars = false;
  const frames = new Map();  // frameId -> {side, index, iframe}
  const paneLogs = { orig: [], tr: [] };
  const statCache = { key: null, orig: null, tr: null };
  const cols = {};
  let frameSeq = 0;
  let inputs = {};

  window.addEventListener('message', onFrameMessage);

  function onShow() { if (self.stale) { render(); self.stale = false; } }

  // ------------------------------------------------------------------ dữ liệu
  function ensureChat() {
    const p = app.project;
    if (!p) { chat = null; return; }
    if (chat && projectId === p.id) {
      // cập nhật lời chào theo bản dịch mới nhất
      chat[0].swipes = greetings();
      return;
    }
    projectId = p.id;
    chat = [{ role: 'assistant', swipes: greetings(), swipe: { orig: 0, tr: 0 } }];
    paneLogs.orig = []; paneLogs.tr = [];
  }

  function greetings() {
    const p = app.project;
    const out = [];
    const fm = p.items.find((it) => it.path.join('.') === 'data.first_mes');
    out.push({ orig: fm ? fm.text : '', tr: fm ? p.output(fm.id) : '' });
    for (const it of p.items.filter((x) => x.path[1] === 'alternate_greetings')) out.push({ orig: it.text, tr: p.output(it.id) });
    return out;
  }

  function translatedCard() {
    const p = app.project;
    if (p._pvCard?.v !== p.version) p._pvCard = { v: p.version, card: p.buildCard(app.ts()) };
    return p._pvCard.card;
  }
  function scriptsFor(side) {
    const p = app.project;
    const d = side === 'orig' ? p.card.raw.data : translatedCard().data;
    return d.extensions?.regex_scripts || [];
  }
  function charName(side) {
    return side === 'orig' ? app.project.cardName : translatedCard().data?.name || app.project.cardName;
  }

  /** stat_data ban đầu (qua schema nếu có) — tính bất đồng bộ & lưu đệm */
  async function baseStat(side) {
    const p = app.project;
    const key = p.id + ':' + p.version;
    if (statCache.key !== key) { statCache.key = key; statCache.orig = null; statCache.tr = null; }
    if (statCache[side]) return statCache[side];
    const iv = p.allInitVarItems()[0];
    let data = {};
    // MVU thay <user>/{{user}}/{{char}} trong InitVar bằng tên thật trước khi đọc
    const user = app.ts().userName || 'User';
    const subst = (t) => evaluateMacros(String(t || ''), { user, char: charName(side) }).replace(/<user>/gi, user).replace(/<char>/gi, charName(side));
    if (iv) { try { data = yamlLoad(subst(side === 'orig' ? iv.text : p.output(iv.id))) || {}; } catch { data = {}; } }
    const sc = p.schemaItems()[0];
    if (sc) {
      try {
        const r = await validateSchema(side === 'orig' ? sc.text : p.output(sc.id), data, { timeout: 12000 });
        if (r.ok && r.data) data = r.data;
        else if (!r.ok) plog(side, 'Schema: ' + (r.error || '') + (r.issues?.length ? ' — ' + r.issues.slice(0, 2).map((i) => i.path + ': ' + i.message).join('; ') : ''), 'warn');
      } catch { /* bỏ qua */ }
    }
    statCache[side] = data;
    return data;
  }

  function textOf(msg, side) {
    if (msg.swipes) return msg.swipes[msg.swipe[side]]?.[side] ?? '';
    return msg[side] ?? '';
  }

  // ------------------------------------------------------------------ giao diện
  function render() {
    clear(el);
    frames.clear();
    const p = app.project;
    if (!p) { el.classList.remove('fill'); el.append(h('h2', null, '🧩 Regex & Xem trước'), h('div', { class: 'empty' }, 'Hãy nhập card trước.')); return; }
    el.classList.add('fill');
    ensureChat();
    const side = h('div', { class: 'pv-side' });
    const main = h('div', { class: 'pv-main' });
    el.append(h('div', { class: 'pv-layout', style: { width: '100%' } }, side, main));
    renderRegexList(side);
    renderMain(main);
  }

  function renderRegexList(box) {
    const p = app.project;
    const orig = p.card.raw.data.extensions?.regex_scripts || [];
    const tr = translatedCard().data.extensions?.regex_scripts || [];
    box.append(h('h3', { style: { marginTop: '4px' } }, `Regex (${orig.length})`),
      h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'Bấm "🧪 Thử" để tạo tin nhắn mẫu khớp regex và xem HTML trước/sau khi dịch.'));
    if (!orig.length) box.append(h('div', { class: 'muted' }, 'Card không có regex.'));
    orig.forEach((r, i) => {
      const t = tr[i] || r;
      const changedFind = t.findRegex !== r.findRegex;
      const place = (r.placement || []).map((x) => PLACEMENT_LABELS[x] || x).join(', ');
      box.append(h('div', { class: 'rx-item' + (selRegex === i ? ' sel' : '') + (r.disabled ? ' off' : ''), onclick: () => { selRegex = i; render(); } },
        h('div', { class: 'nm' }, r.scriptName || `#${i + 1}`, t.scriptName !== r.scriptName ? h('span', { class: 'muted' }, ' → ' + t.scriptName) : null),
        h('div', { class: 'fd', title: r.findRegex }, r.findRegex),
        changedFind ? h('div', { class: 'fd diff-new', title: t.findRegex }, '→ ' + t.findRegex) : null,
        h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } },
          r.disabled ? h('span', { class: 'pill' }, 'tắt') : null,
          r.markdownOnly ? h('span', { class: 'pill' }, 'chỉ hiển thị') : null,
          r.promptOnly ? h('span', { class: 'pill warn' }, 'chỉ prompt') : null,
          h('span', { class: 'pill' }, place),
          (r.minDepth != null && r.minDepth !== '') || (r.maxDepth != null && r.maxDepth !== '') ? h('span', { class: 'pill' }, `độ sâu ${r.minDepth ?? '–'}..${r.maxDepth ?? '–'}`) : null,
          h('button', { class: 'btn small', style: { marginLeft: 'auto' }, onclick: (e) => { e.stopPropagation(); selRegex = i; tryRegex(i); } }, '🧪 Thử'))));
    });
    if (selRegex >= 0 && orig[selRegex]) {
      const r = orig[selRegex], t = tr[selRegex] || r;
      box.append(h('h4', null, 'Replace (gốc)'), h('div', { class: 'code-view', style: { maxHeight: '160px' } }, truncate(r.replaceString || '(rỗng — xóa phần khớp)', 4000)),
        h('h4', null, 'Replace (sau dịch)'), h('div', { class: 'code-view', style: { maxHeight: '160px' } }, truncate(t.replaceString || '(rỗng)', 4000)));
    }
  }

  function tryRegex(i) {
    const p = app.project;
    const r = (p.card.raw.data.extensions?.regex_scripts || [])[i];
    if (!r) return;
    const texts = [];
    for (const it of p.items) if (typeof it.text === 'string' && it.kind !== 'regexFind' && !it.meta?.isReplace) texts.push(it.text);
    let sample = findSampleFor(r, texts);
    let from = 'trích từ card';
    if (!sample) { sample = syntheticSample(r); from = 'mẫu tự tạo'; }
    if (!sample) { toast('Không tạo được mẫu cho regex này — hãy dán một tin nhắn AI thật vào ô mẫu.', 'warn', 5000); render(); return; }
    sampleText = sample;
    sampleTr = null;
    // thay tin mẫu cũ
    chat = chat.filter((m, idx) => idx === 0 || !m.sample);
    const role = (r.placement || []).includes(2) ? 'assistant' : 'user';
    chat.push({ role, orig: sample, tr: mapSample(sample), sample: true });
    plog('orig', `Thử regex "${r.scriptName}" với ${from} (${sample.length} ký tự)`, 'info');
    render();
  }

  /** Bản dịch "đồng bộ" của tin mẫu: ánh xạ đường dẫn biến + nhãn theo từ điển, dùng bản dịch đã có trong TM */
  function mapSample(text) {
    const p = app.project;
    const ts = app.ts();
    const a = analyzeItem({ kind: 'auto', text, meta: {} }, { dict: p.dictIndex(ts), entryNames: new Set(), opts: { codeStrings: ts.codeStrings, chunkSize: ts.chunkSize } });
    return a.render({ tm: p.tm, dict: p.dictIndex(ts) });
  }

  function renderMain(main) {
    const p = app.project;
    const ta = h('textarea', { rows: 4, placeholder: 'Dán một tin nhắn AI mẫu (ví dụ phản hồi có <UpdateVariable>, <StatusPlaceHolderImpl/>, <ztl>{...}</ztl>...) để xem regex hiển thị thế nào' }, sampleText);
    ta.addEventListener('change', () => { sampleText = ta.value; sampleTr = null; });
    const add = (role) => {
      sampleText = ta.value;
      if (!sampleText.trim()) return toast('Ô mẫu đang trống', 'warn');
      chat.push({ role, orig: sampleText, tr: sampleTr ?? mapSample(sampleText) });
      render();
    };
    const trBtn = h('button', { class: 'btn small', onclick: async () => {
      sampleText = ta.value;
      if (!hasCJK(sampleText)) return toast('Tin mẫu không có tiếng Trung', 'info');
      const conn = app.conn();
      if (!conn.url || !conn.model) return toast('Chưa cấu hình proxy', 'warn');
      trBtn.disabled = true; trBtn.textContent = 'Đang dịch…';
      try {
        const ts = app.ts();
        const a = analyzeItem({ kind: 'auto', text: sampleText, meta: {} }, { dict: p.dictIndex(ts), entryNames: new Set(), opts: { codeStrings: ts.codeStrings, chunkSize: ts.chunkSize } });
        const tm = new Map(p.tm);
        await runTranslation({ segments: a.segments.filter((s) => !tm.has(s.key)), tm, settings: { ...ts, concurrency: 2 }, conn, preset: app.preset.data, dict: p.data.dict, cardName: p.cardName, glossary: p.data.glossary, onLog: (m, l) => app.log(m, l) });
        sampleTr = a.render({ tm, dict: p.dictIndex(ts) });
        toast('Đã dịch tin mẫu — bấm "Thêm làm tin AI" để xem', 'ok');
        const last = chat[chat.length - 1];
        if (last && last.orig === sampleText) { last.tr = sampleTr; render(); }
      } catch (e) { toast('Lỗi: ' + e.message, 'err'); }
      finally { trBtn.disabled = false; trBtn.textContent = '🌐 Dịch tin mẫu bằng AI'; }
    } }, '🌐 Dịch tin mẫu bằng AI');

    const syncChk = h('input', { type: 'checkbox', checked: sync });
    syncChk.addEventListener('change', () => { sync = syncChk.checked; });
    const varsChk = h('input', { type: 'checkbox', checked: showVars });
    varsChk.addEventListener('change', () => { showVars = varsChk.checked; renderColumns(); });

    main.append(h('div', { class: 'pv-toolbar' },
      ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => add('assistant') }, '➕ Thêm làm tin AI'),
        h('button', { class: 'btn small', onclick: () => add('user') }, '➕ Thêm làm tin người dùng'),
        trBtn,
        h('button', { class: 'btn small', onclick: () => { chat = null; projectId = null; ensureChat(); render(); } }, '🗑 Đặt lại chat'),
        h('button', { class: 'btn small', onclick: () => { statCache.key = null; renderColumns(); } }, '⟳ Vẽ lại'),
        h('label', { class: 'check small', style: { margin: '0 0 0 auto' } }, syncChk, 'Đồng bộ swipe 2 bên'),
        h('label', { class: 'check small', style: { margin: 0 } }, varsChk, 'Hiện stat_data'),
      )));
    const colsWrap = h('div', { class: 'pv-cols' });
    main.append(colsWrap);
    for (const s of Object.keys(SIDES)) {
      const chatEl = h('div', { class: 'pv-chat' });
      const logEl = h('div', { class: 'pv-log' });
      const input = h('input', { type: 'text', placeholder: 'Gõ tin nhắn người dùng rồi Enter…' });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          const v = input.value.trim();
          chat.push(s === 'orig' ? { role: 'user', orig: v, tr: mapSample(v) } : { role: 'user', orig: v, tr: v });
          input.value = '';
          renderColumns();
        }
      });
      inputs[s] = input;
      colsWrap.append(h('div', { class: 'pv-col' },
        h('div', { class: 'pv-col-head' }, SIDES[s]),
        chatEl,
        h('div', { style: { padding: '6px 10px', borderTop: '1px solid var(--border)' } }, input),
        logEl));
      cols[s] = { chatEl, logEl };
    }
    renderColumns();
  }

  async function renderColumns() {
    for (const s of Object.keys(SIDES)) await renderSide(s);
  }

  async function renderSide(side) {
    const col = cols[side];
    if (!col || !chat) return;
    const p = app.project;
    for (const [id, f] of frames) if (f.side === side) frames.delete(id);
    clear(col.chatEl);
    col.chatEl.append(h('div', { class: 'muted small' }, 'Đang chuẩn bị biến…'));
    const [base, libs] = await Promise.all([baseStat(side), vendorSources(['jquery', 'lodash', 'yaml', 'env'])]);
    clear(col.chatEl);
    const scripts = scriptsFor(side);
    const user = app.ts().userName || 'User';
    const macro = { user, char: charName(side) };
    // stat_data theo từng tin nhắn (MVU)
    const stats = [];
    let cur = base;
    chat.forEach((m, i) => {
      const t = evaluateMacros(textOf(m, side), macro);
      if (m.role === 'assistant') cur = applyMvuUpdates(cur, t);
      stats[i] = cur;
    });
    const frameChat = chat.map((m, i) => ({
      name: m.role === 'user' ? user : macro.char, is_user: m.role === 'user',
      message: evaluateMacros(textOf(m, side), macro),
      swipes: m.swipes ? m.swipes.map((sw) => evaluateMacros(sw[side] ?? '', macro)) : undefined,
      swipe_id: m.swipes ? m.swipe[side] : 0,
      stat_data: stats[i],
    }));
    chat.forEach((m, i) => {
      const raw = evaluateMacros(textOf(m, side), macro);
      const depth = chat.length - 1 - i;
      const shown = displayText(scripts, raw, { isUser: m.role === 'user', depth, macro });
      const { html, blocks } = formatMessage(shown);
      const host = h('div', { class: 'mes-body' });
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${MESSAGE_CSS}</style>` + html;
      root.querySelectorAll('.th-frame-slot').forEach((slot) => {
        const code = blocks[Number(slot.dataset.block)];
        const fid = 'f' + (++frameSeq);
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', FRAME_SANDBOX);
        iframe.setAttribute('loading', 'lazy');
        iframe.style.height = '120px';
        iframe.srcdoc = buildFrameDoc(code, {
          frameId: fid, messageId: i, stat_data: stats[i], chat: frameChat, charName: macro.char, userName: user,
          bookName: side === 'orig' ? p.card.raw.data.character_book?.name : translatedCard().data.character_book?.name,
        }, { viewportHeight: Math.max(500, window.innerHeight - 160) }, libs);
        frames.set(fid, { side, index: i, iframe });
        slot.appendChild(iframe);
      });
      const head = h('div', { class: 'mes-head' },
        h('span', { class: 'who' }, m.role === 'user' ? '🧑 ' + user : '🤖 ' + macro.char),
        h('span', null, `#${i}`),
        m.sample ? h('span', { class: 'pill' }, 'mẫu') : null,
        blocks.length ? h('span', { class: 'pill' }, `${blocks.length} giao diện`) : null,
        m.swipes ? h('span', { class: 'swipe' },
          h('button', { class: 'btn small icon', onclick: () => swipe(side, -1) }, '◀'),
          h('span', { class: 'small' }, `${m.swipe[side] + 1}/${m.swipes.length}`),
          h('button', { class: 'btn small icon', onclick: () => swipe(side, 1) }, '▶')) :
          h('span', { class: 'swipe' }, h('button', { class: 'btn small icon', title: 'Xóa tin', onclick: () => { chat.splice(i, 1); renderColumns(); } }, '✕')));
      const mes = h('div', { class: 'mes' + (m.role === 'user' ? ' user' : '') }, head, host);
      if (showVars && m.role === 'assistant') mes.append(h('details', null, h('summary', { class: 'small muted' }, 'stat_data sau tin này'), h('pre', { class: 'code-view', style: { maxHeight: '220px' } }, JSON.stringify(stats[i], null, 2))));
      col.chatEl.append(mes);
    });
    renderLog(side);
  }

  function swipe(side, dir) {
    const m = chat[0];
    const n = m.swipes.length;
    const sides = sync ? ['orig', 'tr'] : [side];
    for (const s of sides) m.swipe[s] = (m.swipe[s] + dir + n) % n;
    if (sync) renderColumns(); else renderSide(side);
  }

  function plog(side, msg, level = 'info') {
    paneLogs[side].push({ msg, level, t: Date.now() });
    if (paneLogs[side].length > 200) paneLogs[side].shift();
    renderLog(side);
  }
  function renderLog(side) {
    const col = cols[side];
    if (!col) return;
    clear(col.logEl);
    const items = paneLogs[side].slice(-60);
    if (!items.length) col.logEl.append(h('div', { class: 'muted' }, 'Nhật ký tương tác (slash command, toast, lỗi script) sẽ hiện ở đây.'));
    for (const l of items) col.logEl.append(h('div', { class: l.level === 'error' ? 'err' : l.level === 'warn' || l.level === 'warning' ? 'warn' : l.level === 'success' || l.level === 'ok' ? 'ok' : '' }, l.msg));
    col.logEl.scrollTop = col.logEl.scrollHeight;
  }

  // ------------------------------------------------------------------ tin từ iframe
  function onFrameMessage(ev) {
    const d = ev.data;
    if (!d || !d.__th || !frames.has(d.frameId)) return;
    const f = frames.get(d.frameId);
    if (ev.source !== f.iframe.contentWindow) return;
    const side = f.side;
    switch (d.type) {
      case 'height': f.iframe.style.height = Math.min(Math.max(30, Number(d.height) || 0) + 4, 20000) + 'px'; break;
      case 'toast': plog(side, `[toast ${d.level}] ${d.title ? d.title + ': ' : ''}${d.message}`, d.level); break;
      case 'log': plog(side, '[lỗi script] ' + d.message, 'error'); break;
      case 'vars': plog(side, 'Script cập nhật biến (' + (d.option?.type || 'chat') + ')', 'info'); break;
      case 'slash': runSlash(side, d.cmd); break;
      case 'setChat': {
        let rerender = false;
        for (const x of d.list || []) {
          const m = chat[x.message_id];
          if (!m) continue;
          if (typeof x.swipe_id === 'number' && m.swipes && m.swipes[x.swipe_id]) {
            for (const s of sync ? ['orig', 'tr'] : [side]) m.swipe[s] = x.swipe_id;
            plog(side, `setChatMessages: chuyển lời chào #${x.message_id} sang swipe ${x.swipe_id}`, 'ok');
            rerender = true;
          } else if (typeof x.message === 'string') {
            if (m.swipes) m.swipes[m.swipe[side]][side] = x.message; else m[side] = x.message;
            plog(side, `setChatMessages: sửa nội dung tin #${x.message_id}`, 'ok');
            rerender = true;
          }
        }
        if (rerender) setTimeout(() => (sync ? renderColumns() : renderSide(side)), 30);
        break;
      }
      case 'createChat': {
        for (const x of d.list || []) chat.push({ role: x.role === 'user' ? 'user' : 'assistant', orig: side === 'orig' ? x.message : '', tr: side === 'tr' ? x.message : '' });
        plog(side, `createChatMessages: thêm ${(d.list || []).length} tin`, 'ok');
        setTimeout(renderColumns, 30);
        break;
      }
      default: break;
    }
  }

  function splitPipes(cmd) {
    const out = [];
    let cur = '', q = null, depth = 0;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (c === '\\' && cmd[i + 1] === '|') { cur += '|'; i++; continue; }
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === '"') { q = c; cur += c; continue; }
      if (c === '{' && cmd[i + 1] === ':') depth++;
      if (c === ':' && cmd[i + 1] === '}') depth = Math.max(0, depth - 1);
      if (c === '|' && !depth) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }

  function runSlash(side, cmd) {
    for (const part of splitPipes(String(cmd || ''))) {
      const m = part.match(/^\/([\w-]+)\s*([\s\S]*)$/);
      if (!m) { plog(side, 'slash: ' + part); continue; }
      const name = m[1].toLowerCase();
      let rest = m[2];
      const named = {};
      rest = rest.replace(/^(?:(\w+)=("[^"]*"|\S+)\s*)+/, (all) => { all.replace(/(\w+)=("[^"]*"|\S+)/g, (x, k, v) => { named[k] = v.replace(/^"|"$/g, ''); }); return ''; });
      switch (name) {
        case 'echo': plog(side, '📢 ' + rest, named.severity || 'info'); toast(rest, named.severity || 'info', 2500); break;
        case 'send':
          chat.push({ role: 'user', orig: side === 'orig' ? rest : '', tr: side === 'tr' ? rest : '' });
          plog(side, '/send: ' + truncate(rest, 160), 'ok');
          setTimeout(() => renderSide(side), 30);
          break;
        case 'sendas': case 'sys': case 'comment': case 'narrate':
          chat.push({ role: 'assistant', orig: side === 'orig' ? rest : '', tr: side === 'tr' ? rest : '' });
          plog(side, `/${name}: ` + truncate(rest, 160), 'ok');
          setTimeout(() => renderSide(side), 30);
          break;
        case 'trigger': case 'continue': case 'swipe': case 'regenerate':
          plog(side, `/${name}: trong SillyTavern sẽ gọi AI tạo phản hồi (xem trước không gọi AI).`, 'warn');
          break;
        case 'setinput': if (inputs[side]) inputs[side].value = rest; plog(side, '/setinput: ' + truncate(rest, 120)); break;
        case 'setvar': case 'setglobalvar': plog(side, `/${name} ${named.key || ''} = ${truncate(rest, 80)}`); break;
        case 'cut': case 'del': plog(side, `/${name} ${rest}`); break;
        default: plog(side, `/${name} ${truncate(rest, 100)} (chưa mô phỏng)`); break;
      }
    }
  }

  /** Mở xem trước từ tab Card */
  function focusItem(it) {
    const p = app.project;
    if (!p) return;
    ensureChat();
    if (it.path.join('.') === 'data.first_mes') { chat[0].swipe = { orig: 0, tr: 0 }; }
    else if (it.path[1] === 'alternate_greetings') { const n = Number(it.path[2]) + 1; chat[0].swipe = { orig: n, tr: n }; }
    else if (it.meta?.isReplace) { selRegex = it.meta.regexIndex; self.stale = true; tryRegex(it.meta.regexIndex); return; }
    else if (typeof it.text === 'string') {
      chat = chat.filter((m, idx) => idx === 0 || !m.sample);
      chat.push({ role: 'assistant', orig: it.text, tr: p.output(it.id), sample: true });
    }
    self.stale = true;
  }

  return self;
}
