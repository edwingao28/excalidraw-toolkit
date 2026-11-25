import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runDiagramJob } from '../../src/ci.js';
import { acceptEvidenceBaseline } from '../../src/evidence.js';

// Runs one real refresh of the sample diagram from the repository root (the
// sandbox branch checkout). The accepted baseline is built at --base from the
// committed evidence, then the job runs the Claude Code adapter at --source.
const { values } = parseArgs({ options: {
  base: { type: 'string' }, source: { type: 'string' }, state: { type: 'string' }, claude: { type: 'string', default: 'claude' },
  model: { type: 'string' }, 'max-budget-usd': { type: 'string' }, 'max-turns': { type: 'string', default: '40' },
} });
if (!values.base || !values.source || !values.state) throw new Error('Provide --base, --source and --state');
const root = process.cwd(), state = resolve(values.state);
const diagram = 'examples/live-validation/request-flow.excalidraw';
const evidence = JSON.parse(readFileSync(join(root, 'examples/live-validation/evidence.json'), 'utf8'));
const baseline = await acceptEvidenceBaseline({ repositoryPath: root, inputPath: join(root, diagram), generatedPath: join(root, diagram),
  evidence: { ...evidence, source: { kind: 'git', revision: values.base } }, outputDir: join(state, 'baseline') });
const adapter = new URL('../ci/claude-code-adapter.mjs', import.meta.url).pathname;
const config = { schemaVersion: 1, id: 'live-validation', sourcePaths: ['examples/live-validation/src'], diagramPath: diagram, trigger: 'manual',
  baseline: { bundlePath: 'baseline/evidence.json', sha256: baseline.sha256 }, output: 'jobs',
  execution: { version: 'claude-code-adapter-v1', executable: process.execPath, timeoutMs: 1_200_000, forwardEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    args: [adapter, '--claude', values.claude, '--max-turns', values['max-turns'],
      ...(values.model ? ['--model', values.model] : []), ...(values['max-budget-usd'] ? ['--max-budget-usd', values['max-budget-usd']] : [])] } };
const job = await runDiagramJob({ repositoryPath: root, stateDir: state, config,
  event: { trigger: 'manual', baseRevision: values.base, sourceRevision: values.source, headRef: 'refs/heads/live-validation', trusted: true } });
const result = { status: job.receipt.status, receiptFile: relative(state, job.receiptPath), receiptHash: job.sha256,
  sourceRevision: job.receipt.sourceRevision, ...(job.receipt.error ? { error: job.receipt.error } : {}), ...(job.receipt.reason ? { reason: job.receipt.reason } : {}) };
writeFileSync(join(state, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'completed') process.exitCode = 1;
