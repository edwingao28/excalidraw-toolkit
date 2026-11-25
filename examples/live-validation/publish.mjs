import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readDiagramJob } from '../../src/ci.js';
import { sha256 } from '../../src/scene.js';

// Stages a completed live-validation job's four artifacts as uniquely named
// release assets and writes the request for examples/ci/publish-job.mjs. It
// writes no request unless the job completed, so nothing is then published.
const names = ['state', 'repository', 'pr', 'tag', 'assets', 'publication-state', 'out'];
const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
if (names.some(name => !values[name])) throw new Error(`Provide --${names.join(', --')}`);
const result = JSON.parse(readFileSync(join(values.state, 'result.json'), 'utf8'));
if (result.status !== 'completed') {
  console.log(JSON.stringify({ status: 'skipped', reason: result.reason ?? result.error?.code ?? result.status }));
  process.exit(0);
}
const receiptPath = join(resolve(values.state), result.receiptFile);
const { receipt } = await readDiagramJob(receiptPath, { expectedHash: result.receiptHash });
mkdirSync(values.assets, { recursive: true });
const artifacts = {};
for (const name of ['native', 'preview', 'evidence', 'report']) {
  const entry = receipt.artifacts[name];
  const bytes = readFileSync(join(dirname(receiptPath), entry.file));
  if (sha256(bytes) !== entry.sha256) throw new Error('A qualified artifact changed before upload');
  const asset = `${receipt.jobKey.slice(0, 16)}-${name}-${basename(entry.file)}`;
  writeFileSync(join(values.assets, asset), bytes, { flag: 'wx' });
  artifacts[name] = { url: `https://github.com/${values.repository}/releases/download/${values.tag}/${encodeURIComponent(asset)}`, sha256: entry.sha256 };
}
const [owner, repo] = values.repository.split('/');
writeFileSync(values.out, `${JSON.stringify({ receiptPath, receiptHash: result.receiptHash, stateDir: resolve(values['publication-state']),
  publication: { enabled: true, owner, repo, pullNumber: Number(values.pr), actor: 'github-actions[bot]', forkPolicy: 'deny', visibility: 'public',
    artifactOrigins: ['https://github.com'], artifacts },
  context: { trustedWorkflow: true, sourceRepository: values.repository, sourceRevision: receipt.sourceRevision } }, null, 2)}\n`);
console.log(JSON.stringify({ status: 'ready', assets: Object.keys(artifacts).length }));
