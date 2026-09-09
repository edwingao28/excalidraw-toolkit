import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acceptEvidenceBaseline, associateEvidence, readEvidenceBundle } from "../src/evidence.js";
import { adoptRefresh, mergeGeneratedScenes, stageRefresh } from "../src/refresh.js";
import { readRefreshReview } from "../src/review-receipts.js";
import { validateScene, sha256 } from "../src/scene.js";

const exec = promisify(execFile);
const copy = structuredClone;
function scene() {
  return {
    type: "excalidraw", version: 2, unknownScene: { preserve: true }, appState: { gridSize: 20 },
    files: { unused: { dataURL: "retained asset" } },
    elements: [
      { id: "api", type: "rectangle", x: 0, y: 0, width: 100, height: 80, backgroundColor: "#fff", boundElements: [{ id: "flow", type: "arrow" }, { id: "api-label", type: "text" }] },
      { id: "api-label", type: "text", text: "API", originalText: "API", x: 20, y: 20, width: 30, height: 20, containerId: "api" },
      { id: "worker", type: "rectangle", x: 300, y: 0, width: 100, height: 80, backgroundColor: "#fff", customData: { annotation: "keep" }, boundElements: [{ id: "flow", type: "arrow" }, { id: "worker-label", type: "text" }] },
      { id: "worker-label", type: "text", text: "Worker", originalText: "Worker", x: 320, y: 20, width: 60, height: 20, containerId: "worker" },
      { id: "flow", type: "arrow", points: [[0, 0], [200, 0]], startBinding: { elementId: "api" }, endBinding: { elementId: "worker" } },
      { id: "note", type: "text", text: "Human annotation", x: 0, y: 200, unknownElement: [1, 2] },
    ],
  };
}
function evidence() {
  return {
    schemaVersion: 1, source: { kind: "git", revision: "HEAD" },
    scope: { question: "How does the request reach the worker?", paths: ["src"], coverage: "partial", unknowns: ["Runtime routing was not observed."] },
    references: [{ id: "source", path: "src/flow.js", startLine: 1, endLine: 1, symbol: "handle" }],
    nodes: [{ semanticId: "request:api", elementId: "api", referenceIds: ["source"] }, { semanticId: "request:worker", elementId: "worker", referenceIds: ["source"] }],
    relations: [{ semanticId: "request:next", elementId: "flow", from: "request:api", to: "request:worker", kind: "assumption", claim: "This is an authored flow hypothesis.", referenceIds: ["source"] }],
  };
}
const element = (scene, id) => scene.elements.find(element => element.id === id);
function mergeFixture() {
  return { baselineGenerated: scene(), current: scene(), proposedGenerated: scene(), baselineEvidence: evidence(), proposedEvidence: evidence() };
}
function addQueue(input) {
  const { proposedGenerated: proposed, proposedEvidence: next } = input;
  element(proposed, "flow").endBinding.elementId = "queue";
  element(proposed, "flow").points = [[0, 0], [70, 0]];
  element(proposed, "worker").boundElements = [{ id: "queued-flow", type: "arrow" }, { id: "worker-label", type: "text" }];
  proposed.elements.push(
    { id: "queue", type: "rectangle", x: 150, y: 0, width: 100, height: 80, boundElements: [{ id: "flow", type: "arrow" }, { id: "queued-flow", type: "arrow" }] },
    { id: "queued-flow", type: "arrow", points: [[0, 0], [70, 0]], startBinding: { elementId: "queue" }, endBinding: { elementId: "worker" } },
  );
  next.nodes.push({ semanticId: "request:queue", elementId: "queue", referenceIds: ["source"] });
  next.relations[0].to = "request:queue";
  next.relations.push({ semanticId: "request:queue-to-worker", elementId: "queued-flow", from: "request:queue", to: "request:worker", kind: "assumption", claim: "The proposed queue forwards work.", referenceIds: ["source"] });
}

test("fieldwise refresh preserves moved components, custom labels and all unrelated content", () => {
  const input = mergeFixture();
  element(input.current, "worker").x = 450;
  element(input.current, "worker-label").x = 470;
  element(input.current, "worker-label").text = "My worker";
  element(input.current, "worker-label").originalText = "My worker";
  input.current.unknownScene = { manual: true };
  element(input.proposedGenerated, "api").backgroundColor = "#a5d8ff";
  element(input.proposedGenerated, "worker").customData = { unknown: "source cannot overwrite this" };
  element(input.proposedGenerated, "note").text = "Source tries to overwrite a manual note";
  input.proposedGenerated.appState.gridSize = 99;
  const before = copy(input);
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "ready");
  assert.equal(element(result.candidate, "api").backgroundColor, "#a5d8ff");
  for (const id of ["worker", "worker-label", "note"]) assert.deepEqual(element(result.candidate, id), element(input.current, id));
  assert.deepEqual(result.candidate.appState, input.current.appState);
  assert.deepEqual(result.candidate.unknownScene, input.current.unknownScene);
  assert.deepEqual(result.candidate.files, input.current.files);
  assert.ok(result.overrides.some(change => change.elementId === "worker" && change.field === "x"));
  assert.deepEqual(input, before);
});

test("different human and source labels produce explicit conflicts with each value", () => {
  const input = mergeFixture();
  element(input.current, "worker-label").text = "My worker";
  element(input.proposedGenerated, "worker-label").text = "Queue worker";
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(result.conflicts[0], {
    code: "FIELD_CONFLICT", semanticId: "request:worker", elementId: "worker-label", field: "text",
    baseline: { present: true, value: "Worker" }, human: { present: true, value: "My worker" }, proposed: { present: true, value: "Queue worker" },
  });
  assert.equal(element(result.candidate, "worker-label").text, "My worker");
  element(input.proposedGenerated, "worker-label").text = "My worker";
  assert.equal(mergeGeneratedScenes(input).status, "ready");
});

test("source topology additions keep native identities and validate the resulting bindings", () => {
  const input = mergeFixture();
  addQueue(input);
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "ready");
  validateScene(result.candidate);
  assert.equal(element(result.candidate, "flow").endBinding.elementId, "queue");
  assert.deepEqual(element(result.candidate, "note"), element(input.current, "note"));
  assert.equal(result.candidate.elements.filter(item => item.id === "queue").length, 1);
});

test("uncertain renames and native ID replacement require reconciliation", () => {
  const input = mergeFixture();
  input.proposedEvidence.nodes[1].semanticId = "renamed:worker";
  input.proposedEvidence.relations[0].to = "renamed:worker";
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "reconciliation-required");
  assert.ok(result.conflicts.some(item => item.code === "UNRESOLVED_IDENTITY"));
  assert.ok(result.conflicts.some(item => item.code === "ELEMENT_ID_COLLISION"));
  assert.deepEqual(element(result.candidate, "worker"), element(input.current, "worker"));
  const replacement = mergeFixture();
  replacement.proposedGenerated.elements.push({ id: "new-api", type: "rectangle" });
  replacement.proposedEvidence.nodes[0].elementId = "new-api";
  assert.ok(mergeGeneratedScenes(replacement).conflicts.some(item => item.code === "NATIVE_ID_CHANGED"));
});

test("removal is explicit, scoped and blocked by manual changes or surviving dependencies", () => {
  const input = mergeFixture();
  input.proposedGenerated.elements = input.proposedGenerated.elements.filter(item => !["worker", "worker-label", "flow"].includes(item.id));
  element(input.proposedGenerated, "api").boundElements = [{ id: "api-label", type: "text" }];
  input.proposedEvidence.nodes.pop();
  input.proposedEvidence.relations = [];
  assert.equal(mergeGeneratedScenes(input).status, "reconciliation-required");
  input.removedSemanticIds = ["request:worker", "request:next"];
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "ready");
  for (const id of ["worker", "worker-label", "flow"]) assert.equal(element(result.candidate, id).isDeleted, true);
  validateScene(result.candidate);
  const changed = copy(input);
  element(changed.current, "worker").customData.annotation = "A new human note";
  assert.ok(mergeGeneratedScenes(changed).conflicts.some(item => item.code === "DELETE_MODIFIED_ELEMENT"));
  const outside = copy(input);
  outside.proposedEvidence.scope.paths = ["different-subsystem"];
  assert.ok(mergeGeneratedScenes(outside).conflicts.some(item => item.code === "REMOVAL_OUTSIDE_SCOPE"));
  const unknown = copy(input);
  unknown.baselineEvidence.relations[0].referenceIds = [];
  assert.ok(mergeGeneratedScenes(unknown).conflicts.some(item => item.code === "REMOVAL_SCOPE_UNKNOWN"));
  const dependency = copy(input);
  dependency.current.elements.push({ id: "manual-arrow", type: "arrow", endBinding: { elementId: "worker" } });
  element(dependency.current, "worker").boundElements.push({ id: "manual-arrow", type: "arrow" });
  assert.equal(mergeGeneratedScenes(dependency).status, "reconciliation-required");
});

test("broken candidate topology is never emitted as an adoptable native file", () => {
  const input = mergeFixture();
  addQueue(input);
  element(input.current, "worker").boundElements.push({ id: "manual-label", type: "text" });
  input.current.elements.push({ id: "manual-label", type: "text", containerId: "worker" });
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "reconciliation-required");
  assert.equal(result.candidate, null);
  assert.ok(result.conflicts.some(item => item.code === "TOPOLOGY_CONFLICT"));
});

test("a shared image asset cannot change unmanaged copies", () => {
  const input = mergeFixture();
  for (const value of [input.baselineGenerated, input.current, input.proposedGenerated]) {
    value.files.shared = { dataURL: "original image" };
    value.elements.push({ id: "source-image", type: "image", fileId: "shared" }, { id: "manual-image", type: "image", fileId: "shared" });
  }
  for (const value of [input.baselineEvidence, input.proposedEvidence]) value.nodes.push({ semanticId: "source:image", elementId: "source-image", referenceIds: ["source"] });
  input.proposedGenerated.files.shared = { dataURL: "updated image" };
  const result = mergeGeneratedScenes(input);
  assert.equal(result.status, "reconciliation-required");
  assert.deepEqual(result.conflicts, [{ code: "UNMANAGED_ASSET_CONFLICT", fileId: "shared", elementIds: ["manual-image"] }]);
  assert.deepEqual(result.candidate.files.shared, input.current.files.shared);
  assert.deepEqual(element(result.candidate, "manual-image"), element(input.current, "manual-image"));
  assert.ok(!result.changes.some(change => change.kind === "asset"));

  // A shared update is allowed when every consumer is explicitly source-owned.
  for (const value of [input.baselineEvidence, input.proposedEvidence]) value.nodes.push({ semanticId: "source:image-copy", elementId: "manual-image", referenceIds: ["source"] });
  const managed = mergeGeneratedScenes(input);
  assert.equal(managed.status, "ready");
  assert.deepEqual(managed.candidate.files.shared, input.proposedGenerated.files.shared);
});

async function diskFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "toolkit refresh "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repo");
  await fs.mkdir(join(repositoryPath, "src"), { recursive: true });
  const git = async (...args) => (await exec("git", ["-C", repositoryPath, ...args])).stdout.trim();
  await git("init", "-b", "main");
  const commit = async code => {
    await fs.writeFile(join(repositoryPath, "src/flow.js"), code);
    await git("add", "src/flow.js");
    await git("-c", "user.name=Refresh fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "test: update flow fixture");
  };
  await commit("export function handle() { return 'worker'; }\n");
  const basePath = join(root, "base.excalidraw");
  const currentPath = join(root, "human.excalidraw");
  const generatedPath = join(root, "new.excalidraw");
  const original = `${JSON.stringify(scene(), null, 4)}\n\n`;
  await fs.writeFile(basePath, original);
  await fs.writeFile(currentPath, original);
  const base = await acceptEvidenceBaseline({ repositoryPath, inputPath: basePath, generatedPath: basePath, evidence: evidence(), outputDir: join(root, "base-bundle") });
  await fs.writeFile(generatedPath, original);
  return { root, basePath, original, repositoryPath, currentPath, generatedPath, baselineBundlePath: base.bundlePath, baselineHash: base.sha256, evidence: evidence(), outputDir: join(root, "stage"), requestId: "queue-refresh", commit, git };
}

test("staging and explicit adoption retain exact baselines, request hashes and manual overrides", async t => {
  const f = await diskFixture(t);
  await f.commit("export function handle() { return 'queue-worker'; }\n");
  const human = scene();
  element(human, "worker").x = 420;
  await fs.writeFile(f.currentPath, JSON.stringify(human));
  const proposed = scene();
  element(proposed, "api").backgroundColor = "#a5d8ff";
  await fs.writeFile(f.generatedPath, JSON.stringify(proposed));
  const beforeBaseline = await fs.readFile(f.baselineBundlePath);
  const beforeHuman = await fs.readFile(f.currentPath);
  const saved = await stageRefresh(f);
  assert.equal(saved.receipt.status, "ready");
  assert.equal(saved.receipt.request.evidence.source.revision, await f.git("rev-parse", "HEAD"));
  assert.equal((await stageRefresh(f)).reused, true);
  assert.deepEqual(await fs.readFile(f.baselineBundlePath), beforeBaseline);
  assert.deepEqual(await fs.readFile(f.currentPath), beforeHuman);
  const outputDir = join(f.root, "adopted");
  const adopted = await adoptRefresh({ receiptPath: saved.receiptPath, expectedHash: saved.sha256, outputDir });
  assert.equal(adopted.adopted, true);
  const retained = await readEvidenceBundle(adopted.bundlePath, { expectedHash: adopted.sha256 });
  assert.deepEqual(retained.generatedScene, proposed);
  assert.equal(element(retained.deliveredScene, "worker").x, 420);
  assert.equal(element(retained.deliveredScene, "api").backgroundColor, "#a5d8ff");
  const lineage = JSON.parse(await fs.readFile(adopted.adoptionPath, "utf8"));
  assert.equal(lineage.priorBaselineHash, f.baselineHash);
  assert.equal(lineage.refreshHash, saved.sha256);
  assert.equal((await adoptRefresh({ receiptPath: saved.receiptPath, expectedHash: saved.sha256, outputDir })).reused, true);
  assert.deepEqual(await fs.readFile(f.currentPath), beforeHuman);
});

test("the same source revision creates no scene churn and never advances the baseline", async t => {
  const f = await diskFixture(t);
  const regenerated = scene();
  element(regenerated, "worker").x = 999;
  await fs.writeFile(f.generatedPath, JSON.stringify(regenerated));
  const saved = await stageRefresh(f);
  assert.equal(saved.receipt.status, "unchanged");
  assert.equal(await fs.readFile(join(f.outputDir, "candidate.excalidraw"), "utf8"), f.original);
  const outputDir = join(f.root, "must-not-create");
  const adopted = await adoptRefresh({ receiptPath: saved.receiptPath, expectedHash: saved.sha256, outputDir });
  assert.equal(adopted.adopted, false);
  assert.equal(adopted.bundlePath, f.baselineBundlePath);
  await assert.rejects(fs.stat(outputDir), { code: "ENOENT" });
});

test("associations and missing baselines produce reconciliation receipts that cannot be adopted", async t => {
  const f = await diskFixture(t);
  const association = await associateEvidence({ repositoryPath: f.repositoryPath, inputPath: f.currentPath, evidence: f.evidence, outputDir: join(f.root, "association") });
  for (const [name, baselineBundlePath, baselineHash] of [["associated", association.bundlePath, association.sha256], ["missing", undefined, undefined]]) {
    const saved = await stageRefresh({ ...f, baselineBundlePath, baselineHash, outputDir: join(f.root, name) });
    assert.equal(saved.receipt.status, "reconciliation-required");
    assert.equal(saved.receipt.conflicts[0].code, "MISSING_GENERATED_BASELINE");
    await assert.rejects(adoptRefresh({ receiptPath: saved.receiptPath, expectedHash: saved.sha256, outputDir: join(f.root, `${name}-adopt`) }), { code: "RECONCILIATION_REQUIRED" });
  }
});

test("conflicts, later human edits and changed artifacts block adoption without writing a baseline", async t => {
  const f = await diskFixture(t);
  await f.commit("export function handle() { return 'new-worker'; }\n");
  const proposed = scene();
  element(proposed, "worker-label").text = "New worker";
  await fs.writeFile(f.generatedPath, JSON.stringify(proposed));
  const human = scene();
  element(human, "worker-label").text = "My worker";
  await fs.writeFile(f.currentPath, JSON.stringify(human));
  const conflict = await stageRefresh(f);
  await assert.rejects(adoptRefresh({ receiptPath: conflict.receiptPath, expectedHash: conflict.sha256, outputDir: join(f.root, "blocked") }), { code: "RECONCILIATION_REQUIRED" });
  await assert.rejects(fs.stat(join(f.root, "blocked")), { code: "ENOENT" });
  await fs.writeFile(f.currentPath, f.original);
  const ready = await stageRefresh({ ...f, outputDir: join(f.root, "ready") });
  await fs.appendFile(f.currentPath, " ");
  await assert.rejects(adoptRefresh({ receiptPath: ready.receiptPath, expectedHash: ready.sha256, outputDir: join(f.root, "stale") }), { code: "STALE_INPUT" });
  await fs.writeFile(f.currentPath, f.original);
  await fs.appendFile(join(f.root, "ready/candidate.excalidraw"), " ");
  await assert.rejects(adoptRefresh({ receiptPath: ready.receiptPath, expectedHash: ready.sha256, outputDir: join(f.root, "tampered") }), { code: "CORRUPT_REFRESH" });
  await assert.rejects(fs.stat(join(f.root, "tampered")), { code: "ENOENT" });
});

test("a reused output cannot silently accept a different request or corrupted retained file", async t => {
  const f = await diskFixture(t);
  await stageRefresh(f);
  await assert.rejects(stageRefresh({ ...f, requestId: "different" }), { code: "REQUEST_CONFLICT" });
  await fs.appendFile(join(f.outputDir, "candidate.excalidraw"), " ");
  await assert.rejects(stageRefresh(f), { code: "CORRUPT_REFRESH" });
});


async function reviewPreviews(saved) {
  const directory = join(saved.receiptPath, '..');
  await fs.mkdir(join(directory, 'previews/abcd'), { recursive: true });
  const images = {};
  for (const [side, native] of Object.entries({ before: 'current', ...(saved.receipt.artifacts.candidate ? { after: 'candidate' } : { proposal: 'generated' }) })) {
    const file = `previews/abcd/${side}.png`, bytes = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    await fs.writeFile(join(directory, file), bytes);
    images[side] = { file, sha256: sha256(bytes), native };
  }
  const manifest = { schemaVersion: 1, refreshHash: saved.sha256, refreshStatus: saved.receipt.status, images };
  await fs.writeFile(join(directory, 'previews.json'), JSON.stringify(manifest));
  return manifest;
}

test('refresh review checks native merge and distinguishes human, proposal and candidate', async t => {
  const f = await diskFixture(t);
  await f.commit("export function handle() { return 'queued'; }\n");
  const human = scene(), proposed = scene();
  element(human, 'worker').x = 420;
  element(proposed, 'api').backgroundColor = '#a5d8ff';
  await fs.writeFile(f.currentPath, JSON.stringify(human));
  await fs.writeFile(f.generatedPath, JSON.stringify(proposed));
  const saved = await stageRefresh(f);
  await reviewPreviews(saved);
  const beforeFiles = await fs.readdir(f.root);
  const loaded = await readRefreshReview(saved.receiptPath, { expectedHash: saved.sha256 });
  assert.deepEqual(loaded.beforeScene, human);
  assert.deepEqual(loaded.proposalScene, proposed);
  assert.equal(element(loaded.scene, 'worker').x, 420);
  assert.equal(element(loaded.scene, 'api').backgroundColor, '#a5d8ff');
  assert.deepEqual(loaded.review.viewLabels, { before: 'Before', proposal: 'Source proposal', after: 'Candidate' });
  assert.equal(loaded.review.status, 'ready');
  assert.deepEqual(Object.keys(loaded.previewPngs), ['before', 'after']);
  const images = JSON.parse(await fs.readFile(join(f.outputDir, 'previews.json'))).images;
  assert.equal(sha256(loaded.previewPngs.after), images.after.sha256);
  assert.ok(loaded.review.overrides.some(item => item.label === 'Worker'));
  assert.deepEqual(await fs.readdir(f.root), beforeFiles);
});

test('refresh review recomputes conflicts and rejects fabricated ready status', async t => {
  const f = await diskFixture(t);
  await f.commit("export function handle() { return 'queued'; }\n");
  const human = scene(), proposed = scene();
  element(human, 'worker-label').text = 'Ops worker';
  element(proposed, 'worker-label').text = 'Queue worker';
  await fs.writeFile(f.currentPath, JSON.stringify(human));
  await fs.writeFile(f.generatedPath, JSON.stringify(proposed));
  const saved = await stageRefresh(f);
  await reviewPreviews(saved);
  const loaded = await readRefreshReview(saved.receiptPath);
  assert.equal(loaded.review.status, 'reconciliation-required');
  assert.equal(loaded.review.viewLabels.after, 'Partial candidate');
  assert.equal(loaded.review.conflicts[0].human.value, 'Ops worker');
  const bytes = await fs.readFile(saved.receiptPath);
  for (const change of [
    receipt => { receipt.conflicts = []; receipt.status = 'ready'; },
    receipt => { receipt.overrides.push({ elementId: 'api', field: 'x' }); },
    receipt => { receipt.proposedEvidence.scope.unknowns = []; },
  ]) {
    const receipt = JSON.parse(bytes); change(receipt);
    await fs.writeFile(saved.receiptPath, JSON.stringify(receipt));
    await assert.rejects(readRefreshReview(saved.receiptPath), { code: 'CORRUPT_REFRESH' });
  }
  await fs.writeFile(saved.receiptPath, bytes);
  await fs.appendFile(join(f.outputDir, 'candidate.excalidraw'), ' ');
  await assert.rejects(readRefreshReview(saved.receiptPath), { code: 'CORRUPT_REFRESH' });
});

test('refresh review rejects mismatched preview manifests, PNGs and malformed receipts', async t => {
  const f = await diskFixture(t), saved = await stageRefresh(f);
  const manifest = await reviewPreviews(saved), path = join(f.outputDir, 'previews.json');
  const receiptBytes = await fs.readFile(saved.receiptPath);
  for (const content of ['null', '{}', '{']) {
    await fs.writeFile(saved.receiptPath, content);
    await assert.rejects(readRefreshReview(saved.receiptPath), { code: 'CORRUPT_REFRESH' });
  }
  await fs.writeFile(saved.receiptPath, receiptBytes);
  for (const change of [
    value => { value.refreshHash = '0'.repeat(64); },
    value => { value.images.after.native = 'generated'; },
    value => { value.images.after.file = '../after.png'; },
  ]) {
    const value = copy(manifest); change(value);
    await fs.writeFile(path, JSON.stringify(value));
    await assert.rejects(readRefreshReview(saved.receiptPath), { code: 'CORRUPT_REVIEW' });
  }
  await fs.writeFile(path, JSON.stringify(manifest));
  await fs.appendFile(join(f.outputDir, manifest.images.after.file), 'changed');
  await assert.rejects(readRefreshReview(saved.receiptPath), { code: 'CORRUPT_REVIEW' });
});


test('refresh review shows the source proposal when topology prevents a candidate', async t => {
  const f = await diskFixture(t);
  await f.commit("export function handle() { return 'queue'; }\n");
  const input = mergeFixture();
  addQueue(input);
  element(input.current, 'worker').boundElements.push({ id: 'manual-label', type: 'text' });
  input.current.elements.push({ id: 'manual-label', type: 'text', text: 'Manual', containerId: 'worker' });
  await fs.writeFile(f.currentPath, JSON.stringify(input.current));
  await fs.writeFile(f.generatedPath, JSON.stringify(input.proposedGenerated));
  const saved = await stageRefresh({ ...f, evidence: input.proposedEvidence });
  assert.equal(saved.receipt.artifacts.candidate, null);
  await reviewPreviews(saved);
  const loaded = await readRefreshReview(saved.receiptPath);
  assert.deepEqual(loaded.review.viewLabels, { before: 'Before', after: 'Source proposal' });
  assert.deepEqual(loaded.scene, input.proposedGenerated);
  assert.equal(loaded.proposalScene, undefined);
  const images = JSON.parse(await fs.readFile(join(f.outputDir, 'previews.json'))).images;
  assert.equal(sha256(loaded.previewPngs.after), images.proposal.sha256);
  assert.equal(loaded.review.status, 'reconciliation-required');
  assert.ok(loaded.review.conflicts.some(item => item.code === 'TOPOLOGY_CONFLICT'));
});
