import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readEvidenceBundle, validateEvidence } from './evidence.js';
import { sha256, validateScene } from './scene.js';
import { verifyRefresh } from './refresh.js';

const execute = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BYTES = 32 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const inside = (path, parent) => parent === '.' || path === parent || path.startsWith(`${parent}/`);

function relativePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\\u0000\r\n]/u.test(value) ||
      posix.normalize(value) !== value || value.split('/').some(part => ['..', '.', '.git'].includes(part))) {
    fail('INVALID_CONFIG', 'Use normalized relative paths outside .git');
  }
  return value;
}

function checkedConfig(config) {
  if (config?.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(config.id ?? '') ||
      !Array.isArray(config.sourcePaths) || !config.sourcePaths.length ||
      !['push', 'pull_request', 'manual'].includes(config.trigger) ||
      !HASH.test(config.baseline?.sha256 ?? '') || typeof config.execution?.version !== 'string' || !config.execution.version.trim()) {
    fail('INVALID_CONFIG', 'Declare schemaVersion, id, sourcePaths, trigger, pinned baseline and execution version');
  }
  config.sourcePaths.forEach(path => path === '.' || relativePath(path));
  relativePath(config.diagramPath);
  relativePath(config.baseline.bundlePath);
  relativePath(config.output);
  if (inside(config.baseline.bundlePath, config.output) || inside(config.output, dirname(config.baseline.bundlePath))) {
    fail('INVALID_CONFIG', 'Keep the accepted baseline outside the job output directory');
  }
  const { executable, args, timeoutMs, forwardEnv = [] } = config.execution;
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0') ||
      !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 ||
      !Array.isArray(forwardEnv) || forwardEnv.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name) || /^(GH_|GITHUB_|ACTIONS_)/.test(name))) {
    fail('INVALID_CONFIG', 'Use an absolute executable, literal argv, a 1–3600000 ms budget, and explicit non-GitHub environment names');
  }
  return structuredClone(config);
}

async function git(repository, args) {
  const { stdout } = await execute('git', ['--no-pager', '--literal-pathspecs', '-C', repository, ...args], {
    encoding: 'buffer', timeout: 10000, maxBuffer: MAX_BYTES,
    env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

async function revision(repository, value) {
  return (await git(repository, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`])).toString().trim();
}

async function regularFile(root, relative) {
  relativePath(relative);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('ARTIFACT_BOUNDARY', 'Artifact roots must be regular directories');
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      fail('ARTIFACT_BOUNDARY', 'Artifacts and baselines must be regular files inside their declared directory');
    }
    if (i === parts.length - 1 && stat.size > MAX_BYTES) fail('ARTIFACT_SIZE', 'Artifact exceeds the 32 MiB limit');
  }
  return current;
}

async function write(path, bytes) {
  const handle = await fs.open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function publish(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const pending = `${path}.${randomUUID()}.pending`;
  await write(pending, bytes);
  try { await fs.link(pending, path); } finally { await fs.unlink(pending); }
  const handle = await fs.open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return sha256(bytes);
}

async function readJSON(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }

// Claims are immutable generations, so two crash-recovery processes cannot
// unlink each other's locks. A foreign host must use a separate restored state.
async function claim(directory) {
  const claims = join(directory, 'claims');
  await fs.mkdir(claims, { recursive: true });
  const names = (await fs.readdir(claims)).filter(name => /^\d+\.json$/.test(name));
  const generation = Math.max(0, ...names.map(name => Number(name.slice(0, -5))));
  if (generation) {
    const owner = await readJSON(join(claims, `${generation}.json`));
    if (owner.hostname !== hostname()) fail('JOB_BUSY', 'An unfinished job belongs to another runner; restore its completed receipt or use a separate state copy');
    try { process.kill(owner.pid, 0); fail('JOB_BUSY', 'This exact job is already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const attempt = randomUUID();
  try { await publish(join(claims, `${generation + 1}.json`), { pid: process.pid, hostname: hostname(), attempt }); }
  catch (error) { if (error.code === 'EEXIST') fail('JOB_BUSY', 'Another runner claimed this exact job'); throw error; }
  return attempt;
}

/** The configured existing agent/workflow reads JSON on stdin and returns JSON
 * on stdout. There is no shell, interpolation, automatic model, or fallback. */
export function commandRunner(execution) {
  return async (request, { signal }) => {
    const env = Object.fromEntries(['PATH', 'SYSTEMROOT', 'TMPDIR', ...(execution.forwardEnv ?? [])]
      .filter(name => !/^(GH_|GITHUB_|ACTIONS_)/.test(name) && process.env[name] !== undefined).map(name => [name, process.env[name]]));
    return await new Promise((resolveResult, reject) => {
      const child = spawn(execution.executable, execution.args, {
        cwd: request.repositoryPath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      const stdout = [];
      let bytes = 0;
      let failure;
      const stop = error => {
        failure ??= error;
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
      };
      const aborted = () => stop(Object.assign(new Error('Configured execution budget expired'), { code: 'EXECUTION_TIMEOUT' }));
      signal.addEventListener('abort', aborted, { once: true });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) stop(Object.assign(new Error('Runner output exceeded its limit'), { code: 'RUNNER_OUTPUT' }));
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) stop(Object.assign(new Error('Runner logs exceeded their limit'), { code: 'RUNNER_OUTPUT' })); });
      child.on('error', error => { failure ??= Object.assign(new Error('Configured runtime is unavailable'), { code: error.code ?? 'RUNTIME_UNAVAILABLE' }); });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        signal.removeEventListener('abort', aborted);
        if (failure) return reject(failure);
        if (code !== 0) return reject(Object.assign(new Error(`Configured runtime exited with code ${code}; no successful result was produced`), { code: 'RUNTIME_FAILED' }));
        try { resolveResult(JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
        catch { reject(Object.assign(new Error('Runtime must return one JSON artifact manifest'), { code: 'RUNNER_OUTPUT' })); }
      });
      if (signal.aborted) aborted();
      child.stdin.end(JSON.stringify(request));
    });
  };
}

async function verifyOutput(result, request) {
  if (!['ready', 'unchanged'].includes(result?.status)) fail('UNQUALIFIED_RESULT', 'Runtime did not produce a ready or unchanged result');
  const paths = {};
  const artifacts = {};
  for (const name of ['native', 'preview', 'evidence', 'report']) {
    paths[name] = await regularFile(request.outputDir, result.artifacts?.[name]);
    const bytes = await fs.readFile(paths[name]);
    if (name === 'native') validateScene(JSON.parse(bytes.toString()));
    if (name === 'preview' && (bytes.length <= PNG.length || !bytes.subarray(0, PNG.length).equals(PNG))) fail('INVALID_PREVIEW', 'Expected a native PNG preview');
    artifacts[name] = { file: result.artifacts[name], sha256: sha256(bytes) };
  }
  const evidence = await readJSON(paths.evidence);
  if (evidence.source?.kind !== 'git' || evidence.source.revision !== request.sourceRevision ||
      !evidence.scope?.paths.every(path => request.sourcePaths.some(parent => inside(path, parent)))) {
    fail('SOURCE_SCOPE', 'Output evidence must identify the exact job revision within configured paths');
  }
  const checked = await validateEvidence({ repositoryPath: request.repositoryPath, inputPath: paths.native, evidence });
  if (checked.sceneHash !== artifacts.native.sha256) fail('STALE_ARTIFACT', 'Native output changed during validation');
  const report = await readJSON(paths.report);
  if (report.schemaVersion !== 1 || report.status !== result.status || report.sourceRevision !== request.sourceRevision ||
      report.baseRevision !== request.baseRevision || !Array.isArray(report.changes) || !Array.isArray(report.conflicts) || report.conflicts.length) {
    fail('UNQUALIFIED_RESULT', 'Change report must match the job and contain no unresolved conflicts');
  }
  if (!HASH.test(report.refresh?.sha256 ?? '')) fail('UNQUALIFIED_REFRESH', 'Return a retained stageRefresh receipt with its SHA-256 in report.refresh');
  const refreshPath = await regularFile(request.outputDir, report.refresh.file);
  const verified = await verifyRefresh(refreshPath, { expectedHash: report.refresh.sha256,
    baselineBundlePath: request.baselineBundlePath, baselineHash: request.baselineHash,
    currentPath: request.currentPath, repositoryPath: request.repositoryPath, requestId: request.requestId });
  const { sceneHash: candidateHash, ...candidateEvidence } = checked;
  const { sceneHash: generatedHash, ...generatedEvidence } = verified.checked;
  if (verified.candidate.sha256 !== artifacts.native.sha256 || verified.receipt.status !== result.status ||
      !isDeepStrictEqual(candidateEvidence, generatedEvidence) ||
      ['changes', 'conflicts', 'overrides'].some(field => !isDeepStrictEqual(report[field], verified.receipt[field]))) {
    fail('UNQUALIFIED_REFRESH', 'Native output, evidence or report differs from the verified three-way refresh');
  }
  const { verifyNativePreview } = await import('./render.js');
  const preview = await verifyNativePreview(verified.candidate.scene, await fs.readFile(paths.preview));
  const proof = { refresh: { file: report.refresh.file, sha256: report.refresh.sha256 } };
  for (const name of ['current', 'generated']) proof[name] = {
    file: posix.join(posix.dirname(report.refresh.file), `${name}.excalidraw`), sha256: verified[name].sha256,
  };
  for (const [name, entry] of Object.entries(artifacts)) {
    if (sha256(await fs.readFile(paths[name])) !== entry.sha256) fail('STALE_ARTIFACT', 'Runtime artifacts changed during verification');
  }
  for (const entry of Object.values(proof)) {
    if (sha256(await fs.readFile(await regularFile(request.outputDir, entry.file))) !== entry.sha256) fail('STALE_ARTIFACT', 'Refresh proof changed during qualification');
  }
  return { artifacts, proof, preview };
}

export async function readDiagramJob(receiptPath, { expectedHash } = {}) {
  const bytes = await fs.readFile(receiptPath);
  if (expectedHash !== undefined && sha256(bytes) !== expectedHash) fail('CORRUPT_JOB', 'Job receipt hash differs from the retained hash');
  const receipt = JSON.parse(bytes.toString());
  if (receipt.schemaVersion !== 1 || !HASH.test(receipt.jobKey ?? '') ||
      !REVISION.test(receipt.sourceRevision ?? '') || !REVISION.test(receipt.baseRevision ?? '') ||
      !['completed', 'failed', 'skipped', 'superseded'].includes(receipt.status)) fail('CORRUPT_JOB', 'Invalid job receipt');
  if (receipt.status === 'completed' && (!HASH.test(receipt.baselineHash ?? '') || receipt.trusted !== true ||
      !['ready', 'unchanged'].includes(receipt.result) || ['native', 'preview', 'evidence', 'report'].some(name => !receipt.artifacts?.[name]) ||
      receipt.verification?.method !== 'three-way-native-v1' || receipt.verification.preview?.pixelMatch !== true ||
      ['refresh', 'current', 'generated', 'baseline', 'baselineGenerated', 'baselineDelivered', 'input'].some(name => !receipt.verification.artifacts?.[name]))) {
    fail('CORRUPT_JOB', 'A completed job must retain its qualified artifacts and accepted baseline');
  }
  for (const entry of [...Object.values(receipt.artifacts ?? {}), ...Object.values(receipt.verification?.artifacts ?? {})]) {
    let bytes;
    try { bytes = await fs.readFile(await regularFile(dirname(resolve(receiptPath)), entry.file)); }
    catch { fail('CORRUPT_JOB', 'A retained job artifact is missing or outside its boundary'); }
    if (!HASH.test(entry.sha256 ?? '') || sha256(bytes) !== entry.sha256) fail('CORRUPT_JOB', 'A retained job artifact changed');
  }
  return { receiptPath: resolve(receiptPath), sha256: sha256(bytes), receipt };
}

/** stateDir is a restored, trusted artifact directory, not the source checkout.
 * Outputs are immutable per revision/configuration; baseline adoption is separate. */
export async function runDiagramJob({ repositoryPath, stateDir, config: unchecked, event }, { runner } = {}) {
  const config = checkedConfig(unchecked);
  if (!REVISION.test(event?.sourceRevision ?? '') || !REVISION.test(event?.baseRevision ?? '') ||
      !/^refs\/(heads|remotes|pull)\/[A-Za-z0-9._/-]+$/.test(event?.headRef ?? '') || event.headRef.includes('..') ||
      !['push', 'pull_request', 'manual'].includes(event.trigger) || typeof event.trusted !== 'boolean') fail('INVALID_EVENT', 'Use exact commits, an explicit head ref, trigger, and trusted event classification');
  const repository = await fs.realpath(resolve(repositoryPath));
  const top = (await git(repository, ['rev-parse', '--show-toplevel'])).toString().trim();
  if (await fs.realpath(top) !== repository) fail('SOURCE_BOUNDARY', 'repositoryPath must identify the repository root');
  const state = resolve(stateDir);
  if (state === repository || state.startsWith(`${repository}/`)) fail('STATE_BOUNDARY', 'Persist trusted CI state outside the source checkout');
  await fs.mkdir(state, { recursive: true });
  const keyInput = { config, sourceRevision: event.sourceRevision, baseRevision: event.baseRevision, headRef: event.headRef, trigger: event.trigger, trusted: event.trusted };
  const jobKey = sha256(canonical(keyInput));
  const directory = join(state, config.output, config.id, jobKey);
  const receiptPath = join(directory, 'job.json');
  try { return { ...(await readDiagramJob(receiptPath)), duplicate: true }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, { recursive: true });
  const attempt = await claim(directory);
  const attemptDir = join(directory, 'attempts', attempt);
  await fs.mkdir(attemptDir, { recursive: true });
  const receipt = { schemaVersion: 1, jobKey, configId: config.id, sourceRevision: event.sourceRevision,
    baseRevision: event.baseRevision, headRef: event.headRef, trusted: event.trusted, config, attempt, artifacts: {} };
  await write(join(attemptDir, 'request.json'), `${JSON.stringify(keyInput, null, 2)}\n`);
  try {
    if (!event.trusted) fail('UNTRUSTED_EXECUTION', 'Untrusted source events cannot execute a credentialed diagram workflow');
    if (event.trigger !== config.trigger) { receipt.status = 'skipped'; receipt.reason = 'trigger-not-configured'; }
    else if (await revision(repository, event.headRef) !== event.sourceRevision) { receipt.status = 'superseded'; receipt.reason = 'source-head-changed'; }
    else {
      if (await revision(repository, event.baseRevision) !== event.baseRevision || await revision(repository, event.sourceRevision) !== event.sourceRevision) fail('INVALID_EVENT', 'Exact source commits are unavailable');
      const changedPaths = (await git(repository, ['diff', '--name-only', '-z', '--no-renames', event.baseRevision, event.sourceRevision, '--'])).toString().split('\0').filter(Boolean);
      receipt.changedPaths = changedPaths.filter(path => config.sourcePaths.some(parent => inside(path, parent)));
      if (!receipt.changedPaths.length) { receipt.status = 'skipped'; receipt.reason = 'no-relevant-source-changes'; }
      else {
        const baselinePath = await regularFile(state, config.baseline.bundlePath);
        const baseline = await readEvidenceBundle(baselinePath, { expectedHash: config.baseline.sha256 });
        if (!baseline.generatedScene) fail('MISSING_BASELINE', 'CI refresh requires an explicitly accepted generated baseline');
        const inputDir = join(attemptDir, 'input');
        const outputDir = join(attemptDir, 'output');
        await fs.mkdir(inputDir); await fs.mkdir(outputDir);
        for (const file of ['evidence.json', 'delivered.excalidraw', 'generated.excalidraw']) {
          const path = await regularFile(dirname(baselinePath), file);
          await write(join(inputDir, file), await fs.readFile(path));
        }
        await readEvidenceBundle(join(inputDir, 'evidence.json'), { expectedHash: config.baseline.sha256 });
        const tree = (await git(repository, ['ls-tree', '-z', event.sourceRevision, '--', config.diagramPath])).toString();
        const entry = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(tree);
        if (!entry || entry[3] !== config.diagramPath) fail('INVALID_DIAGRAM', 'Diagram must be a regular file at the exact source revision');
        const currentBytes = await git(repository, ['cat-file', 'blob', entry[2]]);
        validateScene(JSON.parse(currentBytes.toString()));
        const currentPath = join(inputDir, 'current.excalidraw');
        await write(currentPath, currentBytes);
        const request = { schemaVersion: 1, requestId: jobKey, repositoryPath: repository,
          baseRevision: event.baseRevision, sourceRevision: event.sourceRevision, sourcePaths: config.sourcePaths,
          baselineBundlePath: join(inputDir, 'evidence.json'), baselineHash: config.baseline.sha256, currentPath, outputDir };
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error('Configured execution budget expired'), { code: 'EXECUTION_TIMEOUT' }));
        }, config.execution.timeoutMs); });
        let result;
        try { result = await Promise.race([(runner ?? commandRunner(config.execution))(structuredClone(request), { signal: controller.signal }), timeout]); }
        finally { clearTimeout(timer); }
        const { artifacts, proof, preview } = await verifyOutput(result, request);
        await readEvidenceBundle(join(inputDir, 'evidence.json'), { expectedHash: config.baseline.sha256 });
        if (sha256(await fs.readFile(currentPath)) !== sha256(currentBytes)) fail('STALE_INPUT', 'Runtime changed the retained native input');
        receipt.artifacts = Object.fromEntries(Object.entries(artifacts).map(([name, item]) => [name, {
          ...item, file: `attempts/${attempt}/output/${item.file}`,
        }]));
        const retained = Object.fromEntries(Object.entries(proof).map(([name, item]) => [name, { ...item, file: `attempts/${attempt}/output/${item.file}` }]));
        for (const [name, file] of Object.entries({ baseline: 'evidence.json', baselineGenerated: 'generated.excalidraw', baselineDelivered: 'delivered.excalidraw', input: 'current.excalidraw' })) {
          retained[name] = { file: `attempts/${attempt}/input/${file}`, sha256: sha256(await fs.readFile(join(inputDir, file))) };
        }
        receipt.verification = { method: 'three-way-native-v1', preview, artifacts: retained };
        receipt.baselineHash = config.baseline.sha256;
        receipt.result = result.status;
        receipt.status = await revision(repository, event.headRef) === event.sourceRevision ? 'completed' : 'superseded';
        if (receipt.status === 'superseded') receipt.reason = 'source-head-changed';
      }
    }
  } catch (error) {
    receipt.status = 'failed';
    // Do not retain runtime stderr or credentials in a public failure artifact.
    receipt.error = { code: error.code ?? 'JOB_FAILED', message: ['EXECUTION_TIMEOUT', 'RUNTIME_FAILED', 'RUNTIME_UNAVAILABLE', 'UNQUALIFIED_RESULT', 'UNQUALIFIED_REFRESH', 'INVALID_PREVIEW', 'PREVIEW_MISMATCH', 'PREVIEW_BROWSER_MISSING', 'UNTRUSTED_EXECUTION', 'MISSING_BASELINE'].includes(error.code)
      ? error.message : `Diagram job failed (${error.code ?? 'validation-error'}); no output was qualified` };
    receipt.artifacts = {};
  }
  const hash = await publish(receiptPath, receipt);
  return { receiptPath, sha256: hash, receipt, duplicate: false };
}
