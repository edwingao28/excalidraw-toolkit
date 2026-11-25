import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_OUTPUT = 64 * 1024 * 1024;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

const ID = { type: 'string', minLength: 1 };
const IDS = { type: 'array', items: ID };
// The model returns the regenerated scene and its evidence as validated JSON;
// the toolkit then checks every reference, mapping and the three-way merge.
export const PROPOSAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['generatedScene', 'evidence', 'removedSemanticIds', 'summary'],
  properties: {
    generatedScene: { type: 'object', required: ['type', 'version', 'elements'],
      properties: { type: { const: 'excalidraw' }, version: { type: 'integer' }, elements: { type: 'array', items: { type: 'object' } }, appState: { type: 'object' }, files: { type: 'object' } } },
    evidence: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'scope', 'references', 'nodes', 'relations'], properties: {
      schemaVersion: { const: 1 },
      scope: { type: 'object', additionalProperties: false, required: ['question', 'paths', 'coverage', 'unknowns'], properties: {
        question: ID, paths: { type: 'array', minItems: 1, items: ID }, coverage: { const: 'partial' }, unknowns: { type: 'array', items: ID } } },
      references: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'path', 'startLine', 'endLine', 'symbol'], properties: {
        id: ID, path: ID, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, symbol: ID } } },
      nodes: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['semanticId', 'elementId', 'referenceIds'], properties: {
        semanticId: ID, elementId: ID, referenceIds: IDS } } },
      relations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['semanticId', 'elementId', 'from', 'to', 'kind', 'claim', 'referenceIds'], properties: {
        semanticId: ID, elementId: ID, from: ID, to: ID, kind: { enum: ['import', 'call', 'assumption'] }, claim: ID, referenceIds: IDS } } },
    } },
    removedSemanticIds: IDS,
    summary: { type: 'string' },
  },
};

function prompt(request, changedPaths) {
  return [
    'You are refreshing an existing Excalidraw architecture diagram after a source change. Work only from files; do not ask questions.',
    `Repository: the current directory, checked out at commit ${request.sourceRevision}. The previous accepted state is commit ${request.baseRevision}.`,
    `Scope: only these source paths: ${request.sourcePaths.join(', ')}.`,
    `Changed files in scope: ${changedPaths.length ? changedPaths.join(', ') : 'none listed'}. The full diff is in input/changes.diff.`,
    'Inputs in the added input directory:',
    '- input/baseline-generated.excalidraw: the last accepted generated diagram. Start from it.',
    '- input/baseline-evidence.json: its evidence. Its "evidence" object shows the expected shape and the semantic IDs to keep.',
    '- input/current.excalidraw: the diagram people edit. Read it for context only; the toolkit merges their edits separately.',
    'Produce a regenerated proposal:',
    '1. Copy baseline-generated.excalidraw and change only what the source change requires. Keep every unchanged element, its ID and its fields exactly.',
    '2. New shapes are native rectangles with a bound text label (containerId set, and listed in the shape\'s boundElements). New connections are native arrows whose startBinding.elementId and endBinding.elementId name the shapes, listed in both shapes\' boundElements. Give new elements new, stable, descriptive IDs.',
    '3. Evidence: every node maps a semanticId to a shape elementId with at least one reference; every relation maps an arrow to its from/to node semanticIds, with kind "call" or "import" backed by references, or "assumption" (no references required) whose arrow label text starts with "Assumption".',
    '4. References cite exact 1-based line ranges in files at the current commit, within the scope paths, with the symbol named on those lines. Read the files to get line numbers right.',
    '5. Keep existing semanticIds for the same concepts. List any semanticId you intentionally removed in removedSemanticIds.',
    'Return the result through the structured output only.',
  ].join('\n');
}

/** Ask Claude Code, headless and read-only, for a regenerated scene and its
 * evidence, and write them as a prepared refresh proposal. The run gets an
 * empty HOME, user settings only, no MCP servers and Read/Glob/Grep only, so a
 * repository's own settings, hooks or MCP config are not loaded. */
export async function proposeWithClaudeCode(request, { claude = 'claude', model, maxTurns = 40, maxBudgetUsd, bare = false, env = process.env } = {}) {
  const work = join(request.outputDir, 'agent');
  const input = join(work, 'input');
  await fs.mkdir(input, { recursive: true });
  await fs.copyFile(request.currentPath, join(input, 'current.excalidraw'));
  await fs.copyFile(join(dirname(request.baselineBundlePath), 'generated.excalidraw'), join(input, 'baseline-generated.excalidraw'));
  await fs.copyFile(request.baselineBundlePath, join(input, 'baseline-evidence.json'));
  const git = args => execute('git', ['--no-pager', '--literal-pathspecs', '-C', request.repositoryPath, ...args], { maxBuffer: MAX_OUTPUT, encoding: 'utf8' });
  const range = `${request.baseRevision}..${request.sourceRevision}`;
  const changedPaths = (await git(['diff', '--name-only', range, '--', ...request.sourcePaths])).stdout.split('\n').filter(Boolean);
  await fs.writeFile(join(input, 'changes.diff'), (await git(['diff', range, '--', ...request.sourcePaths])).stdout);

  const home = await fs.mkdtemp(join(tmpdir(), 'toolkit-claude-home-'));
  const args = ['-p', prompt(request, changedPaths), '--output-format', 'json', '--json-schema', JSON.stringify(PROPOSAL_SCHEMA),
    '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--add-dir', input, '--no-session-persistence',
    '--max-turns', String(maxTurns), '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(model ? ['--model', model] : []), ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []), ...(bare ? ['--bare'] : [])];
  // Only what the run needs: the controller already limited env to explicitly
  // forwarded credentials, and GitHub variables are never forwarded.
  const childEnv = Object.fromEntries(Object.entries({ PATH: env.PATH, TMPDIR: env.TMPDIR, SYSTEMROOT: env.SYSTEMROOT, HOME: home,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, DISABLE_AUTOUPDATER: '1' })
    .filter(([, value]) => value !== undefined));
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      const child = spawn(claude, args, { cwd: request.repositoryPath, env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
      const chunks = []; let bytes = 0;
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) child.kill('SIGKILL'); else chunks.push(chunk); });
      child.on('error', error => reject(Object.assign(new Error(`Claude Code is unavailable: ${error.message}`), { code: 'RUNTIME_UNAVAILABLE' })));
      child.on('close', code => resolve({ code, text: Buffer.concat(chunks).toString('utf8') }));
    });
  } finally { await fs.rm(home, { recursive: true, force: true }); }
  let result;
  try { result = JSON.parse(output.text); } catch { fail('RUNNER_OUTPUT', `Claude Code exited ${output.code} without a JSON result`); }
  await fs.writeFile(join(work, 'run.json'), `${JSON.stringify({ exitCode: output.code, subtype: result.subtype, isError: result.is_error,
    numTurns: result.num_turns, totalCostUsd: result.total_cost_usd, summary: result.structured_output?.summary ?? null }, null, 2)}\n`);
  const proposal = result.structured_output;
  if (output.code !== 0 || result.subtype !== 'success' || result.is_error || !proposal || typeof proposal !== 'object') {
    fail('RUNTIME_FAILED', `Claude Code did not return a structured proposal (${result.subtype ?? 'no result'})`);
  }
  await fs.writeFile(join(work, 'generated.excalidraw'), `${JSON.stringify(proposal.generatedScene, null, 2)}\n`);
  const proposalPath = join(work, 'proposal.json');
  // The proposal names no revision; it is pinned to the job's exact commit.
  await fs.writeFile(proposalPath, JSON.stringify({ command: 'refresh-diagram', generatedPath: 'generated.excalidraw',
    evidence: { ...proposal.evidence, source: { kind: 'git', revision: request.sourceRevision } },
    ...(proposal.removedSemanticIds.length ? { removedSemanticIds: proposal.removedSemanticIds } : {}) }));
  return proposalPath;
}
