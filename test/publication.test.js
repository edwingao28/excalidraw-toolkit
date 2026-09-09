import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { sha256 } from '../src/scene.js';
import { publishDiagramJob } from '../src/publication.js';
import { acceptEvidenceBaseline } from '../src/evidence.js';
import { runDiagramJob } from '../src/ci.js';
import { runPreparedRefresh } from '../src/ci-workflow.js';

const execute = promisify(execFile);
const actor = 'diagram-bot[bot]';
let sourceRevision;
let qualifiedJob;
let qualifiedRoot;

// Build one real, pixel-qualified job, then restore its immutable directory for
// each HTTP scenario. Publication must consume real proof, not invented flags.
async function createQualifiedJob() {
  const root = qualifiedRoot = await fs.mkdtemp(join(tmpdir(), 'toolkit-publication-source-'));
  const repositoryPath = join(root, 'source'), stateDir = join(root, 'state');
  await fs.mkdir(repositoryPath);
  const git = async (...args) => (await execute('git', ['-C', repositoryPath, ...args])).stdout.trim();
  const commit = async () => {
    await git('add', '.');
    await git('-c', 'user.name=Publication fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: update publication fixture');
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-b', 'main');
  const scene = JSON.parse(await fs.readFile(new URL('./fixtures/annotated.excalidraw', import.meta.url), 'utf8'));
  const inputPath = join(repositoryPath, 'flow.excalidraw');
  await fs.writeFile(inputPath, JSON.stringify(scene));
  await fs.writeFile(join(repositoryPath, 'api.js'), 'export function handle() { return 1; }\n');
  const baseRevision = await commit();
  const evidence = revision => ({ schemaVersion: 1, source: { kind: 'git', revision },
    scope: { question: 'Where is handle?', paths: ['api.js'], coverage: 'partial', unknowns: ['Runtime behavior is not established.'] },
    references: [{ id: 'handler', path: 'api.js', startLine: 1, endLine: 1, symbol: 'handle' }],
    nodes: [{ semanticId: 'api', elementId: 'service', referenceIds: ['handler'] }], relations: [] });
  const baseline = await acceptEvidenceBaseline({ repositoryPath, inputPath, generatedPath: inputPath, evidence: evidence(baseRevision), outputDir: join(stateDir, 'baseline') });
  await fs.writeFile(join(repositoryPath, 'api.js'), 'export function handle() { return 2; }\n');
  sourceRevision = await commit();
  scene.elements[0].backgroundColor = '#d0ebff';
  const generatedPath = join(root, 'proposed.excalidraw'), proposalPath = join(root, 'proposal.json');
  await fs.writeFile(generatedPath, JSON.stringify(scene));
  await fs.writeFile(proposalPath, JSON.stringify({ command: 'refresh-diagram', generatedPath, evidence: evidence(sourceRevision) }));
  const job = await runDiagramJob({ repositoryPath, stateDir,
    config: { schemaVersion: 1, id: 'flow', sourcePaths: ['api.js'], diagramPath: 'flow.excalidraw', trigger: 'manual',
      baseline: { bundlePath: 'baseline/evidence.json', sha256: baseline.sha256 }, output: 'jobs',
      execution: { executable: process.execPath, args: [], version: 'qualified-publication-v1', timeoutMs: 10000 } },
    event: { trigger: 'manual', baseRevision, sourceRevision, headRef: 'refs/heads/main', trusted: true },
  }, { runner: request => runPreparedRefresh(request, proposalPath) });
  assert.equal(job.receipt.status, 'completed', JSON.stringify(job.receipt.error));
  assert.equal(job.receipt.verification.preview.pixelMatch, true);
  return job;
}
after(async () => { if (qualifiedRoot) await fs.rm(qualifiedRoot, { recursive: true, force: true }); });

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'toolkit-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = await (qualifiedJob ??= createQualifiedJob());
  await fs.cp(dirname(job.receiptPath), join(root, 'job'), { recursive: true });
  const receiptPath = join(root, 'job/job.json');
  const receiptBytes = await fs.readFile(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString());
  const links = Object.fromEntries(['native', 'preview', 'evidence', 'report'].map(name => [name,
    { url: `https://artifacts.example.invalid/${name}`, sha256: receipt.artifacts[name].sha256 }]));
  const state = { comments: [], requests: [], nextId: 1, head: sourceRevision, private: false, headRepository: 'owner/repo',
    denyWrite: false, uncertain: false, uncertainPersist: true, readFailureAfterWrite: false, secondHead: null, headReads: 0, actor };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    state.requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body });
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/repos/owner/repo/pulls/12') {
      state.headReads++;
      if (state.headReads === 2 && state.secondHead) state.head = state.secondHead;
      return reply(200, { state: 'open', head: { sha: state.head, repo: { full_name: state.headRepository } },
        base: { repo: { full_name: 'owner/repo', private: state.private } } });
    }
    if (url.pathname === '/repos/owner/repo/issues/12/comments' && request.method === 'GET') {
      if (state.readFailureAfterWrite && state.requests.some(item => ['POST', 'PATCH'].includes(item.method))) return reply(503, { message: 'unavailable' });
      const page = Number(url.searchParams.get('page'));
      return reply(200, state.comments.slice((page - 1) * 100, page * 100));
    }
    if (request.method === 'POST' || request.method === 'PATCH') {
      if (state.denyWrite) return reply(403, { message: 'forbidden' });
      const content = JSON.parse(body);
      const comment = request.method === 'PATCH' ? state.comments.find(item => item.id === Number(url.pathname.split('/').at(-1))) :
        { id: state.nextId++, user: { login: state.actor } };
      if (request.method === 'POST' && (!state.uncertain || state.uncertainPersist)) state.comments.push(comment);
      if (!comment) return reply(404, { message: 'not found' });
      if (!state.uncertain || state.uncertainPersist) comment.body = content.body;
      if (state.headAfterWrite) state.head = state.headAfterWrite;
      if (state.uncertain) { request.socket.destroy(); return; }
      return reply(request.method === 'POST' ? 201 : 200, comment);
    }
    reply(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { receiptPath, receiptHash: sha256(receiptBytes), stateDir: join(root, 'publication-state'),
    publication: { enabled: true, owner: 'owner', repo: 'repo', pullNumber: 12, actor, forkPolicy: 'deny',
      visibility: 'public', artifactOrigins: ['https://artifacts.example.invalid'], artifacts: links, apiUrl },
    context: { trustedWorkflow: true, sourceRepository: 'owner/repo', sourceRevision } };
  const credentials = { token: 'fixture-token' };
  const writes = () => state.requests.filter(request => ['POST', 'PATCH', 'DELETE'].includes(request.method));
  return { root, options, credentials, state, receipt, writes };
}

test('disabled publication performs no filesystem or HTTP I/O and ignores other configuration', async () => {
  assert.deepEqual(await publishDiagramJob({ receiptPath: '/missing', publication: { enabled: false } }, {
    fetch: () => assert.fail('Disabled HTTP'),
  }), { status: 'disabled' });
});

test('creates one managed update and repeated runs reconcile without another write', async t => {
  const f = await fixture(t);
  const first = await publishDiagramJob(f.options, f.credentials);
  assert.equal(first.status, 'created');
  assert.equal(f.state.comments.length, 1);
  assert.match(f.state.comments[0].body, /Editable diagram/);
  assert.match(f.state.comments[0].body, /Source evidence/);
  const repeat = await publishDiagramJob(f.options, f.credentials);
  assert.equal(repeat.status, 'unchanged');
  assert.equal(repeat.commentId, first.commentId);
  assert.equal(f.writes().length, 1);
  assert.ok(f.state.requests.every(request => request.auth === 'Bearer fixture-token'));
});

test('uncertain POST that succeeded is looked up and reconciled once', async t => {
  const f = await fixture(t);
  f.state.uncertain = true;
  const result = await publishDiagramJob(f.options, f.credentials);
  assert.equal(result.status, 'reconciled');
  assert.equal(f.writes().length, 1);
  assert.equal(f.state.comments.length, 1);
  const index = f.state.requests.findIndex(request => request.method === 'POST');
  assert.match(f.state.requests[index + 1].url, /comments\?/);
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'unchanged');
  assert.equal(f.writes().length, 1);
});

test('unknown outcome persists across fresh publisher calls and never blindly recreates an absent comment', async t => {
  const f = await fixture(t);
  f.state.uncertain = true;
  f.state.uncertainPersist = false;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'uncertain');
  f.state.uncertain = false;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'uncertain');
  assert.equal(f.writes().length, 1);
  assert.equal(f.state.comments.length, 0);
  // Model delayed remote visibility: reconciliation uses the persisted body hash.
  const body = JSON.parse(f.writes()[0].body).body;
  f.state.comments.push({ id: 22, user: { login: actor }, body });
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'unchanged');
  assert.equal(f.writes().length, 1);
});

test('an uncertain response followed by a failed lookup reconciles on the next run', async t => {
  const f = await fixture(t);
  f.state.uncertain = true;
  f.state.readFailureAfterWrite = true;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'uncertain');
  f.state.readFailureAfterWrite = false;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'unchanged');
  assert.equal(f.writes().length, 1);
});

test('changes update the same managed comment and an uncertain PATCH is reconciled', async t => {
  const f = await fixture(t);
  const first = await publishDiagramJob(f.options, f.credentials);
  f.options.publication.artifacts.native.url += '?download=1';
  f.state.uncertain = true;
  const updated = await publishDiagramJob(f.options, f.credentials);
  assert.equal(updated.status, 'reconciled');
  assert.equal(updated.commentId, first.commentId);
  assert.deepEqual(f.writes().map(request => request.method), ['POST', 'PATCH']);
  assert.equal(f.state.comments.length, 1);
});

test('stale heads at entry and immediately before mutation make no writes', async t => {
  const f = await fixture(t);
  f.state.head = 'c'.repeat(40);
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'source-head-changed');
  assert.equal(f.writes().length, 0);
  f.state.head = sourceRevision;
  f.state.headReads = 0;
  f.state.secondHead = 'd'.repeat(40);
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'source-head-changed');
  assert.equal(f.writes().length, 0);
});

test('trusted-context and live fork checks prevent credentialed fork publication', async t => {
  const f = await fixture(t);
  for (const context of [
    { ...f.options.context, trustedWorkflow: false }, { ...f.options.context, sourceRepository: 'contributor/fork' },
  ]) {
    const result = await publishDiagramJob({ ...f.options, receiptPath: '/does-not-exist', context }, { ...f.credentials, fetch: () => assert.fail('Untrusted HTTP') });
    assert.equal(result.reason, 'untrusted-or-fork-context');
  }
  f.state.headRepository = 'contributor/fork';
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'fork-publication-disabled');
  assert.equal(f.writes().length, 0);
});

test('a head change during the remote mutation is reported as superseded rather than current success', async t => {
  const f = await fixture(t);
  f.state.headAfterWrite = 'd'.repeat(40);
  const result = await publishDiagramJob(f.options, f.credentials);
  assert.equal(result.status, 'superseded');
  assert.equal(result.wrote, true);
  assert.equal(f.writes().length, 1);
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'source-head-changed');
  assert.equal(f.writes().length, 1);
});

test('private/public visibility, missing credentials and rejected permissions fail explicitly', async t => {
  const f = await fixture(t);
  assert.equal((await publishDiagramJob(f.options)).reason, 'publication-credential-unavailable');
  assert.equal(f.state.requests.length, 0);
  f.state.private = true;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'repository-visibility-mismatch');
  f.options.publication.visibility = 'repository';
  f.state.denyWrite = true;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'REMOTE_REJECTED');
  f.state.denyWrite = false;
  assert.equal((await publishDiagramJob(f.options, f.credentials)).status, 'created');
  assert.equal(f.state.comments.length, 1);
  const journals = await fs.readdir(f.options.stateDir);
  const files = await fs.readdir(join(f.options.stateDir, journals[0]));
  for (const file of files) assert.doesNotMatch(await fs.readFile(join(f.options.stateDir, journals[0], file), 'utf8'), /fixture-token/);
});

test('all comment pages are searched and other authors or unrelated comments remain untouched', async t => {
  const f = await fixture(t);
  const first = await publishDiagramJob(f.options, f.credentials);
  const managed = f.state.comments[0];
  f.state.comments = Array.from({ length: 100 }, (_, index) => ({ id: index + 100, body: 'Unrelated', user: { login: 'human' } }));
  f.state.comments[0].body = managed.body; // A copied marker is not ownership.
  f.state.comments.push(managed);
  assert.equal((await publishDiagramJob(f.options, f.credentials)).commentId, first.commentId);
  assert.equal(f.writes().length, 1);
  assert.ok(f.state.requests.some(request => request.url.endsWith('page=2')));
  f.state.comments.push({ ...managed, id: 500 });
  assert.equal((await publishDiagramJob(f.options, f.credentials)).reason, 'AMBIGUOUS_PUBLICATION');
  assert.equal(f.writes().length, 1);
});

test('concurrent publishers sharing state cannot both create comments', async t => {
  const f = await fixture(t);
  const results = await Promise.all([publishDiagramJob(f.options, f.credentials), publishDiagramJob(f.options, f.credentials)]);
  assert.ok(results.some(result => result.status === 'created'));
  assert.ok(results.every(result => ['created', 'unchanged', 'busy', 'uncertain'].includes(result.status)));
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.writes().length, 1);
});

test('artifact hash mismatch, unexpected origins and changed local artifacts cannot be published', async t => {
  const f = await fixture(t);
  const wrong = structuredClone(f.options);
  wrong.publication.artifacts.native.sha256 = '0'.repeat(64);
  await assert.rejects(publishDiagramJob(wrong, f.credentials), { code: 'INVALID_ARTIFACT_LINK' });
  const origin = structuredClone(f.options);
  origin.publication.artifacts.native.url = 'https://untrusted.example.invalid/diagram';
  await assert.rejects(publishDiagramJob(origin, f.credentials), { code: 'INVALID_ARTIFACT_LINK' });
  await fs.appendFile(join(dirname(f.options.receiptPath), f.receipt.artifacts.native.file), 'changed');
  await assert.rejects(publishDiagramJob(f.options, f.credentials), { code: 'CORRUPT_JOB' });
  assert.equal(f.state.requests.length, 0);
});

test('missing native qualification or a changed merge proof blocks publication before HTTP', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.options.receiptPath);
  const receipt = JSON.parse(original);
  delete receipt.verification;
  const bytes = JSON.stringify(receipt);
  await fs.writeFile(f.options.receiptPath, bytes);
  await assert.rejects(publishDiagramJob({ ...f.options, receiptHash: sha256(bytes) }, f.credentials), { code: 'CORRUPT_JOB' });
  await fs.writeFile(f.options.receiptPath, original);
  await fs.appendFile(join(dirname(f.options.receiptPath), f.receipt.verification.artifacts.generated.file), 'changed');
  await assert.rejects(publishDiagramJob(f.options, f.credentials), { code: 'CORRUPT_JOB' });
  assert.equal(f.state.requests.length, 0);
});

test('redirects are not followed with publication credentials', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await publishDiagramJob(f.options, { ...f.credentials, fetch: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new TypeError('redirect denied');
  } });
  assert.equal(result.reason, 'REMOTE_UNCERTAIN');
  assert.equal(calls, 1);
  assert.equal(f.writes().length, 0);
});
