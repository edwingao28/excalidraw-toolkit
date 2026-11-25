import { parseArgs } from 'node:util';
import { proposeWithClaudeCode } from '../../src/claude-adapter.js';
import { runPreparedRefresh } from '../../src/ci-workflow.js';

// A reviewed runtime adapter for runDiagramJob (docs/ci.md, "Existing workflow
// contract"): one job request on stdin, one artifact manifest on stdout. Claude
// Code runs headless with read-only tools; the toolkit stages and qualifies the
// refresh. Configure it as the job's execution, for example:
//   "executable": "/abs/path/to/node",
//   "args": ["/abs/path/to/examples/ci/claude-code-adapter.mjs", "--claude", "/abs/path/to/claude"],
//   "forwardEnv": ["CLAUDE_CODE_OAUTH_TOKEN"]
const { values } = parseArgs({ options: {
  claude: { type: 'string', default: 'claude' }, model: { type: 'string' },
  'max-turns': { type: 'string', default: '40' }, 'max-budget-usd': { type: 'string' }, bare: { type: 'boolean', default: false },
} });
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  const proposalPath = await proposeWithClaudeCode(request, { claude: values.claude, model: values.model, bare: values.bare,
    maxTurns: Number(values['max-turns']), maxBudgetUsd: values['max-budget-usd'] ? Number(values['max-budget-usd']) : undefined });
  process.stdout.write(JSON.stringify(await runPreparedRefresh(request, proposalPath)));
} catch (error) {
  console.error(`${error.code ?? 'ADAPTER_FAILED'}: ${error.message}`);
  process.exitCode = 1;
}
