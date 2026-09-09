import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { workflowCommand } from '../src/workflow-commands.js';

const exec = promisify(execFile);
export async function workflowFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'toolkit-workflow-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, 'source');
  await fs.mkdir(repositoryPath);
  const git = async (...args) => (await exec('git', ['-C', repositoryPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await fs.writeFile(join(repositoryPath, 'api.js'), 'export function handle() { return 1; }\n');
  await git('add', '.');
  await git('-c', 'user.name=Workflow fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: add workflow fixture');
  const revision = await git('rev-parse', 'HEAD');
  const scene = { type: 'excalidraw', version: 2, source: 'fixture', elements: [
    { id: 'api', type: 'rectangle', x: 0, y: 0, width: 120, height: 80, boundElements: [] },
  ], files: {}, appState: {}, unknownMetadata: { keep: true } };
  const bytes = `${JSON.stringify(scene, null, 4)}\n\n`;
  await fs.writeFile(join(root, 'input.excalidraw'), bytes);
  const evidence = { schemaVersion: 1, source: { kind: 'git', revision },
    scope: { question: 'Where is handle?', paths: ['api.js'], coverage: 'partial', unknowns: ['No runtime trace.'] },
    references: [{ id: 'handle', path: 'api.js', startLine: 1, endLine: 1, symbol: 'handle' }],
    nodes: [{ semanticId: 'request:handler', elementId: 'api', referenceIds: ['handle'] }], relations: [] };
  const request = { repositoryPath: 'source', inputPath: 'input.excalidraw', evidence };
  const requestPath = join(root, 'request.json');
  const save = async value => fs.writeFile(requestPath, JSON.stringify(value));
  await save(request);
  return { root, repositoryPath, revision, scene, bytes, evidence, request, requestPath, save, git };
}

test('request-file boundary dispatches validation, association and explicit baseline acceptance', async t => {
  const f = await workflowFixture(t);
  const validated = await workflowCommand('validate-evidence', f.requestPath);
  assert.equal(validated.source.revision, f.revision);
  assert.equal(validated.repositoryPath, f.repositoryPath);
  assert.equal(validated.validation.semanticClaims, false);
  await f.save({ ...f.request, outputDir: 'associated' });
  const associated = await workflowCommand('associate-evidence', f.requestPath);
  assert.equal(associated.bundlePath, join(f.root, 'associated/evidence.json'));
  assert.equal(await fs.readFile(join(f.root, 'associated/delivered.excalidraw'), 'utf8'), f.bytes);
  assert.equal(associated.bundle.baseline.kind, 'association');
  await f.save({ ...f.request, generatedPath: 'input.excalidraw' });
  const accepted = await workflowCommand('accept-baseline', f.requestPath, { output: join(f.root, 'accepted') });
  assert.equal(accepted.bundle.baseline.kind, 'accepted-generated');
  assert.equal(await fs.readFile(join(f.root, 'input.excalidraw'), 'utf8'), f.bytes);
});

test('request validation fails clearly for malformed JSON, unsupported fields and conflicting CLI output', async t => {
  const f = await workflowFixture(t);
  await assert.rejects(workflowCommand('unknown-command', f.requestPath), { code: 'UNKNOWN_COMMAND' });
  await fs.writeFile(f.requestPath, '{');
  await assert.rejects(workflowCommand('validate-evidence', f.requestPath), { code: 'INVALID_REQUEST' });
  await f.save({ ...f.request, generatedPath: 'input.excalidraw' });
  await assert.rejects(workflowCommand('associate-evidence', f.requestPath), { code: 'INVALID_REQUEST' });
  await f.save({ ...f.request, outputDir: 'one' });
  await assert.rejects(workflowCommand('associate-evidence', f.requestPath, { output: join(f.root, 'two') }), { code: 'INVALID_REQUEST' });
  await assert.rejects(fs.stat(join(f.root, 'one')), { code: 'ENOENT' });
});

test('installed CLI routes request files and emits source evidence as JSON', async t => {
  const f = await workflowFixture(t);
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const checked = JSON.parse((await exec(process.execPath, [cli, 'validate-evidence', '--request', f.requestPath, '--json'], { cwd: tmpdir() })).stdout);
  assert.equal(checked.source.revision, f.revision);
  assert.equal(checked.validation.semanticClaims, false);
  await f.save({ ...f.request, outputDir: 'cli-evidence' });
  const associated = JSON.parse((await exec(process.execPath, [cli, 'associate-evidence', '--request', f.requestPath])).stdout);
  assert.equal(associated.bundle.baseline.kind, 'association');
  assert.equal(await fs.readFile(join(f.root, 'cli-evidence/delivered.excalidraw'), 'utf8'), f.bytes);
});
