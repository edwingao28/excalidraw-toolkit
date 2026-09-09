import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { servePreview } from "../src/render.js";
import { sha256 } from "../src/scene.js";
import { readComparisonReview } from "../src/review-receipts.js";
import { associateEvidence, readEvidenceBundle } from "../src/evidence.js";
import { checkReadability, exportComparison, loadComparison, OUTPUT_TARGETS, planComparison } from "../src/explain.js";

const exec = promisify(execFile);
const repositoryUrl = "https://github.com/example/request-flow";
function scene(queued = false) {
  const elements = [];
  for (const [id, x, text] of [["api", 40, "API"], ...(queued ? [["queue", 370, "Queue"]] : []), ["worker", 700, "Worker"]]) {
    elements.push({ id, type: "rectangle", x, y: 40, width: 180, height: 80, angle: 0, boundElements: [{ id: `${id}-label`, type: "text" }] },
      { id: `${id}-label`, type: "text", x: x + 20, y: 60, width: 120, height: 35, fontSize: 28, fontFamily: 5, lineHeight: 1.25,
        text, originalText: text, angle: 0, containerId: id });
  }
  for (const [id, from, to] of queued ? [["enqueue", "api", "queue"], ["consume", "queue", "worker"]] : [["direct", "api", "worker"]]) {
    const a = elements.find(element => element.id === from), b = elements.find(element => element.id === to);
    a.boundElements.push({ id, type: "arrow" }); b.boundElements.push({ id, type: "arrow" });
    elements.push({ id, type: "arrow", x: a.x + a.width, y: 80, width: b.x - a.x - a.width, height: 0, angle: 0,
      points: [[0, 0], [b.x - a.x - a.width, 0]], startBinding: { elementId: from }, endBinding: { elementId: to } });
    if (id === "consume") {
      elements.at(-1).boundElements = [{ id: "consume-label", type: "text" }];
      elements.push({ id: "consume-label", type: "text", x: 520, y: 135, width: 360, height: 35, fontSize: 28, fontFamily: 5, lineHeight: 1.25,
        text: "Assumption: delivery", containerId: "consume" });
    }
  }
  elements.push({ id: "note", type: "text", x: 40, y: 180, width: 600, height: 35, fontSize: 28, fontFamily: 5, lineHeight: 1.25,
    text: "Runtime execution has not been observed.", customData: { manual: true } });
  return { type: "excalidraw", version: 2, elements, files: {}, appState: { viewBackgroundColor: "#faf9f5" }, customTopLevel: "preserve" };
}
function proposal(revision, queued) {
  return { schemaVersion: 1, source: { kind: "git", revision },
    scope: { question: "How does the handler reach the worker?", paths: ["src"], coverage: "partial", unknowns: ["Runtime delivery and retry behavior were not observed."] },
    references: [
      { id: "handler", path: "src/api.js", startLine: 2, endLine: 2, symbol: "handle" },
      { id: "worker", path: "src/worker.js", startLine: 1, endLine: 1, symbol: "run" },
      ...(queued ? [{ id: "queue", path: "src/queue.js", startLine: 1, endLine: 1, symbol: "enqueue" }] : []),
    ],
    nodes: [
      { semanticId: "request:api", elementId: "api", referenceIds: ["handler"] },
      { semanticId: "request:worker", elementId: "worker", referenceIds: ["worker"] },
      ...(queued ? [{ semanticId: "request:queue", elementId: "queue", referenceIds: ["queue"] }] : []),
    ],
    relations: queued ? [
      { semanticId: "request:enqueue", elementId: "enqueue", from: "request:api", to: "request:queue", kind: "call", claim: "handle contains enqueue(input).", referenceIds: ["handler"] },
      { semanticId: "request:consume", elementId: "consume", from: "request:queue", to: "request:worker", kind: "assumption", claim: "An external consumer delivers queued jobs to run; runtime wiring is unresolved.", referenceIds: [] },
    ] : [{ semanticId: "request:direct", elementId: "direct", from: "request:api", to: "request:worker", kind: "call", claim: "handle contains run(input).", referenceIds: ["handler"] }],
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "toolkit explain "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repository");
  await fs.mkdir(join(repositoryPath, "src"), { recursive: true });
  const git = async (...args) => (await exec("git", ["-C", repositoryPath, ...args])).stdout.trim();
  const commit = async message => {
    await git("add", "src");
    await git("-c", "user.name=Comparison fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-b", "main");
  await fs.writeFile(join(repositoryPath, "src/api.js"), 'import { run } from "./worker.js";\nexport function handle(input) { return run(input); }\n');
  await fs.writeFile(join(repositoryPath, "src/worker.js"), "export function run(input) { return input; }\n");
  const baseRevision = await commit("test: add direct call fixture");
  const save = async (revision, queued) => {
    const inputPath = join(root, queued ? "head.excalidraw" : "base.excalidraw");
    await fs.writeFile(inputPath, `${JSON.stringify(scene(queued), null, 4)}\n\n`);
    const saved = await associateEvidence({ repositoryPath, inputPath, evidence: proposal(revision, queued), outputDir: join(root, queued ? "head-bundle" : "base-bundle") });
    return { bundlePath: saved.bundlePath, expectedHash: saved.sha256, revision };
  };
  const base = await save(baseRevision, false);
  await fs.writeFile(join(repositoryPath, "src/api.js"), 'import { enqueue } from "./queue.js";\nexport function handle(input) { return enqueue(input); }\n');
  await fs.writeFile(join(repositoryPath, "src/queue.js"), "export function enqueue(input) { return pending.push(input); }\n");
  const headRevision = await commit("test: add queue fixture");
  const head = await save(headRevision, true);
  const required = { base: { nodes: ["request:api", "request:worker"], relations: ["request:direct"] },
    head: { nodes: ["request:api", "request:queue", "request:worker"], relations: ["request:enqueue", "request:consume"] } };
  return { root, git, repositoryPath, repositoryUrl, base, head, required, target: "article", outputDir: join(root, "comparison") };
}
// Contract doubles exercise export orchestration. They do not qualify the native
// font renderer; actual rendering is covered by the renderer integration gate.
function measureScene(document) {
  return { renderer: "@excalidraw/excalidraw@test-contract", fontsLoaded: true, bounds: { x: 40, y: 40, width: 840, height: 175 },
    visibleElementIds: document.elements.filter(element => !element.isDeleted && element.opacity !== 0).map(element => element.id),
    text: document.elements.filter(element => element.type === "text").map(element => ({ id: element.id, x: element.x, y: element.y, width: element.width, height: element.height, fontSize: element.fontSize })) };
}
async function renderScene(document, path, viewport) {
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(viewport.width, 16); png.writeUInt32BE(viewport.height, 20);
  await fs.writeFile(path, png, { flag: "wx" });
}

test("direct call becomes an evidenced queue path with explicit required content and revision-specific links", async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.repositoryPath, "src/api.js"), "dirty checkout must not change either citation\n");
  const plan = await loadComparison({ ...f, base: { ...f.base, revision: "HEAD~1" }, head: { ...f.head, revision: "HEAD" } });
  assert.equal(plan.base.revision, f.base.revision); assert.equal(plan.head.revision, f.head.revision);
  assert.deepEqual(plan.changes.nodes.map(({ semanticId, status }) => [semanticId, status]), [
    ["request:api", "changed"], ["request:queue", "added"], ["request:worker", "unchanged"],
  ]);
  assert.deepEqual(plan.changes.relations.map(({ semanticId, status }) => [semanticId, status]), [
    ["request:consume", "added"], ["request:direct", "removed"], ["request:enqueue", "added"],
  ]);
  for (const change of [...plan.changes.nodes, ...plan.changes.relations]) {
    for (const [side, item] of [["base", change.before], ["head", change.after]]) {
      if (!item) continue;
      assert.equal(item.semanticClaimsVerified, false); assert.equal(item.runtimeBehaviorVerified, false);
      for (const reference of item.sources) assert.ok(reference.url.includes(`/blob/${f[side].revision}/`));
    }
  }
  assert.equal(plan.changes.relations.find(item => item.semanticId === "request:consume").after.certainty, "assumption");
  assert.equal(plan.changes.relations.find(item => item.semanticId === "request:enqueue").after.certainty, "source-cited");
  assert.deepEqual(plan.base.scene.elements.find(item => item.id === "note"), plan.head.scene.elements.find(item => item.id === "note"));
  const missing = structuredClone(f.required); missing.head.relations.push("request:lost");
  await assert.rejects(loadComparison({ ...f, required: missing }), { code: "MISSING_REQUIRED" });
});

test("exact commit identity is required even when selected source files are unchanged", async t => {
  const f = await fixture(t);
  await f.git("-c", "user.name=Comparison fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "test: advance unrelated revision");
  await assert.rejects(loadComparison({ ...f, head: { ...f.head, revision: "HEAD" } }), { code: "REVISION_MISMATCH" });
  const retained = JSON.parse(await fs.readFile(f.head.bundlePath, "utf8"));
  retained.evidence.references[0].excerpt = "fabricated excerpt";
  await fs.writeFile(f.head.bundlePath, JSON.stringify(retained));
  await assert.rejects(loadComparison({ ...f, head: { ...f.head, expectedHash: undefined } }), { code: "CORRUPT_EVIDENCE" });
});

test("pure planning reports relation changes and refuses moved unchanged context without editing either scene", async t => {
  const f = await fixture(t);
  const base = await readEvidenceBundle(f.base.bundlePath), head = await readEvidenceBundle(f.head.bundlePath);
  const before = structuredClone({ base, head });
  planComparison({ ...f, base, head });
  assert.deepEqual({ base, head }, before);
  head.deliveredScene.elements.find(item => item.id === "worker").x += 10;
  assert.throws(() => planComparison({ ...f, base, head }), { code: "UNSTABLE_CONTEXT" });
  head.deliveredScene.elements.find(item => item.id === "worker").x -= 10;
  const caption = head.deliveredScene.elements.find(item => item.id === "consume-label");
  caption.text = "Delivery";
  assert.throws(() => planComparison({ ...f, base, head }), { code: "UNLABELED_ASSUMPTION" });
  caption.text = "Assumption: delivery";
  base.bundle.evidence.relations[0].semanticId = "request:enqueue";
  const required = structuredClone(f.required); required.base.relations = ["request:enqueue"];
  const changed = planComparison({ ...f, base, head, required });
  assert.equal(changed.changes.relations.find(item => item.semanticId === "request:enqueue").status, "changed");
});

test("shared native glyph bounds determine both output transforms and effective font-size gates", async t => {
  const f = await fixture(t);
  const plan = await loadComparison(f);
  for (const target of Object.keys(OUTPUT_TARGETS)) {
    const view = checkReadability({ ...plan, target: OUTPUT_TARGETS[target] }, { base: measureScene(plan.base.scene), head: measureScene(plan.head.scene) });
    assert.equal(view.scale, 1);
    assert.equal(view.offsetX + (view.bounds.x + view.bounds.width / 2) * view.scale, view.width / 2);
    assert.equal(view.offsetY + (view.bounds.y + view.bounds.height / 2) * view.scale, view.height / 2);
    assert.equal(view.minimumEffectiveFontSize, 28);
  }
  const measured = { base: measureScene(plan.base.scene), head: measureScene(plan.head.scene) };
  // Real glyph extents can exceed stale declared element.width; include them.
  measured.head.text[0].width = 3000;
  assert.throws(() => checkReadability(plan, measured), { code: "INSUFFICIENT_READABILITY" });
  measured.head = measureScene(plan.head.scene); measured.head.text.pop();
  assert.throws(() => checkReadability(plan, measured), { code: "INVALID_RENDER_METRICS" });
  measured.head = measureScene(plan.head.scene); measured.head.visibleElementIds = measured.head.visibleElementIds.filter(id => id !== "consume");
  assert.throws(() => checkReadability(plan, measured), { code: "MISSING_REQUIRED" });
});

test("readability failure writes nothing and never calls the renderer", async t => {
  const f = await fixture(t);
  let rendered = false;
  await assert.rejects(exportComparison({ ...f, target: { name: "narrow article", width: 400, height: 300, padding: 20, minimumFontSize: 18 } }, {
    measureScene, renderScene() { rendered = true; },
  }), { code: "INSUFFICIENT_READABILITY" });
  assert.equal(rendered, false);
  await assert.rejects(fs.stat(f.outputDir), { code: "ENOENT" });
});

test("export retains exact native bytes, one affine transform, assumptions, and immutable completion receipts", async t => {
  const f = await fixture(t);
  const calls = [];
  const result = await exportComparison(f, { measureScene, renderScene: async (...args) => { calls.push(structuredClone(args[2])); await renderScene(...args); } });
  assert.deepEqual(calls[0], calls[1]);
  for (const [side, name] of [["base", "before"], ["head", "after"]]) {
    assert.deepEqual(await fs.readFile(join(f.outputDir, `${name}.excalidraw`)), await fs.readFile(join(f.root, `${side}.excalidraw`)));
  }
  assert.equal(result.report.validation.renderedReadability, true);
  assert.equal(result.report.validation.semanticClaims, false); assert.equal(result.report.validation.runtimeBehavior, false);
  const md = await fs.readFile(join(f.outputDir, "changes.md"), "utf8");
  assert.match(md, /assumption/); assert.match(md, /source-cited/); assert.ok(md.includes(f.base.revision)); assert.ok(md.includes(f.head.revision));
  assert.ok(md.includes("request:consume")); assert.ok(md.includes("request:direct")); assert.ok(md.includes("request:enqueue"));
  await assert.rejects(exportComparison(f, { measureScene, renderScene }), { code: "OUTPUT_EXISTS" });
});

test("incorrect rendered dimensions never publish a complete comparison", async t => {
  const f = await fixture(t);
  await assert.rejects(exportComparison(f, { measureScene, renderScene: (document, path, viewport) => renderScene(document, path, { ...viewport, width: 1 }) }), { code: "INVALID_RENDER" });
  await assert.rejects(fs.stat(join(f.outputDir, "comparison.json")), { code: "ENOENT" });
});


test("comparison review derives source context and labels from checked evidence", async t => {
  const f = await fixture(t);
  const saved = await exportComparison(f, { measureScene, renderScene });
  const review = await readComparisonReview(saved.reportPath, { expectedHash: saved.sha256 });
  assert.deepEqual(review.beforeScene, scene(false));
  assert.deepEqual(review.scene, scene(true));
  assert.equal(review.review.sides.before.revision, f.base.revision);
  assert.equal(review.review.sides.after.revision, f.head.revision);
  const enqueue = review.review.sides.after.relations.find(item => item.to === 'Queue');
  assert.equal(enqueue.from, 'API');
  assert.equal(enqueue.claim, 'handle contains enqueue(input).');
  assert.equal(enqueue.sources[0].url, `${repositoryUrl}/blob/${f.head.revision}/src/api.js#L2-L2`);
  assert.deepEqual(review.review.sides.after.scope.unknowns, proposal(f.head.revision, true).scope.unknowns);
  assert.equal(review.review.sides.after.relations.find(item => item.kind === 'assumption').sources.length, 0);
});

test("comparison review rejects changed artifacts and hand-edited claims or source locations", async t => {
  const f = await fixture(t);
  const saved = await exportComparison(f, { measureScene, renderScene });
  const original = await fs.readFile(saved.reportPath);
  for (const name of ['before.excalidraw', 'after.excalidraw', 'before.png', 'after.png', 'changes.md']) {
    const path = join(f.outputDir, name), bytes = await fs.readFile(path);
    await fs.writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
    await assert.rejects(readComparisonReview(saved.reportPath), { code: 'CORRUPT_REVIEW' });
    await fs.writeFile(path, bytes);
  }
  for (const mutate of [
    report => { report.changes.relations[2].after.claim = 'This executes exactly once.'; },
    report => { report.changes.relations[2].after.sources[0].url = 'https://example.com/fabricated'; },
    report => { report.head.scope.unknowns = []; },
    report => { report.inputs.head.sha256 = '0'.repeat(64); },
    report => { report.artifacts['after.excalidraw'].file = '../head.excalidraw'; },
  ]) {
    const report = JSON.parse(original); mutate(report);
    await fs.writeFile(saved.reportPath, JSON.stringify(report));
    await assert.rejects(readComparisonReview(saved.reportPath), { code: 'CORRUPT_REVIEW' });
  }
  await fs.writeFile(saved.reportPath, original);
  await assert.rejects(readComparisonReview(saved.reportPath, { expectedHash: '0'.repeat(64) }), { code: 'CORRUPT_REVIEW' });
  const bundle = JSON.parse(await fs.readFile(f.head.bundlePath, 'utf8'));
  bundle.evidence.references[0].excerpt = 'fabricated excerpt';
  await fs.writeFile(f.head.bundlePath, JSON.stringify(bundle));
  await assert.rejects(readComparisonReview(saved.reportPath), { code: 'CORRUPT_EVIDENCE' });
});

test("comparison review rejects malformed receipts and symlink artifacts", async t => {
  const f = await fixture(t);
  const saved = await exportComparison(f, { measureScene, renderScene });
  const original = await fs.readFile(saved.reportPath);
  for (const bytes of ['{', 'null', '{}', '{"schemaVersion":1,"status":"complete"}']) {
    await fs.writeFile(saved.reportPath, bytes);
    await assert.rejects(readComparisonReview(saved.reportPath), { code: 'CORRUPT_REVIEW' });
  }
  await fs.writeFile(saved.reportPath, original);
  const path = join(f.outputDir, 'after.excalidraw');
  await fs.unlink(path);
  await fs.symlink(join(f.root, 'head.excalidraw'), path);
  await assert.rejects(readComparisonReview(saved.reportPath), { code: 'CORRUPT_REVIEW' });
});


test("preview CLI opens a comparison receipt with verified Before/After context", async t => {
  const f = await fixture(t);
  const saved = await exportComparison(f, { measureScene, renderScene });
  const child = spawn(process.execPath, [new URL('../bin/cli.js', import.meta.url).pathname,
    'preview', saved.reportPath, '--no-open', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  const result = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`Preview did not start: ${errors}`)), 10000);
    child.stderr.on('data', bytes => { errors += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}: ${errors}`)); });
    child.stdout.on('data', bytes => {
      output += bytes;
      try { const value = JSON.parse(output); clearTimeout(timer); resolve(value); } catch {}
    });
  });
  assert.equal(result.mode, 'comparison');
  const metadata = await (await fetch(`${result.url}context`)).json();
  assert.equal(metadata.review.kind, 'source-comparison');
  assert.equal(metadata.review.sides.after.revision, f.head.revision);
  assert.deepEqual(metadata.beforeScene, scene(false));
  assert.deepEqual(metadata.retainedPngViews, ['before', 'after']);
  assert.equal(metadata.previewPngs, undefined);
  for (const view of ['before', 'after']) {
    const response = await fetch(`${result.url}exports/${view}.png`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(join(f.outputDir, `${view}.png`)));
  }
  assert.equal((await fetch(`${result.url}exports/proposal.png`)).status, 404);
  assert.equal((await fetch(new URL('/exports/after.png', result.url))).status, 404);
});


test('comparison PNG button downloads the exact native target image for each view', async t => {
  const f = await fixture(t);
  const renderer = await import('../src/target-render.js');
  const saved = await exportComparison(f, renderer);
  const loaded = await readComparisonReview(saved.reportPath);
  const preview = await servePreview(loaded.scene, loaded);
  t.after(() => preview.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(preview.url);
  await page.waitForFunction(() => window.previewReady || window.previewError);
  assert.equal(await page.evaluate(() => window.previewError), undefined);
  for (const view of ['Before', 'After']) {
    await page.getByRole('tab', { name: view, exact: true }).click();
    await page.waitForFunction(() => window.previewReady);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    const download = await pending;
    const bytes = await fs.readFile(await download.path());
    assert.equal(bytes.readUInt32BE(16), saved.report.target.width);
    assert.equal(bytes.readUInt32BE(20), saved.report.target.height);
    assert.equal(sha256(bytes), saved.report.artifacts[`${view.toLowerCase()}.png`].sha256);
  }
});
