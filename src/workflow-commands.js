import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './scene.js';

export const WORKFLOW_COMMANDS = Object.freeze(['validate-evidence', 'associate-evidence', 'accept-baseline', 'explain-change', 'refresh-diagram', 'adopt-refresh']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

async function readRequest(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.trim()) fail('INVALID_REQUEST', 'Provide a JSON request file with --request');
  const path = resolve(requestPath);
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('INVALID_REQUEST', 'Request must be a JSON file no larger than 32 MiB');
  let request;
  try { request = JSON.parse(await fs.readFile(path, 'utf8')); }
  catch { fail('INVALID_REQUEST', 'Request file contains invalid JSON'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST', 'Request must contain one JSON object');
  return { request, directory: dirname(path) };
}

function requestOptions(request, directory, values, allowed, pathFields) {
  if (Object.keys(request).some(key => !allowed.includes(key))) fail('INVALID_REQUEST', 'Request contains unsupported fields for this command');
  const options = structuredClone(request);
  for (const key of pathFields) {
    if (options[key] === undefined) continue;
    if (typeof options[key] !== 'string' || !options[key].trim()) fail('INVALID_REQUEST', `${key} must be a filesystem path`);
    options[key] = resolve(directory, options[key]);
  }
  if (values.output !== undefined) {
    if (!allowed.includes('outputDir')) fail('INVALID_REQUEST', '--output does not apply to this command');
    const output = resolve(values.output);
    if (options.outputDir !== undefined && output !== options.outputDir) fail('INVALID_REQUEST', '--output conflicts with request.outputDir');
    options.outputDir = output;
  }
  return options;
}

async function refreshPreviews(result, renderer) {
  const directory = dirname(result.receiptPath);
  const manifestPath = join(directory, 'previews.json');
  const verify = async () => {
    const bytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(bytes.toString());
    if (manifest.refreshHash !== result.sha256 || manifest.schemaVersion !== 1 || manifest.refreshStatus !== result.receipt.status ||
        !manifest.images?.before || !(manifest.images.after ?? manifest.images.proposal) || Object.keys(manifest.images).length !== 2) fail('CORRUPT_PREVIEW', 'Preview manifest identifies another or incomplete refresh');
    for (const entry of Object.values(manifest.images)) {
      if (!/^previews\/[a-f0-9-]+\/(before|after|proposal)\.png$/.test(entry.file) ||
          !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail('CORRUPT_PREVIEW', 'Invalid retained refresh preview reference');
      let image;
      try { image = await fs.readFile(join(directory, entry.file)); }
      catch { fail('CORRUPT_PREVIEW', 'A retained refresh preview is unavailable'); }
      if (sha256(image) !== entry.sha256) fail('CORRUPT_PREVIEW', 'A retained refresh preview changed');
    }
    return { manifestPath, sha256: sha256(bytes), manifest };
  };
  try { return await verify(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const attempt = `previews/${randomUUID()}`;
  await fs.mkdir(join(directory, attempt), { recursive: true });
  const images = {};
  const sides = { before: 'current', ...(result.receipt.artifacts.candidate ? { after: 'candidate' } : { proposal: 'generated' }) };
  for (const [side, key] of Object.entries(sides)) {
    const native = result.receipt.artifacts[key];
    const bytes = await fs.readFile(join(directory, native.file));
    if (sha256(bytes) !== native.sha256) fail('CORRUPT_REFRESH', 'A refresh native artifact changed before preview');
    const file = `${attempt}/${side}.png`;
    await renderer(JSON.parse(bytes.toString()), join(directory, file));
    const png = await fs.readFile(join(directory, file));
    if (png.length <= 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('INVALID_PREVIEW', 'Native renderer did not produce a PNG');
    images[side] = { file, sha256: sha256(png), native: key };
    const handle = await fs.open(join(directory, file), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  for (const entry of Object.values(result.receipt.artifacts).filter(Boolean)) {
    if (sha256(await fs.readFile(join(directory, entry.file))) !== entry.sha256) fail('CORRUPT_REFRESH', 'Renderer changed a retained native artifact');
  }
  const bytes = `${JSON.stringify({ schemaVersion: 1, refreshHash: result.sha256, refreshStatus: result.receipt.status, images }, null, 2)}\n`;
  const pending = join(directory, `${attempt}/manifest.pending.json`);
  const handle = await fs.open(pending, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.link(pending, manifestPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.unlink(pending);
  return verify();
}

/** JSON command boundary. It returns data; the CLI owns printing and exit codes.
 * Filesystem paths in requests are relative to the request file, not shell cwd. */
export async function workflowCommand(command, requestPath, values = {}, dependencies = {}) {
  if (!WORKFLOW_COMMANDS.includes(command)) fail('UNKNOWN_COMMAND', `Unknown workflow command: ${command}`);
  const { request, directory } = await readRequest(requestPath);
  if (command === 'adopt-refresh') {
    const options = requestOptions(request, directory, values, ['receiptPath', 'expectedHash', 'outputDir'], ['receiptPath', 'outputDir']);
    const { adoptRefresh } = await import('./refresh.js');
    return adoptRefresh(options);
  }
  if (command === 'refresh-diagram') {
    const options = requestOptions(request, directory, values,
      ['requestId', 'baselineBundlePath', 'baselineHash', 'currentPath', 'generatedPath', 'repositoryPath', 'evidence', 'removedSemanticIds', 'outputDir'],
      ['baselineBundlePath', 'currentPath', 'generatedPath', 'repositoryPath', 'outputDir']);
    const { stageRefresh } = await import('./refresh.js');
    const result = await stageRefresh(options);
    const renderer = dependencies.renderScene ?? (await import('./render.js')).renderScene;
    return { ...result, previews: await refreshPreviews(result, renderer) };
  }
  if (command === 'explain-change') {
    const options = requestOptions(request, directory, values,
      ['repositoryPath', 'base', 'head', 'target', 'required', 'repositoryUrl', 'outputDir'], ['repositoryPath', 'outputDir']);
    for (const side of ['base', 'head']) {
      if (!options[side] || typeof options[side] !== 'object' || Array.isArray(options[side])) fail('INVALID_REQUEST', `Provide the ${side} evidence bundle and revision`);
      options[side] = requestOptions(options[side], directory, {}, ['bundlePath', 'revision', 'expectedHash'], ['bundlePath']);
    }
    const { exportComparison } = await import('./explain.js');
    const renderer = dependencies.targetRenderer ?? await import('./target-render.js');
    return exportComparison(options, renderer);
  }
  const paths = ['repositoryPath', 'inputPath'];
  const allowed = [...paths, 'evidence'];
  if (command !== 'validate-evidence') { paths.push('outputDir'); allowed.push('outputDir'); }
  if (command === 'accept-baseline') { paths.push('generatedPath'); allowed.push('generatedPath'); }
  const options = requestOptions(request, directory, values, allowed, paths);
  const evidence = await import('./evidence.js');
  if (command === 'validate-evidence') return evidence.validateEvidence(options);
  if (command === 'associate-evidence') return evidence.associateEvidence(options);
  return evidence.acceptEvidenceBaseline(options);
}
