import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { runDiagramJob, readDiagramJob, commandRunner } from '../src/ci.js';
import { acceptEvidenceBaseline } from '../src/evidence.js';
import { sha256 } from '../src/scene.js';
import { runPreparedRefresh } from '../src/ci-workflow.js';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'toolkit-ci-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, 'repository');
  const stateDir = join(root, 'state');
  await fs.mkdir(join(repositoryPath, 'src'), { recursive: true });
  const git = async (...args) => (await exec('git', ['-C', repositoryPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  const commit = async () => {
    await git('add', '.');
    await git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: update CI fixture');
    return git('rev-parse', 'HEAD');
  };
  const scene = JSON.parse(await fs.readFile(new URL('./fixtures/annotated.excalidraw', import.meta.url), 'utf8'));
  for (const element of scene.elements) {
    if (element.id === 'service') element.id = 'api';
    if (element.containerId === 'service') element.containerId = 'api';
    if (element.startBinding?.elementId === 'service') element.startBinding.elementId = 'api';
    if (element.endBinding?.elementId === 'service') element.endBinding.elementId = 'api';
  }
  scene.unknown = { retained: true };
  const inputPath = join(repositoryPath, 'flow.excalidraw');
  const original = JSON.stringify(scene, null, 4) + '\n\n';
  await fs.writeFile(inputPath, original);
  await fs.writeFile(join(repositoryPath, 'src/api.js'), 'export function handle() { return 1; }\n');
  const baseRevision = await commit();
  const evidence = revision => ({ schemaVersion: 1, source: { kind: 'git', revision },
    scope: { question: 'What does handle return?', paths: ['src'], coverage: 'partial', unknowns: ['Runtime behavior is not established.'] },
    references: [{ id: 'handle', path: 'src/api.js', startLine: 1, endLine: 1, symbol: 'handle' }],
    nodes: [{ semanticId: 'api', elementId: 'api', referenceIds: ['handle'] }], relations: [] });
  const baseline = await acceptEvidenceBaseline({ repositoryPath, inputPath, generatedPath: inputPath, outputDir: join(stateDir, 'baseline'), evidence: evidence(baseRevision) });
  await fs.writeFile(join(repositoryPath, 'src/api.js'), 'export function handle() { return 2; }\n');
  const sourceRevision = await commit();
  const config = { schemaVersion: 1, id: 'request-flow', sourcePaths: ['src'], diagramPath: 'flow.excalidraw', trigger: 'push',
    baseline: { bundlePath: 'baseline/evidence.json', sha256: baseline.sha256 }, output: 'jobs',
    execution: { version: 'fixture-v1', executable: process.execPath, args: [], timeoutMs: 5000 } };
  const event = { trigger: 'push', baseRevision, sourceRevision, headRef: 'refs/heads/main', trusted: true };
  const runner = async request => {
    const generated = JSON.parse(await fs.readFile(join(dirname(request.baselineBundlePath), 'generated.excalidraw')));
    generated.elements[0].backgroundColor = '#d0ebff';
    const generatedPath = join(request.outputDir, 'proposed.excalidraw');
    const proposalPath = join(request.outputDir, 'proposal.json');
    await fs.writeFile(generatedPath, JSON.stringify(generated));
    await fs.writeFile(proposalPath, JSON.stringify({ command: 'refresh-diagram', generatedPath, evidence: evidence(request.sourceRevision) }));
    return runPreparedRefresh(request, proposalPath);
  };
  return { root, repositoryPath, stateDir, config, event, runner, evidence, git, commit, original, inputPath };
}

test('relevant commit produces verified immutable artifacts, duplicate event reuses them', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await runDiagramJob(f, { runner: async request => { calls++; return f.runner(request); } });
  assert.equal(result.receipt.status, 'completed');
  assert.deepEqual(result.receipt.changedPaths, ['src/api.js']);
  assert.equal(Object.keys(result.receipt.artifacts).length, 4);
  assert.equal(await fs.readFile(f.inputPath, 'utf8'), f.original);
  const reused = await runDiagramJob(f, { runner: () => assert.fail('Duplicate executed') });
  assert.equal(calls, 1);
  assert.equal(reused.duplicate, true);
  assert.equal(reused.sha256, result.sha256);
  await fs.appendFile(join(dirname(result.receiptPath), result.receipt.artifacts.native.file), ' ');
  await assert.rejects(runDiagramJob(f), { code: 'CORRUPT_JOB' });
});

test('qualification preserves manual fields, annotations and assets and retains the merge proof', async t => {
  const f = await fixture(t);
  const human = JSON.parse(f.original);
  human.elements[0].strokeColor = '#e03131';
  human.elements.find(element => element.id === 'note').text = 'A manual note that must survive';
  human.files.asset = { ...human.files.asset, humanMetadata: 'retain the complete asset' };
  await fs.writeFile(f.inputPath, JSON.stringify(human));
  const sourceRevision = await f.commit();
  const options = { ...f, event: { ...f.event, sourceRevision } };
  const result = await runDiagramJob(options, { runner: f.runner });
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt.error));
  assert.equal(result.receipt.verification.preview.pixelMatch, true);
  const candidate = JSON.parse(await fs.readFile(join(dirname(result.receiptPath), result.receipt.artifacts.native.file)));
  assert.equal(candidate.elements[0].strokeColor, '#e03131');
  assert.deepEqual(candidate.elements.find(element => element.id === 'note'), human.elements.find(element => element.id === 'note'));
  assert.deepEqual(candidate.files, human.files);
  assert.ok(candidate.elements[0].backgroundColor !== human.elements[0].backgroundColor);
  await fs.appendFile(join(dirname(result.receiptPath), result.receipt.verification.artifacts.generated.file), ' ');
  await assert.rejects(runDiagramJob(options, { runner: () => assert.fail('Corrupt proof reran the agent') }), { code: 'CORRUPT_JOB' });
});

test('candidate preservation is recomputed even when a runner rewrites matching artifact hashes', async t => {
  const f = await fixture(t);
  const human = JSON.parse(f.original);
  human.elements[0].strokeColor = '#e03131';
  await fs.writeFile(f.inputPath, JSON.stringify(human));
  const sourceRevision = await f.commit();
  for (const id of ['drop-note', 'erase-manual-override']) {
    const result = await runDiagramJob({ ...f, config: { ...f.config, id }, event: { ...f.event, sourceRevision } }, { runner: async request => {
      const result = await f.runner(request);
      const candidatePath = join(request.outputDir, result.artifacts.native);
      const candidate = JSON.parse(await fs.readFile(candidatePath));
      if (id === 'drop-note') candidate.elements = candidate.elements.filter(element => element.id !== 'note');
      else candidate.elements[0].strokeColor = JSON.parse(f.original).elements[0].strokeColor;
      const bytes = JSON.stringify(candidate);
      await fs.writeFile(candidatePath, bytes);
      const reportPath = join(request.outputDir, result.artifacts.report);
      const report = JSON.parse(await fs.readFile(reportPath));
      const refreshPath = join(request.outputDir, report.refresh.file);
      const refresh = JSON.parse(await fs.readFile(refreshPath));
      refresh.artifacts.candidate.sha256 = sha256(bytes);
      refresh.overrides = []; report.overrides = [];
      const receiptBytes = JSON.stringify(refresh);
      await fs.writeFile(refreshPath, receiptBytes);
      report.refresh.sha256 = sha256(receiptBytes);
      await fs.writeFile(reportPath, JSON.stringify(report));
      return result;
    } });
    assert.equal(result.receipt.status, 'failed', id);
    assert.equal(result.receipt.error.code, 'UNQUALIFIED_REFRESH', id);
    assert.deepEqual(result.receipt.artifacts, {});
  }
});

test('CI rejects missing refresh proof, false reports, truncated PNGs and a different native preview', async t => {
  const f = await fixture(t);
  const cases = {
    'missing-proof': ['UNQUALIFIED_REFRESH', async (request, result) => {
      const path = join(request.outputDir, result.artifacts.report), report = JSON.parse(await fs.readFile(path));
      delete report.refresh; await fs.writeFile(path, JSON.stringify(report));
    }],
    'false-report': ['UNQUALIFIED_REFRESH', async (request, result) => {
      const path = join(request.outputDir, result.artifacts.report), report = JSON.parse(await fs.readFile(path));
      report.changes = []; await fs.writeFile(path, JSON.stringify(report));
    }],
    'signature-only': ['INVALID_PREVIEW', async (request, result) => {
      await fs.writeFile(join(request.outputDir, result.artifacts.preview), Buffer.from('89504e470d0a1a0a00', 'hex'));
    }],
    'header-without-image': ['INVALID_PREVIEW', async (request, result) => {
      const path = join(request.outputDir, result.artifacts.preview);
      await fs.writeFile(path, (await fs.readFile(path)).subarray(0, 33));
    }],
    'wrong-native-pixels': ['PREVIEW_MISMATCH', async (request, result) => {
      const report = JSON.parse(await fs.readFile(join(request.outputDir, result.artifacts.report)));
      const before = await fs.readFile(join(request.outputDir, dirname(report.refresh.file), report.previews.images.before.file));
      const path = join(request.outputDir, result.artifacts.preview), after = await fs.readFile(path);
      assert.deepEqual(before.subarray(16, 24), after.subarray(16, 24), 'the mismatch has the same dimensions');
      await fs.writeFile(path, before);
    }],
  };
  for (const [id, [code, modify]] of Object.entries(cases)) {
    const result = await runDiagramJob({ ...f, config: { ...f.config, id } }, { runner: async request => {
      const result = await f.runner(request); await modify(request, result); return result;
    } });
    assert.equal(result.receipt.status, 'failed', id);
    assert.equal(result.receipt.error.code, code, `${id}: ${JSON.stringify(result.receipt.error)}`);
    assert.deepEqual(result.receipt.artifacts, {});
  }
});

test('irrelevant and nonconfigured events skip without reading a missing baseline or launching a runtime', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.repositoryPath, 'README.md'), 'irrelevant\n');
  const sourceRevision = await f.commit();
  await fs.rm(join(f.stateDir, 'baseline'), { recursive: true });
  const result = await runDiagramJob({ ...f, event: { ...f.event, baseRevision: f.event.sourceRevision, sourceRevision } }, { runner: () => assert.fail('Irrelevant executed') });
  assert.equal(result.receipt.status, 'skipped');
  assert.equal(result.receipt.reason, 'no-relevant-source-changes');
  const wrong = await runDiagramJob({ ...f, event: { ...f.event, trigger: 'manual' } }, { runner: () => assert.fail('Wrong trigger executed') });
  assert.equal(wrong.receipt.reason, 'trigger-not-configured');
});

test('stale events and events superseded during execution never replace newer outputs', async t => {
  const f = await fixture(t);
  let newResult;
  const old = await runDiagramJob(f, { runner: async request => {
    await fs.writeFile(join(f.repositoryPath, 'src/api.js'), 'export function handle() { return 3; }\n');
    const sourceRevision = await f.commit();
    newResult = await runDiagramJob({ ...f, event: { ...f.event, baseRevision: f.event.sourceRevision, sourceRevision } }, { runner: f.runner });
    return f.runner(request);
  } });
  assert.equal(old.receipt.status, 'superseded');
  assert.equal(newResult.receipt.status, 'completed');
  assert.notEqual(old.receiptPath, newResult.receiptPath);
  assert.equal((await readDiagramJob(newResult.receiptPath)).sha256, newResult.sha256);
  const stale = await runDiagramJob({ ...f, config: { ...f.config, id: 'late-event' } }, { runner: () => assert.fail('Stale executed') });
  assert.equal(stale.receipt.status, 'superseded');
});

test('clean runner restores baseline and completed receipts without absolute workspace identity', async t => {
  const f = await fixture(t);
  const completed = await runDiagramJob(f, { runner: f.runner });
  const copy = join(f.root, 'restored-state');
  const checkout = join(f.root, 'fresh-checkout');
  await fs.cp(f.stateDir, copy, { recursive: true });
  await exec('git', ['clone', '--no-hardlinks', f.repositoryPath, checkout]);
  const reused = await runDiagramJob({ ...f, repositoryPath: checkout, stateDir: copy }, { runner: () => assert.fail('Restored result executed') });
  assert.equal(reused.sha256, completed.sha256);
  const next = await runDiagramJob({ ...f, repositoryPath: checkout, stateDir: copy, config: { ...f.config, id: 'new-job' } }, { runner: async request => {
    assert.equal(await fs.readFile(join(dirname(request.baselineBundlePath), 'generated.excalidraw'), 'utf8'), f.original);
    assert.equal(request.baselineHash, f.config.baseline.sha256);
    return f.runner(request);
  } });
  assert.equal(next.receipt.status, 'completed');
});

test('unavailable and failing runtimes persist failed receipts and never successful artifacts', async t => {
  const f = await fixture(t);
  for (const [id, execution] of [
    ['absent', { executable: join(f.root, 'missing-runtime') }],
    ['denied', { args: ['-e', 'process.exit(3)'] }],
    ['empty', { args: ['-e', 'process.stdout.write(JSON.stringify({status:"ready"}))'] }],
  ]) {
    const result = await runDiagramJob({ ...f, config: { ...f.config, id, execution: { ...f.config.execution, ...execution } } });
    assert.equal(result.receipt.status, 'failed');
    assert.equal(typeof result.receipt.error.code, 'string');
    assert.deepEqual(result.receipt.artifacts, {});
  }
});

test('execution timeout kills the actual process group and fails the durable job', async t => {
  const f = await fixture(t);
  const marker = join(f.root, 'must-not-write');
  const script = join(f.root, 'slow.mjs');
  await fs.writeFile(script, `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'late'), 500);`);
  const result = await runDiagramJob({ ...f, config: { ...f.config, execution: { ...f.config.execution, args: [script], timeoutMs: 30 } } });
  assert.equal(result.receipt.status, 'failed');
  assert.equal(result.receipt.error.code, 'EXECUTION_TIMEOUT');
  await delay(550);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('a real executable consumes stdin and produces qualified output through the same contract', async t => {
  const f = await fixture(t);
  const script = join(f.root, 'existing-workflow.mjs');
  await fs.writeFile(script, `
    import fs from 'node:fs/promises'; import path from 'node:path';
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const evidence = ${JSON.stringify(f.evidence(f.event.sourceRevision))};
    const {runPreparedRefresh} = await import('${new URL('../src/ci-workflow.js', import.meta.url).href}');
    const generatedPath = path.join(path.dirname(request.baselineBundlePath), 'generated.excalidraw');
    const proposalPath = path.join(request.outputDir, 'proposal.json');
    await fs.writeFile(proposalPath,JSON.stringify({command:'refresh-diagram',generatedPath,evidence}));
    const result = await runPreparedRefresh(request, proposalPath);
    process.stdout.write(JSON.stringify(result));
  `);
  const result = await runDiagramJob({ ...f, config: { ...f.config, execution: { ...f.config.execution, args: [script] } } });
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.result, 'ready');
});

test('one exact concurrent job runs once and unfinished dead-owner claims recover', async t => {
  const f = await fixture(t);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const running = runDiagramJob(f, { runner: async request => { entered(); await blocked; return f.runner(request); } });
  await ready;
  await assert.rejects(runDiagramJob(f, { runner: () => assert.fail('Second runner') }), { code: 'JOB_BUSY' });
  unblock();
  const result = await running;
  const job = dirname(result.receiptPath);
  await fs.unlink(result.receiptPath);
  const ownerPath = join(job, 'claims/1.json');
  const owner = JSON.parse(await fs.readFile(ownerPath));
  // Simulate the retained claim after a dead runner; keep its attempted artifacts.
  owner.pid = 2147483647;
  owner.hostname = hostname();
  await fs.writeFile(ownerPath, JSON.stringify(owner));
  const recovered = await runDiagramJob(f, { runner: f.runner });
  assert.equal(recovered.receipt.status, 'completed');
  assert.notEqual(recovered.receipt.attempt, result.receipt.attempt);
  assert.equal((await fs.readdir(join(job, 'attempts'))).length, 2);
});

test('wrong revisions, out-of-scope evidence, unresolved conflicts and symlink outputs fail qualification', async t => {
  const f = await fixture(t);
  const cases = {
    'wrong-revision': async (request, result) => {
      const path = join(request.outputDir, result.artifacts.evidence);
      const value = JSON.parse(await fs.readFile(path)); value.source.revision = f.event.baseRevision;
      await fs.writeFile(path, JSON.stringify(value));
    },
    'wide-scope': async (request, result) => {
      const path = join(request.outputDir, result.artifacts.evidence);
      const value = JSON.parse(await fs.readFile(path)); value.scope.paths = ['.'];
      await fs.writeFile(path, JSON.stringify(value));
    },
    conflicts: async (request, result) => {
      const path = join(request.outputDir, result.artifacts.report);
      const value = JSON.parse(await fs.readFile(path)); value.conflicts = ['Human label differs'];
      await fs.writeFile(path, JSON.stringify(value));
    },
    symlink: async (request, result) => {
      const path = join(request.outputDir, result.artifacts.native);
      await fs.unlink(path); await fs.symlink(request.currentPath, path);
    },
  };
  for (const [id, modify] of Object.entries(cases)) {
    const result = await runDiagramJob({ ...f, config: { ...f.config, id } }, { runner: async request => {
      const value = await f.runner(request); await modify(request, value); return value;
    } });
    assert.equal(result.receipt.status, 'failed', id);
  }
});

test('untrusted events never execute and explicit argv has no shell interpretation or implicit secrets', async t => {
  const f = await fixture(t);
  const denied = await runDiagramJob({ ...f, event: { ...f.event, trusted: false } }, { runner: () => assert.fail('Untrusted runner') });
  assert.equal(denied.receipt.error.code, 'UNTRUSTED_EXECUTION');
  const marker = join(f.root, 'shell-marker');
  const arg = `$(touch ${marker})`;
  const controller = new AbortController();
  const run = commandRunner({ executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({arg:process.argv[1],token:process.env.GITHUB_TOKEN??null}))', arg] });
  const value = await run({ repositoryPath: f.repositoryPath }, { signal: controller.signal });
  assert.equal(value.arg, arg);
  assert.equal(value.token, null);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await assert.rejects(runDiagramJob({ ...f, config: { ...f.config, execution: { ...f.config.execution, forwardEnv: ['GITHUB_TOKEN'] } } }), { code: 'INVALID_CONFIG' });
});

test('baseline tampering and path traversal cannot produce a success receipt', async t => {
  const f = await fixture(t);
  await fs.appendFile(join(f.stateDir, 'baseline/generated.excalidraw'), ' ');
  const result = await runDiagramJob(f, { runner: () => assert.fail('Corrupt baseline executed') });
  assert.equal(result.receipt.status, 'failed');
  for (const path of ['../escape', '/tmp/escape', 'x/../escape', '.git/state']) {
    await assert.rejects(runDiagramJob({ ...f, config: { ...f.config, output: path } }), { code: 'INVALID_CONFIG' });
  }
  assert.equal(sha256(await fs.readFile(f.inputPath)), sha256(f.original));
});
