#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runPreparedRefresh } from '../src/ci-workflow.js';

const { values } = parseArgs({ options: { proposal: { type: 'string' } } });
if (!values.proposal) throw new Error('Provide --proposal for an already investigated refresh request');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 32 * 1024 * 1024) throw new Error('CI request exceeds 32 MiB');
}
const result = await runPreparedRefresh(JSON.parse(input), values.proposal);
process.stdout.write(`${JSON.stringify(result)}\n`);
