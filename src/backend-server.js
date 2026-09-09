import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../dist/runtime', import.meta.url));
const canvas = fileURLToPath(new URL('../dist/canvas', import.meta.url));

export function packagedBackendEntry(kind) {
  if (!['mcp', 'server'].includes(kind)) throw new Error('BACKEND_ENTRY: unknown entry kind');
  const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.upstream?.name !== 'mcp-excalidraw-server' || manifest.upstream.version !== '2.0.0' ||
    manifest.upstream.distSha256 !== 'c04eec947302a1d32a9485aa2cf7132f58a5bd223bd91febe17b59aff8c136eb') throw new Error('BACKEND_VERSION: packaged runtime identity differs from pinned backend 2.0.0');
  const name = kind === 'mcp' ? 'bin.mjs' : 'server.mjs';
  if (manifest.entries?.[kind] !== name) throw new Error('BACKEND_ENTRY: invalid manifest entry');
  const path = join(runtime, name);
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== manifest.files?.[name]) throw new Error('BACKEND_INTEGRITY: packaged runtime entry was modified');
  return path;
}

// Retain the helper signature for the canvas wrapper. No code is generated in
// the user's home, and no build-time dependency is resolved at runtime.
export function prepareBackendServer(_home) {
  if (!existsSync(join(canvas, 'index.html'))) throw new Error('CANVAS_ASSETS: missing packaged frontend; reinstall the toolkit');
  if (!existsSync(join(runtime, 'fonts'))) throw new Error('CANVAS_FONTS: missing packaged fonts; reinstall the toolkit');
  return packagedBackendEntry('server');
}
