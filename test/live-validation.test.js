import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { sha256 } from '../src/scene.js';

const exec = promisify(execFile);
const sample = new URL('../examples/live-validation/', import.meta.url).pathname;

// Answers like `claude -p --json-schema`: the accepted diagram with one change.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), input = args[args.indexOf('--add-dir') + 1];
const scene = JSON.parse(fs.readFileSync(path.join(input, 'baseline-generated.excalidraw'), 'utf8'));
scene.elements.find(element => element.id === 'worker').backgroundColor = '#b2f2bb';
const { evidence } = JSON.parse(fs.readFileSync(path.join(input, 'baseline-evidence.json'), 'utf8'));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: {
  generatedScene: scene, removedSemanticIds: [], summary: 'fixture',
  evidence: { schemaVersion: 1, scope: pick(evidence.scope, ['question', 'paths', 'coverage', 'unknowns']),
    references: evidence.references.map(item => pick(item, ['id', 'path', 'startLine', 'endLine', 'symbol'])), nodes: evidence.nodes, relations: evidence.relations } } }));
`;

test('the live-validation sample runs end to end with the adapter and stages a publication request', { timeout: 240000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'toolkit-live-validation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository'), copy = join(repository, 'examples/live-validation');
  await fs.mkdir(copy, { recursive: true });
  for (const name of ['src', 'request-flow.excalidraw', 'evidence.json', 'change.mjs']) await fs.cp(join(sample, name), join(copy, name), { recursive: true });
  const git = async (...args) => (await exec('git', ['-C', repository, ...args])).stdout.trim();
  const commit = async message => {
    await git('add', '.');
    await git('-c', 'user.name=Sandbox', '-c', 'user.email=sandbox@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q', '-b', 'main');
  const base = await commit('test: sample base');
  await git('switch', '-q', '-c', 'live-validation');
  await exec(process.execPath, [join(copy, 'change.mjs')]);
  assert.match(await fs.readFile(join(copy, 'src/api.js'), 'utf8'), /enqueue/);
  const source = await commit('test: sandbox change');
  const claude = join(root, 'fake-claude');
  await fs.writeFile(claude, FAKE, { mode: 0o755 });

  const state = join(root, 'state');
  const run = await exec(process.execPath, [join(sample, 'run.mjs'), '--base', base, '--source', source, '--state', state, '--claude', claude],
    { cwd: repository, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' }, timeout: 200000 });
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 'completed', run.stdout);
  assert.equal(result.sourceRevision, source);

  const out = join(root, 'publication.json');
  await exec(process.execPath, [join(sample, 'publish.mjs'), '--state', state, '--repository', 'owner/repo', '--pr', '42', '--tag', 'diagram-artifacts',
    '--assets', join(root, 'assets'), '--publication-state', join(root, 'publication-state'), '--out', out]);
  const request = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(request.publication.forkPolicy, 'deny');
  assert.equal(request.publication.pullNumber, 42);
  assert.equal(request.context.sourceRevision, source);
  for (const link of Object.values(request.publication.artifacts)) {
    const file = decodeURIComponent(link.url.split('/').at(-1));
    assert.equal(sha256(await fs.readFile(join(root, 'assets', file))), link.sha256);
  }
  const candidate = JSON.parse(await fs.readFile(join(root, 'assets', decodeURIComponent(request.publication.artifacts.native.url.split('/').at(-1))), 'utf8'));
  assert.equal(candidate.elements.find(element => element.id === 'worker').backgroundColor, '#b2f2bb');
});
