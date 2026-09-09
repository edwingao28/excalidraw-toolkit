import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { applyStyleOperations, deriveSceneChanges, editScene, inspectScene, sha256, validateScene, verifyReceipt } from "../src/scene.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zz1kAAAAASUVORK5CYII=", "base64");
const renderScene = async (_scene, path) => fs.writeFile(path, PNG);

function sceneFixture() {
  const element = (id, type, extra = {}) => ({
    id, type, x: 20, y: 20, width: 100, height: 60, angle: 0,
    strokeColor: "#000000", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: 12,
    version: 7, versionNonce: 100, isDeleted: false, boundElements: null,
    updated: 1234, link: null, locked: false, ...extra,
  });
  return {
    type: "excalidraw", version: 2, source: "test",
    elements: [
      element("api", "rectangle", { boundElements: [{ id: "label", type: "text" }, { id: "edge", type: "arrow" }], customData: { manual: "keep" } }),
      element("label", "text", { containerId: "api", text: "API", originalText: "API", fontSize: 20, fontFamily: 1, textAlign: "center", verticalAlign: "middle", autoResize: true, lineHeight: 1.25 }),
      element("worker", "ellipse", { x: 250, boundElements: [{ id: "edge", type: "arrow" }] }),
      element("edge", "arrow", { x: 120, y: 50, width: 130, height: 0, points: [[0, 0], [130, 0]], startBinding: { elementId: "api", focus: 0, gap: 1 }, endBinding: { elementId: "worker", focus: 0, gap: 1 } }),
      element("note", "text", { x: 45, y: 175, text: "Hand-positioned note", originalText: "Hand-positioned note", fontSize: 16, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 }),
      element("image", "image", { y: 250, fileId: "asset", scale: [1, 1], status: "saved" }),
      element("deleted", "rectangle", { isDeleted: true, boundElements: [{ id: "old-missing-label", type: "text" }] }),
      element("future-element", "future-element", { mystery: { untouched: [1, 2, 3] } }),
    ],
    appState: { viewBackgroundColor: "#f5f5f5", gridSize: 20, customView: { mode: "manual" } },
    files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${PNG.toString("base64")}`, created: 100 } },
    arbitraryMetadata: { extension: "keep", nested: [1, { preserve: true }] },
  };
}

async function setup(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "excalidraw-edit-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scene = sceneFixture();
  const inputPath = join(directory, "input.excalidraw");
  const original = `${JSON.stringify(scene)}\n\n`;
  await fs.writeFile(inputPath, original);
  return {
    scene, inputPath, original, directory,
    request: { inputPath, outputDir: join(directory, "output"), requestId: "edit-001", baseHash: sha256(original), operations: [{ op: "setStyle", targetId: "api", style: { backgroundColor: "#a5d8ff" } }] },
  };
}

test("inspect exposes stable IDs, bindings, assets, and the supported operation set", async (t) => {
  const { inputPath, original } = await setup(t);
  const result = await inspectScene(inputPath);
  assert.equal(result.baseHash, sha256(original));
  assert.equal(result.elements.find((element) => element.id === "api").label, "API");
  assert.equal(result.elements.find((element) => element.id === "edge").startBinding.elementId, "api");
  assert.deepEqual(result.assetIds, ["asset"]);
  assert.deepEqual(result.capabilities.operations, ["setStyle"]);
  assert.deepEqual(result.capabilities.setStyle.elementTypes, ["rectangle", "ellipse", "diamond"]);
});

test("style edit preserves original bytes and every protected native value", async (t) => {
  const { scene, inputPath, original, request } = await setup(t);
  const receipt = await editScene(request, { renderScene });
  assert.equal(receipt.status, "complete");
  const candidate = JSON.parse(await fs.readFile(receipt.artifacts["after.excalidraw"].path));
  const expected = structuredClone(scene);
  expected.elements[0].backgroundColor = "#a5d8ff";
  assert.deepEqual(candidate, expected);
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
  assert.equal(await fs.readFile(receipt.artifacts["before.excalidraw"].path, "utf8"), original);
  assert.deepEqual(receipt.changes, [{ id: "api", properties: { backgroundColor: { before: "transparent", after: "#a5d8ff" } } }]);
  assert.equal(receipt.outputHash, sha256(await fs.readFile(receipt.artifacts["after.excalidraw"].path)));
});

test("same recorded request returns the completed bundle without rendering again", async (t) => {
  const { request } = await setup(t);
  let calls = 0;
  const render = async (...args) => { calls++; await renderScene(...args); };
  const first = await editScene(request, { renderScene: render });
  const retry = await editScene(request, { renderScene: render });
  assert.deepEqual(first, retry);
  assert.equal(calls, 2);
  const reordered = { ...request, operations: [{ style: { backgroundColor: "#a5d8ff" }, targetId: "api", op: "setStyle" }] };
  assert.deepEqual(await editScene(reordered, { renderScene: render }), first);
  const different = structuredClone(request);
  different.operations[0].style.backgroundColor = "#ff0000";
  await assert.rejects(editScene(different, { renderScene }), { code: "REQUEST_CONFLICT" });
});

test("retry does not claim a corrupted or incomplete artifact as complete", async (t) => {
  const { request } = await setup(t);
  const first = await editScene(request, { renderScene });
  await fs.writeFile(first.artifacts["after.excalidraw"].path, "changed");
  await assert.rejects(editScene(request, { renderScene }), { code: "CORRUPT_RESULT" });
});

test("receipt verification derives changes and rejects metadata tampering on retry and preview", async (t) => {
  const { request, directory } = await setup(t);
  let renders = 0;
  const render = async (...args) => { renders++; return renderScene(...args); };
  const receipt = await editScene(request, { renderScene: render });
  const { sceneCommand } = await import("../src/commands.js");
  const outside = join(directory, "copied-after.excalidraw");
  await fs.copyFile(receipt.artifacts["after.excalidraw"].path, outside);
  for (const mutate of [
    value => { value.outputHash = "0".repeat(64); },
    value => { value.inputHash = "0".repeat(64); },
    value => { value.changes = []; },
    value => { value.changes[0].properties.backgroundColor.after = "#ff0000"; },
    value => { value.validation.protectedValues = false; },
    value => { value.requestId = "another-request"; },
    value => { value.requestDigest = "0".repeat(64); },
    value => { value.schemaVersion = 2; },
    value => { value.artifacts["after.excalidraw"].path = outside; },
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    await fs.writeFile(receipt.receiptPath, JSON.stringify(changed));
    await assert.rejects(editScene(request, { renderScene: render }), { code: "CORRUPT_RESULT" });
    await assert.rejects(sceneCommand("preview", receipt.receiptPath, { "no-open": true }), { code: "CORRUPT_RESULT" });
  }
  await fs.writeFile(receipt.receiptPath, JSON.stringify(receipt));
  const verified = await verifyReceipt(receipt.receiptPath);
  assert.deepEqual(verified.receipt, receipt);
  assert.deepEqual(deriveSceneChanges(verified.beforeScene, verified.afterScene), receipt.changes);
  assert.deepEqual(await editScene(request, { renderScene: render }), receipt);
  assert.equal(renders, 2);
  const requestPath = join(request.outputDir, request.requestId, "request.json");
  const recorded = JSON.parse(await fs.readFile(requestPath));
  recorded.operations[0].style.backgroundColor = "#ff0000";
  await fs.writeFile(requestPath, JSON.stringify(recorded));
  await assert.rejects(verifyReceipt(receipt.receiptPath), { code: "CORRUPT_RESULT" });
});

test("derived receipts retain tombstones and the appended created-element schema", () => {
  const before = sceneFixture(), after = structuredClone(before);
  after.elements.find(element => element.id === "note").isDeleted = true;
  const added = { id: "new-node", type: "rectangle", x: 450, y: 20, width: 100, height: 60, isDeleted: false };
  after.elements.push(added);
  assert.deepEqual(deriveSceneChanges(before, after), [
    { id: "note", properties: { isDeleted: { before: false, after: true } } },
    { id: "new-node", created: true, properties: Object.fromEntries(Object.entries(added).map(([field, value]) => [field, { before: null, after: value }])) },
  ]);
  const reordered = structuredClone(before); [reordered.elements[0], reordered.elements[1]] = [reordered.elements[1], reordered.elements[0]];
  assert.throws(() => deriveSceneChanges(before, reordered), { code: "CORRUPT_RESULT" });
});

test("completed retry returns its recorded result even when the source later changes", async (t) => {
  const { inputPath, request } = await setup(t);
  const first = await editScene(request, { renderScene });
  await fs.writeFile(inputPath, "subsequent user edit");
  assert.deepEqual(await editScene(request, { renderScene }), first);
  assert.equal(await fs.readFile(inputPath, "utf8"), "subsequent user edit");
});

test("an external edit during rendering is retained while the bundle uses its inspected revision", async (t) => {
  const { inputPath, original, request } = await setup(t);
  const receipt = await editScene(request, { renderScene: async (...args) => {
    await fs.writeFile(inputPath, "user changed the original while rendering");
    await renderScene(...args);
  } });
  assert.equal(await fs.readFile(inputPath, "utf8"), "user changed the original while rendering");
  assert.equal(await fs.readFile(receipt.artifacts["before.excalidraw"].path, "utf8"), original);
  assert.equal(receipt.inputHash, sha256(original));
});

test("stale input and validation failures leave the source intact without a completion receipt", async (t) => {
  const { inputPath, original, request } = await setup(t);
  const stale = { ...request, baseHash: "0".repeat(64) };
  await assert.rejects(editScene(stale, { renderScene }), { code: "STALE_INPUT" });
  await assert.rejects(fs.readFile(join(request.outputDir, request.requestId, "receipt.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
});

test("failed rendering remains incomplete and the same request recovers in a new attempt", async (t) => {
  const { inputPath, original, request } = await setup(t);
  await assert.rejects(editScene(request, { renderScene: async () => { throw new Error("renderer unavailable"); } }), /renderer unavailable/);
  const jobDir = join(request.outputDir, request.requestId);
  await assert.rejects(fs.readFile(join(jobDir, "receipt.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
  const result = await editScene(request, { renderScene });
  assert.equal(result.status, "complete");
  assert.deepEqual((await fs.readdir(join(jobDir, "claims"))).sort(), ["1.json", "2.json"]);
});

test("a renderer cannot mutate canonical scene values", async (t) => {
  const { scene, inputPath, original, request } = await setup(t);
  const mutate = async (document, path) => {
    assert.throws(() => { document.elements[0].x = 999; }, TypeError);
    assert.throws(() => { document.arbitraryMetadata.extension = "lost"; }, TypeError);
    await renderScene(document, path);
  };
  const receipt = await editScene(request, { renderScene: mutate });
  const candidate = JSON.parse(await fs.readFile(receipt.artifacts["after.excalidraw"].path));
  assert.equal(candidate.elements[0].x, scene.elements[0].x);
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
});

test("invalid PNG output is never a completed result", async (t) => {
  const { request } = await setup(t);
  await assert.rejects(editScene(request, { renderScene: async (_, path) => fs.writeFile(path, "not an image") }), { code: "INVALID_RENDER" });
});

test("unexpected native-file writes during rendering cannot be reported as a valid edit", async (t) => {
  const { request, inputPath, original } = await setup(t);
  await assert.rejects(editScene(request, { renderScene: async (document, path) => {
    await fs.writeFile(join(dirname(path), "after.excalidraw"), "normalized by renderer");
    await renderScene(document, path);
  } }), { code: "PROTECTED_CHANGE" });
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
  await assert.rejects(fs.readFile(join(request.outputDir, request.requestId, "receipt.json")), { code: "ENOENT" });
});

test("simultaneous requests cannot own the same job", async (t) => {
  const { request } = await setup(t);
  let release;
  let started;
  const hold = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const first = editScene(request, { renderScene: async (...args) => { started(); await hold; await renderScene(...args); } });
  await entered;
  await assert.rejects(editScene(request, { renderScene }), { code: "REQUEST_BUSY" });
  release();
  const receipt = await first;
  assert.deepEqual(await editScene(request, { renderScene }), receipt);
});

test("racing retries after failure select one generation without stealing a live claim", async (t) => {
  const { request } = await setup(t);
  await assert.rejects(editScene(request, { renderScene: async () => { throw new Error("first failure"); } }));
  let renders = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => editScene(request, { renderScene: async (...args) => {
    renders++;
    await delay(20);
    await renderScene(...args);
  } })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((result) => result.status === "rejected")) assert.equal(result.reason.code, "REQUEST_BUSY");
  assert.equal(renders, 2);
  assert.deepEqual((await fs.readdir(join(request.outputDir, request.requestId, "claims"))).sort(), ["1.json", "2.json"]);
});

test("a killed owner is recovered without deleting or reusing its claim", async (t) => {
  const { directory, request, inputPath, original } = await setup(t);
  const marker = join(directory, "render-started");
  const source = `import { editScene } from ${JSON.stringify(new URL("../src/scene.js", import.meta.url).href)};
    import { promises as fs } from 'node:fs';
    await editScene(${JSON.stringify(request)}, { renderScene: async () => {
      await fs.writeFile(${JSON.stringify(marker)}, 'started');
      await new Promise(() => { setInterval(() => {}, 1000); });
    }});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "pipe" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let started = false;
  for (let count = 0; count < 150; count++) {
    try { await fs.access(marker); started = true; break; } catch {}
    await delay(20);
  }
  assert.equal(started, true, "child reached rendering");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const result = await editScene(request, { renderScene });
  assert.equal(result.status, "complete");
  assert.deepEqual((await fs.readdir(join(request.outputDir, request.requestId, "claims"))).sort(), ["1.json", "2.json"]);
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
});

test("invalid IDs, references, image assets, and unsupported mutations fail explicitly", () => {
  const duplicate = sceneFixture();
  duplicate.elements.push(structuredClone(duplicate.elements[0]));
  assert.throws(() => validateScene(duplicate), { code: "DUPLICATE_ID" });
  const dangling = sceneFixture();
  dangling.elements[1].containerId = "missing";
  assert.throws(() => validateScene(dangling), { code: "INVALID_BINDING" });
  const missing = sceneFixture();
  delete missing.files.asset;
  assert.throws(() => validateScene(missing), { code: "MISSING_ASSET" });
  const scene = sceneFixture();
  assert.throws(() => applyStyleOperations(scene, [{ op: "setStyle", targetId: "future-element", style: { strokeColor: "#fff" } }]), { code: "UNSUPPORTED_TARGET" });
  assert.throws(() => applyStyleOperations(scene, [{ op: "setStyle", targetId: "api", style: { x: 300 } }]), { code: "INVALID_REQUEST" });
  assert.throws(() => applyStyleOperations(scene, [{ op: "setStyle", targetId: "api", style: { strokeColor: "javascript:alert(1)" } }]), { code: "INVALID_REQUEST" });
  assert.throws(() => applyStyleOperations(scene, [{ op: "setLabel", targetId: "api", text: "New" }]), { code: "INVALID_REQUEST" });
});
