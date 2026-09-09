// Packaging only: consumers receive dist/canvas and never fetch or build upstream.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceBytes = readFileSync(join(root, 'scripts/canvas-source.json'));
const source = JSON.parse(sourceBytes);
const lockBytes = readFileSync(join(root, 'scripts/canvas-lock.json'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lockSha256 = sha256(lockBytes);
const patchBytes = readFileSync(join(root, 'scripts/canvas-fonts.patch'));
const patchSha256 = sha256(patchBytes);
const buildScriptSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
const inputSha256 = sha256(Buffer.concat([sourceBytes, lockBytes, patchBytes, Buffer.from(buildScriptSha256)]));
const cache = join(root, '.cache/canvas');
const archive = join(cache, `source-${source.commit}.tar.gz`);
const workspace = join(cache, inputSha256);
const output = join(root, 'dist/canvas');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}

mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  const response = await fetch(source.archiveUrl, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Upstream download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== source.archiveSha256) throw new Error('Upstream archive SHA256 mismatch');
  writeFileSync(archive, bytes);
}
if (sha256(readFileSync(archive)) !== source.archiveSha256) throw new Error('Cached upstream archive SHA256 mismatch');

// The cache key includes every maintained source/lock input. Failed installs do
// not write the receipt, so the next invocation retries npm ci in the same cache.
const receipt = join(workspace, '.canvas-install-complete');
if (!existsSync(receipt)) {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', workspace], root);
  const packagePath = join(workspace, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.overrides = source.overrides;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(workspace, 'package-lock.json'), lockBytes);
  run('git', ['apply', '--check', join(root, 'scripts/canvas-fonts.patch')], workspace);
  run('git', ['apply', join(root, 'scripts/canvas-fonts.patch')], workspace);
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], workspace);
  writeFileSync(receipt, inputSha256);
}
run('npm', ['run', 'build:frontend', '--', '--base', '/'], workspace);
const frontend = join(workspace, 'dist/frontend');
if (!existsSync(join(frontend, 'index.html'))) throw new Error('Upstream build did not produce index.html');

rmSync(output, { recursive: true, force: true });
cpSync(frontend, output, { recursive: true });
cpSync(join(workspace, 'LICENSE'), join(output, 'UPSTREAM-LICENSE'));
const files = {};
for (const path of readdirSync(output, { recursive: true }).sort()) {
  const absolute = join(output, path);
  if (statSync(absolute).isFile()) files[path.replaceAll('\\', '/')] = sha256(readFileSync(absolute));
}
const lock = JSON.parse(lockBytes);
const versions = {};
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (/(?:^|\/)node_modules\/(?:@excalidraw\/(?:excalidraw|mermaid-to-excalidraw)|mermaid|dompurify|nanoid|lodash-es|qs|uuid|vite)$/.test(path)) {
    versions[path] = pkg.version;
  }
}
const manifest = {
  schemaVersion: 1,
  upstream: source,
  basePath: '/',
  lockSha256,
  patches: { 'canvas-fonts.patch': patchSha256 },
  buildScriptSha256,
  inputSha256,
  build: { node: process.version, vite: lock.packages['node_modules/vite'].version },
  versions,
  files,
  assetsSha256: sha256(JSON.stringify(files)),
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Canvas: ${Object.keys(files).length} files; assets SHA256 ${manifest.assetsSha256}`);
