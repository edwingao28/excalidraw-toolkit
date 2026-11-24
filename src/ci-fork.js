import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readDiagramJob, runDiagramJob } from './ci.js';
import { sha256 } from './scene.js';

const execute = promisify(execFile);
const REVISION = /^[a-f0-9]{40}$/;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const lower = value => typeof value === 'string' ? value.toLowerCase() : null;

/** Check that a workflow_run event and the live pull request describe the
 * same open PR head. Everything in the run payload and in artifacts from the
 * PR's workflow is untrusted; only agreement with the live PR is accepted. */
export function verifyForkRun({ run, pull, repository, workflowPath }) {
  if (!FULL_NAME.test(repository ?? '') || typeof workflowPath !== 'string' || !workflowPath.startsWith('.github/workflows/')) {
    fail('INVALID_FORK_RUN', 'Provide the destination repository and the expected PR workflow path');
  }
  if (run?.event !== 'pull_request' || run.conclusion !== 'success' || lower(run.repository?.full_name) !== lower(repository) ||
      run.path !== workflowPath || !REVISION.test(run.head_sha ?? '') || !FULL_NAME.test(run.head_repository?.full_name ?? '')) {
    fail('FORK_RUN_MISMATCH', 'The triggering run must be a successful pull_request run of the expected workflow in this repository');
  }
  if (pull?.state !== 'open' || !Number.isSafeInteger(pull.number) || pull.number < 1 || lower(pull.base?.repo?.full_name) !== lower(repository) ||
      pull.head?.sha !== run.head_sha || lower(pull.head?.repo?.full_name) !== lower(run.head_repository.full_name) || !REVISION.test(pull.base?.sha ?? '')) {
    fail('FORK_RUN_MISMATCH', 'The live pull request does not match the triggering run');
  }
  return { pullNumber: pull.number, sourceRepository: pull.head.repo.full_name, sourceRevision: pull.head.sha, baseSha: pull.base.sha };
}

async function git(repository, args) {
  const { stdout } = await execute('git', ['--no-pager', '-C', repository, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

async function getPull(apiUrl, repository, number, { token, fetch }) {
  if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_FORK_RUN', 'The PR number must be a positive integer');
  let response;
  try {
    response = await fetch(`${apiUrl}/repos/${repository}/pulls/${number}`, { redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  } catch { fail('REMOTE_UNCERTAIN', 'GitHub did not return the pull request'); }
  if (!response.ok) fail('REMOTE_REJECTED', `GitHub returned HTTP ${response.status} for the pull request`);
  return response.json();
}

/** Qualify a fork PR's committed proposal in a trusted job that holds no write
 * token. The PR head is fetched as Git objects only; nothing is checked out or
 * executed from it, and the configuration and accepted baseline come from the
 * trusted checkout. */
export async function qualifyForkPullRequest({ repositoryPath, stateDir, baselineDir, config, run, pullNumber, repository, workflowPath,
  apiUrl = 'https://api.github.com', remote = 'origin' }, { token, fetch = globalThis.fetch } = {}) {
  if (config?.execution?.kind !== 'prepared-proposal' || config.trigger !== 'pull_request') {
    fail('INVALID_CONFIG', 'Fork qualification requires a pull_request prepared-proposal configuration');
  }
  const pull = await getPull(apiUrl, repository, pullNumber, { token, fetch });
  const verified = verifyForkRun({ run, pull, repository, workflowPath });
  const repositoryRoot = await fs.realpath(resolve(repositoryPath));
  const headRef = `refs/pull/${verified.pullNumber}/head`;
  // Objects only: a fetch into a private ref runs no hooks and changes no files.
  await git(repositoryRoot, ['fetch', '--no-tags', '--no-recurse-submodules', remote, `+${headRef}:${headRef}`]);
  if (await git(repositoryRoot, ['rev-parse', '--verify', `${headRef}^{commit}`]) !== verified.sourceRevision) {
    return { status: 'superseded', reason: 'source-head-changed', ...verified };
  }
  const baseRevision = await git(repositoryRoot, ['merge-base', verified.baseSha, verified.sourceRevision]);
  // The accepted baseline is copied from the trusted checkout into CI state.
  const target = join(resolve(stateDir), posix.dirname(config.baseline.bundlePath));
  await fs.mkdir(target, { recursive: true });
  for (const file of ['evidence.json', 'delivered.excalidraw', 'generated.excalidraw']) {
    const source = join(resolve(baselineDir), file);
    if (!(await fs.lstat(source)).isFile()) fail('INVALID_BASELINE', 'Baseline files must be regular files');
    await fs.copyFile(source, join(target, file));
  }
  const job = await runDiagramJob({ repositoryPath: repositoryRoot, stateDir, config,
    event: { trigger: 'pull_request', baseRevision, sourceRevision: verified.sourceRevision, headRef, trusted: false } });
  // receiptFile is relative to stateDir so a later job can restore the state elsewhere.
  return { status: job.receipt.status, receiptFile: relative(resolve(stateDir), job.receiptPath), receiptHash: job.sha256, ...verified,
    ...(job.receipt.error ? { error: job.receipt.error } : {}), ...(job.receipt.reason ? { reason: job.receipt.reason } : {}) };
}

/** Stage a completed job's four artifacts as uniquely named release assets and
 * build the publication request that links to them. Run in the publishing job
 * after downloading the qualified state; the caller uploads the staged files. */
export async function prepareForkPublication({ receiptPath, receiptHash, repository, releaseTag, pullNumber, sourceRepository, actor, assetDir,
  publicationStateDir, visibility = 'public' }) {
  if (!FULL_NAME.test(repository ?? '') || !FULL_NAME.test(sourceRepository ?? '') || !TAG.test(releaseTag ?? '') ||
      !Number.isSafeInteger(pullNumber) || pullNumber < 1 || typeof publicationStateDir !== 'string' || !publicationStateDir) {
    fail('INVALID_PUBLICATION', 'Provide the repository, source repository, release tag, PR number and publication state directory');
  }
  const { receipt } = await readDiagramJob(receiptPath, { expectedHash: receiptHash });
  if (receipt.status !== 'completed') return { status: 'blocked', reason: 'job-not-completed' };
  await fs.mkdir(assetDir, { recursive: true });
  const artifacts = {};
  for (const name of ['native', 'preview', 'evidence', 'report']) {
    const entry = receipt.artifacts[name];
    const bytes = await fs.readFile(join(dirname(resolve(receiptPath)), entry.file));
    if (sha256(bytes) !== entry.sha256) fail('CORRUPT_JOB', 'A qualified artifact changed before upload');
    const asset = `${receipt.jobKey.slice(0, 16)}-${name}-${basename(entry.file)}`;
    await fs.writeFile(join(assetDir, asset), bytes, { flag: 'wx' });
    artifacts[name] = { url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(asset)}`, sha256: entry.sha256 };
  }
  const [owner, repo] = repository.split('/');
  return { status: 'ready', request: { receiptPath: resolve(receiptPath), receiptHash, stateDir: resolve(publicationStateDir),
    publication: { enabled: true, owner, repo, pullNumber, actor, forkPolicy: 'prepared-proposal', visibility,
      artifactOrigins: ['https://github.com'], artifacts },
    context: { trustedWorkflow: true, sourceRepository, sourceRevision: receipt.sourceRevision } } };
}
