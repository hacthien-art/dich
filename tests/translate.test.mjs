// Kiểm thử phần đọc phản hồi AI, kiểm tra placeholder, dựng prompt theo preset ST, cập nhật biến MVU
import { parseTagged, validateSegment, makeBatches, leftoverHan } from '../public/js/core/translate.js';
import { buildMessages, importPreset, exportPreset, postProcess } from '../public/js/core/preset.js';
import { evaluateMacros } from '../public/js/core/macros.js';
import { applyMvuUpdates } from '../public/js/core/mvu.js';
import { applyStyle, sanitizeName } from '../public/js/core/dict.js';
import { readCardFromPng, writeCardToPng, encodeChunks } from '../public/js/core/png.js';

let fails = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + A + '\n    exp: ' + B); } else console.log('  ✓ ' + msg);
};

// ---- parseTagged
const resp = 'Đây là bản dịch:\n<seg id="1">Xin chào ⟦1⟧</seg>\n<seg id=2 type="ui">Thế giới</seg>\n<item id="3" kind="key" ctx="a.&lt;user&gt;.b">Độ hảo cảm</item>';
eq([...parseTagged(resp, 'seg').entries()], [[1, 'Xin chào ⟦1⟧'], [2, 'Thế giới']], 'đọc thẻ <seg>');
eq([...parseTagged(resp, 'item').entries()], [[3, 'Độ hảo cảm']], 'đọc thẻ <item> có thuộc tính');
eq([...parseTagged('<item id="1" ctx="x>y">Sai</item>', 'item').entries()], [[1, 'Sai']], 'thuộc tính chứa > vẫn đọc đúng');

// ---- validateSegment
const seg = { key: '当前好感度：⟦1⟧，{{user}}', holes: [{}] };
eq(validateSegment(seg, 'Hảo cảm hiện tại: ⟦1⟧, {{user}}').ok, true, 'bản dịch đủ placeholder + macro');
eq(validateSegment(seg, 'Hảo cảm hiện tại: , {{user}}').ok, false, 'mất placeholder -> lỗi');
eq(validateSegment(seg, 'Hảo cảm ⟦1⟧ ⟦1⟧ {{user}}').ok, false, 'lặp placeholder -> lỗi');
eq(validateSegment(seg, 'Hảo cảm hiện tại: ⟦1⟧').soft, true, 'mất {{user}} -> lỗi mềm');
eq(validateSegment(seg, 'Hảo cảm hiện tại: [[1]], {{user}}').ok, true, 'chuẩn hóa [[1]] -> ⟦1⟧');
eq(makeBatches([{ key: 'a'.repeat(10) }, { key: 'b'.repeat(10) }, { key: 'c'.repeat(10) }], 25, 10).map((b) => b.length), [2, 1], 'chia lô theo số ký tự');

// ---- còn sót chữ Hán (vd tên thẻ <姬悠馨_id40> bị giữ nguyên)
const segTag = { key: '<姬悠馨_id40>\n<character:姬悠馨>\n身份：转学生', holes: [] };
const vLeft = validateSegment(segTag, '<姬悠馨_id40>\n<character:姬悠馨>\nThân phận: học sinh chuyển trường');
eq([vLeft.ok, vLeft.soft, vLeft.leftover], [false, true, ['姬悠馨']], 'phát hiện chữ Hán còn sót trong tên thẻ -> lỗi mềm để dịch lại');
eq(validateSegment(segTag, '<Cơ Du Hinh_id40>\n<character:Cơ Du Hinh>\nThân phận: học sinh chuyển trường').ok, true, 'dịch cả chữ Hán trong thẻ -> hợp lệ');
eq(validateSegment(segTag, '<姬悠馨_id40>\n<character:姬悠馨>\nThân phận: học sinh', new Set(['姬悠馨'])).ok, true, 'từ được phép giữ nguyên (thuật ngữ "giữ") không bị báo lỗi');
eq(leftoverHan('Xin chào ⟦1⟧ 世界 và 世界'), ['世界'], 'liệt kê cụm chữ Hán còn sót (không trùng)');

// ---- macro
eq(evaluateMacros('{{setvar::x::1}}{{addvar::x::2}}{{getvar::x}}|{{user}}|{{// bỏ}}|{{char}}', { user: 'A', char: 'B' }), '3|A||B', 'macro biến + user/char + chú thích');

// ---- preset
const { data } = importPreset({
  temperature: 0.7, prompts: [
    { identifier: 'main', role: 'system', content: 'MAIN {{char}}' },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'jb', role: 'system', content: 'JB' },
    { identifier: 'deep', role: 'user', content: 'DEEP', injection_position: 1, injection_depth: 1 },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'jb', enabled: true }, { identifier: 'deep', enabled: true }] }],
  my_extra: 42,
}, 'p.json');
const msgs = buildMessages(data, { usePresetPrompts: true, systemPrompt: 'SYS', taskMessages: [{ role: 'user', content: 'TASK' }], macro: { char: 'C' } });
eq(msgs.map((m) => m.role + ':' + m.content), ['system:MAIN C', 'system:SYS', 'user:DEEP', 'user:TASK', 'system:JB'], 'thứ tự prompt + chèn in-chat theo độ sâu');
eq(JSON.parse(exportPreset({ data })).my_extra, 42, 'xuất preset giữ trường gốc');
eq(postProcess([{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'assistant', content: 'c' }], 'strict').map((m) => m.role), ['system', 'user', 'assistant'], 'post-processing strict');

// ---- MVU
const st = { 角色: { 好感度: 10, 状态: ['正常', '描述'] } };
const after = applyMvuUpdates(st, "<UpdateVariable>_.set('角色.好感度', 10, 25);_.set('角色.状态', '开心');</UpdateVariable>");
eq(after, { 角色: { 好感度: 25, 状态: ['开心', '描述'] } }, 'lệnh _.set (kể cả dạng [giá trị, mô tả])');
const after2 = applyMvuUpdates(st, '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/角色/好感度","value":5},{"op":"insert","path":"/角色/新","value":1}]</JSONPatch></UpdateVariable>');
eq(after2.角色.好感度, 15, 'JSON Patch delta');
eq(after2.角色.新, 1, 'JSON Patch insert');

// ---- đặt tên biến
eq(applyStyle('Độ hảo cảm', 'underscore', 'key'), 'Độ_hảo_cảm', 'kiểu nối _');
eq(applyStyle('Độ hảo cảm', 'snake', 'key'), 'do_hao_cam', 'kiểu snake không dấu');
eq(applyStyle('Đặc tính', 'camel', 'key'), 'dacTinh', 'kiểu camelCase');
eq(applyStyle('Biến', 'natural', 'key', '_变量'), '_Biến', 'giữ tiền tố _ (biến chỉ đọc)');
eq(sanitizeName('"Thế.giới/<a>"', 'key'), 'Thế giới a', 'lọc ký tự phá đường dẫn');

// ---- PNG
const tiny = encodeChunks([{ name: 'IHDR', data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]) }, { name: 'IDAT', data: new Uint8Array([120, 156, 99, 0, 1, 0, 0, 5, 0, 1]) }, { name: 'IEND', data: new Uint8Array() }]);
const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Thử 测试 ✓' } };
const png = writeCardToPng(writeCardToPng(tiny, JSON.stringify(card)), JSON.stringify(card));
const back = readCardFromPng(png);
eq([back.source, JSON.parse(back.json).spec, JSON.parse(back.json).data.name], ['ccv3', 'chara_card_v3', 'Thử 测试 ✓'], 'ghi/đọc PNG (chara + ccv3, UTF-8, ghi đè chunk cũ)');

console.log(fails ? fails + ' lỗi' : 'translate/preset/mvu/png OK');
process.exit(fails ? 1 : 0);
