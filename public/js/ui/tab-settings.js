// Tab Cài đặt dịch: thông số chạy, phạm vi dịch, xử lý mã, prompt dịch
import { h, clear, field, checkbox, select, toast } from './dom.js';
import { DEFAULT_PROMPTS } from '../core/translate.js';
import { DEFAULT_TRANSLATE_SETTINGS } from '../project.js';

export function create(app, el) {
  const self = { render };

  function render() {
    clear(el);
    const ts = app.ts();
    const save = () => app.saveSettings();
    const reanalyze = () => { save(); if (app.project) { app.project.analyze(ts); app.saveProject(); app.refresh('card'); app.refresh('vars'); app.updateTopbar(); } };
    const num = (key, opts = {}) => {
      const inp = h('input', { type: 'number', value: ts[key], min: opts.min ?? 0, max: opts.max, step: opts.step ?? 1 });
      inp.addEventListener('change', () => { ts[key] = Number(inp.value); (opts.re ? reanalyze : save)(); });
      return inp;
    };

    const run = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Thông số chạy'),
      h('div', { class: 'grid3' },
        field('Số yêu cầu song song', num('concurrency', { min: 1, max: 16 }), 'Proxy giới hạn tốc độ thì để 1-2.'),
        field('Ký tự tối đa mỗi lô', num('batchChars', { min: 300, max: 20000, step: 100 }), 'Lớn = ít yêu cầu hơn nhưng dễ bị cắt cụt. Gợi ý 2000-4000.'),
        field('Số đoạn tối đa mỗi lô', num('batchSegs', { min: 1, max: 300 })),
        field('Số lần thử lại', num('retries', { min: 0, max: 6 })),
        field('Nghỉ giữa các yêu cầu (ms)', num('delayMs', { min: 0, max: 60000, step: 100 })),
        field('Chia văn bản dài theo (ký tự)', num('chunkSize', { min: 400, max: 12000, step: 100, re: true }), 'Đoạn văn dài hơn sẽ được cắt tại ranh giới dòng.'),
        field('Tên người dùng ({{user}})', (() => { const i = h('input', { type: 'text', value: ts.userName }); i.addEventListener('change', () => { ts.userName = i.value || 'User'; save(); }); return i; })()),
      ),
      checkbox('Dùng các prompt đang bật của preset ST (preset phá giới hạn)', !!ts.usePresetPrompts, (v) => { ts.usePresetPrompts = v; save(); }),
      checkbox('Dùng Assistant Prefill của preset cho mọi API (không chỉ Claude)', !!ts.applyPrefill, (v) => { ts.applyPrefill = v; save(); }),
      checkbox('Tự gợi ý bảng biến/thuật ngữ bằng AI trước khi dịch toàn bộ', !!ts.autoSuggestDict, (v) => { ts.autoSuggestDict = v; save(); }),
    );

    const scope = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Phạm vi dịch'),
      h('div', { class: 'grid2' },
        h('div', null,
          checkbox('Dịch tên nhân vật (name)', !!ts.translateCardName, (v) => { ts.translateCardName = v; save(); app.project?.bump(); }),
          checkbox('Dịch thẻ (tags)', !!ts.translateTags, (v) => { ts.translateTags = v; save(); app.project?.bump(); }),
          checkbox('Dịch tên mục lorebook (comment) — tự đồng bộ getwi() trong EJS', !!ts.translateComments, (v) => { ts.translateComments = v; reanalyze(); }, 'Tiền tố [InitVar], [mvu_update], [EJS]… luôn được giữ nguyên.'),
          checkbox('Dịch tên regex', !!ts.translateRegexNames, (v) => { ts.translateRegexNames = v; save(); app.project?.bump(); }),
          checkbox('Dịch tên & mô tả script Tavern Helper', !!ts.translateScriptNames, (v) => { ts.translateScriptNames = v; ts.translateScriptInfo = v; save(); app.project?.bump(); }, 'Tên nút bấm của script không bị đổi (MVU gắn sự kiện theo tên nút).'),
        ),
        h('div', null,
          field('Từ khóa kích hoạt lorebook (keys)', select({ append: 'Giữ từ khóa gốc + thêm bản dịch (khuyên dùng)', replace: 'Thay bằng bản dịch', keep: 'Giữ nguyên' }, ts.keysMode, (v) => { ts.keysMode = v; save(); app.project?.bump(); })),
          field('Chuỗi tiếng Trung trong mã JS (HTML/script)', select({ smart: 'Thông minh — dịch chữ hiển thị, giữ chuỗi dùng làm khóa/so sánh', all: 'Dịch mọi chuỗi (trừ biến đã đồng bộ)', none: 'Không dịch chuỗi trong mã' }, ts.codeStrings, (v) => { ts.codeStrings = v; reanalyze(); })),
          checkbox('Dịch cả chuỗi trong mã EJS (<% %>) — mặc định chỉ đồng bộ biến', !!ts.ejsStrings, (v) => { ts.ejsStrings = v; reanalyze(); }),
          checkbox('Dịch chú thích trong mã (<!-- -->, //, /* */)', !!ts.comments, (v) => { ts.comments = v; reanalyze(); }),
        ),
      ),
    );

    const P = { ...DEFAULT_PROMPTS, ...(ts.prompts || {}) };
    const promptEditor = (key, title, hint) => {
      const ta = h('textarea', { rows: key === 'system' ? 14 : 10 }, P[key]);
      ta.addEventListener('change', () => { ts.prompts = { ...(ts.prompts || {}), [key]: ta.value }; save(); });
      return h('div', { class: 'field' },
        h('div', { class: 'row' }, h('span', { class: 'lbl', style: { flex: 1 } }, title),
          h('button', { class: 'btn small', onclick: () => { ta.value = DEFAULT_PROMPTS[key]; const p = { ...(ts.prompts || {}) }; delete p[key]; ts.prompts = p; save(); toast('Đã khôi phục mặc định', 'ok', 1500); } }, '↺ Mặc định')),
        ta, h('div', { class: 'hint' }, hint));
    };
    const prompts = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Prompt dịch'),
      promptEditor('system', 'Chỉ thị hệ thống (system)', 'Biến: {{name_rule}} (quy tắc tên riêng), {{card_name}}. Có thể dùng macro ST như {{user}}, {{char}}.'),
      promptEditor('task', 'Yêu cầu dịch (user) — đặt tại vị trí Chat History của preset', 'Biến: {{card_name}}, {{glossary}} (thuật ngữ liên quan), {{segments}} (các thẻ <seg>). Giữ yêu cầu trả về thẻ <seg id="..."> để app đọc kết quả.'),
      promptEditor('dict', 'Gợi ý tên biến / thuật ngữ', 'Biến: {{card_name}}, {{name_rule}}, {{items}} (các thẻ <item>). Kết quả phải trả về thẻ <item id="...">.'),
    );

    el.append(h('h2', null, '⚙️ Cài đặt dịch'), run, scope, prompts,
      h('button', { class: 'btn', onclick: () => { Object.assign(ts, { ...DEFAULT_TRANSLATE_SETTINGS, prompts: ts.prompts }); reanalyze(); render(); toast('Đã đặt lại thông số (giữ prompt)', 'ok'); } }, '↺ Đặt lại thông số mặc định'));
  }
  return self;
}
