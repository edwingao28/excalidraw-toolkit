import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { qualifyForkPullRequest } from '../../src/ci-fork.js';

// Runs in the trusted, read-only qualify job of fork-publish.yml, from the
// default-branch checkout (the current directory). --pr comes from the PR's own
// workflow and is untrusted: only its number is read, then checked against the
// live pull request and the triggering run.
const names = ['repository', 'state', 'baseline', 'config', 'run', 'pr', 'workflow', 'out'];
const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
if (names.some(name => !values[name])) throw new Error(`Provide --${names.join(', --')}`);
const pr = JSON.parse(await readFile(values.pr, 'utf8'));
const result = await qualifyForkPullRequest({
  repositoryPath: '.', stateDir: values.state, baselineDir: values.baseline,
  config: JSON.parse(await readFile(values.config, 'utf8')), run: JSON.parse(await readFile(values.run, 'utf8')),
  pullNumber: pr?.number, repository: values.repository, workflowPath: values.workflow,
}, { token: process.env.GH_TOKEN });
await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (result.status === 'failed') process.exitCode = 1;
