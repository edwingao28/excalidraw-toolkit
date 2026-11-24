import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareForkPublication } from '../../src/ci-fork.js';

// Runs in the publish job of fork-publish.yml on state written by the trusted
// qualify job of the same run. It rechecks every artifact hash, stages uniquely
// named release assets and writes the request for publish-job.mjs. It writes no
// request unless the job completed, so the workflow then publishes nothing.
const names = ['state', 'qualified', 'repository', 'tag', 'actor', 'assets', 'publication-state', 'out'];
const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
if (names.some(name => !values[name])) throw new Error(`Provide --${names.join(', --')}`);
const qualified = JSON.parse(await readFile(values.qualified, 'utf8'));
if (qualified.status !== 'completed') {
  console.log(JSON.stringify({ status: 'skipped', reason: qualified.reason ?? qualified.error?.code ?? qualified.status }));
} else {
  const result = await prepareForkPublication({
    receiptPath: join(values.state, qualified.receiptFile), receiptHash: qualified.receiptHash,
    repository: values.repository, releaseTag: values.tag, pullNumber: qualified.pullNumber,
    sourceRepository: qualified.sourceRepository, actor: values.actor, assetDir: values.assets,
    publicationStateDir: values['publication-state'],
  });
  if (result.status === 'ready') await writeFile(values.out, `${JSON.stringify(result.request, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, reason: result.reason }));
}
