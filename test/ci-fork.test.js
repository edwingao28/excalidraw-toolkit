import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareForkPublication, qualifyForkPullRequest, verifyForkRun } from '../src/ci-fork.js';
import { acceptEvidenceBaseline } from '../src/evidence.js';
import { publishDiagramJob } from '../src/publication.js';
import { sha256 } from '../src/scene.js';

const exec = promisify(execFile);
const workflowPath = '.github/workflows/fork-pr.yml';
const identity = ['-c', 'user.name=Fork fixture', '-c', 'user.email=fork@example.invalid', '-c', 'commit.gpgSign=false'];

function evidence(revision) {
  return { schemaVersion: 1, source: revision ? { kind: 'git', revision } : { kind: 'git' },
    scope: { question: 'What does handle return?', paths: ['src'], coverage: 'partial', unknowns: ['Runtime behavior is not established.'] },
    references: [{ id: 'handle', path: 'src/api.js', startLine: 1, endLine: 1, symbol: 'handle' }],
    nodes: [{ semanticId: 'api', elementId: 'service', referenceIds: ['handle'] }], relations: [] };
}

// upstream.git plays GitHub: the trusted checkout clones it, and a contributor's
// commit is published there as refs/pull/7/head, as GitHub does for fork PRs.
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'toolkit-fork-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream.git'), trusted = join(root, 'trusted'), contributor = join(root, 'contributor');
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
  await exec('git', ['init', '--bare', '-b', 'main', upstream]);
  await exec('git', ['clone', '-q', upstream, contributor]);
  const scene = JSON.parse(await fs.readFile(new URL('./fixtures/annotated.excalidraw', import.meta.url), 'utf8'));
  await fs.mkdir(join(contributor, 'src'));
  await fs.writeFile(join(contributor, 'flow.excalidraw'), JSON.stringify(scene));
  await fs.writeFile(join(contributor, 'src/api.js'), 'export function handle() { return 1; }\n');
  await git(contributor, 'add', '.');
  await git(contributor, ...identity, 'commit', '-q', '-m', 'test: base');
  const baseRevision = await git(contributor, 'rev-parse', 'HEAD');
  await git(contributor, 'push', '-q', 'origin', 'main');
  await exec('git', ['clone', '-q', upstream, trusted]);
  const baseline = await acceptEvidenceBaseline({ repositoryPath: trusted, inputPath: join(trusted, 'flow.excalidraw'),
    generatedPath: join(trusted, 'flow.excalidraw'), evidence: evidence(baseRevision), outputDir: join(root, 'baseline') });

  const pushHead = async (value, fill = '#d0ebff') => {
    await fs.writeFile(join(contributor, 'src/api.js'), `export function handle() { return ${value}; }\n`);
    const generated = structuredClone(scene); generated.elements[0].backgroundColor = fill;
    await fs.mkdir(join(contributor, 'diagram'), { recursive: true });
    await fs.writeFile(join(contributor, 'diagram/generated.excalidraw'), JSON.stringify(generated));
    await fs.writeFile(join(contributor, 'diagram/proposal.json'), JSON.stringify({ command: 'refresh-diagram', generatedPath: 'generated.excalidraw', evidence: evidence() }));
    await git(contributor, 'add', '.');
    await git(contributor, ...identity, 'commit', '-q', '-m', `test: contributor change ${value}`);
    const head = await git(contributor, 'rev-parse', 'HEAD');
    await git(contributor, 'push', '-q', '-f', 'origin', `HEAD:refs/pull/7/head`);
    return head;
  };
  const headRevision = await pushHead(2);
  const config = { schemaVersion: 1, id: 'flow', sourcePaths: ['src'], diagramPath: 'flow.excalidraw', trigger: 'pull_request',
    baseline: { bundlePath: 'baseline/evidence.json', sha256: baseline.sha256 }, output: 'jobs',
    execution: { kind: 'prepared-proposal', version: 'contributor-v1', proposalPath: 'diagram/proposal.json' } };
  const run = { event: 'pull_request', conclusion: 'success', repository: { full_name: 'owner/repo' }, path: workflowPath,
    head_sha: headRevision, head_repository: { full_name: 'contributor/fork' } };
  const pull = { state: 'open', number: 7, base: { sha: baseRevision, repo: { full_name: 'owner/repo', private: false } },
    head: { sha: headRevision, repo: { full_name: 'contributor/fork' } } };
  return { root, trusted, git, baseRevision, headRevision, pushHead, config, run, pull, stateDir: join(root, 'state'), baselineDir: join(root, 'baseline') };
}

// A minimal GitHub double for the pull request and its comments.
function github(pull) {
  const comments = [], requests = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    requests.push({ method: init.method ?? 'GET', pathname, auth: init.headers?.Authorization });
    const json = (status, value) => ({ ok: status < 300, status, json: async () => value });
    if (pathname === '/repos/owner/repo/pulls/7') return json(200, pull);
    if (pathname === '/repos/owner/repo/issues/7/comments' && (init.method ?? 'GET') === 'GET') return json(200, comments);
    if (pathname === '/repos/owner/repo/issues/7/comments' && init.method === 'POST') {
      const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body: JSON.parse(init.body).body };
      comments.push(comment);
      return json(201, comment);
    }
    return json(404, {});
  };
  return { fetch, comments, requests };
}

test('a fork run is accepted only when it matches the live pull request', () => {
  const run = { event: 'pull_request', conclusion: 'success', repository: { full_name: 'Owner/Repo' }, path: workflowPath,
    head_sha: 'a'.repeat(40), head_repository: { full_name: 'contributor/fork' } };
  const pull = { state: 'open', number: 7, base: { sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } }, head: { sha: 'a'.repeat(40), repo: { full_name: 'Contributor/Fork' } } };
  assert.deepEqual(verifyForkRun({ run, pull, repository: 'owner/repo', workflowPath }),
    { pullNumber: 7, sourceRepository: 'Contributor/Fork', sourceRevision: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
  for (const [changedRun, changedPull] of [
    [{ ...run, event: 'pull_request_target' }, pull], [{ ...run, conclusion: 'failure' }, pull],
    [{ ...run, repository: { full_name: 'other/repo' } }, pull], [{ ...run, path: '.github/workflows/other.yml' }, pull],
    [{ ...run, head_sha: 'c'.repeat(40) }, pull], [{ ...run, head_repository: { full_name: 'someone/else' } }, pull],
    [run, { ...pull, state: 'closed' }], [run, { ...pull, base: { ...pull.base, repo: { full_name: 'other/repo' } } }],
    [run, { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } }], [run, { ...pull, number: '7' }],
  ]) {
    assert.throws(() => verifyForkRun({ run: changedRun, pull: changedPull, repository: 'owner/repo', workflowPath }), { code: 'FORK_RUN_MISMATCH' });
  }
  assert.throws(() => verifyForkRun({ run, pull, repository: 'owner/repo', workflowPath: 'fork-pr.yml' }), { code: 'INVALID_FORK_RUN' });
});

test('a fork PR proposal is fetched as data, qualified without a write token and published by the separate job', async t => {
  const f = await fixture(t);
  const before = await f.git(f.trusted, 'rev-parse', 'HEAD');
  const api = github(f.pull);
  const qualified = await qualifyForkPullRequest({ repositoryPath: f.trusted, stateDir: f.stateDir, baselineDir: f.baselineDir, config: f.config,
    run: f.run, pullNumber: 7, repository: 'owner/repo', workflowPath }, { token: 'read-token', fetch: api.fetch });
  assert.equal(qualified.status, 'completed', JSON.stringify(qualified));
  assert.equal(qualified.sourceRepository, 'contributor/fork');
  assert.equal(qualified.sourceRevision, f.headRevision);
  assert.ok(!qualified.receiptFile.startsWith('/'));
  assert.equal(await f.git(f.trusted, 'rev-parse', 'HEAD'), before, 'the trusted checkout never moves to the PR');
  assert.equal(await f.git(f.trusted, 'status', '--porcelain'), '', 'no PR file is written to the trusted working tree');
  await assert.rejects(fs.stat(join(f.trusted, 'diagram/proposal.json')), { code: 'ENOENT' });

  const staged = await prepareForkPublication({ receiptPath: join(f.stateDir, qualified.receiptFile), receiptHash: qualified.receiptHash,
    repository: 'owner/repo', releaseTag: 'diagram-artifacts', pullNumber: qualified.pullNumber, sourceRepository: qualified.sourceRepository,
    actor: 'github-actions[bot]', assetDir: join(f.root, 'assets'), publicationStateDir: join(f.root, 'publication-state') });
  assert.equal(staged.status, 'ready');
  assert.equal(staged.request.publication.forkPolicy, 'prepared-proposal');
  const assets = await fs.readdir(join(f.root, 'assets'));
  assert.equal(assets.length, 4);
  for (const [name, link] of Object.entries(staged.request.publication.artifacts)) {
    const file = decodeURIComponent(link.url.split('/').at(-1));
    assert.ok(link.url.startsWith('https://github.com/owner/repo/releases/download/diagram-artifacts/'), name);
    assert.equal(sha256(await fs.readFile(join(f.root, 'assets', file))), link.sha256);
  }
  const published = await publishDiagramJob(staged.request, { token: 'write-token', fetch: api.fetch });
  assert.equal(published.status, 'created', JSON.stringify(published));
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, /checked by CI without running its code/);
});

test('mismatched runs fetch nothing, and a PR head that moved during qualification is superseded', async t => {
  const f = await fixture(t);
  const api = github(f.pull);
  await assert.rejects(qualifyForkPullRequest({ repositoryPath: f.trusted, stateDir: f.stateDir, baselineDir: f.baselineDir, config: f.config,
    run: { ...f.run, head_sha: f.baseRevision }, pullNumber: 7, repository: 'owner/repo', workflowPath }, { fetch: api.fetch }), { code: 'FORK_RUN_MISMATCH' });
  await assert.rejects(f.git(f.trusted, 'rev-parse', '--verify', 'refs/pull/7/head'));
  await assert.rejects(fs.stat(f.stateDir), { code: 'ENOENT' });
  await assert.rejects(qualifyForkPullRequest({ repositoryPath: f.trusted, stateDir: f.stateDir, baselineDir: f.baselineDir,
    config: { ...f.config, execution: { executable: process.execPath, args: [], version: 'v1', timeoutMs: 1000 } },
    run: f.run, pullNumber: 7, repository: 'owner/repo', workflowPath }, { fetch: api.fetch }), { code: 'INVALID_CONFIG' });

  await f.pushHead(3);
  const moved = await qualifyForkPullRequest({ repositoryPath: f.trusted, stateDir: f.stateDir, baselineDir: f.baselineDir, config: f.config,
    run: f.run, pullNumber: 7, repository: 'owner/repo', workflowPath }, { fetch: api.fetch });
  assert.equal(moved.status, 'superseded');
});
