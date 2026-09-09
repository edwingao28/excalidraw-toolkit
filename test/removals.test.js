import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOperations, editScene, sha256, validateScene } from "../src/scene.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zz1kAAAAASUVORK5CYII=", "base64");
const renderScene = async (_, path) => fs.writeFile(path, PNG);

function fixture() {
  return {
    type: "excalidraw", version: 2, appState: { gridSize: 20 }, files: { photo: { dataURL: "keep image data", mimeType: "image/png" } }, customData: { annotation: "keep" },
    elements: [
      { id: "api", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0, boundElements: [{ id: "api-label", type: "text" }, { id: "direct", type: "arrow" }] },
      { id: "api-label", type: "text", x: 30, y: 25, width: 60, height: 25, angle: 0, text: "API", originalText: "API", containerId: "api", fontFamily: 5, fontSize: 20, lineHeight: 1.25, textAlign: "center", verticalAlign: "middle", autoResize: true },
      { id: "worker", type: "rectangle", x: 400, y: 0, width: 120, height: 80, angle: 0, boundElements: [{ id: "direct", type: "arrow" }] },
      { id: "direct", type: "arrow", x: 130, y: 40, width: 260, height: 0, angle: 0, points: [[0, 0], [260, 0]], startBinding: { elementId: "api", focus: 0, gap: 10 }, endBinding: { elementId: "worker", focus: 0, gap: 10 }, boundElements: [{ id: "arrow-label", type: "text" }], customData: { manual: true } },
      { id: "arrow-label", type: "text", x: 230, y: 30, width: 60, height: 20, angle: 0, containerId: "direct", text: "HTTP" },
      { id: "note", type: "text", x: 20, y: 250, width: 150, height: 30, angle: 0, text: "Hand-positioned note" },
      { id: "image", type: "image", fileId: "photo", x: 600, y: 100, width: 80, height: 80, angle: 0, customData: { preserve: true } },
      { id: "old-deleted", type: "rectangle", isDeleted: true, customData: { historic: true }, boundElements: [{ id: "old-missing", type: "text" }] },
    ],
  };
}

test("removing an arrow tombstones it and its owned label, unlinking only its live endpoints", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, [{ op: "remove", targetId: "direct" }]);
  validateScene(candidate);
  const expected = structuredClone(scene);
  expected.elements[0].boundElements = [{ id: "api-label", type: "text" }];
  expected.elements[2].boundElements = [];
  expected.elements[3].isDeleted = true;
  expected.elements[4].isDeleted = true;
  assert.deepEqual(candidate, expected);
  assert.deepEqual(changes.map((change) => change.id), ["api", "worker", "direct", "arrow-label"]);
});

test("connected node removal requires an explicit connection policy", async () => {
  await assert.rejects(applyOperations(fixture(), [{ op: "remove", targetId: "api" }]), { code: "AMBIGUOUS_REMOVAL" });
  await assert.rejects(applyOperations(fixture(), [{ op: "remove", targetId: "api", connections: "guess" }]), { code: "INVALID_REQUEST" });
});

test("detach policy removes the node and label while preserving the visible arrow geometry", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [{ op: "remove", targetId: "api", connections: "detach" }]);
  validateScene(candidate);
  assert.equal(candidate.elements[0].isDeleted, true);
  assert.equal(candidate.elements[1].isDeleted, true);
  assert.deepEqual(candidate.elements[3], { ...scene.elements[3], startBinding: null });
  assert.deepEqual(candidate.elements[4], scene.elements[4]);
  assert.deepEqual(candidate.elements[2], scene.elements[2]);
  assert.deepEqual(candidate.elements.slice(5), scene.elements.slice(5));
});

test("remove policy deletes dependent arrows and labels without deleting the opposite component", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [{ op: "remove", targetId: "api", connections: "remove" }]);
  validateScene(candidate);
  assert.deepEqual(candidate.elements.filter((element) => element.isDeleted && element.id !== "old-deleted").map((element) => element.id), ["api", "api-label", "direct", "arrow-label"]);
  assert.deepEqual(candidate.elements[2], { ...scene.elements[2], boundElements: [] });
  assert.deepEqual(candidate.files, scene.files);
});

test("disconnecting selected ends preserves the path, text, and any remaining reciprocal binding", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [{ op: "disconnect", targetId: "direct", end: "start" }]);
  validateScene(candidate);
  assert.deepEqual(candidate.elements[3], { ...scene.elements[3], startBinding: null });
  assert.deepEqual(candidate.elements[0].boundElements, [{ id: "api-label", type: "text" }]);
  assert.deepEqual(candidate.elements[2], scene.elements[2]);
  const both = await applyOperations(scene, [{ op: "disconnect", targetId: "direct", end: "both" }]);
  validateScene(both.candidate);
  assert.equal(both.candidate.elements[3].endBinding, null);
  assert.deepEqual(both.candidate.elements[2].boundElements, []);
  const loop = fixture();
  loop.elements[3].endBinding.elementId = "api";
  loop.elements[2].boundElements = [];
  const partial = await applyOperations(loop, [{ op: "disconnect", targetId: "direct", end: "start" }]);
  assert.deepEqual(partial.candidate.elements[0].boundElements, loop.elements[0].boundElements);
  validateScene(partial.candidate);
});

test("deleting a bound label or image preserves unrelated native data and asset bytes", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [{ op: "remove", targetId: "api-label" }, { op: "remove", targetId: "image" }]);
  validateScene(candidate);
  assert.deepEqual(candidate.elements[0].boundElements, [{ id: "direct", type: "arrow" }]);
  assert.deepEqual(candidate.elements[6], { ...scene.elements[6], isDeleted: true });
  assert.deepEqual(candidate.files, scene.files);
  assert.deepEqual(candidate.elements[7], scene.elements[7]);
});

test("frames cannot be deleted while they retain live children", async () => {
  const scene = fixture();
  scene.elements.push({ id: "frame", type: "frame", x: -20, y: -20, width: 160, height: 120, angle: 0 });
  scene.elements[0].frameId = "frame";
  scene.elements[1].frameId = "frame";
  await assert.rejects(applyOperations(scene, [{ op: "remove", targetId: "frame" }]), { code: "AMBIGUOUS_REMOVAL" });
  const { candidate } = await applyOperations(scene, [{ op: "remove", targetId: "frame" }, { op: "remove", targetId: "api", connections: "remove" }]);
  validateScene(candidate);
  assert.equal(candidate.elements[8].isDeleted, true);
});

test("revise a direct flow into a queue flow while preserving manual annotations", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [
    { op: "setLabel", targetId: "api", text: "Entry" },
    { op: "addNode", id: "queue", type: "rectangle", x: 200, y: 0, width: 120, height: 80, region: { x: 180, y: -10, width: 160, height: 100 }, label: { id: "queue-label", text: "Queue" } },
    { op: "connect", id: "enqueue", fromId: "api", toId: "queue" },
    { op: "connect", id: "dequeue", fromId: "queue", toId: "worker" },
    { op: "remove", targetId: "direct" },
  ], { measureLabel: async ({ text }) => ({ text, width: 60, height: 25 }) });
  const index = validateScene(candidate);
  assert.equal(index.get("direct").isDeleted, true);
  assert.equal(index.get("arrow-label").isDeleted, true);
  assert.equal(index.get("api-label").text, "Entry");
  assert.equal(index.get("enqueue").endBinding.elementId, "queue");
  assert.equal(index.get("dequeue").endBinding.elementId, "worker");
  assert.deepEqual(index.get("note"), scene.elements[5]);
  assert.deepEqual(candidate.files, scene.files);
});

test("deletion uses the shared retry and recovery contract", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "excalidraw-remove-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.excalidraw");
  const original = JSON.stringify(fixture());
  await fs.writeFile(inputPath, original);
  const request = { inputPath, outputDir: directory, requestId: "remove-001", baseHash: sha256(original), operations: [{ op: "remove", targetId: "api", connections: "remove" }] };
  await assert.rejects(editScene(request, { renderScene: async () => { throw new Error("interrupted render"); } }));
  await assert.rejects(fs.access(join(directory, request.requestId, "receipt.json")), { code: "ENOENT" });
  const receipt = await editScene(request, { renderScene });
  assert.deepEqual(await editScene(request, { renderScene: async () => assert.fail("must reuse completed result") }), receipt);
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
  validateScene(JSON.parse(await fs.readFile(receipt.artifacts["after.excalidraw"].path)));
});

test("unsupported or contradictory deletion requests fail without inference", async () => {
  await assert.rejects(applyOperations(fixture(), [{ op: "disconnect", targetId: "direct" }]), { code: "INVALID_REQUEST" });
  await assert.rejects(applyOperations(fixture(), [{ op: "disconnect", targetId: "api", end: "both" }]), { code: "UNSUPPORTED_TARGET" });
  await assert.rejects(applyOperations(fixture(), [{ op: "remove", targetId: "old-deleted" }]), { code: "UNKNOWN_TARGET" });
  await assert.rejects(applyOperations(fixture(), [{ op: "remove", targetId: "api", connections: "remove" }, { op: "disconnect", targetId: "direct", end: "both" }]), { code: "INVALID_REQUEST" });
});
