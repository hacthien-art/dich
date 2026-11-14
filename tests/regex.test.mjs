// Kiểm thử engine regex kiểu ST
import { runRegexScript, regexFromString, displayText } from '../public/js/core/stregex.js';

let fails = 0;
const eq = (a, b, msg) => { if (a !== b) { fails++; console.log('  ✗ ' + msg + '\n    got: ' + JSON.stringify(a) + '\n    exp: ' + JSON.stringify(b)); } else console.log('  ✓ ' + msg); };

const s1 = { findRegex: String.raw`/<xuan>([\s\S]*?)<\/xuan>/`, replaceString: '[[$1]] {{match}} {{user}}', trimStrings: ['A'], placement: [2], markdownOnly: true };
eq(String(regexFromString(s1.findRegex)), String.raw`/<xuan>([\s\S]*?)<\/xuan>/`, 'regexFromString dạng /.../');
eq(runRegexScript(s1, 'x<xuan>ABC</xuan>y', { user: 'U' }), 'x[[BC]] <xuan>BC</xuan> Uy', '$1 + trimStrings (áp cả cho {{match}} như ST) + macro');
const s2 = { findRegex: String.raw`<UpdateVariable>[\s\S]*?</UpdateVariable>`, replaceString: '', placement: [2], promptOnly: true };
const s3 = { findRegex: 'foo', replaceString: 'bar', placement: [2] };
const s4 = { findRegex: 'q', replaceString: 'Q', placement: [2], markdownOnly: true, maxDepth: 0 };
eq(displayText([s1, s2, s3], 'foo <xuan>q</xuan><UpdateVariable>x</UpdateVariable>', { depth: 0, macro: { user: 'U' } }), 'bar [[q]] <xuan>q</xuan> U<UpdateVariable>x</UpdateVariable>', 'markdownOnly áp dụng khi hiển thị, promptOnly thì không');
eq(displayText([s4], 'q', { depth: 1, macro: {} }), 'q', 'maxDepth loại tin nhắn sâu hơn');
eq(displayText([s4], 'q', { depth: 0, macro: {} }), 'Q', 'maxDepth cho phép tin mới nhất');
const s5 = { findRegex: String.raw`/(?<n>\d+)/g`, replaceString: '<$<n>>', placement: [2] };
eq(displayText([s5], 'a1b22', { depth: 0 }), 'a<1>b<22>', 'nhóm có tên $<n> + cờ g');
console.log(fails ? fails + ' lỗi' : 'regex OK');
process.exit(fails ? 1 : 0);
