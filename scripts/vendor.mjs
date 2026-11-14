// Sao chép / đóng gói thư viện bên thứ ba vào public/vendor để app chạy offline, không cần npm install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

const copies = [
  ['node_modules/js-yaml/dist/js-yaml.mjs', 'js-yaml.mjs'],
  ['node_modules/showdown/dist/showdown.min.js', 'showdown.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
  ['node_modules/jquery/dist/jquery.min.js', 'jquery.min.js'],
  ['node_modules/lodash/lodash.min.js', 'lodash.min.js'],
];
for (const [src, dst] of copies) {
  fs.copyFileSync(path.join(root, src), path.join(out, dst));
  console.log('copied', dst);
}

// js-yaml dạng IIFE (window.jsyaml) để dùng trong iframe xem trước
await build({
  stdin: { contents: "import { load, dump } from 'js-yaml'; window.YAML = { parse: (s) => load(s), stringify: (o) => dump(o), load, dump };", resolveDir: root },
  bundle: true, format: 'iife', minify: true, outfile: path.join(out, 'yaml.iife.js'), logLevel: 'warning',
});
console.log('built yaml.iife.js');

// zod v4 dạng IIFE (window.z) — schema MVU Zod dùng biến toàn cục z
await build({
  stdin: { contents: "import { z } from 'zod'; window.z = z;", resolveDir: root },
  bundle: true, format: 'iife', minify: true, outfile: path.join(out, 'zod.iife.js'), logLevel: 'warning',
});
console.log('built zod.iife.js');
