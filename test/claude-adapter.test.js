import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runDiagramJob } from '../src/ci.js';
import { acceptEvidenceBaseline } from '../src/evidence.js';

const exec = promisify(execFile);
const adapter = new URL('../examples/ci/claude-code-adapter.mjs', import.meta.url).pathname;

// Stands in for the claude CLI: records what it was given, then answers like
// `claude -p --output-format json --json-schema` from the staged inputs.
const fake = mode => `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const input = args[args.indexOf('--add-dir') + 1];
fs.writeFileSync(path.join(input, '..', 'fake-log.json'), JSON.stringify({ args, cwd: process.cwd(), env: process.env, homeExists: fs.existsSync(process.env.HOME) }));
const mode = ${JSON.stringify(mode)};
if (mode === 'error') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true })); process.exit(1); }
const scene = JSON.parse(fs.readFileSync(path.join(input, 'baseline-generated.excalidraw'), 'utf8'));
scene.elements[0].backgroundColor = '#d0ebff';
const { evidence } = JSON.parse(fs.readFileSync(path.join(input, 'baseline-evidence.json'), 'utf8'));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, structured_output: {
  generatedScene: scene, removedSemanticIds: [], summary: 'Recolored the API node.',
  evidence: { schemaVersion: 1, scope: pick(evidence.scope, ['question', 'paths', 'coverage', 'unknowns']),
    references: evidence.references.map(item => pick(item, ['id', 'path', 'startLine', 'endLine', 'symbol'])),
    nodes: evidence.nodes, relations: evidence.relations } } }));
`;

async function fixture(t, mode) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'toolkit-claude-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claude = join(root, 'fake-claude');
  await fs.writeFile(claude, fake(mode), { mode: 0o755 });
  const repositoryPath = join(root, 'repository'), stateDir = join(root, 'state');
  await fs.mkdir(join(repositoryPath, 'src'), { recursive: true });
  const git = async (...args) => (await exec('git', ['-C', repositoryPath, ...args])).stdout.trim();
  const commit = async () => {
    await git('add', '.');
    await git('-c', 'user.name=Adapter fixture', '-c', 'user.email=adapter@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'test: adapter fixture');
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q', '-b', 'main');
  const scene = JSON.parse(await fs.readFile(new URL('./fixtures/annotated.excalidraw', import.meta.url), 'utf8'));
  await fs.writeFile(join(repositoryPath, 'flow.excalidraw'), JSON.stringify(scene));
  await fs.writeFile(join(repositoryPath, 'src/api.js'), 'export function handle() { return 1; }\n');
  const baseRevision = await commit();
  const baseline = await acceptEvidenceBaseline({ repositoryPath, inputPath: join(repositoryPath, 'flow.excalidraw'), generatedPath: join(repositoryPath, 'flow.excalidraw'),
    outputDir: join(stateDir, 'baseline'), evidence: { schemaVersion: 1, source: { kind: 'git', revision: baseRevision },
      scope: { question: 'What does handle return?', paths: ['src'], coverage: 'partial', unknowns: ['Runtime behavior is not established.'] },
      references: [{ id: 'handle', path: 'src/api.js', startLine: 1, endLine: 1, symbol: 'handle' }],
      nodes: [{ semanticId: 'api', elementId: 'service', referenceIds: ['handle'] }], relations: [] } });
  await fs.writeFile(join(repositoryPath, 'src/api.js'), 'export function handle() { return 2; }\n');
  const sourceRevision = await commit();
  const config = { schemaVersion: 1, id: 'flow', sourcePaths: ['src'], diagramPath: 'flow.excalidraw', trigger: 'manual',
    baseline: { bundlePath: 'baseline/evidence.json', sha256: baseline.sha256 }, output: 'jobs',
    execution: { version: 'claude-code-adapter-v1', executable: process.execPath, args: [adapter, '--claude', claude, '--max-turns', '12'],
      timeoutMs: 120000, forwardEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] } };
  const event = { trigger: 'manual', baseRevision, sourceRevision, headRef: 'refs/heads/main', trusted: true };
  return { root, repositoryPath, stateDir, config, event };
}

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

test('the Claude Code adapter runs read-only and locked down, and its proposal is qualified like any other', { timeout: 180000 }, async t => {
  withEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture', GITHUB_TOKEN: 'github-must-not-leak', GH_TOKEN: 'gh-must-not-leak' });
  const f = await fixture(t, 'success');
  const job = await runDiagramJob(f);
  assert.equal(job.receipt.status, 'completed', JSON.stringify(job.receipt.error));
  assert.equal(job.receipt.result, 'ready');
  assert.equal(job.receipt.verification.preview.pixelMatch, true);
  const [attempt] = await fs.readdir(join(f.stateDir, 'jobs/flow', job.receipt.jobKey, 'attempts'));
  const agent = join(f.stateDir, 'jobs/flow', job.receipt.jobKey, 'attempts', attempt, 'output/agent');
  const log = JSON.parse(await fs.readFile(join(agent, 'fake-log.json'), 'utf8'));
  const flag = name => log.args[log.args.indexOf(name) + 1];
  assert.equal(log.args[0], '-p');
  assert.equal(flag('--tools'), 'Read,Glob,Grep');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--setting-sources'), 'user');
  assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(flag('--max-turns'), '12');
  assert.ok(log.args.includes('--strict-mcp-config') && log.args.includes('--no-session-persistence'));
  assert.equal(JSON.parse(flag('--json-schema')).required.includes('evidence'), true);
  assert.equal(log.cwd, f.repositoryPath);
  assert.equal(log.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-fixture');
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) assert.equal(log.env[name], undefined, `${name} is never forwarded`);
  assert.notEqual(log.env.HOME, homedir());
  assert.equal(log.homeExists, true);
  await assert.rejects(fs.stat(log.env.HOME), { code: 'ENOENT' }, 'the temporary HOME is removed');
  const run = JSON.parse(await fs.readFile(join(agent, 'run.json'), 'utf8'));
  assert.deepEqual([run.subtype, run.isError, run.summary], ['success', false, 'Recolored the API node.']);
  assert.ok((await fs.readFile(join(agent, 'input/changes.diff'), 'utf8')).includes('return 2'));
});

test('an adapter run without a structured proposal fails the job without artifacts', { timeout: 120000 }, async t => {
  withEnv(t, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture' });
  const f = await fixture(t, 'error');
  const job = await runDiagramJob(f);
  assert.equal(job.receipt.status, 'failed');
  assert.equal(job.receipt.error.code, 'RUNTIME_FAILED');
  assert.deepEqual(job.receipt.artifacts, {});
  const [attempt] = await fs.readdir(join(f.stateDir, 'jobs/flow', job.receipt.jobKey, 'attempts'));
  const run = JSON.parse(await fs.readFile(join(f.stateDir, 'jobs/flow', job.receipt.jobKey, 'attempts', attempt, 'output/agent/run.json'), 'utf8'));
  assert.deepEqual([run.subtype, run.isError], ['error_max_structured_output_retries', true]);
});
