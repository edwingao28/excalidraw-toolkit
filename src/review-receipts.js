import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256, validateScene } from './scene.js';

const HASH = /^[a-f0-9]{64}$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'CORRUPT_REVIEW' }); };

async function readReport(path, expectedHash) {
  const bytes = await fs.readFile(path);
  if (expectedHash !== undefined && (!HASH.test(expectedHash) || sha256(bytes) !== expectedHash)) fail('Review receipt differs from its retained hash');
  let report;
  try { report = JSON.parse(bytes.toString()); } catch { fail('Review receipt contains invalid JSON'); }
  return { report, hash: sha256(bytes) };
}

async function artifact(directory, entry, name, native = false) {
  if (entry?.file !== name || !HASH.test(entry.sha256 ?? '')) fail(`Invalid retained artifact: ${name}`);
  const path = join(directory, name);
  let bytes;
  try {
    if (!(await fs.lstat(path)).isFile()) fail(`Artifact must be a regular file: ${name}`);
    bytes = await fs.readFile(path);
  } catch { fail(`Cannot read retained artifact: ${name}`); }
  if (sha256(bytes) !== entry.sha256) fail(`Retained artifact changed: ${name}`);
  if (native) {
    let scene;
    try { scene = JSON.parse(bytes.toString()); validateScene(scene); } catch { fail(`Invalid native artifact: ${name}`); }
    return { bytes, scene };
  }
  return { bytes };
}

export async function readComparisonReview(receiptPath, { expectedHash } = {}) {
  const path = resolve(receiptPath);
  const directory = dirname(path);
  const { report, hash } = await readReport(path, expectedHash);
  if (report?.schemaVersion !== 1 || report.status !== 'complete' || !report.inputs?.base || !report.inputs?.head || !report.artifacts) fail('Expected a completed source comparison receipt');
  const before = await artifact(directory, report.artifacts['before.excalidraw'], 'before.excalidraw', true);
  const after = await artifact(directory, report.artifacts['after.excalidraw'], 'after.excalidraw', true);
  const previewPngs = {};
  for (const name of ['before.png', 'after.png']) {
    const { bytes } = await artifact(directory, report.artifacts[name], name);
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.readUInt32BE(16) !== report.target?.width || bytes.readUInt32BE(20) !== report.target?.height) fail('Retained PNG does not match the declared comparison dimensions');
    previewPngs[name.slice(0, -4)] = bytes;
  }
  await artifact(directory, report.artifacts['changes.md'], 'changes.md');
  const { readEvidenceBundle } = await import('./evidence.js');
  const source = await readEvidenceBundle(report.inputs.base.bundlePath, { expectedHash: report.inputs.base.evidenceHash });
  const { loadComparison } = await import('./explain.js');
  const plan = await loadComparison({ repositoryPath: source.bundle.evidence.repositoryPath,
    base: { bundlePath: report.inputs.base.bundlePath, expectedHash: report.inputs.base.evidenceHash, revision: report.base?.revision },
    head: { bundlePath: report.inputs.head.bundlePath, expectedHash: report.inputs.head.evidenceHash, revision: report.head?.revision },
    target: report.target, required: report.required, repositoryUrl: report.repositoryUrl });
  // Source claims, labels and change kinds come from a freshly checked native
  // comparison. Never display edited report metadata as a verified result.
  if (!isDeepStrictEqual(plan.changes, report.changes) || !isDeepStrictEqual(plan.base.scope, report.base.scope) ||
      !isDeepStrictEqual(plan.head.scope, report.head.scope) || !isDeepStrictEqual(before.scene, plan.base.scene) ||
      !isDeepStrictEqual(after.scene, plan.head.scene) || sha256(before.bytes) !== plan.inputs.base.sha256 || sha256(after.bytes) !== plan.inputs.head.sha256) {
    fail('Comparison claims, source scope or native identity differ from the checked evidence');
  }
  for (const side of ['base', 'head']) {
    if (report.inputs[side].sha256 !== plan.inputs[side].sha256 || report.inputs[side].inputPath !== plan.inputs[side].inputPath) fail('Comparison input identity was changed');
  }
  const sides = {};
  for (const [view, side] of [['before', 'base'], ['after', 'head']]) {
    const itemKey = view;
    const nodes = new Map(plan.changes.nodes.map(change => change[itemKey]).filter(Boolean).map(node => [node.semanticId, node.label || node.semanticId]));
    sides[view] = { revision: plan[side].revision, scope: plan[side].scope,
      relations: plan.changes.relations.filter(change => change[itemKey]).map(change => {
        const relation = change[itemKey];
        return { status: change.status, from: nodes.get(relation.from), to: nodes.get(relation.to), kind: relation.kind,
          claim: relation.claim, sources: relation.sources.map(({ url, path, startLine, endLine }) => ({ url, path, startLine, endLine })) };
      }) };
  }
  return { scene: after.scene, beforeScene: before.scene, previewPngs,
    review: { kind: 'source-comparison', receiptHash: hash, title: 'Source comparison', viewLabels: { before: 'Before', after: 'After' }, sides } };
}


export async function readRefreshReview(receiptPath, { expectedHash } = {}) {
  const path = resolve(receiptPath), directory = dirname(path);
  const { readVerifiedRefresh } = await import('./refresh.js');
  const verified = await readVerifiedRefresh(path, { expectedHash });
  const { receipt, current, proposed, candidate, evidence } = verified;
  const { report: manifest } = await readReport(join(directory, 'previews.json'));
  const expectedSides = candidate ? { before: 'current', after: 'candidate' } : { before: 'current', proposal: 'generated' };
  if (manifest?.schemaVersion !== 1 || manifest.refreshHash !== verified.sha256 || manifest.refreshStatus !== receipt.status ||
      !isDeepStrictEqual(Object.keys(manifest.images ?? {}).sort(), Object.keys(expectedSides).sort())) fail('Preview manifest does not identify this refresh');
  const previewPngs = {};
  for (const [side, native] of Object.entries(expectedSides)) {
    const entry = manifest.images[side];
    if (entry?.native !== native || !new RegExp(`^previews/[a-f0-9-]+/${side}\\.png$`).test(entry?.file ?? '')) fail('Invalid refresh preview reference');
    // Reject symlinked parents as well as symlinked image files.
    for (const parent of ['previews', dirname(entry.file)]) {
      if (!(await fs.lstat(join(directory, parent))).isDirectory()) fail('Preview paths must remain inside the receipt directory');
    }
    const { bytes } = await artifact(directory, entry, entry.file);
    if (bytes.length <= 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('Invalid retained PNG');
    previewPngs[side === 'proposal' ? 'after' : side] = bytes;
  }
  const labels = new Map();
  for (const scene of [proposed, current]) {
    const index = new Map(scene.elements.map(element => [element.id, element]));
    for (const element of scene.elements) {
      const texts = (element.boundElements ?? []).filter(item => item.type === 'text').map(item => index.get(item.id));
      const label = element.type === 'text' ? element.originalText ?? element.text : texts.map(text => text?.originalText ?? text?.text).filter(Boolean).join(' ');
      if (label) labels.set(element.id, label);
    }
  }
  const nodeIds = new Map(evidence.nodes.map(item => [item.semanticId, item.elementId]));
  for (const relation of evidence.relations) {
    if (!labels.has(relation.elementId)) labels.set(relation.elementId, `${labels.get(nodeIds.get(relation.from)) || 'Source'} → ${labels.get(nodeIds.get(relation.to)) || 'Target'}`);
  }
  const describe = item => ({ ...item, label: labels.get(item.elementId) || 'Diagram element' });
  return { previewPngs, scene: candidate ?? proposed, beforeScene: current, ...(candidate ? { proposalScene: proposed } : {}),
    review: { kind: 'source-refresh', title: 'Source refresh', receiptHash: verified.sha256, status: receipt.status,
      viewLabels: candidate ? { before: 'Before', proposal: 'Source proposal', after: receipt.status === 'reconciliation-required' ? 'Partial candidate' : 'Candidate' } : { before: 'Before', after: 'Source proposal' },
      source: { revision: evidence.source.revision ?? 'Working tree', scope: evidence.scope },
      conflicts: receipt.conflicts.map(describe), overrides: receipt.overrides.map(describe), changes: receipt.changes.map(describe) } };
}
