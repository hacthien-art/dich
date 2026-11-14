// Tab Preset: nhập/xuất preset ST nguyên vẹn, chỉnh sampler, Prompt Manager (bật/tắt, kéo thả, sửa)
import { h, clear, toast, field, checkbox, select, modal, promptBox, confirmBox, download, pickFile, readFileBytes } from './dom.js';
import { SAMPLERS, MARKERS, DEFAULT_PRESET, getOrder, getPrompt, exportPreset } from '../core/preset.js';
import { store, safeId } from './store.js';
import { importPresetObject, loadPresets } from '../app.js';
import { deepClone, uuid } from '../core/util.js';

const REASONING = { auto: 'Tự động (không gửi)', min: 'Tối thiểu', low: 'Thấp', medium: 'Trung bình', high: 'Cao', max: 'Tối đa' };

export function create(app, el) {
  const self = { render };

  function render() {
    clear(el);
    const P = app.preset;
    const d = P.data;
    const save = () => app.savePreset();

    // ---------------------------------------------------------- thanh preset
    const names = [...new Set([...app.presetList, safeId(P.name)])];
    const presetSel = h('select', null, names.map((n) => h('option', { value: n, selected: n === safeId(P.name) }, n)));
    presetSel.addEventListener('change', async () => {
      const x = await store.get('presets', presetSel.value);
      if (x?.data) { app.preset = { name: x.name || presetSel.value, data: x.data }; app.settings.activePreset = app.preset.name; app.saveSettings(); render(); }
    });

    const bar = h('div', { class: 'card-box' },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, field('Preset Chat Completion đang dùng', presetSel)),
        h('div', { class: 'row', style: { paddingTop: '8px' } },
          h('button', { class: 'btn primary', onclick: async () => {
            const f = await pickFile('.json,application/json');
            if (!f) return;
            try { const j = JSON.parse(new TextDecoder().decode(await readFileBytes(f))); await importPresetObject(j, f.name); } catch (e) { toast('Nhập preset lỗi: ' + e.message, 'err'); }
          } }, '📥 Nhập preset ST'),
          h('button', { class: 'btn', onclick: () => download(safeId(P.name) + '.json', exportPreset(P), 'application/json') }, '📤 Xuất'),
          h('button', { class: 'btn', onclick: async () => {
            const n = await promptBox('Lưu preset thành', 'Tên preset', P.name + ' (sửa)');
            if (!n) return;
            app.preset = { name: n, data: deepClone(d) };
            await store.put('presets', safeId(n), { name: n, data: app.preset.data });
            app.presetList.push(safeId(n)); app.settings.activePreset = n; app.saveSettings(); render();
          } }, '💾 Lưu thành…'),
          h('button', { class: 'btn', onclick: async () => {
            if (!(await confirmBox('Đặt lại preset này về mặc định của app?', 'Đặt lại'))) return;
            app.preset.data = deepClone(DEFAULT_PRESET); save(); render();
          } }, '↺ Mặc định'),
          h('button', { class: 'btn danger', disabled: !app.presetList.includes(safeId(P.name)), onclick: async () => {
            if (!(await confirmBox(`Xóa preset "${P.name}"?`, 'Xóa', 'danger'))) return;
            await store.del('presets', safeId(P.name));
            app.presetList = app.presetList.filter((x) => x !== safeId(P.name));
            app.settings.activePreset = null; app.saveSettings();
            await loadPresets(); render();
          } }, '🗑'),
        )),
      h('div', { class: 'muted small' }, 'Preset được nhập "y chang" — mọi trường gốc (kể cả trường app không dùng) được giữ nguyên khi xuất lại. Có thể kéo-thả file preset .json vào cửa sổ.'),
    );

    // ---------------------------------------------------------- sampler
    const samplers = h('div', { class: 'grid3' }, SAMPLERS.map((sp) => {
      const val = d[sp.key] ?? DEFAULT_PRESET[sp.key] ?? 0;
      const num = h('input', { type: 'number', value: val, step: sp.step, min: sp.min, max: sp.max });
      const range = sp.wide ? null : h('input', { type: 'range', min: sp.min, max: sp.max, step: sp.step, value: val });
      const set = (v) => { const n = Number(v); if (!Number.isFinite(n)) return; d[sp.key] = n; num.value = n; if (range) range.value = n; save(); };
      num.addEventListener('change', () => set(num.value));
      range?.addEventListener('input', () => set(range.value));
      return h('div', { class: 'sampler' }, h('div', { class: 'name' }, h('span', null, sp.label), h('code', { class: 'muted' }, sp.key)), range || h('span'), num);
    }));

    const prefill = h('textarea', { rows: 3, placeholder: 'Assistant Prefill (Claude) — để trống nếu không dùng' }, d.assistant_prefill || '');
    prefill.addEventListener('change', () => { d.assistant_prefill = prefill.value; save(); });

    const opts = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Tham số lấy mẫu (giống panel AI Response Configuration của ST)'),
      samplers,
      h('hr'),
      h('div', { class: 'grid2' },
        h('div', null,
          checkbox('Streaming (stream_openai)', d.stream_openai !== false, (v) => { d.stream_openai = v; save(); }),
          checkbox('Gộp các tin system liên tiếp (squash_system_messages)', !!d.squash_system_messages, (v) => { d.squash_system_messages = v; save(); }),
          checkbox('Claude: dùng system prompt (claude_use_sysprompt)', d.claude_use_sysprompt !== false, (v) => { d.claude_use_sysprompt = v; save(); }),
          checkbox('Gemini: dùng system instruction (use_makersuite_sysprompt)', d.use_makersuite_sysprompt !== false, (v) => { d.use_makersuite_sysprompt = v; save(); }),
          checkbox('Hiện suy luận (show_thoughts)', !!d.show_thoughts, (v) => { d.show_thoughts = v; save(); }),
        ),
        h('div', null,
          field('Reasoning effort', select(REASONING, d.reasoning_effort || 'auto', (v) => { d.reasoning_effort = v; save(); }), 'Chỉ gửi khi bật "Gửi reasoning_effort" trong tab Kết nối.'),
          field('Assistant Prefill', prefill, 'Chỉ dùng cho Claude, hoặc mọi API nếu bật "Dùng prefill cho mọi API" ở tab Cài đặt dịch.'),
        ),
      ),
    );

    // ---------------------------------------------------------- Prompt Manager
    const order = getOrder(d);
    const list = h('div', { class: 'pm-list' });
    let dragIdx = -1;
    const renderList = () => {
      clear(list);
      order.forEach((o, idx) => {
        const p = getPrompt(d, o.identifier);
        const isMarker = !!p?.marker;
        const name = p?.name || MARKERS[o.identifier] || o.identifier;
        const tog = h('input', { type: 'checkbox', checked: !!o.enabled, title: 'Bật/tắt' });
        tog.addEventListener('change', () => { o.enabled = tog.checked; save(); row.classList.toggle('off', !o.enabled); });
        const row = h('div', { class: 'pm-item' + (o.enabled ? '' : ' off') + (isMarker ? ' marker' : ''), draggable: 'true' },
          h('span', { class: 'handle', title: 'Kéo để đổi thứ tự' }, '⠿'),
          tog,
          h('span', { class: 'nm', title: o.identifier }, name, ' ',
            isMarker ? h('span', { class: 'pill' }, o.identifier === 'chatHistory' ? 'vị trí nội dung cần dịch' : 'marker') : null,
            Number(p?.injection_position) === 1 ? h('span', { class: 'pill warn' }, `in-chat @${p.injection_depth ?? 4}`) : null),
          h('span', { class: 'pill' }, p?.role || (isMarker ? '—' : 'system')),
          h('span', { class: 'muted small' }, p && !isMarker ? `${(p.content || '').length} ký tự` : ''),
          h('span', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'btn small icon', title: 'Lên', onclick: () => move(idx, -1) }, '↑'),
            h('button', { class: 'btn small icon', title: 'Xuống', onclick: () => move(idx, 1) }, '↓'),
            h('button', { class: 'btn small icon', title: 'Sửa', disabled: !p, onclick: () => editPrompt(p) }, '✎'),
            h('button', { class: 'btn small icon', title: 'Xóa khỏi danh sách', onclick: async () => {
              if (!(await confirmBox(`Xóa prompt "${name}"?`, 'Xóa', 'danger'))) return;
              order.splice(idx, 1);
              if (p && !MARKERS[p.identifier]) d.prompts = d.prompts.filter((x) => x !== p);
              save(); renderList();
            } }, '🗑')),
        );
        row.addEventListener('dragstart', () => { dragIdx = idx; row.classList.add('dragging'); });
        row.addEventListener('dragend', () => { row.classList.remove('dragging'); });
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-target');
          if (dragIdx < 0 || dragIdx === idx) return;
          const [it] = order.splice(dragIdx, 1);
          order.splice(idx, 0, it);
          dragIdx = -1; save(); renderList();
        });
        list.appendChild(row);
      });
      // prompt có trong preset nhưng chưa nằm trong thứ tự
      const missing = (d.prompts || []).filter((p) => !order.some((o) => o.identifier === p.identifier));
      if (missing.length) {
        list.appendChild(h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'Prompt chưa có trong danh sách: ',
          missing.map((p) => h('button', { class: 'btn small ghost', onclick: () => { order.push({ identifier: p.identifier, enabled: true }); save(); renderList(); } }, '+ ' + (p.name || p.identifier)))));
      }
    };
    const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; save(); renderList(); };
    renderList();

    const usePM = checkbox('Dùng các prompt đang BẬT của preset khi dịch (gửi kèm prompt dịch tại vị trí "Chat History")', !!app.ts().usePresetPrompts,
      (v) => { app.ts().usePresetPrompts = v; app.saveSettings(); }, 'Hữu ích với preset phá giới hạn (jailbreak) để model chịu dịch nội dung nhạy cảm. Tắt = chỉ dùng prompt dịch của app (sạch, ổn định hơn). Sampler luôn lấy từ preset.');

    const pm = h('div', { class: 'card-box' },
      h('div', { class: 'row' }, h('h3', { style: { margin: 0, flex: 1 } }, 'Prompt Manager'),
        h('button', { class: 'btn small', onclick: () => {
          const id = uuid();
          const p = { identifier: id, name: 'Prompt mới', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, forbid_overrides: false };
          d.prompts.push(p); order.push({ identifier: id, enabled: true }); save(); renderList(); editPrompt(p);
        } }, '➕ Thêm prompt')),
      usePM,
      list,
    );

    async function editPrompt(p) {
      if (!p) return;
      const isMarker = !!p.marker;
      const name = h('input', { type: 'text', value: p.name || '' });
      const role = select({ system: 'system', user: 'user', assistant: 'assistant' }, p.role || 'system', () => {});
      const pos = select({ 0: 'Tương đối (theo thứ tự danh sách)', 1: 'Trong chat (in-chat, theo độ sâu)' }, Number(p.injection_position || 0), () => {});
      const depth = h('input', { type: 'number', value: p.injection_depth ?? 4, min: 0 });
      const ord = h('input', { type: 'number', value: p.injection_order ?? 100 });
      const content = h('textarea', { rows: 16, disabled: isMarker }, p.content || '');
      const body = h('div', null,
        h('div', { class: 'grid2' }, field('Tên', name), field('Vai (role)', role)),
        isMarker ? h('div', { class: 'muted small' }, 'Đây là marker của ST (vị trí chèn dữ liệu), không có nội dung riêng.') :
          h('div', { class: 'grid3' }, field('Vị trí', pos), field('Độ sâu (in-chat)', depth), field('Thứ tự (in-chat)', ord)),
        field('Nội dung (hỗ trợ macro {{user}}, {{char}}, {{setvar}}, {{getvar}}, {{random}}, {{// }}, {{trim}}...)', content),
      );
      const ok = await modal('Sửa prompt: ' + (p.name || p.identifier), body, [{ label: 'Hủy', value: false }, { label: 'Lưu', cls: 'primary', value: true }], { wide: true });
      if (!ok) return;
      p.name = name.value;
      p.role = role.value;
      if (!isMarker) {
        p.content = content.value;
        p.injection_position = Number(pos.value);
        p.injection_depth = Number(depth.value);
        p.injection_order = Number(ord.value);
      }
      save(); renderList();
    }

    el.append(h('h2', null, '🎛️ Preset & Tham số'), bar, opts, pm);
  }
  return self;
}
