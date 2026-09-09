import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { publishDiagramJob } from '../../src/publication.js';

const { values } = parseArgs({ options: { enabled: { type: 'boolean', default: false }, request: { type: 'string' } } });
if (!values.enabled) {
  console.log(JSON.stringify({ status: 'disabled' }));
} else {
  if (!values.request) throw new Error('Provide --request pointing to a trusted publication request');
  const options = JSON.parse(await readFile(values.request, 'utf8'));
  const result = await publishDiagramJob(options, { token: process.env.GH_TOKEN });
  console.log(JSON.stringify(result, null, 2));
  if (!['created', 'updated', 'reconciled', 'unchanged', 'disabled'].includes(result.status)) process.exitCode = 1;
}
