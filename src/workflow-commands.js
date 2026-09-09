import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const WORKFLOW_COMMANDS = Object.freeze(['validate-evidence', 'associate-evidence', 'accept-baseline', 'explain-change']);
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

/** JSON command boundary. It returns data; the CLI owns printing and exit codes.
 * Filesystem paths in requests are relative to the request file, not shell cwd. */
export async function workflowCommand(command, requestPath, values = {}, dependencies = {}) {
  if (!WORKFLOW_COMMANDS.includes(command)) fail('UNKNOWN_COMMAND', `Unknown workflow command: ${command}`);
  const { request, directory } = await readRequest(requestPath);
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
