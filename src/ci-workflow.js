import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { workflowCommand } from './workflow-commands.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Adapt an already investigated source proposal to the same interactive
 * refresh command. This adapter performs no model inference or source guessing. */
export async function runPreparedRefresh(job, proposalPath, dependencies = {}) {
  const path = resolve(proposalPath);
  const proposal = JSON.parse(await fs.readFile(path, 'utf8'));
  if (!proposal || proposal.command !== 'refresh-diagram' ||
      Object.keys(proposal).some(key => !['command', 'generatedPath', 'evidence', 'removedSemanticIds'].includes(key)) ||
      typeof proposal.generatedPath !== 'string' || !proposal.generatedPath.trim() ||
      proposal.evidence?.source?.kind !== 'git' || proposal.evidence.source.revision !== job.sourceRevision) {
    fail('INVALID_PROPOSAL', 'Provide a prepared refresh-diagram proposal at the exact requested Git revision');
  }
  const requestPath = join(job.outputDir, 'refresh-request.json');
  const request = { requestId: job.requestId, baselineBundlePath: job.baselineBundlePath, baselineHash: job.baselineHash,
    currentPath: job.currentPath, generatedPath: resolve(dirname(path), proposal.generatedPath), repositoryPath: job.repositoryPath,
    evidence: proposal.evidence, ...(proposal.removedSemanticIds ? { removedSemanticIds: proposal.removedSemanticIds } : {}),
    outputDir: join(job.outputDir, 'refresh') };
  await fs.writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
  const result = await workflowCommand('refresh-diagram', requestPath, {}, dependencies);
  if (!['ready', 'unchanged'].includes(result.receipt.status) || result.receipt.conflicts.length || !result.receipt.artifacts.candidate) {
    fail('RECONCILIATION_REQUIRED', 'Prepared source refresh has unresolved conflicts; inspect its retained receipt and previews');
  }
  const report = { schemaVersion: 1, status: result.receipt.status, sourceRevision: job.sourceRevision, baseRevision: job.baseRevision,
    changes: result.receipt.changes, conflicts: result.receipt.conflicts, overrides: result.receipt.overrides,
    refresh: { file: 'refresh/refresh.json', sha256: result.sha256 }, previews: result.previews.manifest,
    validation: { semanticClaims: false, runtimeBehavior: false, visualAcceptance: false } };
  await fs.writeFile(join(job.outputDir, 'evidence.json'), JSON.stringify(proposal.evidence), { flag: 'wx' });
  await fs.writeFile(join(job.outputDir, 'change-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  return { status: result.receipt.status, artifacts: {
    native: 'refresh/candidate.excalidraw', preview: `refresh/${result.previews.manifest.images.after.file}`,
    evidence: 'evidence.json', report: 'change-report.json',
  } };
}
