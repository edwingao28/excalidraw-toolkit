import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runDiagramJob } from '../../src/ci.js';

const { values } = parseArgs({ options: Object.fromEntries(
  ['repository', 'state', 'config', 'event'].map(name => [name, { type: 'string' }]),
) });
if (Object.keys(values).length !== 4) throw new Error('Provide --repository, --state, --config and --event');
const result = await runDiagramJob({ repositoryPath: values.repository, stateDir: values.state,
  config: JSON.parse(await readFile(values.config, 'utf8')), event: JSON.parse(await readFile(values.event, 'utf8')) });
console.log(JSON.stringify(result, null, 2));
if (result.receipt.status === 'failed') process.exitCode = 1;
