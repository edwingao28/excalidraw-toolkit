import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acceptEvidenceBaseline, associateEvidence, readEvidenceBundle, validateEvidence } from "../src/evidence.js";
import { sha256 } from "../src/scene.js";

const exec = promisify(execFile);
const apiSource = 'import { run } from "./worker.js";\nexport function handle(input) {\n  return run(input);\n}\n';
const workerSource = "export function run(input) { return input; }\n";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "toolkit evidence "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  await fs.mkdir(join(repositoryPath, "src"), { recursive: true });
  const git = async (...args) => (await exec("git", ["-C", repositoryPath, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await fs.writeFile(join(repositoryPath, "src/api.js"), apiSource);
  await fs.writeFile(join(repositoryPath, "src/worker.js"), workerSource);
  await git("add", "src");
  await git("-c", "user.name=Evidence fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "test: add request flow fixture");
  const revision = await git("rev-parse", "HEAD");
  const scene = {
    type: "excalidraw", version: 2, source: "handwritten fixture", unknownTopLevel: { keep: true },
    elements: [
      { id: "api", type: "rectangle", x: 10, y: 20, width: 120, height: 80, customData: { manual: true }, boundElements: [{ id: "connection", type: "arrow" }] },
      { id: "worker", type: "rectangle", x: 260, y: 20, width: 120, height: 80, boundElements: [{ id: "connection", type: "arrow" }] },
      { id: "connection", type: "arrow", points: [[0, 0], [130, 0]], startBinding: { elementId: "api" }, endBinding: { elementId: "worker" } },
      { id: "manual-note", type: "text", text: "Keep this handwritten note", x: 1, y: 200 },
      { id: "manual-image", type: "image", fileId: "image-asset" },
    ],
    files: { "image-asset": { dataURL: "data:image/png;base64,retained" } },
    appState: { viewBackgroundColor: "#fefefe", gridSize: 20 },
  };
  const inputPath = join(root, "handwritten diagram.excalidraw");
  const bytes = Buffer.from(`${JSON.stringify(scene, null, 4)}\n\n`);
  await fs.writeFile(inputPath, bytes);
  const evidence = {
    schemaVersion: 1, source: { kind: "git", revision: "HEAD" },
    scope: { question: "How does handle reach run?", paths: ["src"], coverage: "partial", unknowns: ["Caller routing and runtime inputs were not traced."] },
    references: [
      { id: "api-import", path: "src/api.js", startLine: 1, endLine: 1, symbol: "run" },
      { id: "api-call", path: "src/api.js", startLine: 3, endLine: 3, symbol: "run" },
      { id: "worker-definition", path: "src/worker.js", startLine: 1, endLine: 1, symbol: "run" },
    ],
    nodes: [
      { semanticId: "request:handler", elementId: "api", referenceIds: ["api-call"] },
      { semanticId: "request:worker", elementId: "worker", referenceIds: ["worker-definition"] },
    ],
    relations: [{ semanticId: "request:import", elementId: "connection", from: "request:handler", to: "request:worker", kind: "import", claim: "api.js imports run from worker.js", referenceIds: ["api-import"] }],
  };
  return { root, repositoryPath, inputPath, bytes, scene, evidence, revision, git, outputDir: join(root, "bundle") };
}

test("committed references resolve immutable files, excerpts, and token locations despite dirty sources", async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.repositoryPath, "src/api.js"), "unrelated dirty working tree\n");
  const checked = await validateEvidence(f);
  assert.deepEqual(checked.source, { kind: "git", revision: f.revision });
  assert.equal(checked.references[0].excerpt, apiSource.split("\n")[0]);
  assert.equal(checked.references[0].sha256, sha256(apiSource));
  assert.match(checked.references[0].blob, /^[a-f0-9]{40,64}$/);
  assert.equal(checked.sceneHash, sha256(f.bytes));
  assert.deepEqual(checked.nodes, f.evidence.nodes);
  assert.equal(checked.nodes.length, 2); // Handwritten note and image remain outside the association.
  assert.deepEqual(checked.scope.unknowns, f.evidence.scope.unknowns);
});

test("working-tree references require inspected content digests and reject stale sources", async t => {
  const f = await fixture(t);
  f.evidence.source = { kind: "working-tree" };
  await assert.rejects(validateEvidence(f), { code: "INVALID_REFERENCE" });
  for (const reference of f.evidence.references) reference.sha256 = sha256(reference.path === "src/api.js" ? apiSource : workerSource);
  const checked = await validateEvidence(f);
  assert.deepEqual(checked.source, { kind: "working-tree", baseRevision: f.revision });
  assert.equal(checked.references[0].blob, null);
  await fs.appendFile(join(f.repositoryPath, "src/api.js"), "// changed\n");
  await assert.rejects(associateEvidence(f), { code: "STALE_SOURCE" });
  await assert.rejects(fs.stat(f.outputDir), { code: "ENOENT" });
});

test("scope and file boundaries reject traversal, symlinks, and a repository subdirectory", async t => {
  const f = await fixture(t);
  for (const path of ["../outside.js", "/tmp/outside.js", ".git/config", "src/../src/api.js", "src\\api.js", "other/api.js"]) {
    const evidence = structuredClone(f.evidence);
    evidence.references[0].path = path;
    await assert.rejects(validateEvidence({ ...f, evidence }), { code: "SOURCE_BOUNDARY" });
  }
  await assert.rejects(validateEvidence({ ...f, repositoryPath: join(f.repositoryPath, "src") }), { code: "SOURCE_BOUNDARY" });
  await fs.symlink("api.js", join(f.repositoryPath, "src/link.js"));
  await f.git("add", "src/link.js");
  await f.git("-c", "user.name=Evidence fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "test: add symlink fixture");
  f.evidence.references[0].path = "src/link.js";
  await assert.rejects(validateEvidence(f), { code: "SOURCE_BOUNDARY" });
  f.evidence.source = { kind: "working-tree" };
  f.evidence.references[0].sha256 = sha256(apiSource);
  await assert.rejects(validateEvidence(f), { code: "SOURCE_BOUNDARY" });
});

test("source references fail closed for nonexistent lines and ambiguous symbol selections", async t => {
  const f = await fixture(t);
  for (const replacement of [{ startLine: 0 }, { endLine: 200 }, { symbol: "runner" }, { symbol: "absent" }]) {
    const evidence = structuredClone(f.evidence);
    Object.assign(evidence.references[0], replacement);
    await assert.rejects(validateEvidence({ ...f, evidence }), { code: "INVALID_REFERENCE" });
  }
  f.evidence.references.push(structuredClone(f.evidence.references[0]));
  await assert.rejects(validateEvidence(f), { code: "AMBIGUOUS_IDENTITY" });
});

test("semantic identities and native relation endpoints cannot be guessed or duplicated", async t => {
  const f = await fixture(t);
  for (const update of [
    evidence => { evidence.nodes[1].semanticId = evidence.nodes[0].semanticId; },
    evidence => { evidence.nodes[1].elementId = evidence.nodes[0].elementId; },
  ]) {
    const evidence = structuredClone(f.evidence);
    update(evidence);
    await assert.rejects(validateEvidence({ ...f, evidence }), { code: "AMBIGUOUS_IDENTITY" });
  }
  let evidence = structuredClone(f.evidence);
  evidence.nodes[0].elementId = "guessed-element";
  await assert.rejects(validateEvidence({ ...f, evidence }), { code: "UNKNOWN_TARGET" });
  evidence = structuredClone(f.evidence);
  [evidence.relations[0].from, evidence.relations[0].to] = [evidence.relations[0].to, evidence.relations[0].from];
  await assert.rejects(validateEvidence({ ...f, evidence }), { code: "INVALID_MAPPING" });
});

test("valid references never certify a claim, runtime behavior, or complete coverage", async t => {
  const f = await fixture(t);
  for (const kind of ["import", "call", "assumption"]) {
    f.evidence.relations[0].kind = kind;
    f.evidence.relations[0].claim = "Author assertion deliberately unsupported by the excerpt";
    if (kind === "assumption") f.evidence.relations[0].referenceIds = [];
    const checked = await validateEvidence(f);
    assert.equal(checked.relations[0].kind, kind);
    assert.deepEqual(checked.validation, { sourceLocations: true, sceneMappings: true, semanticClaims: false, runtimeBehavior: false });
  }
  f.evidence.relations[0].kind = "call";
  await assert.rejects(validateEvidence(f), { code: "INVALID_REFERENCE" });
  f.evidence.scope.coverage = "complete";
  await assert.rejects(validateEvidence(f), { code: "INVALID_SCOPE" });
  f.evidence.scope.coverage = "partial";
  f.evidence.verified = true;
  await assert.rejects(validateEvidence(f), { code: "INVALID_EVIDENCE" });
});

test("explicit association preserves exact native bytes and invents no generated history", async t => {
  const f = await fixture(t);
  const saved = await associateEvidence(f);
  assert.equal(saved.bundle.baseline.kind, "association");
  assert.equal(saved.bundle.baseline.priorBaseline, null);
  assert.equal(saved.bundle.baseline.generated, null);
  assert.deepEqual(await fs.readFile(join(f.outputDir, "delivered.excalidraw")), f.bytes);
  assert.deepEqual(await fs.readFile(f.inputPath), f.bytes);
  const read = await readEvidenceBundle(saved.bundlePath, { expectedHash: saved.sha256 });
  assert.deepEqual(read.deliveredScene, f.scene);
  assert.equal(read.generatedScene, null);
  await assert.rejects(associateEvidence(f), { code: "OUTPUT_EXISTS" });
  assert.deepEqual(await fs.readFile(join(f.outputDir, "delivered.excalidraw")), f.bytes);
  assert.throws(() => associateEvidence({ ...f, generatedPath: f.inputPath }), { code: "INVALID_BASELINE" });
});

test("accepted generated and delivered baselines remain independently reconstructible", async t => {
  const f = await fixture(t);
  await assert.rejects(acceptEvidenceBaseline(f), { code: "INVALID_BASELINE" });
  await assert.rejects(fs.stat(f.outputDir), { code: "ENOENT" });
  const generated = structuredClone(f.scene);
  generated.elements[0].x = 100;
  generated.elements[0].customData.manual = false;
  const generatedPath = join(f.root, "generated input.excalidraw");
  const generatedBytes = Buffer.from(JSON.stringify(generated));
  await fs.writeFile(generatedPath, generatedBytes);
  const saved = await acceptEvidenceBaseline({ ...f, generatedPath });
  assert.equal(saved.bundle.baseline.kind, "accepted-generated");
  assert.deepEqual(await fs.readFile(join(f.outputDir, "generated.excalidraw")), generatedBytes);
  await fs.unlink(f.inputPath);
  await fs.unlink(generatedPath);
  const read = await readEvidenceBundle(saved.bundlePath, { expectedHash: saved.sha256 });
  assert.deepEqual(read.generatedScene, generated);
  assert.deepEqual(read.deliveredScene, f.scene);
  assert.equal(read.bundle.evidence.source.revision, f.revision);
});

test("bundle readers reject altered artifacts and manifest substitutions", async t => {
  const f = await fixture(t);
  const saved = await associateEvidence(f);
  const deliveredPath = join(f.outputDir, "delivered.excalidraw");
  await fs.appendFile(deliveredPath, " ");
  await assert.rejects(readEvidenceBundle(saved.bundlePath), { code: "CORRUPT_EVIDENCE" });
  await fs.writeFile(deliveredPath, f.bytes);
  const changed = structuredClone(saved.bundle);
  changed.baseline.delivered.file = "../handwritten diagram.excalidraw";
  await fs.writeFile(saved.bundlePath, JSON.stringify(changed));
  await assert.rejects(readEvidenceBundle(saved.bundlePath), { code: "CORRUPT_EVIDENCE" });
  await assert.rejects(readEvidenceBundle(saved.bundlePath, { expectedHash: saved.sha256 }), { code: "CORRUPT_EVIDENCE" });
});
