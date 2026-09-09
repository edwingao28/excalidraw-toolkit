import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareBackendServer, packagedBackendEntry } from '../src/backend-server.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'toolkit-bundled-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('packaged entries retain upstream identity, complete source hashes and license notices', t => {
  const home = join(fixture(t), 'unused-home');
  const target = prepareBackendServer(home);
  assert.equal(target, join(root, 'dist/runtime/server.mjs'));
  assert.equal(packagedBackendEntry('mcp'), join(root, 'dist/runtime/bin.mjs'));
  assert.equal(existsSync(home), false);
  const manifest = JSON.parse(readFileSync(join(root, 'dist/runtime/manifest.json'), 'utf8'));
  assert.equal(manifest.upstream.version, '2.0.0');
  assert.equal(Object.keys(manifest.upstream.sourceFiles).length, 203);
  assert.equal(digest(JSON.stringify(manifest.upstream.sourceFiles)), manifest.upstream.distSha256);
  assert.ok(manifest.packages.some(pkg => pkg.name === 'express'));
  assert.ok(manifest.packages.some(pkg => pkg.name === '@modelcontextprotocol/server'));
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(digest(readFileSync(join(root, 'dist/runtime', name))), hash, name);
  assert.match(readFileSync(join(root, 'dist/runtime/THIRD_PARTY_NOTICES.txt'), 'utf8'), /cookie-signature@1\.0\.7/);
});

test('server imports after relocation without upstream dependencies and rejects changed entries', async t => {
  const directory = fixture(t);
  mkdirSync(join(directory, 'src'));
  mkdirSync(join(directory, 'dist/canvas'), { recursive: true });
  writeFileSync(join(directory, 'dist/canvas/index.html'), '<html>isolated canvas fixture</html>');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  cpSync(join(root, 'src/backend-server.js'), join(directory, 'src/backend-server.js'));
  cpSync(join(root, 'dist/runtime'), join(directory, 'dist/runtime'), { recursive: true, dereference: true });
  const imported = await import(pathToFileURL(join(directory, 'src/backend-server.js')).href);
  const target = imported.prepareBackendServer(join(directory, 'home'));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const server=await import(${JSON.stringify(pathToFileURL(target).href)});console.log(JSON.stringify({app:typeof server.default,start:typeof server.startServer}));`], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, LOG_FILE_PATH: join(directory, 'backend.log') }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(output), { app: 'function', start: 'function' });
  assert.equal(existsSync(join(directory, 'node_modules')), false);
  writeFileSync(target, readFileSync(target, 'utf8') + '\n// changed');
  assert.throws(() => imported.prepareBackendServer(directory), /BACKEND_INTEGRITY/);
  const manifestPath = join(directory, 'dist/runtime/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.upstream.version = 'unexpected';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => imported.packagedBackendEntry('mcp'), /BACKEND_VERSION/);
});
