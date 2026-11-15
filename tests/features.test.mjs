// Kiểm thử các tính năng 1.1: PNG chuẩn CRC, giá trị ghép, EJS, chú thích, data-*, ${a|b}, biến trùng tên, nút/biến Tavern Helper
import vm from 'node:vm';
import * as yaml from 'js-yaml';
import { crc32, encodeChunks, writeCardToPng, readCardFromPng, verifyPng } from '../public/js/core/png.js';
import { makeCard, listItems, buildTranslatedCard } from '../public/js/core/card.js';
import { scanCard, mergeScan, makeDictIndex, findConflicts } from '../public/js/core/dict.js';
import { analyzeItem, findDynamicEntryRefs, PH_RE } from '../public/js/core/analyze.js';
import { suffixConflicts, planConflicts, resolveConflicts } from '../public/js/core/translate.js';

let fails = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + A + '\n    exp: ' + B); } else console.log('  ✓ ' + msg);
};
const ok = (cond, msg, extra) => eq(!!cond, true, msg + (cond || extra === undefined ? '' : ' — ' + extra));
const HAN = /[㐀-鿿]/;

// ------------------------------------------------------------------ PNG
// Bộ đọc nghiêm ngặt giống png-chunks-extract (SillyTavern dùng): kiểm CRC từng chunk
function strictExtract(data) {
  if (data[0] !== 0x89 || data[1] !== 0x50) throw new Error('Invalid .png file header');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let idx = 8, ended = false;
  const chunks = [];
  while (idx < data.length) {
    const len = dv.getUint32(idx);
    const name = String.fromCharCode(...data.subarray(idx + 4, idx + 8));
    if (!chunks.length && name !== 'IHDR') throw new Error('IHDR header missing');
    if (name === 'IEND') { ended = true; break; }
    const crcActual = dv.getUint32(idx + 8 + len);
    const crcExpect = crc32(data, idx + 4, idx + 8 + len);
    if (crcExpect !== crcActual) throw new Error('CRC values for ' + name + ' header do not match, PNG file is likely corrupted');
    chunks.push({ name, data: data.subarray(idx + 8, idx + 8 + len) });
    idx += 12 + len;
  }
  if (!ended) throw new Error('.png file ended prematurely: no IEND header was found');
  return chunks;
}
eq(crc32(new TextEncoder().encode('IEND')).toString(16), 'ae426082', 'CRC32 chuẩn PNG (IEND = AE426082)');
const tiny = encodeChunks([{ name: 'IHDR', data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]) }, { name: 'IDAT', data: new Uint8Array([120, 156, 99, 0, 1, 0, 0, 5, 0, 1]) }, { name: 'IEND', data: new Uint8Array() }]);
eq([...tiny.slice(-12)].map((b) => b.toString(16).padStart(2, '0')).join(''), '0000000049454e44ae426082', 'chunk IEND ghi ra đúng chuẩn');
const cardPng = writeCardToPng(tiny, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Thử 测试' } }));
let strictErr = null;
try { strictExtract(cardPng); } catch (e) { strictErr = e.message; }
eq(strictErr, null, 'PNG xuất ra qua được bộ đọc kiểm CRC của SillyTavern');
eq(verifyPng(cardPng).ok, true, 'verifyPng chấp nhận PNG xuất ra');
const broken = cardPng.slice(); broken[20] ^= 0xff;
eq(verifyPng(broken).ok, false, 'verifyPng phát hiện CRC sai');
eq(JSON.parse(readCardFromPng(broken).json).data.name, 'Thử 测试', 'vẫn đọc được PNG cũ bị lỗi CRC (để nhập lại & xuất lại)');

// ------------------------------------------------------------------ tiện ích phân tích
const settings = { varMode: 'translate', namingStyle: 'natural' };
function setup(raw, dst = {}) {
  const card = makeCard(raw);
  const items = listItems(card);
  const scan = scanCard(card, items);
  const dict = mergeScan({}, scan.entries);
  for (const [src, v] of Object.entries(dict)) v.dst = dst[src] ?? '';
  const idx = makeDictIndex(dict, settings);
  const entryNames = new Set((card.raw.data.character_book?.entries || []).map((e) => e.comment).filter(Boolean));
  return { card, items, dict, idx, entryNames };
}
function render(env0, it, opts = {}, tmFn = null) {
  const ctx = { dict: env0.idx, entryNames: env0.entryNames, opts: { codeStrings: 'smart', chunkSize: 1800, comments: true, ...opts } };
  const a = analyzeItem(it, ctx);
  const tm = new Map();
  if (tmFn) for (const s of a.segments) tm.set(s.key, tmFn(s.key, s));
  return { a, out: a.render({ tm, dict: env0.idx, entryName: (s) => s, keysMode: 'replace' }) };
}
const book = (entries) => ({ name: 'B', entries: entries.map((e, i) => ({ id: i, keys: [], content: '', enabled: true, ...e })) });

// ------------------------------------------------------------------ giá trị ghép "权势、高知、舆论" + khóa object trong script
{
  const raw = {
    spec: 'chara_card_v2', data: {
      name: 'T', first_mes: 'x',
      character_book: book([{ comment: '[InitVar]', content: '男NPC:\n  陈树荣:\n    标签: 权势、高知、舆论\n  阿勇:\n    标签: 低知\n' }]),
      extensions: {
        tavern_helper: {
          scripts: [{ type: 'script', name: 's', id: '1', content: "const TAG_MEANS = {\n  权势: ['找关系'],\n  高知: ['搜集黑料'],\n  低知: ['找人'],\n  舆论: ['散播'],\n};\nconst BASE = { 低知: 3, 舆论: 4, 高知: 5, 权势: 5 };\nfunction split(v){ return String(v||'').split(/[、,，;；]/).map(s=>s.trim()).filter(Boolean); }\nconst DEF = { '陈树荣': { 标签: '权势、高知、舆论' } };\nglobalThis.__r = split(DEF['陈树荣'].标签).map(t => [t, !!TAG_MEANS[t], BASE[t]]);" }],
          variables: {},
        },
      },
    },
  };
  const dst = { 权势: 'Quyền thế', 高知: 'Học cao', 低知: 'Ít học', 舆论: 'Dư luận', 标签: 'Nhãn', 男NPC: 'NPC nam', 陈树荣: 'Trần Thụ Vinh', 阿勇: 'A Dũng' };
  const env0 = setup(raw, dst);
  eq(['权势', '高知', '舆论'].map((k) => env0.dict[k]?.kind), ['value', 'value', 'value'], 'giá trị ghép được tách thành từng nhãn trong từ điển');
  eq(env0.dict['权势、高知、舆论'], undefined, 'không thêm nguyên chuỗi ghép vào từ điển');
  const iv = env0.items.find((it) => it.kind === 'initvar');
  const ivOut = render(env0, iv).out;
  eq(yaml.load(ivOut)['NPC nam']['Trần Thụ Vinh']['Nhãn'], 'Quyền thế、Học cao、Dư luận', 'InitVar: giá trị ghép dịch từng nhãn, giữ dấu 、');
  const code = env0.items.find((it) => it.kind === 'code');
  const out = render(env0, code).out;
  ok(!HAN.test(out.replace(/找关系|搜集黑料|找人|散播/g, '')), 'script: khóa TAG_MEANS/BASE + chuỗi ghép không còn chữ Hán', out);
  const sb = { globalThis: {} }; sb.globalThis = sb;
  vm.runInNewContext(out, sb);
  eq(sb.__r, [['Quyền thế', true, 5], ['Học cao', true, 5], ['Dư luận', true, 4]], 'script chạy đúng: tách nhãn rồi tra TAG_MEANS/BASE vẫn khớp sau dịch');
}

// ------------------------------------------------------------------ EJS
{
  const ejs = "<%_ const ch = getvar('stat_data.世界.章节', { defaults: '幕间' }); _%>\n<%_ if (ch === '开局') { _%>\n她笑了，说：“你好”。\n<%_ } else { _%>\n她哭了。<%= ch === '开局' ? '是' : '否' %>\n<%_ } _%>\n<%- await getwi(null, bookName + ' / 第' + n + '章') %>\n<%- await getwi(null, '▶️开局流程') %>\n<% print('欢迎'); /* 注释 */ %>";
  const raw = { spec: 'chara_card_v2', data: { name: 'T', first_mes: 'x', character_book: book([
    { comment: '[InitVar]', content: '世界:\n  章节: 开局\n' },
    { comment: '[EJS]控制', content: ejs },
    { comment: '▶️开局流程', content: 'a' },
    { comment: '失落之城 / 第一章', content: 'b' },
    { comment: '失落之城 / 总纲', content: 'c' },
  ]) } };
  const env0 = setup(raw, { 世界: 'Thế giới', 章节: 'Chương', 开局: 'Khai cuộc' });
  const it = env0.items.find((x) => x.label.includes('[EJS]控制') && x.kind === 'auto');
  const r = render(env0, it, {}, (k) => k.replace(/[㐀-鿿]+/g, 'VI'));
  const keys = r.a.segments.map((s) => s.key);
  ok(keys.every((k) => !/<%[_\s]/.test(k) && !k.includes('} else {')), 'thẻ EJS điều khiển không nằm trong đoạn gửi AI (AI không thể đảo lệnh if/else)', JSON.stringify(keys));
  ok(keys.some((k) => k.includes('她笑了')) && keys.some((k) => k.includes('她哭了')), 'chữ giữa các thẻ EJS vẫn được dịch');
  ok(r.out.includes("'stat_data.Thế giới.Chương'"), 'getvar(đường dẫn) trong EJS được đồng bộ biến');
  ok(r.out.includes("ch === 'Khai cuộc'"), 'so sánh với giá trị trong từ điển được đồng bộ');
  ok(r.out.includes("'幕间'"), 'chuỗi thường trong thẻ mã <% %> giữ nguyên (an toàn logic)');
  ok(r.out.includes("? 'VI' : 'VI'"), 'chuỗi trong thẻ xuất <%= %> được dịch');
  ok(r.out.includes("print('VI')"), "print('…') trong EJS được dịch");
  ok(r.out.includes("' / 第'") && r.out.includes("'章'"), 'mảnh tên mục ghép động trong getwi() giữ nguyên');
  const dyn = findDynamicEntryRefs([ejs], env0.entryNames);
  eq([...dyn.pinned].sort(), ['失落之城 / 第一章'], 'phát hiện mục lorebook bị getwi() ghép động -> giữ tên');
  const pct = render(env0, { kind: 'auto', text: "<%= '50%' + '数' %>" }, {}, () => 'VI%>x').out;
  eq(pct, "<%= '50%' + 'VI%\\>x' %>", 'bản dịch chứa "%>" trong EJS được viết thành %\\> (không cắt ngang thẻ)');
}

// ------------------------------------------------------------------ chú thích trong mã
{
  const env0 = { idx: makeDictIndex({}, settings), entryNames: new Set() };
  const code = "// 计数器\nlet a = 1; /* 说明：数量 */ a++;";
  const r = render(env0, { kind: 'code', text: code }, { comments: true }, (k) => 'Dòng 1\nDòng 2 */ hết');
  ok(!HAN.test(r.out), 'chú thích // và /* */ được dịch');
  let compiles = true; try { new vm.Script(r.out); } catch { compiles = false; }
  ok(compiles, 'bản dịch có xuống dòng / "*/" vẫn không phá mã', r.out);
  ok(r.out.split('\n')[0].startsWith('// Dòng 1 Dòng 2'), 'chú thích // được ép trên 1 dòng');
  const html = render(env0, { kind: 'auto', text: '<div>x</div><!-- 按钮 --><span>y</span>' }, { comments: true }, () => 'Nút --> lạ');
  ok(html.out.includes('<!-- Nút - -> lạ -->'), 'chú thích HTML không bị đóng sớm bởi "-->"', html.out);
}

// ------------------------------------------------------------------ data-* và <style> trong văn xuôi
{
  const env0 = { idx: makeDictIndex({ 角色: { kind: 'key', dst: 'Nhân vật' } }, settings), entryNames: new Set() };
  const html = '<div class="b" data-prompt="【开始】 # 场景生成指令\n请根据以下元素，扩写开场。" data-tab="角色" data-x="设置" data-close="点击查看 ▶︎">按钮</div>';
  const r = render(env0, { kind: 'auto', text: html }, {}, (k) => k.replace(/[㐀-鿿]+/g, 'VI'));
  ok(!/data-prompt="[^"]*[㐀-鿿]/.test(r.out), 'data-prompt (prompt gửi đi) được dịch', r.out);
  ok(r.out.includes('data-close="VI ▶︎"'), 'data-close (chữ hiển thị qua CSS attr()) được dịch');
  ok(r.out.includes('data-tab="Nhân vật"'), 'data-* là khóa trong từ điển -> đồng bộ');
  ok(r.out.includes('data-x="设置"'), 'data-* ngắn không rõ vai trò -> giữ nguyên');
  const prose = render(env0, { kind: 'auto', text: '要求：必须用<style>标签包裹，不许遗漏。\n示例：<style> .a { color: red; } </style>' }, {}, (k) => k.replace(/[㐀-鿿]+/g, 'VI'));
  ok(!HAN.test(prose.out), 'văn xuôi nhắc tới thẻ <style> vẫn được dịch (không bị coi là CSS)', prose.out);
  ok(prose.out.includes('.a { color: red; }'), 'CSS thật phía sau vẫn giữ nguyên');
}

// ------------------------------------------------------------------ ${a|b} trong quy tắc cập nhật MVU
{
  const raw = { spec: 'chara_card_v2', data: { name: 'T', first_mes: 'x', character_book: book([
    { comment: '[InitVar]', content: '队伍:\n  成员:\n    外貌: a\n    性格: b\n' },
    { comment: '[mvu_update]规则', content: '队伍.成员.${外貌|性格}:\n  check: 更新\n队伍.${角色名}:\n  type: object\n' },
  ]) } };
  const env0 = setup(raw, { 队伍: 'Đội', 成员: 'Thành viên', 外貌: 'Ngoại hình', 性格: 'Tính cách', 角色名: 'Tên nhân vật' });
  eq(env0.dict['角色名']?.kind, 'key', 'placeholder ${角色名} được thêm vào từ điển');
  const it = env0.items.find((x) => x.label.includes('[mvu_update]') && x.kind === 'auto');
  const out = render(env0, it).out;
  ok(out.includes('Đội.Thành viên.${Ngoại hình|Tính cách}:') && out.includes('Đội.${Tên nhân vật}:'), 'đường dẫn có ${a|b} và ${tên} được đồng bộ', out);
}

// ------------------------------------------------------------------ Tavern Helper: nút script + biến
{
  const raw = { spec: 'chara_card_v2', data: { name: 'T', first_mes: 'x', extensions: { tavern_helper: {
    scripts: [
      { type: 'script', name: 'MVU', id: 'a', content: "import 'https://x/bundle.js';", button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }] }, data: {} },
      { type: 'script', name: '工具', id: 'b', content: "eventOn(getButtonEvent('刷新面板'), () => {}); const v = getVariables({type:'character'}); v.好感度;", button: { enabled: true, buttons: [{ name: '刷新面板', visible: true }] }, data: {} },
    ],
    variables: { 好感度: 0, 心情: '开心' },
  } } } };
  const env0 = setup(raw, { 刷新面板: 'Làm mới bảng', 重新处理变量: 'X', 好感度: 'Độ hảo cảm', 开心: 'Vui vẻ' });
  const btns = env0.items.filter((x) => x.kind === 'button').map((x) => x.text);
  eq(btns, ['刷新面板'], 'chỉ nút được chính script lắng nghe mới được dịch (nút MVU giữ nguyên)');
  const outputs = new Map(env0.items.map((it) => [it.id, render(env0, it).out]));
  const built = buildTranslatedCard(env0.card, outputs);
  const s2 = built.data.extensions.tavern_helper.scripts[1];
  eq([s2.button.buttons[0].name, s2.content.includes("getButtonEvent('Làm mới bảng')")], ['Làm mới bảng', true], 'tên nút và getButtonEvent() đổi cùng nhau');
  eq(built.data.extensions.tavern_helper.scripts[0].button.buttons[0].name, '重新处理变量', 'nút của bundle MVU không đổi');
  eq(built.data.extensions.tavern_helper.variables, { 'Độ hảo cảm': 0, 心情: 'Vui vẻ' }, 'biến nhân vật TH: khóa/giá trị đồng bộ theo từ điển');
  ok(s2.content.includes("v['Độ hảo cảm']"), 'script đọc biến TH theo tên mới');
}

// ------------------------------------------------------------------ class trong mã: định nghĩa & truy cập đổi cùng nhau
{
  const env0 = { idx: makeDictIndex({ 好感度: { kind: 'key', dst: 'Độ hảo cảm' }, 升级: { kind: 'key', dst: 'Nâng cấp' } }, settings), entryNames: new Set() };
  const code = 'class A { 好感度 = 1; 升级() { return this.好感度 + 1; } static 升级() { return 2; } get 好感度2() { return 0; } }\nconst o = { get 好感度() { return 3; } };\nglobalThis.__r = [new A().升级(), A.升级(), o.好感度];';
  const out = render(env0, { kind: 'code', text: code }).out;
  const sb = {}; sb.globalThis = sb;
  let err = null; try { vm.runInNewContext(out, sb); } catch (e) { err = e.message; }
  eq([err, sb.__r], [null, [2, 2, 3]], 'thành viên class / getter đổi tên đồng bộ với chỗ gọi');
}

// ------------------------------------------------------------------ biến trùng tên
{
  const dict = {
    动向: { kind: 'key', dst: 'Động thái', parents: ['安宁'], count: 2 },
    动态: { kind: 'key', dst: 'Động thái', parents: ['安宁'], count: 5 },
    年份: { kind: 'key', dst: 'Năm', parents: [], count: 1 },
    五: { kind: 'key', dst: 'Năm', parents: [], count: 1, manual: true },
    其他: { kind: 'key', dst: 'Động thái 2', parents: ['安宁'], count: 1 },
  };
  eq(findConflicts(dict, settings).length, 2, 'phát hiện 2 nhóm trùng tên');
  const plan = planConflicts(dict, findConflicts(dict, settings));
  eq(plan.map((g) => [g.keep, g.rename]), [[['动态'], ['动向']], [['五'], ['年份']]], 'giữ tên mục sửa tay / dùng nhiều nhất, đặt lại tên các mục còn lại');
  const d2 = JSON.parse(JSON.stringify(dict));
  const ch = suffixConflicts(d2, settings);
  eq(findConflicts(d2, settings).length, 0, 'hậu tố số loại bỏ mọi xung đột');
  eq(ch.map((c) => c.to), ['Động thái 3', 'Năm 2'], 'hậu tố không trùng tên đã có (Động thái 2 đã dùng -> Động thái 3)');
  const d3 = JSON.parse(JSON.stringify(dict));
  const ch3 = suffixConflicts(d3, { ...settings, namingStyle: 'snake' });
  eq(findConflicts(d3, { ...settings, namingStyle: 'snake' }).length, 0, 'hậu tố đúng cả với kiểu đặt tên snake_case');
  void ch3;

  // AI giả: lần 1 trả về tên vẫn trùng, lần 2 trả về tên khác
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    const user = body.payload.messages.map((m) => m.content).join('\n');
    const ids = [...user.matchAll(/<item id="(\d+)" now="([^"]*)"[^>]*>([^<]+)<\/item>/g)];
    const ans = ids.map(([, id, now, src]) => `<item id="${id}">${calls === 1 ? now : { 动向: 'Xu hướng', 年份: 'Niên phần' }[src] || 'X'}</item>`).join('\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: ans }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const d4 = JSON.parse(JSON.stringify(dict));
  const res = await resolveConflicts({ settings, conn: { provider: 'openai', url: 'http://x', model: 'm' }, preset: { stream_openai: false }, cardName: 'T' }, d4);
  eq([d4['动向'].dst, d4['年份'].dst, d4['五'].dst, res.remaining.length, res.suffixed.length], ['Xu hướng', 'Niên phần', 'Năm', 0, 0], 'AI đặt lại tên (vòng 2 khi vòng 1 vẫn trùng), mục sửa tay giữ nguyên');
}

// ------------------------------------------------------------------ tên mục lorebook trùng mục từ điển
{
  const raw = { spec: 'chara_card_v2', data: { name: 'T', first_mes: 'x', character_book: book([
    { comment: '[InitVar]', content: '地点: 学校\n' },
    { comment: '学校', content: '学校的介绍' },
  ]) } };
  const env0 = setup(raw, { 地点: 'Địa điểm', 学校: 'Trường học' });
  const it = env0.items.find((x) => x.kind === 'comment' && x.text === '学校');
  eq(render(env0, it).out, 'Trường học', 'tên mục trùng giá trị biến -> dùng đúng bản dịch từ điển (getwi theo biến vẫn tìm thấy)');
}

console.log(fails ? fails + ' lỗi' : 'features OK');
process.exit(fails ? 1 : 0);
void PH_RE;
