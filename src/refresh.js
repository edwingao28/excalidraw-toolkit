import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acceptEvidenceBaseline, readEvidenceBundle, validateEvidence } from "./evidence.js";
import { sha256, validateScene } from "./scene.js";

const HASH = /^[a-f0-9]{64}$/;
const EDITABLE = new Set([
  "x", "y", "width", "height", "angle", "text", "originalText", "fontSize", "fontFamily",
  "textAlign", "verticalAlign", "lineHeight", "autoResize", "strokeColor", "backgroundColor",
  "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "roundness", "points",
  "startBinding", "endBinding", "boundElements", "containerId", "startArrowhead", "endArrowhead",
  "elbowed", "fixedSegments", "frameId", "groupIds", "fileId", "scale",
]);
const same = isDeepStrictEqual;
const clone = structuredClone;
const live = element => element && !element.isDeleted;
const valueAt = (object, field) => Object.hasOwn(object, field) ? { present: true, value: object[field] } : { present: false };
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sourceKey(evidence) {
  return canonical({
    source: evidence.source.kind === "git" ? evidence.source : { kind: "working-tree" },
    question: evidence.scope.question, paths: [...evidence.scope.paths].sort(),
    files: [...new Map(evidence.references.map(ref => [ref.path, ref.sha256])).entries()].sort(),
  });
}

function identities(evidence, index) {
  const ids = new Map();
  const elements = new Set();
  for (const item of [...evidence.nodes, ...evidence.relations]) {
    if (ids.has(item.semanticId) || elements.has(item.elementId) || !live(index.get(item.elementId))) {
      fail("RECONCILIATION_REQUIRED", "Semantic identities must map uniquely to live native elements");
    }
    ids.set(item.semanticId, item);
    elements.add(item.elementId);
  }
  return ids;
}

function ownedText(index, element) {
  const bindings = element.boundElements?.filter(binding => binding.type === "text") ?? [];
  if (bindings.length > 1) fail("RECONCILIATION_REQUIRED", `Ambiguous bound text identity: ${element.id}`);
  return bindings.length ? index.get(bindings[0].id) : null;
}

/** Pure merge; only explicitly associated native elements and their bound text are source-owned. */
export function mergeGeneratedScenes({ baselineGenerated, current, proposedGenerated, baselineEvidence, proposedEvidence, removedSemanticIds = [] }) {
  validateScene(current);
  validateScene(proposedGenerated);
  if (!baselineGenerated) return { status: "reconciliation-required", candidate: clone(current), changes: [], overrides: [], conflicts: [{ code: "MISSING_GENERATED_BASELINE" }] };
  validateScene(baselineGenerated);
  const before = new Map(baselineGenerated.elements.map(element => [element.id, element]));
  const human = new Map(current.elements.map(element => [element.id, element]));
  const proposed = new Map(proposedGenerated.elements.map(element => [element.id, element]));
  const oldIds = identities(baselineEvidence, before);
  const newIds = identities(proposedEvidence, proposed);
  if (!Array.isArray(removedSemanticIds) || new Set(removedSemanticIds).size !== removedSemanticIds.length || removedSemanticIds.some(id => !oldIds.has(id) || newIds.has(id))) {
    fail("INVALID_REMOVAL", "Removals must uniquely identify known semantic IDs absent from the new proposal");
  }
  const candidate = clone(current);
  const next = new Map(candidate.elements.map(element => [element.id, element]));
  const conflicts = [];
  const changes = [];
  const overrides = [];
  const managed = new Set();
  const conflict = (code, semanticId, elementId, extra = {}) => conflicts.push({ code, semanticId, elementId, ...extra });
  const mergeElement = (semanticId, base, existing, update) => {
    const id = base?.id ?? update.id;
    if (managed.has(id)) { conflict("AMBIGUOUS_IDENTITY", semanticId, id); return; }
    managed.add(id);
    if (!base) {
      if (human.has(id) || before.has(id)) { conflict("ELEMENT_ID_COLLISION", semanticId, id); return; }
      const addition = clone(update);
      candidate.elements.push(addition);
      next.set(id, addition);
      changes.push({ semanticId, elementId: id, kind: "add" });
      return;
    }
    if (!live(existing)) { conflict("HUMAN_REMOVAL", semanticId, id); return; }
    if (!live(update)) {
      // Deleting a manually modified object needs reconciliation, even when the
      // changed field is unknown to the source workflow.
      if (!same(existing, base)) { conflict("DELETE_MODIFIED_ELEMENT", semanticId, id); return; }
      next.get(id).isDeleted = true;
      changes.push({ semanticId, elementId: id, kind: "remove" });
      return;
    }
    if (base.type !== existing.type || base.type !== update.type) { conflict("ELEMENT_TYPE_CHANGED", semanticId, id); return; }
    for (const field of EDITABLE) {
      const b = valueAt(base, field), h = valueAt(existing, field), n = valueAt(update, field);
      if (same(b, n)) {
        if (!same(b, h)) overrides.push({ semanticId, elementId: id, field });
        continue;
      }
      if (!same(b, h) && !same(h, n)) {
        conflict("FIELD_CONFLICT", semanticId, id, { field, baseline: b, human: h, proposed: n });
        continue;
      }
      if (same(h, n)) continue;
      if (n.present) next.get(id)[field] = clone(n.value);
      else delete next.get(id)[field];
      changes.push({ semanticId, elementId: id, kind: "field", field });
    }
  };
  for (const [semanticId, old] of oldIds) {
    const replacement = newIds.get(semanticId);
    const base = before.get(old.elementId);
    if (!replacement && !removedSemanticIds.includes(semanticId)) {
      conflict("UNRESOLVED_IDENTITY", semanticId, old.elementId); continue;
    }
    if (replacement && replacement.elementId !== old.elementId) {
      conflict("NATIVE_ID_CHANGED", semanticId, old.elementId, { proposedElementId: replacement.elementId }); continue;
    }
    if (!replacement) {
      const refs = baselineEvidence.references.filter(ref => old.referenceIds.includes(ref.id));
      if (!refs.length) { conflict("REMOVAL_SCOPE_UNKNOWN", semanticId, old.elementId); continue; }
      if (refs.some(ref => !proposedEvidence.scope.paths.some(path => path === "." || ref.path === path || ref.path.startsWith(`${path}/`)))) {
        conflict("REMOVAL_OUTSIDE_SCOPE", semanticId, old.elementId); continue;
      }
    }
    const update = replacement ? proposed.get(replacement.elementId) : null;
    mergeElement(semanticId, base, human.get(base.id), update);
    const oldText = ownedText(before, base);
    const newText = update ? ownedText(proposed, update) : null;
    if (oldText && newText && oldText.id !== newText.id) {
      conflict("BOUND_TEXT_ID_CHANGED", semanticId, oldText.id, { proposedElementId: newText.id });
    } else if (oldText || newText) mergeElement(semanticId, oldText, human.get((oldText ?? newText).id), newText);
  }
  for (const [semanticId, item] of newIds) {
    if (oldIds.has(semanticId)) continue;
    const update = proposed.get(item.elementId);
    mergeElement(semanticId, null, human.get(item.elementId), update);
    const bound = ownedText(proposed, update);
    if (bound) mergeElement(semanticId, null, human.get(bound.id), bound);
  }
  // Asset dictionaries and scene-level state are otherwise retained verbatim.
  for (const id of managed) {
    const element = next.get(id);
    if (!live(element) || element.type !== "image" || !element.fileId) continue;
    const fileId = element.fileId;
    const incoming = proposedGenerated.files?.[fileId];
    if (incoming === undefined) continue;
    const prior = baselineGenerated.files?.[fileId], existing = current.files?.[fileId];
    if (same(prior, incoming) || same(existing, incoming)) continue;
    const unmanagedConsumers = candidate.elements.filter(item => live(item) && item.type === "image" && item.fileId === fileId && !managed.has(item.id)).map(item => item.id);
    if (unmanagedConsumers.length) {
      conflicts.push({ code: "UNMANAGED_ASSET_CONFLICT", fileId, elementIds: unmanagedConsumers }); continue;
    }
    if (existing !== undefined && !same(existing, prior)) {
      conflicts.push({ code: "ASSET_CONFLICT", fileId }); continue;
    }
    candidate.files ??= {};
    candidate.files[fileId] = clone(incoming);
    changes.push({ kind: "asset", fileId });
  }
  try { validateScene(candidate); }
  catch (error) {
    conflicts.push({ code: "TOPOLOGY_CONFLICT", detail: error.message });
    return { status: "reconciliation-required", candidate: null, changes, overrides, conflicts };
  }
  return { status: conflicts.length ? "reconciliation-required" : "ready", candidate, changes, overrides, conflicts };
}

async function native(path) {
  const bytes = await fs.readFile(path);
  let scene;
  try { scene = JSON.parse(bytes.toString("utf8")); }
  catch { fail("INVALID_SCENE", "Expected native Excalidraw JSON"); }
  validateScene(scene);
  return { bytes, scene, sha256: sha256(bytes) };
}
async function write(path, bytes) {
  const handle = await fs.open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function publish(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const pending = `${path}.pending`;
  await write(pending, bytes);
  await fs.link(pending, path);
  await fs.unlink(pending);
  const handle = await fs.open(dirname(path), "r");
  try { await handle.sync(); } finally { await handle.close(); }
  return sha256(bytes);
}
async function readReceipt(receiptPath, expectedHash) {
  const bytes = await fs.readFile(receiptPath);
  if (expectedHash !== undefined && (!HASH.test(expectedHash) || sha256(bytes) !== expectedHash)) fail("CORRUPT_REFRESH", "Refresh receipt hash differs");
  let receipt;
  try { receipt = JSON.parse(bytes.toString("utf8")); } catch { fail("CORRUPT_REFRESH", "Invalid refresh JSON"); }
  if (receipt?.schemaVersion !== 1 || !["ready", "unchanged", "reconciliation-required"].includes(receipt.status) || !HASH.test(receipt.requestDigest ?? "") ||
    !receipt.request || sha256(canonical(receipt.request)) !== receipt.requestDigest ||
    ![receipt.conflicts, receipt.changes, receipt.overrides].every(Array.isArray) || !receipt.artifacts) fail("CORRUPT_REFRESH", "Invalid refresh receipt");
  return { receipt, sha256: sha256(bytes) };
}
async function retainedNative(receiptPath, entry, name) {
  if (!entry || entry.file !== name || !HASH.test(entry.sha256 ?? "")) fail("CORRUPT_REFRESH", "Invalid native artifact reference");
  const path = join(dirname(resolve(receiptPath)), name);
  if (!(await fs.lstat(path)).isFile()) fail("CORRUPT_REFRESH", "Native artifacts must be regular files");
  const result = await native(path);
  if (result.sha256 !== entry.sha256) fail("CORRUPT_REFRESH", `Changed artifact: ${name}`);
  return { ...result, path };
}

function mergeRefresh(baseline, current, proposed, checked, removedSemanticIds) {
  if (baseline?.generatedScene && sourceKey(baseline.bundle.evidence) === sourceKey(checked)) {
    return { status: "unchanged", candidate: current, changes: [], overrides: [], conflicts: [] };
  }
  return mergeGeneratedScenes({ baselineGenerated: baseline?.generatedScene, current, proposedGenerated: proposed,
    baselineEvidence: baseline?.bundle.evidence, proposedEvidence: checked, removedSemanticIds });
}

/** Read-only verification for review: recompute status and conflicts from retained inputs. */
export async function readVerifiedRefresh(receiptPath, { expectedHash } = {}) {
  const saved = await readReceipt(receiptPath, expectedHash);
  const { receipt } = saved;
  const current = await retainedNative(receiptPath, receipt.artifacts.current, "current.excalidraw");
  const proposed = await retainedNative(receiptPath, receipt.artifacts.generated, "generated.excalidraw");
  const candidate = receipt.artifacts.candidate ? await retainedNative(receiptPath, receipt.artifacts.candidate, "candidate.excalidraw") : null;
  if (current.sha256 !== receipt.request.currentHash || proposed.sha256 !== receipt.request.generatedHash) fail("CORRUPT_REFRESH", "Retained native scenes differ from the refresh request");
  const checked = await validateEvidence({ repositoryPath: receipt.request.repositoryPath, inputPath: proposed.path, evidence: receipt.request.evidence });
  if (!same(checked, receipt.proposedEvidence)) fail("CORRUPT_REFRESH", "Proposed source evidence changed after staging");
  let baseline = null;
  if (receipt.request.baselineBundlePath) {
    try { baseline = await readEvidenceBundle(receipt.request.baselineBundlePath, { expectedHash: receipt.request.baselineHash }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const merged = mergeRefresh(baseline, current.scene, proposed.scene, checked, receipt.request.removedSemanticIds);
  if (merged.status !== receipt.status || !same(merged.changes, receipt.changes) || !same(merged.overrides, receipt.overrides) ||
      !same(merged.conflicts, receipt.conflicts) || !same(merged.candidate, candidate?.scene ?? null)) fail("CORRUPT_REFRESH", "Refresh status, changes or conflicts differ from the retained three-way merge");
  return { ...saved, current: current.scene, proposed: proposed.scene, candidate: merged.candidate, evidence: checked };
}

export async function stageRefresh({ requestId, baselineBundlePath, baselineHash, currentPath, generatedPath, repositoryPath, evidence, removedSemanticIds = [], outputDir }) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) fail("INVALID_REQUEST", "Provide a stable request ID");
  if (typeof outputDir !== "string" || !outputDir.trim()) fail("INVALID_REQUEST", "Provide a new output directory");
  if (baselineBundlePath && !HASH.test(baselineHash ?? "")) fail("INVALID_BASELINE", "Retain and provide the accepted baseline manifest hash");
  const current = await native(currentPath);
  const proposed = await native(generatedPath);
  const checked = await validateEvidence({ repositoryPath, inputPath: generatedPath, evidence });
  if (checked.sceneHash !== proposed.sha256) fail("STALE_INPUT", "Generated proposal changed during validation");
  const pinnedEvidence = clone(evidence);
  if (checked.source.kind === "git") pinnedEvidence.source = clone(checked.source);
  pinnedEvidence.references = pinnedEvidence.references.map((reference, index) => ({ ...reference, sha256: checked.references[index].sha256 }));
  let baseline = null;
  if (baselineBundlePath) {
    try { baseline = await readEvidenceBundle(baselineBundlePath, { expectedHash: baselineHash }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const request = {
    requestId, baselineBundlePath: baselineBundlePath ? resolve(baselineBundlePath) : null, baselineHash: baselineHash ?? null,
    currentPath: resolve(currentPath), currentHash: current.sha256, generatedPath: resolve(generatedPath), generatedHash: proposed.sha256,
    repositoryPath: checked.repositoryPath, evidence: pinnedEvidence, removedSemanticIds,
  };
  const requestDigest = sha256(canonical(request));
  const directory = resolve(outputDir);
  const receiptPath = join(directory, "refresh.json");
  try {
    const existing = await readReceipt(receiptPath);
    if (existing.receipt.requestDigest !== requestDigest) fail("REQUEST_CONFLICT", "This output directory belongs to a different refresh input");
    await retainedNative(receiptPath, existing.receipt.artifacts.current, "current.excalidraw");
    await retainedNative(receiptPath, existing.receipt.artifacts.generated, "generated.excalidraw");
    if (existing.receipt.artifacts.candidate) await retainedNative(receiptPath, existing.receipt.artifacts.candidate, "candidate.excalidraw");
    return { receiptPath, ...existing, reused: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const merged = mergeRefresh(baseline, current.scene, proposed.scene, checked, removedSemanticIds);
  await fs.mkdir(dirname(directory), { recursive: true });
  try { await fs.mkdir(directory); }
  catch (error) { if (error.code === "EEXIST") fail("INCOMPLETE_REFRESH", "Existing directory has no complete refresh receipt; use a new directory"); throw error; }
  const artifacts = {};
  for (const [key, value] of Object.entries({ current, generated: proposed, candidate: merged.candidate ? {
    bytes: same(merged.candidate, current.scene) ? current.bytes : Buffer.from(`${JSON.stringify(merged.candidate, null, 2)}\n`),
  } : null })) {
    if (!value) { artifacts[key] = null; continue; }
    artifacts[key] = { file: `${key}.excalidraw`, sha256: sha256(value.bytes) };
    await write(join(directory, artifacts[key].file), value.bytes);
  }
  const { candidate, ...report } = merged;
  const receipt = { schemaVersion: 1, requestDigest, request, ...report, proposedEvidence: checked, artifacts };
  const receiptHash = await publish(receiptPath, receipt);
  return { receiptPath, sha256: receiptHash, receipt, reused: false };
}

/** Explicit caller adoption; staging never changes the accepted baseline. */
export async function adoptRefresh({ receiptPath, expectedHash, outputDir }) {
  if (!HASH.test(expectedHash ?? "")) fail("INVALID_REQUEST", "Provide the retained refresh receipt hash");
  const { receipt } = await readReceipt(receiptPath, expectedHash);
  if (receipt.status === "reconciliation-required" || receipt.conflicts.length) fail("RECONCILIATION_REQUIRED", "Resolve conflicts and stage a new refresh before adoption");
  const current = await retainedNative(receiptPath, receipt.artifacts.current, "current.excalidraw");
  const generated = await retainedNative(receiptPath, receipt.artifacts.generated, "generated.excalidraw");
  const candidate = await retainedNative(receiptPath, receipt.artifacts.candidate, "candidate.excalidraw");
  if ((await native(receipt.request.currentPath)).sha256 !== current.sha256) fail("STALE_INPUT", "The human scene changed after staging; reconcile it before adoption");
  await readEvidenceBundle(receipt.request.baselineBundlePath, { expectedHash: receipt.request.baselineHash });
  if (receipt.status === "unchanged") return { adopted: false, bundlePath: receipt.request.baselineBundlePath, sha256: receipt.request.baselineHash };
  if (typeof outputDir !== "string" || !outputDir.trim()) fail("INVALID_REQUEST", "Provide a new baseline output directory");
  const adoptionPath = join(resolve(outputDir), "adoption.json");
  try {
    const prior = JSON.parse(await fs.readFile(adoptionPath, "utf8"));
    if (prior.schemaVersion !== 1 || prior.refreshHash !== expectedHash || prior.priorBaselineHash !== receipt.request.baselineHash || !HASH.test(prior.acceptedHash ?? "")) fail("REQUEST_CONFLICT", "This baseline belongs to another refresh");
    const accepted = await readEvidenceBundle(join(resolve(outputDir), "evidence.json"), { expectedHash: prior.acceptedHash });
    return { adopted: true, bundlePath: join(resolve(outputDir), "evidence.json"), sha256: prior.acceptedHash, bundle: accepted.bundle, adoptionPath, reused: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const accepted = await acceptEvidenceBaseline({
    repositoryPath: receipt.request.repositoryPath, inputPath: candidate.path, generatedPath: generated.path,
    evidence: receipt.request.evidence, outputDir,
  });
  await publish(adoptionPath, {
    schemaVersion: 1, refreshPath: resolve(receiptPath), refreshHash: expectedHash,
    priorBaselinePath: receipt.request.baselineBundlePath, priorBaselineHash: receipt.request.baselineHash,
    acceptedHash: accepted.sha256,
  });
  return { adopted: true, ...accepted, adoptionPath, reused: false };
}
