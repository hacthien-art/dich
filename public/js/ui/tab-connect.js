// Tab Kết nối: proxy URL + mật khẩu/key, quét model, kiểm tra
import { h, clear, toast, field, checkbox, select, promptBox, confirmBox } from './dom.js';
import { PROVIDERS, listModels, chat } from '../core/api.js';
import { uuid, deepClone } from '../core/util.js';

const URL_HINTS = {
  openai: 'Ví dụ: https://ten-proxy.com/v1  ·  https://openrouter.ai/api/v1  ·  http://127.0.0.1:8000/v1',
  claude: 'Ví dụ: https://api.anthropic.com/v1  hoặc URL reverse proxy Claude (thường kết thúc bằng /v1)',
  gemini: 'Ví dụ: https://generativelanguage.googleapis.com  hoặc URL reverse proxy Gemini',
};
const PP = { none: 'Không (gửi nguyên)', merge: 'Gộp tin cùng vai (merge)', semi: 'Bán nghiêm ngặt (1 system ở đầu)', strict: 'Nghiêm ngặt (user/assistant xen kẽ)', single: 'Gộp thành 1 tin user' };

export function create(app, el) {
  const self = { render };

  function render() {
    clear(el);
    const s = app.settings;
    const c = app.conn();
    const save = () => { app.saveSettings(); };

    const profSel = h('select', null, s.connections.map((x) => h('option', { value: x.id, selected: x.id === c.id }, x.name)));
    profSel.addEventListener('change', () => { s.activeConnection = profSel.value; save(); render(); });

    const urlInp = h('input', { type: 'text', value: c.url, placeholder: 'https://...' });
    urlInp.addEventListener('change', () => { c.url = urlInp.value.trim(); save(); });
    const keyInp = h('input', { type: 'password', value: c.key, placeholder: 'Mật khẩu proxy / API key', autocomplete: 'off' });
    keyInp.addEventListener('change', () => { c.key = keyInp.value.trim(); save(); });
    const eye = h('button', { class: 'btn icon', title: 'Hiện/ẩn', onclick: () => { keyInp.type = keyInp.type === 'password' ? 'text' : 'password'; } }, '👁');

    const modelInp = h('input', { type: 'text', value: c.model, placeholder: 'Tên model (vd: gpt-4o, claude-sonnet-4-5, gemini-2.5-pro, deepseek-chat...)' });
    modelInp.addEventListener('change', () => { c.model = modelInp.value.trim(); save(); syncSel(); });
    const filterInp = h('input', { type: 'search', placeholder: 'Lọc model…', style: { maxWidth: '220px' } });
    const modelSel = h('select', { size: 8, style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } });
    const fillModels = () => {
      clear(modelSel);
      const q = filterInp.value.trim().toLowerCase();
      for (const m of c.models || []) {
        if (q && !m.id.toLowerCase().includes(q) && !(m.name || '').toLowerCase().includes(q)) continue;
        modelSel.appendChild(h('option', { value: m.id, selected: m.id === c.model }, m.id + (m.name && m.name !== m.id ? `  — ${m.name}` : '') + (m.context ? `  [${m.context}]` : '')));
      }
    };
    const syncSel = () => { [...modelSel.options].forEach((o) => { o.selected = o.value === c.model; }); };
    filterInp.addEventListener('input', fillModels);
    modelSel.addEventListener('change', () => { c.model = modelSel.value; modelInp.value = c.model; save(); });
    fillModels();

    const listBox = h('div', { hidden: !c.models?.length }, h('div', { class: 'row', style: { marginBottom: '6px' } }, filterInp, h('span', { class: 'muted small' }, 'Bấm để chọn model')), modelSel);
    const noModels = h('div', { class: 'muted small', hidden: !!c.models?.length }, 'Bấm "Quét model" để lấy danh sách model từ proxy, hoặc gõ tên model thủ công.');
    const scanStatus = h('span', { class: 'muted small' }, c.models?.length ? `${c.models.length} model đã quét` : '');
    const scanBtn = h('button', { class: 'btn primary', onclick: async () => {
      c.url = urlInp.value.trim(); c.key = keyInp.value.trim();
      if (!c.url) return toast('Nhập URL proxy trước', 'warn');
      scanBtn.disabled = true; scanStatus.textContent = 'Đang quét…'; scanStatus.className = 'muted small';
      try {
        const r = await listModels(c);
        c.models = r.models;
        let note = '';
        if (r.base && r.base !== c.url.replace(/\/+$/, '') && c.provider === 'openai') {
          note = ` — model lấy từ ${r.base}, đã cập nhật URL`;
          c.url = r.base; urlInp.value = r.base;
        }
        if ((!c.model || !r.models.some((m) => m.id === c.model)) && r.models[0]) { c.model = r.models[0].id; modelInp.value = c.model; }
        save(); fillModels();
        listBox.hidden = !c.models.length; noModels.hidden = !!c.models.length;
        scanStatus.textContent = `✓ Tìm thấy ${r.models.length} model${note}`; scanStatus.className = 'ok small';
      } catch (e) {
        scanStatus.textContent = '✗ ' + e.message; scanStatus.className = 'err small';
      } finally { scanBtn.disabled = false; }
    } }, '🔍 Quét model');

    const testOut = h('div', { class: 'stream-box', hidden: true });
    const testBtn = h('button', { class: 'btn', onclick: async () => {
      c.url = urlInp.value.trim(); c.key = keyInp.value.trim(); c.model = modelInp.value.trim();
      testBtn.disabled = true; testOut.hidden = false; testOut.textContent = 'Đang gửi tin thử…';
      const t0 = performance.now();
      try {
        const r = await chat(c, { ...app.preset.data, openai_max_tokens: 200 }, [
          { role: 'system', content: 'Bạn là trợ lý dịch thuật.' },
          { role: 'user', content: 'Dịch sang tiếng Việt, chỉ trả lời bản dịch: 你好，旅行者。今天的天气真好。' },
        ], { onDelta: (t) => { testOut.textContent = t; }, maxTokens: 200 });
        testOut.textContent = `✓ Kết nối OK (${((performance.now() - t0) / 1000).toFixed(1)}s) — phản hồi:\n${r.text}${r.reasoning ? '\n\n[suy luận]: ' + r.reasoning.slice(0, 400) : ''}`;
        save();
      } catch (e) {
        testOut.textContent = '✗ Lỗi: ' + e.message;
      } finally { testBtn.disabled = false; }
    } }, '🧪 Kiểm tra kết nối');

    const providerSel = select(PROVIDERS, c.provider, (v) => { c.provider = v; save(); render(); });

    const hdr = h('textarea', { rows: 2, placeholder: '{"HTTP-Referer": "...", "X-Title": "..."}' }, c.headers || '');
    hdr.addEventListener('change', () => { c.headers = hdr.value; save(); });
    const body = h('textarea', { rows: 3, placeholder: '{"top_k": 40, "provider": {"order": ["..."]}}' }, c.extraBody || '');
    body.addEventListener('change', () => { c.extraBody = body.value; save(); });

    el.append(
      h('h2', null, '🔌 Kết nối API / Proxy'),
      h('p', { class: 'muted' }, 'Nhập URL proxy và mật khẩu (key) giống mục "Reverse Proxy" / "Custom Endpoint" của SillyTavern. Yêu cầu được gửi qua máy chủ cục bộ nên không bị lỗi CORS.'),
      h('div', { class: 'card-box' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, field('Hồ sơ kết nối', profSel)),
          h('div', { class: 'row', style: { paddingTop: '8px' } },
            h('button', { class: 'btn small', onclick: () => { const n = DEFAULT(); s.connections.push(n); s.activeConnection = n.id; save(); render(); } }, '➕ Mới'),
            h('button', { class: 'btn small', onclick: () => { const n = deepClone(c); n.id = uuid(); n.name = c.name + ' (bản sao)'; s.connections.push(n); s.activeConnection = n.id; save(); render(); } }, '⧉ Nhân bản'),
            h('button', { class: 'btn small', onclick: async () => { const v = await promptBox('Đổi tên hồ sơ', 'Tên mới', c.name); if (v) { c.name = v; save(); render(); } } }, '✎ Đổi tên'),
            h('button', { class: 'btn small danger', disabled: s.connections.length < 2, onclick: async () => {
              if (!(await confirmBox(`Xóa hồ sơ "${c.name}"?`, 'Xóa', 'danger'))) return;
              s.connections = s.connections.filter((x) => x !== c); s.activeConnection = s.connections[0].id; save(); render();
            } }, '🗑 Xóa'))),
        h('div', { class: 'grid2' },
          field('Loại API', providerSel, c.provider === 'openai' ? 'Dùng cho hầu hết proxy (OpenAI, Claude/Gemini qua proxy OpenAI, DeepSeek, OpenRouter, one-api/new-api...)' : ''),
          field('URL proxy (Proxy Server URL)', urlInp, URL_HINTS[c.provider]),
        ),
        field('Mật khẩu proxy / API key', h('div', { class: 'row' }, h('div', { class: 'grow' }, keyInp), eye), 'Được lưu cục bộ trong data/settings/app.json — không chia sẻ thư mục data cho người khác.'),
        h('div', { class: 'row' }, scanBtn, scanStatus),
      ),
      h('div', { class: 'card-box' },
        h('h3', { style: { marginTop: 0 } }, 'Model'),
        field('Model đang dùng', modelInp),
        listBox, noModels,
        h('div', { class: 'row', style: { marginTop: '12px' } }, testBtn),
        testOut,
      ),
      h('details', { class: 'card-box' },
        h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Nâng cao'),
        h('div', { class: 'grid2', style: { marginTop: '12px' } },
          field('Hậu xử lý prompt (Prompt Post-Processing)', select(PP, c.postProcessing || 'none', (v) => { c.postProcessing = v; save(); }), 'Giống tùy chọn của ST cho Custom endpoint. Dùng "Nghiêm ngặt" nếu proxy báo lỗi thứ tự vai.'),
          h('div', null,
            checkbox('Gửi top_k / min_p / top_a / repetition_penalty (nếu khác mặc định)', c.extendedSamplers !== false, (v) => { c.extendedSamplers = v; save(); }),
            checkbox('Gửi reasoning_effort từ preset', !!c.sendReasoningEffort, (v) => { c.sendReasoningEffort = v; save(); }),
            checkbox('Bỏ phần <think>…</think> trong phản hồi', c.stripThinking !== false, (v) => { c.stripThinking = v; save(); }),
            c.provider === 'claude' ? checkbox('Gửi thêm header Authorization: Bearer (một số proxy Claude cần)', !!c.claudeBearer, (v) => { c.claudeBearer = v; save(); }) : null,
          ),
          field('Header bổ sung (JSON)', hdr),
          field('Body JSON bổ sung (gộp vào payload)', body, 'Giống "Include Body Parameters" của ST.'),
        ),
      ),
    );
  }
  const DEFAULT = () => ({ id: uuid(), name: 'Proxy ' + (app.settings.connections.length + 1), provider: 'openai', url: '', key: '', model: '', models: [], headers: '', extraBody: '', postProcessing: 'none', extendedSamplers: true, sendReasoningEffort: false, stripThinking: true, claudeBearer: false });
  return self;
}
