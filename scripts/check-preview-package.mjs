// Inspect npm's actual file selection without rerunning prepack or creating a tarball.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const output = 'dist/preview';
if (!lstatSync(output).isDirectory()) throw new Error('PACKED_PREVIEW: output must be a real directory');
const expected = readdirSync(output, { recursive: true }).filter(path => {
  const stat = lstatSync(join(output, path));
  if (stat.isSymbolicLink()) throw new Error(`PACKED_PREVIEW: symlinked asset ${path}`);
  return stat.isFile();
}).map(path => `${output}/${path.replaceAll('\\', '/')}`);
for (const file of ['preview.js', 'preview.css', 'fonts/Virgil/Virgil-Regular.woff2']) {
  if (!expected.includes(`${output}/${file}`)) throw new Error(`PACKED_PREVIEW: missing built asset ${file}`);
}
const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024,
}));
// npm 11 returns an array; npm 12 keys entries by package identity.
const packages = Array.isArray(result) ? result : Object.values(result);
const files = new Set(packages.flatMap(pkg => (pkg.files ?? []).map(file => file.path)));
const missing = expected.filter(path => !files.has(path));
if (missing.length) throw new Error(`PACKED_PREVIEW: npm omitted ${missing.length} preview files, including ${missing.slice(0, 3).join(', ')}`);
console.log(`Packed preview selection: ${expected.length} built files included`);
