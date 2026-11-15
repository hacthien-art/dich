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
      checkbox('Tự dịch lại các biến bị trùng tên (2 biến khác nhau bị dịch thành cùng một tên)', ts.autoFixConflicts !== false, (v) => { ts.autoFixConflicts = v; save(); }, 'Chạy sau bước gợi ý từ điển và trước khi dịch. AI đặt lại tên cho đủ nghĩa để phân biệt; nếu vẫn trùng thì thêm hậu tố số.'),
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
          checkbox('Dịch cả chuỗi ngắn trong mã EJS (<% %>)', !!ts.ejsStrings, (v) => { ts.ejsStrings = v; reanalyze(); }, 'Mặc định: chuỗi trong thẻ xuất <%= %> / <%- %>, print() và chuỗi là CÂU VĂN trong thẻ mã <% %> (có dấu câu tiếng Trung hoặc dài, vd notes.push(\'…，…\')) được dịch; chuỗi ngắn (giá trị trạng thái, tên) và chuỗi dùng để so sánh / làm khóa / gọi getwi(), setvar() giữ nguyên để logic không hỏng. Bật nếu card chỉ dùng EJS để hiển thị chữ. Chuỗi ngắn còn sót có thể thêm vào từ điển ở tab 🩺 Kiểm tra.'),
          checkbox('Dịch chú thích trong mã (<!-- -->, //, /* */, <%# %>)', !!ts.comments, (v) => { ts.comments = v; reanalyze(); }, 'Chú thích không ảnh hưởng chạy mã; bản dịch được ép trên 1 dòng với // và không thể đóng chú thích sớm.'),
          checkbox('Regex nhận cả dấu câu ASCII thay cho dấu toàn độ rộng (：，（）…)', ts.widenRegex !== false, (v) => { ts.widenRegex = v; reanalyze(); }, 'Bản dịch tiếng Việt viết "Độ hảo cảm: 50" chứ không phải "Độ hảo cảm：50". Bật: find regex / regex trong mã đổi "：" thành "[：:]\\s*" (nhóm không bắt, không đổi số thứ tự $1, $2) để vẫn khớp. Tắt: giữ nguyên regex và bắt bản dịch giữ đúng dấu toàn độ rộng.'),
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

    const updOut = h('span', { class: 'muted small' });
    const updBtn = h('button', { class: 'btn', onclick: async () => {
      updBtn.disabled = true; updOut.textContent = 'Đang hỏi GitHub…';
      try {
        const r = await app.updater.check(true, { silent: false });
        updOut.textContent = r?.error ? '✗ ' + r.error : r?.available ? `Có bản mới (${r.commits?.length || r.behind || 1} thay đổi)` : '✓ Đang dùng bản mới nhất';
      } finally { updBtn.disabled = false; }
    } }, '🔄 Kiểm tra cập nhật');
    const upd = h('div', { class: 'card-box' },
      h('h3', { style: { marginTop: 0 } }, 'Cập nhật ứng dụng'),
      h('div', { class: 'row' }, h('span', { class: 'pill' }, 'Phiên bản: v' + (app.version || '?')), updBtn, updOut),
      checkbox('Tự kiểm tra bản mới trên GitHub khi mở app (nút "⬆ Cập nhật" hiện trên thanh trên cùng khi có bản mới)', app.settings.autoUpdateCheck !== false, (v) => { app.settings.autoUpdateCheck = v; save(); }),
      h('div', { class: 'hint muted small' }, 'Cài bằng git clone: app chạy git fetch + git merge --ff-only. Cài bằng file zip: app tải zip nhánh main và chép đè (thư mục data/ được giữ nguyên). Sau khi cập nhật, app tự khởi động lại.'));

    el.append(h('h2', null, '⚙️ Cài đặt dịch'), run, scope, prompts, upd,
      h('button', { class: 'btn', onclick: () => { Object.assign(ts, { ...DEFAULT_TRANSLATE_SETTINGS, prompts: ts.prompts }); reanalyze(); render(); toast('Đã đặt lại thông số (giữ prompt)', 'ok'); } }, '↺ Đặt lại thông số mặc định'));
  }
  return self;
}
