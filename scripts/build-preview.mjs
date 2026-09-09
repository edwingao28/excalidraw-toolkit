import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// npm omits symlinked output directories; unlink one without changing its target.
rmSync('dist/preview', { recursive: true, force: true });
await build({ entryPoints: ['src/web/preview.jsx'], bundle: true, conditions: ['production'], minify: true, splitting: true, format: 'esm', outdir: 'dist/preview', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
const native = dirname(require.resolve('@excalidraw/excalidraw'));
mkdirSync('dist/preview/fonts', { recursive: true });
cpSync(join(native, 'fonts'), 'dist/preview/fonts', { recursive: true });
