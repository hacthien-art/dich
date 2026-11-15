// Kiểm thử bản 1.2: nhãn [biến] lọt vào bản dịch, kiểm tra chữ Hán, regex mất ký tự (nhãn, thẻ tên tiếng Trung, $1,
// dấu câu toàn độ rộng, nhóm có tên, thuộc tính có nháy lồng), biến trùng tên khác hoa/thường, kiểm tra tổng thể,
// cập nhật card giữ bản dịch, chuyển bản dịch của dự án cũ.
import vm from 'node:vm';
import * as yaml from 'js-yaml';
import { makeCard, listItems, buildTranslatedCard } from '../public/js/core/card.js';
import { scanCard, mergeScan, makeDictIndex, findConflicts, sanitizeName, cleanDictTags, glossaryFor } from '../public/js/core/dict.js';
import { analyzeItem } from '../public/js/core/analyze.js';
import { lexHtml } from '../public/js/core/lexer.js';
import { formatGlossary, stripGlossaryTags, validateSegment, leftoverHan, allowedHanSet, normalizePlaceholders, suggestDict } from '../public/js/core/translate.js';
import { regexFromString, displayText } from '../public/js/core/stregex.js';
import { collectGuardChars, ejsSyntaxError, jsSyntaxError } from '../public/js/core/check.js';
import { legacyVariants, ParaMemory } from '../public/js/core/reuse.js';
import { Project, DEFAULT_TRANSLATE_SETTINGS, matchItems } from '../public/js/project.js';

let fails = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + A + '\n    exp: ' + B); } else console.log('  ✓ ' + msg);
};
const ok = (cond, msg, extra) => eq(!!cond, true, msg + (cond || extra === undefined ? '' : ' — ' + extra));
const HAN = /[㐀-䶿一-鿿豈-﫿]+/g;
const S = { ...DEFAULT_TRANSLATE_SETTINGS };

// ------------------------------------------------------------------ 1) nhãn [biến] / [giá trị]
{
  const gl = formatGlossary([{ src: '元玉仪', dst: 'Nguyên Ngọc Nghi', kind: 'key' }, { src: '无', dst: 'vô', kind: 'value' }, { src: '石', dst: 'thạch', kind: 'term' }]);
  ok(!/\[(biến|giá trị|nhãn)\]/.test(gl), 'bảng thuật ngữ gửi AI không còn gắn nhãn [biến]/[giá trị] sau bản dịch', gl);
  ok(gl.includes('元玉仪 → Nguyên Ngọc Nghi') && gl.startsWith('#'), 'tên biến được nhóm dưới dòng tiêu đề #');
  eq(stripGlossaryTags('Nguyên Ngọc Nghi [biến]_Giai đoạn 01_Mặt nạ phong trần', '元玉仪_阶段01_风尘面具'), 'Nguyên Ngọc Nghi_Giai đoạn 01_Mặt nạ phong trần', 'gỡ "[biến]" lọt vào tên mục lorebook');
  eq(stripGlossaryTags('Sản nghiệp: vô [giá trị], thu nhập [biến] 0(thạch [giá trị])', '产业：无，收入⟦1⟧(石)'), 'Sản nghiệp: vô, thu nhập 0(thạch)', 'gỡ "[giá trị]" / "[biến]" giữa câu');
  eq(stripGlossaryTags('Ghi [biến] vào đây', '把[变量]写在这里'), 'Ghi [biến] vào đây', 'giữ nguyên khi bản gốc thật sự có "[变量]"');
  eq(stripGlossaryTags('[Nhãn] Học viện', '【称号】学院'), '[Nhãn] Học viện', 'giữ "[Nhãn]" khi nó là bản dịch của nhóm ngoặc có sẵn trong bản gốc');
  eq(stripGlossaryTags('[Danh hiệu] Nguyên Ngọc Nghi [biến]', '【称号】元玉仪'), '[Danh hiệu] Nguyên Ngọc Nghi', 'chỉ gỡ nhóm ngoặc thừa so với bản gốc');
  const v = validateSegment({ key: '元玉仪_阶段01', holes: [] }, 'Nguyên Ngọc Nghi [biến]_Giai đoạn 01');
  eq([v.ok, v.out], [true, 'Nguyên Ngọc Nghi_Giai đoạn 01'], 'validateSegment tự gỡ nhãn khi nhận bản dịch');
  eq(sanitizeName('Nguyên Ngọc Nghi [biến]', 'key'), 'Nguyên Ngọc Nghi', 'tên biến do AI gợi ý không mang theo nhãn');
  const d = { a: { kind: 'key', dst: 'Thu nhập [biến]' }, b: { kind: 'value', dst: 'vô [giá trị]' }, c: { kind: 'term', dst: 'Bình thường' } };
  eq([cleanDictTags(d), d.a.dst, d.b.dst], [2, 'Thu nhập', 'vô'], 'gỡ nhãn trong từ điển của dự án cũ');
}

// ------------------------------------------------------------------ 2) kiểm tra còn sót chữ Hán
{
  eq(leftoverHan('Dân số 人口 và 口', new Set(['人口'])), ['口'], 'từ được phép chỉ được tha khi xuất hiện NGUYÊN VẸN (không tha "口" vì "人口" được phép)');
  const dict = {
    冉駹诸部: { kind: 'value', dst: '冉駹诸部' },           // AI trả về vẫn chữ Hán -> KHÔNG được coi là cố ý
    宋体: { kind: 'term', dst: '', keep: true },             // người dùng tích "Giữ"
    长安: { kind: 'term', dst: 'Trường An' },
    空: { kind: 'value', dst: '' },                          // chưa dịch
    原名: { kind: 'term', dst: '原名 (tên gốc)', manual: true }, // người dùng cố ý để chữ Hán
  };
  const allowed = allowedHanSet(dict, S);
  eq([...allowed].sort(), ['原名 (tên gốc)', '宋体'].sort(), 'chỉ mục "Giữ" và bản sửa tay mới được phép còn chữ Hán');
  const seg = { key: '地域：冉駹诸部，字体宋体', holes: [] };
  const v = validateSegment(seg, 'Địa vực: 冉駹诸部, font 宋体', allowed);
  eq([v.ok, v.leftover], [false, ['冉駹诸部']], 'chữ Hán sót do mục từ điển chưa dịch được báo lỗi');
  const g = glossaryFor(['冉駹诸部 长安 空'], dict, S);
  eq(g.map((x) => x.src).sort(), ['长安'], 'bảng thuật ngữ không gửi "gốc → gốc" cho mục chưa dịch / AI trả về chữ Hán');
}

// ------------------------------------------------------------------ 3) gợi ý từ điển: không nhận kết quả còn chữ Hán, gỡ nhãn
{
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    call++;
    const user = JSON.parse(opts.body).payload.messages.map((m) => m.content).join('\n');
    const ids = [...user.matchAll(/<item id="(\d+)"[^>]*>([^<]+)<\/item>/g)];
    const ans = ids.map(([, id, src]) => `<item id="${id}">${src === '冉駹诸部' ? (call === 1 ? '冉駹诸部' : 'Các bộ Nhiễm Mang') : 'Thu nhập [biến]'}</item>`).join('\n');
    return new Response(JSON.stringify({ choices: [{ message: { content: ans }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const got = {};
  await suggestDict({ settings: S, conn: { provider: 'openai', url: 'http://x', model: 'm' }, preset: { stream_openai: false }, cardName: 'T', onItem: (s, d) => { got[s] = d; } },
    [{ src: '冉駹诸部', kind: 'value' }, { src: '收入', kind: 'key' }]);
  eq(got, { 收入: 'Thu nhập', 冉駹诸部: 'Các bộ Nhiễm Mang' }, 'AI trả về chữ Hán -> gợi ý lại (kèm ghi chú), nhãn [biến] bị gỡ');
}

// ------------------------------------------------------------------ 4) placeholder
{
  eq(normalizePlaceholders('A [[1]] B', 1, 'x ⟦1⟧'), 'A ⟦1⟧ B', '[[1]] được hiểu là placeholder khi hợp lệ');
  eq(normalizePlaceholders('arr [[1]] ⟦1⟧', 1, 'k'), 'arr [[1]] ⟦1⟧', '[[1]] giữ nguyên khi ⟦1⟧ đã có');
  eq(normalizePlaceholders('A ⟦ 2 ⟧ 〚1〛', 2), 'A ⟦2⟧ ⟦1⟧', 'chuẩn hóa ⟦ 2 ⟧ và 〚1〛');
}

// ------------------------------------------------------------------ 5) regex mất ký tự
const raw5 = {
  spec: 'chara_card_v2', data: {
    name: '测试', first_mes: '<状态栏>\n姓名：小明\n好感度：50\n</状态栏>\n「你好」她说。\n<思考>内心独白</思考>\n【开场白】欢迎【/开场白】',
    character_book: { name: 'B', entries: [
      { id: 0, keys: [], enabled: true, comment: '[InitVar]', content: '角色:\n  好感度: 50\n  姓名: 小明\n' },
      { id: 1, keys: [], enabled: true, comment: '开局', content: '<div class="anon-btn" data-prompt="【开始】【开场白】 # 场景生成指令\n她无法想象当被问及"闪闪发光"的留学生活时。 【/开场白】">开始</div>' },
    ] },
    extensions: { regex_scripts: [
      { scriptName: '状态栏', findRegex: '/<状态栏>([\\s\\S]*?)<\\/状态栏>/g', replaceString: '<div class="sb"><span>当前状态：</span>$1<script>const t=`$1`; document.title="状态：$1";</script></div>', placement: [2], markdownOnly: true },
      { scriptName: '对话', findRegex: '/「([^」]+)」/g', replaceString: '<span class="say">「$1」</span>', placement: [2], markdownOnly: true },
      { scriptName: '好感', findRegex: '/好感度：(\\d+)/g', replaceString: '<b>好感度：$1</b>', placement: [2], markdownOnly: true },
      { scriptName: '命名组', findRegex: '/(?<名字>[^：\\n]+)：(?<内容>.+)/', replaceString: '<i>$<名字></i>：$<内容>', placement: [2], markdownOnly: true },
      { scriptName: '思考', findRegex: '/<思考>[\\s\\S]*?<\\/思考>/g', replaceString: '', placement: [2], markdownOnly: true },
      { scriptName: '开场', findRegex: '/【开场白】([\\s\\S]*?)【\\/开场白】/', replaceString: '$1', placement: [2] },
    ] },
  },
};
{
  const VI = { 状态栏: 'Thanh trạng thái', 好感度: 'Độ hảo cảm', 角色: 'Nhân vật', 姓名: 'Họ tên', 思考: 'Suy nghĩ', 开场白: 'Mở đầu', 小明: 'Tiểu Minh' };
  const card = makeCard(raw5);
  const items = listItems(card);
  const dict = mergeScan({}, scanCard(card, items).entries);
  eq(['名字', '内容'].map((k) => dict[k]?.kind ?? null), [null, null], 'tên nhóm (?<名字>) của regex không bị coi là nhãn');
  for (const [src, v] of Object.entries(dict)) v.dst = VI[src] || 'Từ' + src.length;
  const idx = makeDictIndex(dict, S);
  const ctx = { dict: idx, entryNames: new Set(['开局']), opts: { codeStrings: 'smart', chunkSize: 1800, comments: true } };
  // "AI" làm hỏng mọi thứ có thể: đổi 【】->[], 「」->"", đổi dấu toàn độ rộng sang ASCII, làm mất $1
  const ai = (key) => key.replace(HAN, (w) => VI[w] || 'chữ').replace(/【/g, '[').replace(/】/g, ']').replace(/：/g, ': ').replace(/，/g, ', ').replace(/。/g, '.').replace(/\$1/g, '');
  const outs = new Map(), segs = [];
  for (const it of items) {
    const a = analyzeItem(it, ctx);
    const tm = new Map();
    for (const s of a.segments) { tm.set(s.key, ai(s.key)); segs.push(s); }
    outs.set(it.id, a.render({ tm, dict: idx, entryName: (s) => s, keysMode: 'replace', widenRegex: true }));
  }
  const built = buildTranslatedCard(card, outs);
  const rx = built.data.extensions.regex_scripts;
  eq(rx.every((r) => !!regexFromString(r.findRegex)), true, 'mọi find regex sau dịch đều hợp lệ (tên nhóm có tên giữ nguyên)');
  const fm = built.data.first_mes;
  eq(rx.map((r) => regexFromString(r.findRegex).test(fm)), [true, true, true, true, true, true], 'mọi regex vẫn khớp lời chào sau dịch (nhãn, thẻ tên Trung, dấu câu, 「」)');
  ok(fm.includes('</Thanh trạng thái>') && fm.includes('【Mở đầu】') && fm.includes('【/Mở đầu】'), 'thẻ đóng </状态栏> và ngoặc 【】 của nhãn được giữ đúng', fm);
  const rep = rx[0].replaceString;
  eq((rep.match(/\$1/g) || []).length, 3, '$1 trong chuỗi JS / thuộc tính của replaceString không bị AI làm mất');
  eq(rx[3].replaceString.includes('$<名字>') && rx[3].replaceString.includes('$<内容>'), true, '$<tên nhóm> trong replace giữ nguyên, khớp tên nhóm trong regex');
  ok(rx[2].findRegex === '/Độ hảo cảm[：:]\\s*(\\d+)/g', 'dấu "：" trong regex được nới thành [：:]\\s* (nhóm bắt $1 không đổi)', rx[2].findRegex);
  const shown = displayText(rx, fm, { depth: 0, macro: { user: 'U' } });
  ok(shown.includes('<b>Độ hảo cảm: 50</b>') && shown.includes('<span class="say">「'), 'xem trước: regex sau dịch áp dụng đúng', shown);
  // thuộc tính có nháy lồng không escape
  const lb = String(outs.get(items.find((x) => x.label === 'Nội dung: 开局').id));
  ok(!HAN.test(lb.replace(/开局/g, '')), 'thuộc tính data-prompt có nháy lồng "…" được dịch hết, không sót đuôi', lb);
  ok(lb.includes('【/Mở đầu】') && lb.includes('"闪闪发光"'.replace(/[一-鿿]+/g, 'chữ')), 'nhãn đóng trong thuộc tính được đổi theo từ điển, nháy lồng giữ nguyên', lb);
  const tag = lexHtml(raw5.data.character_book.entries[1].content).find((t) => t.type === 'tag' && t.lower === 'div');
  eq(tag.attrs.map((a) => a.name), ['class', 'data-prompt'], 'lexer: thuộc tính có nháy lồng không bị vỡ thành thuộc tính rác');
  // validate: ký hiệu regex cần + thẻ tên Trung
  const guard = collectGuardChars(raw5.data.extensions.regex_scripts.map((r) => r.findRegex));
  ok(guard.includes('「') && guard.includes('」') && guard.includes('【') && !guard.includes('：'), 'ký hiệu regex cần: 「 」 【 】 (dấu "：" đã được nới nên không bắt buộc)', guard.join(' '));
  const v1 = validateSegment({ key: '「你好」她说', holes: [] }, '"Xin chào" cô ấy nói', new Set(), { guard });
  eq([v1.ok, v1.soft, /「/.test(v1.reason)], [false, true, true], 'bản dịch đổi 「」 thành "" bị báo lỗi để dịch lại');
  const v2 = validateSegment({ key: '<思考>内心</思考>', holes: [] }, '&lt;Suy nghĩ&gt;Nội tâm', new Set());
  eq([v2.ok, /thẻ/.test(v2.reason)], [false, true], 'bản dịch làm mất dấu < > của thẻ tên tiếng Trung bị báo lỗi');
  // thẻ giả tên Trung trong HTML không bị escape thành &lt;
  const html = analyzeItem({ kind: 'auto', text: '<div>说明</div>\n<正文>内容</正文>' }, { dict: makeDictIndex({}, S), entryNames: new Set(), opts: {} });
  const tm = new Map(html.segments.map((s) => [s.key, s.key.replace(/正文/g, 'Chính văn').replace(HAN, 'chữ')]));
  const out = html.render({ tm, dict: makeDictIndex({}, S) });
  ok(out.includes('<Chính văn>chữ</Chính văn>') && !out.includes('&lt;'), 'thẻ giả <正文> dịch thành <Chính văn>, không thành &lt;Chính văn>', out);
}

// ------------------------------------------------------------------ 6) biến trùng tên khác hoa/thường
{
  const dict = { 足: { kind: 'key', dst: 'Chân', parents: ['情事'] }, 腿: { kind: 'key', dst: 'chân', parents: ['情事'] }, 手: { kind: 'key', dst: 'Tay', parents: ['情事'] } };
  const c = findConflicts(dict, S);
  eq(c.map((x) => x.srcs.sort()), [['腿', '足']], '"Chân" và "chân" trong cùng object bị coi là trùng tên');
}

// ------------------------------------------------------------------ 7) EJS / JS cú pháp
{
  eq(ejsSyntaxError("<% if (a) { %>x<% } %>"), null, 'EJS hợp lệ');
  ok(ejsSyntaxError("<% if (a) { %>x"), 'EJS thiếu } bị phát hiện');
  ok(ejsSyntaxError("<%= 'a' %> <% b"), 'EJS thiếu %> bị phát hiện');
  eq(jsSyntaxError("import x from 'y';\nexport const S = z.object({ a: 1 });\nexport default S;", true), null, 'script module (import/export) kiểm được cú pháp');
  ok(jsSyntaxError("const a = 'x;"), 'JS lỗi chuỗi bị phát hiện');
}

// ------------------------------------------------------------------ 8) kiểm tra tổng thể + cập nhật card
function book(entries) { return { name: 'Sách', entries: entries.map((e, i) => ({ id: i, keys: [], enabled: true, ...e })) }; }
const baseCard = () => ({
  spec: 'chara_card_v2', data: {
    name: '佳人', first_mes: '你好，<user>。\n\n今天天气很好。\n\n【开场白】欢迎来到长安【/开场白】',
    description: '她是一个温柔的人。\n\n她喜欢读书。',
    character_book: book([
      { comment: '[InitVar]', content: '角色:\n  好感度: 50\n  心情: 开心\n' },
      { comment: '世界观', content: '这是一个架空的世界。\n\n这里有很多城市。\n\n长安是首都。' },
      { comment: '人物：小红', content: '小红是主角的朋友。' },
      { comment: '控制器', content: "<%_ const v = getvar('stat_data.角色.好感度'); _%>\n<% if (v > 60) { %>她很喜欢你。<% } else { %>她对你很冷淡。<% } %>\n<%- await getwi(null, '世界观') %>" },
    ]),
    extensions: { regex_scripts: [{ scriptName: '开场', findRegex: '/【开场白】([\\s\\S]*?)【\\/开场白】/', replaceString: '<div>$1</div>', placement: [2] }] },
  },
});
const VI8 = { 角色: 'Nhân vật', 好感度: 'Độ hảo cảm', 心情: 'Tâm trạng', 开心: 'Vui vẻ', 开场白: 'Mở đầu', 长安: 'Trường An' };
const fakeAI = (key) => key.replace(HAN, (w) => VI8[w] || 'chữ' + w.length);
function translateAllFake(p) {
  for (const [src, v] of Object.entries(p.data.dict)) if (!v.dst) v.dst = VI8[src] || 'Từ ' + src.length;
  p.analyze(S);
  for (const s of p.segmentsFor()) if (!p.tm.has(s.key)) p.tm.set(s.key, fakeAI(s.key));
  p.recheckWarnings(S);
}
{
  const p = new Project({ id: 'p1', name: 'T', fileName: 'a.json', format: 'json', card: baseCard() });
  p.rescan(S);
  translateAllFake(p);
  let rep = p.check(S);
  eq(rep.sections.filter((s) => s.level === 'error').map((s) => s.id), [], 'kiểm tra tổng thể: card dịch đúng không có lỗi');
  eq(rep.sections.find((s) => s.id === 'ejs').level, 'ok', 'EJS sau dịch biên dịch được');
  eq(rep.sections.find((s) => s.id === 'regex').level, 'ok', 'regex sau dịch vẫn khớp');
  // làm hỏng có chủ đích
  const ejsItem = p.items.find((it) => it.label === 'Nội dung: 控制器');
  p.setOverride(ejsItem.id, "<% if (v > 60) { %>Cô ấy thích bạn.<% } else { %>Lạnh nhạt.\n<%- await getwi(null, 'Thế giới quan sai') %>");
  const fmItem = p.items.find((it) => it.id === 'data.first_mes');
  p.setOverride(fmItem.id, 'Xin chào [biến], <user>.\n\n[Mở đầu]Chào mừng tới 长安[/Mở đầu]');
  p.data.dict['心情'].dst = 'Độ Hảo Cảm';
  rep = p.check(S);
  const lv = (id) => rep.sections.find((s) => s.id === id).level;
  eq([lv('ejs'), lv('leak'), lv('regex'), lv('dict'), lv('entries')], ['error', 'error', 'warn', 'error', 'error'], 'phát hiện: EJS hỏng, nhãn [biến] lọt, regex hết khớp, biến trùng tên (khác hoa/thường), getwi trỏ sai mục');
  ok(rep.han.items.some((r) => r.itemId === fmItem.id), 'phát hiện chữ Hán còn sót trong bản chỉnh tay');
}
{
  // ---- cập nhật card: giữ bản dịch, chỉ dịch phần mới
  const p = new Project({ id: 'p2', name: 'T', fileName: 'a.json', format: 'json', card: baseCard() });
  p.rescan(S);
  translateAllFake(p);
  const descId = 'data.description';
  p.setOverride(descId, 'Cô ấy dịu dàng (sửa tay).');
  p.data.excluded['data.character_book.entries.2.content'] = true; // không dịch "人物：小红"
  const before = new Map(p.tm);
  const v2 = baseCard();
  const es = v2.data.character_book.entries;
  es[1].content = '这是一个架空的世界。\n\n这里有很多城市和村庄。\n\n长安是首都。';   // sửa 1 đoạn văn
  es.splice(1, 0, { id: 9, keys: [], enabled: true, comment: '新事件', content: '一场大雨来了。' }); // chèn mục mới ở giữa
  es.splice(3, 1);                                                                                // xóa "人物：小红"
  v2.data.first_mes += '\n\n新的一天开始了。';
  v2.data.character_book.entries[0].content += '  体力: 100\n';                                  // thêm biến mới
  const { stats, undo } = p.updateCard(makeCard(v2, { fileName: 'b.json' }), S);
  eq([stats.items.added.length, stats.items.removed.length], [2, 2], 'nhận ra mục mới (新事件: tên + nội dung) và mục bị xóa (人物：小红: tên + nội dung)');
  ok(stats.items.changed.includes('Nội dung: 世界观'), 'nhận ra mục bị sửa dù vị trí trong lorebook đã đổi', JSON.stringify(stats.items.changed));
  eq(stats.segs.exact, stats.segs.total - 4, 'mọi đoạn không đổi được dùng lại nguyên bản dịch cũ');
  eq(p.data.dict['好感度'].dst, 'Độ hảo cảm', 'từ điển giữ bản dịch cũ');
  eq(p.data.overrides[descId], 'Cô ấy dịu dàng (sửa tay).', 'chỉnh tay của mục không đổi được giữ');
  // chỉ gửi AI phần thực sự mới: dòng/đoạn văn mới trong đoạn dài + mục mới hoàn toàn
  const todoSegs = p.segmentsFor().filter((s) => !p.tm.has(s.key));
  const plan = p.deltaPlan(todoSegs);
  eq(plan.send.map((s) => s.key).sort(), ['一场大雨来了。', '新事件', '新的一天开始了。', '这里有很多城市和村庄。'].sort(), 'chỉ gửi AI: mục mới + đoạn văn mới (không gửi lại cả lời chào / cả mục 世界观)');
  eq(stats.segs.parts, 2, 'thống kê cập nhật báo 2 khối dòng mới');
  for (const s of plan.send) p.tm.set(s.key, fakeAI(s.key));
  const r = p.reuseTranslations();
  eq([r.composed, p.segmentsFor().filter((s) => !p.tm.has(s.key)).length], [2, 0], 'ghép phần dịch mới với bản dịch cũ -> không còn đoạn nào chưa dịch');
  const fm = String(p.output('data.first_mes'));
  ok(fm.startsWith(fakeAI('你好，<user>。')) && fm.endsWith(fakeAI('新的一天开始了。')), 'lời chào sau ghép = bản dịch cũ + dòng mới', fm);
  translateAllFake(p);
  const rep = p.check(S);
  eq(rep.sections.filter((s) => s.level === 'error').map((s) => s.id), [], 'sau cập nhật + dịch phần mới: kiểm tra tổng thể không lỗi');
  undo();
  eq([p.items.length, p.cardName, [...p.tm.keys()].filter((k) => !before.has(k)).length], [listItems(makeCard(baseCard())).length, '佳人', 0], 'hoàn tác trả dự án về card cũ, bỏ bản dịch thêm sau cập nhật');
  eq(p.data.overrides[descId], 'Cô ấy dịu dàng (sửa tay).', 'hoàn tác giữ chỉnh tay');
}
{
  // ---- ghép mục cũ/mới khi lorebook bị sắp xếp lại
  const a = listItems(makeCard(baseCard()));
  const c2 = baseCard(); c2.data.character_book.entries.reverse();
  const m = matchItems(a, listItems(makeCard(c2)));
  eq([m.added.length, m.removed.length, m.changed.size], [0, 0, 0], 'lorebook đổi thứ tự: mọi mục đều ghép đúng, không coi là sửa');
}
{
  // ---- dự án dịch bằng bản 1.1: khóa đoạn có nhãn / $1 kiểu cũ -> chuyển sang khóa mới
  const seg = { key: '欢迎⟦1⟧来到⟦2⟧$x', holes: [{ type: 'marker', open: '【', src: '开场白', close: '】' }, { type: 'marker', open: '【/', src: '开场白', close: '】' }] };
  const lv = legacyVariants(seg);
  eq(lv.map((x) => x.key), ['欢迎【⟦1⟧】来到【/⟦2⟧】$x'], 'khóa kiểu cũ của nhãn: ngoặc nằm ngoài placeholder');
  eq(lv[0].convert('Chào 【⟦1⟧】 tới 【/⟦2⟧】$x'), 'Chào ⟦1⟧ tới ⟦2⟧$x', 'bản dịch cũ chuyển sang khóa mới (bỏ ngoặc quanh placeholder)');
  const seg2 = { key: "'⟦1⟧ 的状态'", holes: [{ type: 'raw', text: '$1' }] };
  eq(legacyVariants(seg2).map((x) => [x.key, x.convert("'$1 trạng thái'")]), [["'$1 的状态'", "'⟦1⟧ trạng thái'"]], '$1 viết thẳng trong chuỗi (bản cũ) -> placeholder');
  const mem = new ParaMemory();
  mem.learn('第一段⟦1⟧\n\n第二段\n第三行', 'Đoạn một⟦1⟧\n\nĐoạn hai\nDòng ba');
  eq(mem.compose('第二段\n第三行\n\n第一段⟦1⟧'), 'Đoạn hai\nDòng ba\n\nĐoạn một⟦1⟧', 'ghép bản dịch từ các đoạn văn đã dịch (đổi thứ tự)');
  eq(mem.compose('第二段\n新的一行'), null, 'không ghép khi còn dòng chưa từng dịch');
}

// ------------------------------------------------------------------ 9) InitVar: giá trị trần có biến ở giữa vẫn là YAML hợp lệ
{
  const dict = { 角色: { kind: 'key', dst: 'Nhân vật' }, 好感度: { kind: 'key', dst: 'Độ hảo cảm' } };
  const idx = makeDictIndex(dict, S);
  const a = analyzeItem({ kind: 'initvar', text: '规则: 当角色.好感度达到50时解锁\n' }, { dict: idx, entryNames: new Set(), opts: {} });
  const tm = new Map(a.segments.map((s) => [s.key, s.key.replace('当', 'Khi ').replace(/达到50时解锁/, ' đạt 50: mở khóa # 1')]));
  const out = a.render({ tm, dict: idx });
  let parsed = null; try { parsed = yaml.load(out); } catch { /* */ }
  ok(parsed && Object.values(parsed)[0].includes('Nhân vật.Độ hảo cảm đạt 50: mở khóa # 1'), 'giá trị YAML có ": " / " #" do bản dịch sinh ra được bọc nháy cả giá trị', out);
}

void vm;
console.log(fails ? fails + ' lỗi' : 'v1.2 OK');
process.exit(fails ? 1 : 0);
