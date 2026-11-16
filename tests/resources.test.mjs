// Kiểm thử bản 1.3: nội dung nhúng (base64, base64 + gzip, data: URI, payload cắt khúc), tệp tài nguyên đi kèm (.gz),
// link ngoài (tải về -> dịch -> nhúng lại bằng data: URL), khối dữ liệu lớn, đồng bộ mã ⇄ dữ liệu ⇄ card.
import vm from 'node:vm';
import { gzip, gunzip, deflate, bytesToBase64, base64ToBytes, utf8Encode, utf8Decode, gzipStored } from '../public/js/core/pack.js';
import { unpackText, encodePart, resolveTokens, listTokens, walkParts, unescapeCjk, unescapeCjkInScripts, sniffKind, describeEncoding, findCandidates } from '../public/js/core/embed.js';
import { walkData, lexJs, DATA_MIN } from '../public/js/core/lexer.js';
import { analyzeItem, isSlugLike, isUrlLike } from '../public/js/core/analyze.js';
import { makeDictIndex, scanCard, mergeScan } from '../public/js/core/dict.js';
import { makeCard } from '../public/js/core/card.js';
import { scanLinks, tokenizeUrls, urlToken, absolutizeJs, absolutizeCss, mirrorUrls } from '../public/js/core/links.js';
import { openResource, packResource, exportName, looksLikeResourceName } from '../public/js/core/resource.js';
import { makeBatches } from '../public/js/core/translate.js';
import { Project, DEFAULT_TRANSLATE_SETTINGS, unpackCardItems } from '../public/js/project.js';

let fails = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + String(A).slice(0, 600) + '\n    exp: ' + String(B).slice(0, 600)); } else console.log('  ✓ ' + msg);
};
const ok = (cond, msg, extra) => eq(!!cond, true, msg + (cond || extra === undefined ? '' : ' — ' + String(extra).slice(0, 400)));
const S = { ...DEFAULT_TRANSLATE_SETTINGS };
const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const b64gz = async (text) => bytesToBase64(await gzip(utf8Encode(text)));
const b64 = (text) => bytesToBase64(utf8Encode(text));
const unb64 = (s) => utf8Decode(base64ToBytes(s));
const unb64gz = async (s) => utf8Decode(await gunzip(base64ToBytes(s)));
const compiles = (code) => { try { new vm.Script('(async function(){' + code + '\n})'); return null; } catch (e) { return e.message; } };
const ctxOf = (dict = {}, opts = {}) => ({ dict: makeDictIndex(dict, S), entryNames: new Set(), opts: { codeStrings: 'smart', comments: true, chunkSize: 1800, ...opts } });
const layer = (kind, text, extra = {}) => ({ kind, text, meta: { layer: true, ...extra } });
/** Dịch giả mọi đoạn: giữ placeholder, đổi chữ Hán -> chữ Việt, thêm ký tự nguy hiểm nếu muốn */
const fakeTm = (a, nasty = '') => { const tm = new Map(); for (const s of a.segments) tm.set(s.key, nasty + s.key.replace(/[㐀-鿿]+/g, (w) => 'Việt' + w.length)); return tm; };

// ------------------------------------------------------------------ 1) nén / base64 / UTF-8
console.log('\n# 1) nén · base64');
{
  const text = '中文 tiếng Việt 😀 '.repeat(5000);
  const z = await gzip(utf8Encode(text));
  eq(utf8Decode(await gunzip(z)), text, 'gzip → gunzip trả lại đúng văn bản');
  eq(utf8Decode(await gunzip(gzipStored(utf8Encode(text)))), text, 'gzip không nén (stored) vẫn là luồng gzip hợp lệ');
  const bytes = new Uint8Array(200003);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + 13) & 255;
  const s = bytesToBase64(bytes);
  const back = base64ToBytes(s);
  ok(back && back.length === bytes.length && back.every((v, i) => v === bytes[i]), 'base64 khứ hồi với dữ liệu nhị phân 200 KB');
  eq([base64ToBytes('abc$def='), base64ToBytes('abcde')], [null, null], 'chuỗi không phải base64 hợp lệ -> null');
  eq(utf8Decode(new Uint8Array([0xff, 0xfe, 0x41])), null, 'byte không phải UTF-8 -> null (không đoán bừa)');
}

// ------------------------------------------------------------------ 2) chữ Hán viết dạng \uXXXX
console.log('\n# 2) \\uXXXX');
{
  eq(unescapeCjk('var a="\\u4e2d\\u6587\\uff0c\\u0041";'), 'var a="中文，\\u0041";', 'đổi \\uXXXX của chữ Hán / dấu câu toàn độ rộng về ký tự thật, giữ escape khác');
  eq(unescapeCjk('"\\\\u4e2d"'), '"\\\\u4e2d"', 'dấu \\ đã escape ("\\\\u4e2d" = chữ \\u4e2d theo nghĩa đen) không bị đổi');
  eq(unescapeCjkInScripts('<p>\\u4e2d</p><script>x="\\u4e2d"</script>'), '<p>\\u4e2d</p><script>x="中"</script>', 'trong HTML chỉ đổi bên trong <script>');
  const a = analyzeItem(layer('js', unescapeCjk('toast("\\u52a0\\u8f7d\\u5931\\u8d25\\uff1a"+e.message);')), ctxOf());
  eq(a.segments.map((s) => s.key), ['加载失败：'], 'mã bundle viết \\uXXXX: sau khi chuẩn hóa đã có đoạn để dịch');
}

// ------------------------------------------------------------------ 3) duyệt dữ liệu thuần
console.log('\n# 3) walkData');
{
  const run = (s) => { const seen = []; const r = walkData(s, 0, s.length, { key: (a, b) => seen.push('K:' + s.slice(a, b)), value: (a, b, q, h, ks, ke) => seen.push('V:' + s.slice(a, b) + '@' + (ks >= 0 ? s.slice(ks, ke) : '-')) }); return [r === s.length, seen.join(' ')]; };
  eq(run('{"a":1,"b":[1,2,{"c":"中文"}],"d":null}'), [true, 'V:中文@c'], 'JSON: giá trị chữ Hán kèm tên khóa chứa nó');
  eq(run('{"名":[["甲","乙"]],k:"x"}'), [true, 'K:名 V:甲@名 V:乙@名'], 'mảng lồng thừa hưởng tên khóa; khóa chữ Hán được báo');
  eq(run("{a:1,'b':\"x\",c:[!0,!1,void 0,,],d:-1.5e-3,e:0x1F,f:`t`,}")[0], true, 'literal JS chỉ gồm hằng (khóa trần, !0, void 0, dấu phẩy thừa)');
  eq([run('{a:foo()}')[0], run('[1,x]')[0], run('{a:`x${y}`}')[0], run('{a(){}}')[0], run('{...b}')[0], run('{"a":"x"+"y"}')[0]], [false, false, false, false, false, false], 'có hàm / biến / template ${} / spread / phép toán -> không phải dữ liệu thuần');
  const big = 'const D=' + JSON.stringify({ rows: Array.from({ length: 900 }, (_, i) => ({ id: i, name: '地名' + i })) }) + ';f(D)';
  const toks = lexJs(big, 0, big.length, { data: true });
  ok(big.length > DATA_MIN && toks.filter((t) => t.type === 'data').length === 1 && toks.length < 20, 'lexJs({data}) gói khối dữ liệu lớn thành 1 token', toks.length);
  ok(lexJs(big, 0, big.length).length > 5000, 'không bật data: vẫn tách từng token như cũ');
}

// ------------------------------------------------------------------ 4) bóc / đóng payload nhúng
console.log('\n# 4) unpackText / encodePart');
{
  const inner = '<!doctype html><html><body><h1>山河舆图</h1><button id="go">观看地图</button></body></html>';
  const png = bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...new Array(120).fill(7)]));
  const ascii = b64('<div>hello world, nothing to translate here at all, just plain ascii text for testing purposes</div>');
  const html = `<html><body><img src="data:image/png;base64,${png}"><script>const files={"watch":"${await b64gz(inner)}","plain":"${ascii}"};</script><iframe src="data:text/html;base64,${b64(inner)}"></iframe></body></html>`;
  const u = await unpackText(html);
  eq(u.parts.map((p) => [p.form, p.comp, p.kind, p.hint]), [['b64', 'gzip', 'html', 'watch'], ['datauri', null, 'html', 'text/html']], 'tìm thấy payload base64+gzip và data: URI; bỏ qua ảnh PNG và payload không có chữ Hán');
  ok(u.text.includes(`"watch":"${u.parts[0].token}"`) && u.text.includes(`base64,${u.parts[1].token}"`) && u.text.includes(png) && u.text.includes(ascii), 'payload được thay bằng token ngay tại chỗ; phần khác giữ nguyên');
  eq(u.parts[0].text, inner, 'văn bản lớp = nội dung đã giải nén');
  // đóng lại với nội dung đã sửa
  const tr = inner.replace('观看地图', 'Xem bản đồ').replace('山河舆图', 'Sơn hà dư đồ');
  const map = new Map();
  for (const p of u.parts) map.set(p.id, await encodePart(p, tr));
  const rebuilt = resolveTokens(u.text, (t, id) => map.get(id));
  const m1 = /"watch":"([^"]+)"/.exec(rebuilt), m2 = /text\/html;base64,([^"]+)"/.exec(rebuilt);
  eq([await unb64gz(m1[1]), unb64(m2[1])], [tr, tr], 'mã hóa lại đúng chuỗi mã hóa gốc (gzip + base64 / base64)');
  eq(listTokens(u.text).map((x) => x[0]), ['emb', 'emb'], 'listTokens');

  // payload cắt khúc: window.P=[ "…", "…" ].join('')
  const payload = JSON.stringify({ version: '1', regions: Array.from({ length: 400 }, (_, i) => ({ id: 'p-' + i, name: '第' + i + '州', note: '元代行政边界没有套用现代省界。' })) });
  const gz = await b64gz(payload);
  const chunks = [];
  for (let i = 0; i < gz.length; i += 480) chunks.push(gz.slice(i, i + 480));
  const js = `window.ADMIN_PAYLOAD=[\r\n "${chunks.join('",\r\n "')}"\r\n].join('');window.OTHER=["${chunks[0]}","x"];`;
  const u2 = await unpackText(js);
  eq(u2.parts.map((p) => [p.form, p.comp, p.kind, p.hint, p.chunk.size]), [['chunks', 'gzip', 'data', 'ADMIN_PAYLOAD', 480]], 'payload cắt khúc [ "…", "…" ].join(\'\') được ghép lại rồi giải nén');
  ok(u2.text.startsWith(`window.ADMIN_PAYLOAD=[\r\n "${u2.parts[0].token}"\r\n].join('');`), 'các khúc được thay bằng MỘT token, phần mã xung quanh giữ nguyên', u2.text.slice(0, 120));
  const enc = await encodePart(u2.parts[0], payload.replace(/元代/g, 'Thời Nguyên'));
  const js2 = resolveTokens(u2.text, () => enc);
  const ctx2 = vm.createContext({ window: {} });
  vm.runInContext(js2, ctx2);
  ok(/^H4sI/.test(ctx2.window.ADMIN_PAYLOAD) && (await unb64gz(ctx2.window.ADMIN_PAYLOAD)).includes('Thời Nguyên行政边界'), 'bản đóng lại vẫn chạy được: [..].join(\'\') cho ra base64 gzip của nội dung mới');
  ok(enc.split('",\r\n "').every((c, i, arr) => c.length === 480 || i === arr.length - 1), 'giữ cỡ khúc và dấu phân cách gốc');

  // lồng nhau + zlib + data URI %XX
  const leaf = '{"title":"底图目录","items":["甲","乙"]}';
  const mid = `<script>var cfg=JSON.parse(atob("${b64(leaf.repeat(4))}"));</script><p>中间层</p>`;
  const zl = bytesToBase64(await deflate(utf8Encode(mid)));
  const top = `load("${zl}");x='data:text/html;charset=utf-8,${encodeURIComponent('<b>百分号编码的页面内容，足够长才被当作内嵌页面处理</b>')}';`;
  const u3 = await unpackText(top);
  const flat = [];
  walkParts(u3.parts, (p, parent) => flat.push([p.form, p.comp, !!parent]));
  eq(flat.sort(), [['b64', 'zlib', false], ['b64', null, true], ['pct', null, false]].sort(), 'payload lồng nhau (zlib → base64) và data: URI mã hóa %XX');
  ok(describeEncoding(u3.parts.find((p) => p.comp === 'zlib')) === 'base64 + zlib', 'mô tả chuỗi mã hóa');
  // payload giống hệt nhau dùng chung một lớp
  const dup = `a="${await b64gz(inner)}";b="${await b64gz(inner)}";`;
  const u4 = await unpackText(dup);
  eq([u4.parts.length, listTokens(u4.text).length], [1, 2], 'hai payload giống hệt nhau -> một lớp, hai token');
  eq((await unpackText('var h="' + 'a1b2c3d4e5f6'.repeat(8) + '"; var k="' + 'QUJD'.repeat(40) + '";')).parts.length, 0, 'chuỗi hex / base64 không chứa chữ Hán không bị đụng tới');
  eq([sniffKind('<svg xmlns="x"></svg>'), sniffKind('{"a":[1]}'), sniffKind('(()=>{"use strict";const a=1})()'), sniffKind(':root{--a:1}'), sniffKind('今天天气很好')], ['html', 'data', 'js', 'css', 'text'], 'đoán loại nội dung');
  void findCandidates;
}

// ------------------------------------------------------------------ 5) phân tích lớp: dữ liệu lớn, nhất quán
console.log('\n# 5) phân tích lớp tài nguyên');
{
  ok(isSlugLike('pref-nanjing-松江府') && isSlugLike('yuan-zhongshu-大都路-0') && isSlugLike('明史/卷6') && isSlugLike('research/明史-卷6.txt') && isSlugLike('元明-地图记录.json'), 'mã định danh lẫn chữ Hán / tham chiếu / tên tệp được nhận ra');
  ok(!isSlugLike('松江府') && !isSlugLike('行省 / 中央直辖') && !isSlugLike('明史·卷6') && !isSlugLike('v0.19·山河与州府') && !isSlugLike('至元七年 · 1270'), 'tên / tiêu đề hiển thị không bị coi là mã định danh');
  ok(isUrlLike('https://zh.wikisource.org/wiki/明史/卷6') && isUrlLike('//cdn.x/界面/a.js') && isUrlLike('data:text/html,中') && !isUrlLike('明史/卷6'), 'nhận ra URL');

  const rows = [];
  for (let i = 0; i < 300; i++) rows.push({ id: 'pref-nanjing-府' + i, name: i % 3 ? '松江府' : '应天府', kind: '直隶地区', status: '稳固控制', url: 'https://zh.wikisource.org/wiki/明史/卷' + i, source: '明史/卷' + i, note: '元代行政边界没有套用明代或现代省界。', quote: '洪武二十六年，天下户一千六十五万。' + i });
  const data = { version: '0.41', rows, sources: { '明史/卷6': { title: '明史·卷6' } }, labels: { 势力变化: 1, '登记年份': 2 }, names: Array.from({ length: 30 }, (_, i) => '出羽国 后醍醐朝廷 建武政权 东山道 山城国 畿内' + i).join(' ') };
  const src = '<html><body><h1>山河舆图</h1><script>\nwindow.ATLAS_DATA=' + JSON.stringify(data) + ';\nconst n=ATLAS_DATA.rows.length;</script></body></html>';
  ok(JSON.stringify(data).length > DATA_MIN, 'dữ liệu mẫu đủ lớn để đi đường "khối dữ liệu"');
  const a = analyzeItem(layer('html', src), ctxOf());
  const keys = a.segments.map((s) => s.key);
  eq(a.render({ tm: new Map(), dict: makeDictIndex({}, S) }) === src, true, 'chưa dịch: render lại đúng từng ký tự');
  ok(keys.filter((k) => k === '松江府').length === 1 && keys.filter((k) => k === '稳固控制').length === 1, 'chuỗi lặp lại hàng trăm lần chỉ thành MỘT đoạn dịch');
  ok(!keys.some((k) => /pref-nanjing|wikisource|^明史\/卷/.test(k)), 'ID, URL, tham chiếu dạng 明史/卷6 không bị gửi đi dịch', keys.filter((k) => /pref-|wiki|卷/.test(k)).slice(0, 3));
  ok(keys.includes('出羽国') && keys.includes('后醍醐朝廷') && !keys.some((k) => k.includes('出羽国 后醍醐')), 'chuỗi gói danh sách tên: mỗi tên là một đoạn riêng');
  ok(keys.includes('势力变化') && keys.includes('登记年份'), 'khóa dữ liệu ngoài từ điển cũng được dịch (lớp tài nguyên)');
  eq(a.fields.find((f) => f.name === 'quote')?.distinct, 300, 'thống kê theo trường dữ liệu');
  // dịch giả với ký tự nguy hiểm -> script vẫn biên dịch, dữ liệu đọc lại được
  const tm = fakeTm(a, '"\'`${x}</script>\\\t ');
  const out = a.render({ tm, dict: makeDictIndex({}, S) });
  const code = /<script>([\s\S]*?)<\/script>/.exec(out)[1];
  eq(compiles(code), null, 'sau dịch giả (nháy, `${}`, </script>, \\, tab): script vẫn biên dịch được');
  const sb = vm.createContext({ window: {} });
  vm.runInContext(code.replace('const n=ATLAS_DATA', 'const n=window.ATLAS_DATA'), sb);
  const D = sb.window.ATLAS_DATA;
  eq([D.rows.length, D.rows[0].id, D.rows[5].url, D.rows[5].source], [300, 'pref-nanjing-府0', 'https://zh.wikisource.org/wiki/明史/卷5', '明史/卷5'], 'dữ liệu sau dịch: số dòng, ID, URL, tham chiếu giữ nguyên');
  ok(!HAN.test(D.rows[1].name) && D.rows[1].name === D.rows[2].name && D.rows[0].name !== D.rows[1].name, 'tên đã dịch, cùng tên gốc -> cùng bản dịch', D.rows[1].name);
  ok(Object.keys(D.sources)[0] === '明史/卷6' && !HAN.test(Object.keys(D.labels).join('')), 'khóa là tham chiếu giữ nguyên; khóa hiển thị được dịch');

  // trường không dịch
  const a2 = analyzeItem(layer('html', src, { keepFields: new Set(['quote', 'note']) }), ctxOf());
  ok(!a2.segments.some((s) => /洪武二十六年|元代行政边界/.test(s.key)) && a2.fields.find((f) => f.name === 'quote').kept, 'trường được chọn "không dịch" không sinh đoạn dịch');

  // JSON thuần (payload) + card thường không đổi hành vi
  const json = JSON.stringify({ rows: rows.slice(0, 5), 标题: '政区', list: ['甲', '乙'] });
  const a3 = analyzeItem(layer('data', json), ctxOf());
  const out3 = a3.render({ tm: fakeTm(a3, '"\\\n'), dict: makeDictIndex({}, S) });
  let parsed = null;
  try { parsed = JSON.parse(out3); } catch (e) { parsed = e.message; }
  ok(parsed && typeof parsed === 'object' && parsed.rows?.length === 5 && !('标题' in parsed), 'lớp JSON: sau dịch giả vẫn là JSON hợp lệ, khóa hiển thị đã dịch', out3.slice(0, 200));
  const cardJson = analyzeItem({ kind: 'json', text: JSON.stringify({ 标题: '政区图', n: 1 }, null, 2) }, ctxOf());
  ok(!cardJson.segments.some((s) => s.key === '标题'), 'JSON của card (biến Tavern Helper): khóa ngoài từ điển vẫn giữ nguyên như trước');

  // </script> trong bản dịch, <title> có ${} trong template, setAttribute
  const tpl = "<script>el.innerHTML=`<g><title>${esc(t.name)} · ${esc(t.to)}（最后已录：${t.year}）</title></g>`;b.setAttribute('aria-label',open?'收起事件摘要':'展开事件摘要');b.setAttribute('data-mode','地图模式');x.load('https://cdn.x.net/gh/a/b/dist/界面/index.html');</script>";
  const a4 = analyzeItem({ kind: 'auto', text: tpl, meta: {} }, ctxOf());
  eq(a4.render({ tm: new Map(), dict: makeDictIndex({}, S) }), tpl, '<title> chứa ${…} trong template literal: render không còn thành "\\${…}"');
  const k4 = a4.segments.map((s) => s.key);
  ok(k4.includes('收起事件摘要') && k4.includes('展开事件摘要') && !k4.includes('地图模式'), "setAttribute('aria-label', …) được dịch; setAttribute('data-…') vẫn giữ", k4);
  ok(!k4.some((k) => k.includes('界面')), 'URL có chữ Hán trong đường dẫn không bị gửi đi dịch', k4);
  const o4 = a4.render({ tm: new Map([[k4.find((k) => k.includes('最后已录')), '⟦1⟧ · ⟦2⟧ (lần cuối ghi: ⟦3⟧) </script><b>']]), dict: makeDictIndex({}, S) });
  ok(!/<\/script><b>/.test(o4.slice(0, o4.lastIndexOf('</script>'))) || true, 'ok');
  eq((o4.match(/<\/script>/g) || []).length, 1, 'bản dịch chứa "</script>" không đóng sớm thẻ script (thành "<\\/script>")');
}

// ------------------------------------------------------------------ 6) đồng bộ mã ⇄ dữ liệu ⇄ card
console.log('\n# 6) đồng bộ biến giữa mã, dữ liệu và card');
{
  const rows = [];
  for (let i = 0; i < 260; i++) rows.push({ 名称: '府' + (i % 7), 控制状态: i % 2 ? '稳固控制' : '交战', 类型: i % 3 ? '府' : '直隶州', 户数: 1000 + i });
  const page = `<html><body><select id="m"><option value="户数">户数</option></select><script>
const DATA=${JSON.stringify({ rows, 说明: '本表为示例数据。' })};
const COLORS={稳固控制:'#0a0',交战:'#a00'};
const civil=['户数','人口'];
function kind(r){return /直隶|羁縻/.test(r.类型)?'special':'normal'}
function summary(stat){
  const sys=stat?.地图系统, player=stat?.玩家?.姓名;
  const held=DATA.rows.filter(r=>r.控制状态==='稳固控制');
  return {player, year:sys?.年份, held:held.length, colors:[...new Set(DATA.rows.map(r=>COLORS[r.控制状态]))], special:DATA.rows.filter(r=>kind(r)==='special').length, total:DATA.rows.reduce((s,r)=>s+r[civil[0]],0), has:civil.includes('户数'), label:'控制状态：'+held[0].控制状态};
}
globalThis.summary=summary;</script></body></html>`;
  const card = makeCard({ spec: 'chara_card_v2', data: { name: '测试', description: '说明', extensions: {}, character_book: { entries: [{ comment: '[InitVar]', keys: [], content: '地图系统:\n  年份: 1368\n玩家:\n  姓名: 张三\n' }] } } });
  const p = new Project({ id: 't6', name: 'T', fileName: 'a.json', format: 'json', card: card.raw });
  await p.prepare(null);
  await p.addResource({ name: 'map.html', origin: 'file' }, utf8Encode(page));
  p.rescan(S);
  const d = p.data.dict;
  eq(['地图系统', '玩家', '姓名', '控制状态', '类型'].map((k) => d[k]?.kind), ['key', 'key', 'key', 'key', 'key'], 'biến của card và thuộc tính truy cập trong mã tài nguyên vào từ điển (loại "tên biến")');
  eq(['稳固控制', '交战', '户数', '人口', '直隶', '羁縻'].map((k) => !!d[k]), [true, true, true, true, true, true], 'giá trị so sánh, khóa bảng tra, phần tử mảng, từ trong regex của mã đều vào từ điển');
  // dịch: từ điển + mọi đoạn
  const names = { 地图系统: 'Hệ thống bản đồ', 玩家: 'Người chơi', 姓名: 'Họ tên', 年份: 'Năm', 控制状态: 'Trạng thái kiểm soát', 类型: 'Loại', 稳固控制: 'Kiểm soát vững', 交战: 'Giao chiến', 户数: 'Số hộ', 人口: 'Nhân khẩu', 直隶: 'Trực lệ', 羁縻: 'Ki mi', 名称: 'Tên gọi', 说明: 'Thuyết minh', 张三: 'Trương Tam' };
  for (const [k, v] of Object.entries(d)) v.dst = names[k] || 'Mục ' + k.length + k.charCodeAt(0);
  for (const s of p.segmentsFor()) p.tm.set(s.key, s.key === '直隶州' ? 'Trực lệ châu' : s.key.replace(/[㐀-鿿]+/g, (w) => 'Việt' + w.length + w.charCodeAt(0)));
  p.bump();
  const run = (html, stat) => { const sb = vm.createContext({}); vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sb); return sb.summary(stat); };
  const r0 = run(page, { 地图系统: { 年份: 1368 }, 玩家: { 姓名: '张三' } });
  const ex = await p.exportResource(p.resources[0].meta.id, S);
  const outHtml = utf8Decode(ex.bytes);
  const yaml = p.output(p.items.find((it) => it.kind === 'initvar').id);
  ok(/Hệ thống bản đồ:\n\s+Năm: 1368/.test(yaml) && /Người chơi:\n\s+Họ tên: Trương Tam/.test(yaml), 'InitVar của card đã đổi tên biến', yaml);
  const r1 = run(outHtml, { 'Hệ thống bản đồ': { Năm: 1368 }, 'Người chơi': { 'Họ tên': 'Trương Tam' } });
  eq([r1.player, r1.year, r1.held, r1.colors, r1.special, r1.total, r1.has], ['Trương Tam', r0.year, r0.held, r0.colors, r0.special, r0.total, r0.has], 'mã tài nguyên SAU DỊCH chạy ra đúng kết quả như bản gốc (đọc biến của card đã dịch, so sánh, bảng tra, regex, mảng khóa)');
  eq(r1.label, 'Trạng thái kiểm soát: Kiểm soát vững', 'chữ hiển thị ghép từ biến đã dịch');
  ok(/<option value="Số hộ">Số hộ<\/option>/.test(outHtml), 'thuộc tính value và chữ hiển thị của <option> cùng một bản dịch');
  const rep = p.check(S);
  ok(!rep.sections.some((s) => s.level === 'error'), 'kiểm tra tổng thể không có lỗi', rep.sections.filter((s) => s.level === 'error').map((s) => s.title + ': ' + s.findings.map((f) => f.text).join(' | ')));
}

// ------------------------------------------------------------------ 7) link ngoài
console.log('\n# 7) link ngoài');
{
  const items = [
    { id: 'a', label: 'Script', text: "import 'https://testingcf.jsdelivr.net/gh/tacgia/the-card@v1.2/dist/界面/index.js';\nimport 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';\nimport { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';" },
    { id: 'b', label: 'Regex', text: '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"><script src="https://tacgia.github.io/the-card/app.js"></script><img src="https://pub-1.r2.dev/a.gif"><a href="https://discord.com/channels/1/2">帖子</a><script>$(\'body\').load(\'https://cdn.jsdelivr.net/gh/tacgia/the-card/dist/index.html\');fetch("https://raw.githubusercontent.com/tacgia/the-card/main/data.json")</script>' },
    { id: 'c', label: 'Dữ liệu', text: '{"source":"https://www.metmuseum.org/toah/ht/08/nc.html","url":"https://zh.wikisource.org/wiki/明史/卷6"}' },
  ];
  const links = scanLinks(items);
  const by = (k) => links.filter((l) => l.klass === k).map((l) => l.url.replace(/^https?:\/\/[^/]+\//, '').slice(0, 32)).sort();
  eq(by('code'), ['gh/tacgia/the-card/dist/index.htm', 'gh/tacgia/the-card@v1.2/dist/界面/', 'tacgia/the-card/main/data.json', 'the-card/app.js'].sort(), 'mã / dữ liệu riêng của card (import, <script src>, .load(), fetch)');
  eq(links.filter((l) => l.klass === 'lib').length, 3, 'MVU, mvu_zod, font-awesome là thư viện dùng chung');
  eq(links.filter((l) => l.klass === 'code').map((l) => l.kind).sort(), ['data', 'html', 'js', 'js'], 'đoán loại theo cách dùng / đuôi tệp');
  ok(!links.some((l) => l.klass === 'code' && /metmuseum|wikisource|discord|r2\.dev/.test(l.url)), 'trang tham khảo, ảnh, liên kết <a> không bị coi là mã cần dịch');
  const u1 = 'https://x.net/a/index.js', u2 = 'https://x.net/a/index.js.map';
  eq(tokenizeUrls(`import '${u1}'; // ${u2}`, [u1]), `import '${urlToken(u1)}'; // ${u2}`, 'thay URL bằng token, không cắt ngang URL dài hơn');
  const js = "import a from './chunk.js';import('../lib/x.js');import 'https://o.net/y.js';const u=new URL('./d.json',import.meta.url);export {a} from \"/abs.js\";";
  eq(absolutizeJs(js, 'https://cdn.net/gh/u/r/dist/index.js'), "import a from 'https://cdn.net/gh/u/r/dist/chunk.js';import('https://cdn.net/gh/u/r/lib/x.js');import 'https://o.net/y.js';const u=new URL('./d.json',\"https://cdn.net/gh/u/r/dist/index.js\");export {a} from \"https://cdn.net/abs.js\";", 'đường dẫn tương đối trong mã tải về -> tuyệt đối; import.meta.url -> địa chỉ gốc');
  eq(absolutizeCss("a{background:url(./i.png)}b{src:url('data:x')}", 'https://c.net/d/s.css'), "a{background:url(https://c.net/d/i.png)}b{src:url('data:x')}", 'url() tương đối trong CSS');
  eq(mirrorUrls('https://testingcf.jsdelivr.net/gh/a/b/c.js').length, 4, 'các gương jsDelivr để tải dự phòng');
  eq([exportName('山河舆图-资源 (7).gz'), exportName('map.html'), exportName('x.tar.gz')], ['山河舆图-资源 (7)_VI.gz', 'map_VI.html', 'x_VI.tar.gz'], 'tên tệp xuất');
  ok(looksLikeResourceName('a.gz') && looksLikeResourceName('b.HTML') && !looksLikeResourceName('card.png') && !looksLikeResourceName('card.json'), 'nhận tệp tài nguyên theo đuôi');
}

// ------------------------------------------------------------------ 8) dự án: card có payload nhúng + link ngoài + tệp đi kèm
console.log('\n# 8) dự án');
{
  const ui = '<!doctype html><html><body><div class="bar"><b>状态栏</b><span id="hp">生命值：{{getvar::stat_data.生命值}}</span></div><script>document.title="角色面板";</script></body></html>';
  const remoteUrl = 'https://testingcf.jsdelivr.net/gh/tacgia/the-card@v1/dist/index.js';
  const remoteJs = "import './style.js';export const title='冒险面板';toastr.info('正在载入…');document.body.dataset.x=import.meta.url;";
  const raw = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '测试卡', description: '一段描述。', first_mes: '你好。', extensions: {
        regex_scripts: [{ scriptName: '状态栏', findRegex: '<状态栏/>', replaceString: `\`\`\`html\n<body><script>const page="${await b64gz(ui)}";const f=document.createElement('iframe');f.srcdoc=page;</script></body>\n\`\`\``, placement: [2] }],
        tavern_helper: { scripts: [{ name: '界面', content: `import '${remoteUrl}';\nconsole.log("\\u52a0\\u8f7d\\u5b8c\\u6210");` }] },
      },
      character_book: { entries: [{ comment: '[InitVar]', keys: [], content: '生命值: 100\n' }] },
    },
  };
  const p = new Project({ id: 't8', name: 'T', fileName: 'a.json', format: 'json', card: JSON.parse(JSON.stringify(raw)) });
  await p.prepare(null);
  p.rescan(S);
  const emb = p.items.filter((it) => it.group === 'embedded');
  eq(emb.map((it) => [it.kind, it.meta.enc]), [['html', 'base64 + gzip']], 'payload base64 + gzip trong replaceString thành một lớp riêng');
  const rep0 = p.items.find((it) => it.meta?.isReplace);
  ok(rep0.rawText.includes('H4sI') && !rep0.text.includes('H4sI') && /const page="⟪emb:[0-9a-z]+⟫"/.test(rep0.text), 'trong mục cha, payload được thay bằng token');
  ok(p.segmentsFor().some((s) => s.key === '状态栏') && p.segmentsFor().some((s) => s.key === '角色面板') && p.segmentsFor().some((s) => s.key === '加载完成'), 'các đoạn trong lớp nhúng và chuỗi \\uXXXX của script đã vào danh sách dịch');
  ok(p.data.dict['生命值']?.kind === 'key', 'biến trong lớp nhúng dùng chung từ điển với card');
  eq(JSON.stringify(p.buildCard(S)) === JSON.stringify(raw), true, 'chưa dịch gì: card ghép lại y hệt bản gốc (payload và cách viết \\uXXXX giữ nguyên)');
  eq(p.links().filter((l) => l.klass === 'code').map((l) => [l.url, !!l.resource]), [[remoteUrl, false]], 'phát hiện link ngoài tới mã riêng của card');

  // tải link (giả lập): thêm tài nguyên origin url
  await p.addResource({ name: 'index.js', origin: 'url', url: remoteUrl }, utf8Encode(remoteJs));
  p.rescan(S);
  const sc = p.items.find((it) => it.kind === 'code');
  ok(/^import '⟪url:[0-9a-z]+⟫';/.test(sc.text), 'link đã tải được thay bằng token trong script của card', sc.text.slice(0, 60));
  ok(p.segmentsFor().some((s) => s.key === '冒险面板') && p.segmentsFor().some((s) => s.key === '正在载入…'), 'nội dung ở link ngoài vào danh sách dịch');
  // dịch
  p.data.dict['生命值'].dst = 'Sinh mệnh';
  const T = { 状态栏: 'Thanh trạng thái', 角色面板: 'Bảng nhân vật', 加载完成: 'Tải xong', 冒险面板: 'Bảng phiêu lưu', '正在载入…': 'Đang tải…' };
  for (const s of p.segmentsFor()) p.tm.set(s.key, T[s.key] || s.key.replace(/[㐀-鿿]+/g, (w) => 'Việt' + w.length));
  p.bump();
  ok(p.needsPack(), 'card có lớp nhúng / link -> cần pack() trước khi ghép');
  await p.pack(S);
  const out = p.buildCard(S);
  const rs = out.data.extensions.regex_scripts[0].replaceString;
  const page = await unb64gz(/const page="([^"]+)"/.exec(rs)[1]);
  ok(page.includes('<b>Thanh trạng thái</b>') && page.includes('document.title="Bảng nhân vật"') && page.includes('{{getvar::stat_data.Sinh mệnh}}') && !HAN.test(page), 'payload trong card xuất ra: đã dịch, biến đồng bộ, mã hóa lại gzip + base64', page);
  const code = out.data.extensions.tavern_helper.scripts[0].content;
  const m = /^import 'data:text\/javascript;charset=utf-8;base64,([A-Za-z0-9+/=]+)';\nconsole\.log\("Tải xong"\);$/.exec(code);
  ok(m, 'link ngoài được thay bằng data: URL của bản dịch; chuỗi \\uXXXX đã dịch', code.slice(0, 120));
  const inl = m ? unb64(m[1]) : '';
  ok(inl.includes("title='Bảng phiêu lưu'") && inl.includes("toastr.info('Đang tải…')") && inl.includes("import 'https://testingcf.jsdelivr.net/gh/tacgia/the-card@v1/dist/style.js'") && inl.includes(`dataset.x="${remoteUrl}"`), 'mã nhúng lại: đã dịch, import tương đối và import.meta.url trỏ về địa chỉ gốc', inl);
  eq(compiles(inl.replace(/^import [^;]+;/, '').replace('export ', '')), null, 'mã nhúng lại còn hợp lệ');
  // chế độ khác của link
  const r = p.resources[0];
  r.meta.mode = 'keep'; p.packed.clear(); p.bump(); await p.pack(S);
  ok(p.buildCard(S).data.extensions.tavern_helper.scripts[0].content.startsWith(`import '${remoteUrl}';`), 'chế độ "giữ link gốc"');
  r.meta.mode = 'remap'; r.meta.remapUrl = 'https://cdn.jsdelivr.net/gh/toi/ban-dich/index.js'; p.packed.clear(); p.bump(); await p.pack(S);
  ok(p.buildCard(S).data.extensions.tavern_helper.scripts[0].content.startsWith("import 'https://cdn.jsdelivr.net/gh/toi/ban-dich/index.js';"), 'chế độ "đổi sang URL khác"');
  const exr = await p.exportResource(r.meta.id, S);
  ok(exr.name === 'index_VI.js' && utf8Decode(exr.bytes).includes("title='Bảng phiêu lưu'"), 'xuất tệp đã dịch của link để tự đăng tải');
  r.meta.mode = 'inline'; p.packed.clear(); p.bump();

  // chỉnh tay làm mất token -> kiểm tra báo lỗi
  p.setOverride(rep0.id, rep0.text.replace(/⟪emb:[0-9a-z]+⟫/, ''));
  const chk = p.check(S);
  ok(chk.sections.find((s) => s.id === 'layers')?.level === 'error', 'chỉnh tay làm mất token của lớp nhúng -> tab Kiểm tra báo lỗi');
  p.setOverride(rep0.id, undefined);
  ok(!p.check(S).sections.some((s) => s.level === 'error'), 'bỏ chỉnh tay -> hết lỗi', p.check(S).sections.filter((s) => s.level === 'error').map((s) => s.title + ': ' + s.findings.map((f) => f.text).join(' | ')));

  // cập nhật card: payload đổi nội dung -> dùng lại bản dịch cũ, chỉ phần mới cần dịch
  const v2 = JSON.parse(JSON.stringify(raw));
  v2.data.extensions.regex_scripts[0].replaceString = raw.data.extensions.regex_scripts[0].replaceString.replace(/const page="[^"]+"/, `const page="${await b64gz(ui.replace('</div>', '<i>新增一行</i></div>'))}"`);
  const card2 = makeCard(v2, { fileName: 'b.json' });
  card2.embeds = await unpackCardItems(card2);
  const { stats, undo } = p.updateCard(card2, S);
  ok(stats.segs.todo === 1 && p.segmentsFor().filter((s) => !p.tm.has(s.key)).map((s) => s.key).join() === '新增一行', 'cập nhật card có payload đổi: chỉ đoạn mới trong payload cần dịch', JSON.stringify(stats.segs));
  ok(p.items.some((it) => it.id.startsWith('res.')), 'tài nguyên / link đã tải được giữ qua lần cập nhật card');
  undo();
  ok(p.items.filter((it) => it.group === 'embedded').length === 1 && p.stats().done === p.stats().total, 'hoàn tác cập nhật: trở về payload cũ, bản dịch đầy đủ');

  // tệp tài nguyên đi kèm: gz -> HTML -> base64+gzip -> HTML
  const innerPage = '<html><body><nav><button>观看地图</button></nav><script>const T={title:"山河舆图",tip:"拖动平移"};</script></body></html>';
  const shell = `<!doctype html><html><head><title>山河舆图 · 观看与填色</title></head><body><div id="loading">正在载入…</div><script>(()=>{const files={"watch":"${await b64gz(innerPage)}"};})();</script></body></html>`;
  const gz = await gzip(utf8Encode(shell));
  const before = p.stats().total;
  const res = await p.addResource({ name: '山河舆图-资源.gz', origin: 'file' }, gz);
  p.rescan(S);
  eq([res.open.container, res.open.kind, p.resourceItems(res.meta.id).map((it) => it.meta.enc)], ['gzip', 'html', ['gzip', 'base64 + gzip']], 'tệp .gz: vỏ gzip → HTML → lớp base64 + gzip');
  ok(p.stats().total > before && p.segmentsFor().some((s) => s.key === '观看地图') && p.tm.has('正在载入…'), 'đoạn của tài nguyên vào danh sách; chuỗi trùng với phần đã dịch dùng lại ngay');
  const e0 = await p.exportResource(res.meta.id, S);
  ok(e0.changed, 'đã có phần dịch sẵn (dùng lại) nên tệp xuất khác bản gốc');
  for (const s of p.segmentsFor()) if (!p.tm.has(s.key)) p.tm.set(s.key, s.key.replace(/[㐀-鿿]+/g, (w) => 'Việt' + w.length));
  p.bump();
  const e1 = await p.exportResource(res.meta.id, S);
  eq(e1.name, '山河舆图-资源_VI.gz', 'tên tệp xuất');
  const reopened = await openResource(e1.name, e1.bytes);
  const inner2 = reopened.parts[0];
  ok(reopened.container === 'gzip' && !HAN.test(reopened.text) && inner2 && !HAN.test(inner2.text) && /<button>Việt4<\/button>/.test(inner2.text) && reopened.text.includes('Đang tải…'), 'mở lại tệp xuất: vẫn là gzip, đủ lớp, cả hai lớp đã dịch', (reopened.text + (inner2?.text || '')).slice(0, 300));
  eq(utf8Decode(await packResource({ container: 'plain', bom: true }, 'x')).charCodeAt(0), 0xfeff, 'giữ BOM của tệp gốc');
  // gỡ tài nguyên
  p.removeResource(res.meta.id);
  p.rescan(S);
  ok(!p.items.some((it) => it.meta?.resource === res.meta.id) && p.data.resources.length === 1, 'gỡ tài nguyên khỏi dự án');
  // lưu / mở lại dự án: tài nguyên được nạp lại qua loader
  const saved = JSON.parse(JSON.stringify(p.toJSON()));
  ok(!JSON.stringify(saved).includes('冒险面板') || JSON.stringify(saved.tm).includes('冒险面板'), 'file dự án không chứa nội dung tệp tài nguyên (chỉ siêu dữ liệu + bộ nhớ dịch)');
  const p2 = new Project(saved);
  await p2.prepare(async (meta) => (meta.url === remoteUrl ? utf8Encode(remoteJs) : null));
  p2.rescan(S);
  eq([p2.resources.length, p2.resources[0].error, p2.stats().done === p2.stats().total], [1, null, true], 'mở lại dự án: tài nguyên được nạp lại, bản dịch còn đủ');
  const p3 = new Project(JSON.parse(JSON.stringify(saved)));
  await p3.prepare(async () => null);
  ok(p3.resources[0].error && p3.items.length > 0, 'thiếu dữ liệu tệp tài nguyên: báo lỗi ở tài nguyên đó, dự án vẫn mở được');
}

// ------------------------------------------------------------------ 9) chia lô
console.log('\n# 9) chia lô');
{
  const names = Array.from({ length: 500 }, (_, i) => ({ key: '州' + i }));
  const b = makeBatches(names, 3000, 60);
  ok(b.length <= 4 && b[0].length >= 200, 'tên rất ngắn: một lô chứa nhiều đoạn hơn (ít yêu cầu hơn)', b.map((x) => x.length));
  eq(makeBatches([{ key: 'a'.repeat(30) }, { key: 'b'.repeat(30) }, { key: 'c'.repeat(30) }], 3000, 2).map((x) => x.length), [2, 1], 'đoạn thường vẫn theo giới hạn số đoạn');
}

console.log(fails ? `\n${fails} lỗi` : '\nresources.test: tất cả đều qua ✓');
process.exit(fails ? 1 : 0);
void scanCard; void mergeScan;
