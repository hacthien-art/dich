// Kiểm thử hồi quy cho bộ phân tích: mảnh HTML trong chuỗi JS, thẻ hỏng, đồng bộ biến
import vm from 'node:vm';
import { analyzeItem } from '../public/js/core/analyze.js';

let fails = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + A + '\n    exp: ' + B); } else console.log('  ✓ ' + msg);
};
const ctx = (dict = {}) => ({
  dict: { kindOf: (s) => dict[s]?.kind || null, markers: Object.keys(dict).filter((k) => dict[k].kind === 'marker') },
  entryNames: new Set(), opts: { codeStrings: 'smart', chunkSize: 1800 },
});
const env = (tm = {}, dict = {}) => ({ tm: new Map(Object.entries(tm)), dict: { lookup: (s) => dict[s]?.dst } });
const run = (text, tmFn, dict = {}, kind = 'auto') => {
  const a = analyzeItem({ kind, text, meta: {} }, ctx(dict));
  const tm = {};
  for (const s of a.segments) tm[s.key] = tmFn ? tmFn(s.key) : undefined;
  return { a, same: a.render(env({}, dict)), tr: a.render(env(tm, dict)) };
};
const compiles = (code) => { try { new vm.Script('(function(){' + code + '\n})'); return true; } catch { return false; } };
const scriptOf = (html) => html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

// 1) chuỗi JS chứa thẻ dở dang (thẻ kết thúc ở chuỗi sau)
const html1 = `<div>x</div><script>let h='<label>新名称<input id="n" value="'+E(v)+'"></label>';if(a==='更名')h+='<p title="'+t+'">提示文字</p>';</script>`;
const r1 = run(html1, (k) => k.replace(/新名称/, 'Tên mới').replace(/提示文字/, 'Chữ gợi ý'));
eq(r1.same === html1, true, 'thẻ dở dang trong chuỗi JS: render không dịch giữ nguyên 100%');
eq(r1.a.segments.map((s) => s.key), ['新名称', '提示文字'], 'chỉ lấy chữ, không lấy mã thẻ');
eq(compiles(scriptOf(r1.tr)), true, 'script vẫn hợp lệ sau dịch');
eq(r1.tr.includes(`'<label>Tên mới<input id="n" value="'`), true, 'thẻ <input> không bị escape thành &lt;input');

// 2) chuỗi bắt đầu giữa thẻ: '" title="x">chữ'
const html2 = `<script>s='<span class="a" data-x="'+k+'" title="说明">名字</span>';</script>`;
const r2 = run(html2, (k) => (k === '名字' ? 'Tên' : 'Giải thích'));
eq(r2.same === html2, true, 'đuôi thẻ trong chuỗi: giữ nguyên khi chưa dịch');
eq(compiles(scriptOf(r2.tr)), true, 'đuôi thẻ trong chuỗi: script hợp lệ sau dịch');

// 3) thẻ hỏng trong văn bản HTML
const html3 = '<div>你好 <span 世界</div><p>测试</p>';
const r3 = run(html3, (k) => 'Dịch ' + k.length);
eq(r3.same === html3, true, 'thẻ hỏng trong văn bản: không bị đổi thành &lt;');

// 4) đồng bộ biến trong mã: thuộc tính có dấu cách -> obj['…']
const dict = { 好感度: { kind: 'key', dst: 'Độ hảo cảm' }, 角色: { kind: 'key', dst: 'Nhân vật' } };
const code4 = "<script>const v=data.角色.好感度;const p='stat_data.'+n+'.好感度';const o={好感度:1};const {好感度:q}=o;</script>";
const r4 = run(code4, null, dict);
const s4 = scriptOf(r4.same);
eq(s4.includes("data['Nhân vật']['Độ hảo cảm']"), true, 'truy cập thuộc tính -> dạng ngoặc khi tên có dấu cách');
eq(s4.includes("'.Độ hảo cảm'"), true, 'chuỗi đường dẫn được đổi');
eq(compiles(s4), true, 'mã sau đổi tên biến vẫn hợp lệ');

// 5) chuỗi CSS/base64 1.26 MB trong script (nhúng font WOFF2 + có chữ Hán) không gây treo O(N^2)
{
  const b64 = 'A'.repeat(1261031);
  const bigCode = `const css = "@font-face{font-family:\\"TW Print Kesong\\";src:url(\\"data:font/woff2;base64,${b64}\\")}.paper{content:\\"号外\\"}" /* 开屏报纸 */;`;
  const t0 = Date.now();
  const r5 = run(bigCode, (k) => k.replace(/号外/, 'Số đặc biệt'), {}, 'code');
  const elapsed = Date.now() - t0;
  eq(elapsed < 500, true, `phân tích chuỗi base64 1.26 MB trong ${elapsed}ms (< 500ms, tuyến tính O(N))`);
  eq(r5.same === bigCode, true, 'render không dịch giữ nguyên 100% chuỗi 1.26 MB');
  eq(r5.a.segments.map((s) => s.key), ['号外'], 'chỉ trích xuất chữ trong content CSS, không cắt base64 thành đoạn dịch');
  eq(r5.tr.includes('content:\\"Số đặc biệt\\"') && r5.tr.includes(b64), true, 'dịch đúng chữ trong CSS và giữ nguyên khối base64');
}

console.log(fails ? fails + ' lỗi' : 'analyze OK');
process.exit(fails ? 1 : 0);
