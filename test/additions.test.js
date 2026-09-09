import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOperations, editScene, sha256, validateScene } from "../src/scene.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zz1kAAAAASUVORK5CYII=", "base64");
const measureLabel = async ({ text }) => ({ text, width: 65, height: 25 });
const renderScene = async (_, path) => fs.writeFile(path, PNG);

function fixture() {
  return {
    type: "excalidraw", version: 2, files: { unused: { id: "unused", dataURL: "keep this asset" } }, appState: { gridSize: 20 }, customData: { keep: true },
    elements: [
      { id: "api", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0, roundness: null, boundElements: [{ id: "direct", type: "arrow" }], customData: { manual: true } },
      { id: "worker", type: "rectangle", x: 400, y: 0, width: 120, height: 80, angle: 0, roundness: null, boundElements: [{ id: "direct", type: "arrow" }] },
      { id: "direct", type: "arrow", x: 130, y: 40, width: 260, height: 0, angle: 0, points: [[0, 0], [260, 0]], startBinding: { elementId: "api", focus: 0, gap: 10 }, endBinding: { elementId: "worker", focus: 0, gap: 10 } },
      { id: "note", type: "text", x: 20, y: 260, width: 150, height: 30, angle: 0, text: "Manual note" },
      { id: "deleted", type: "rectangle", x: 20, y: 300, width: 100, height: 80, angle: 0, isDeleted: true },
    ],
  };
}

function operations() {
  return [
    { op: "addNode", id: "queue", type: "rectangle", x: 200, y: 160, width: 140, height: 80, region: { x: 180, y: 150, width: 180, height: 100 }, label: { id: "queue-label", text: "Queue" }, style: { backgroundColor: "#fff3bf" } },
    { op: "connect", id: "enqueue", fromId: "api", toId: "queue" },
    { op: "connect", id: "dequeue", fromId: "queue", toId: "worker" },
  ];
}

test("add a measured node and its requested connections exactly once with reciprocal bindings", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, operations(), { measureLabel });
  const index = validateScene(candidate);
  assert.deepEqual(candidate.elements.map((element) => element.id), [...scene.elements.map((element) => element.id), "queue", "queue-label", "enqueue", "dequeue"]);
  assert.deepEqual(index.get("api").boundElements, [{ id: "direct", type: "arrow" }, { id: "enqueue", type: "arrow" }]);
  assert.deepEqual(index.get("queue").boundElements, [{ id: "queue-label", type: "text" }, { id: "enqueue", type: "arrow" }, { id: "dequeue", type: "arrow" }]);
  assert.equal(index.get("queue-label").containerId, "queue");
  assert.equal(index.get("queue-label").originalText, "Queue");
  assert.equal(index.get("queue-label").x, 237.5);
  assert.deepEqual(candidate.elements.slice(2, 5), scene.elements.slice(2));
  assert.deepEqual(candidate.files, scene.files);
  assert.deepEqual(candidate.customData, scene.customData);
  assert.deepEqual(changes.filter((change) => change.created).map((change) => change.id), ["queue", "queue-label", "enqueue", "dequeue"]);
  assert.deepEqual(changes.filter((change) => !change.created).map((change) => Object.keys(change.properties)), [["boundElements"], ["boundElements"]]);
});

test("explicit IDs make the complete new native elements deterministic", async () => {
  const first = await applyOperations(fixture(), operations(), { measureLabel });
  const second = await applyOperations(fixture(), operations(), { measureLabel });
  assert.deepEqual(first, second);
  for (const id of ["api", "deleted", "queue-label"]) {
    const request = operations(); request[0].id = id;
    await assert.rejects(applyOperations(fixture(), request, { measureLabel }), { code: "ID_CONFLICT" });
  }
});

test("failed rendering recovers with identical IDs and bytes; completed retry returns the same result", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "excalidraw-add-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.excalidraw");
  const original = JSON.stringify(fixture());
  await fs.writeFile(inputPath, original);
  const request = { inputPath, outputDir: directory, requestId: "queue-001", baseHash: sha256(original), operations: operations() };
  await assert.rejects(editScene(request, { measureLabel, renderScene: async () => { throw new Error("render failed"); } }));
  const attempts = join(directory, request.requestId, "attempts");
  const [failedAttempt] = await fs.readdir(attempts);
  const failedBytes = await fs.readFile(join(attempts, failedAttempt, "after.excalidraw"), "utf8");
  const receipt = await editScene(request, { measureLabel, renderScene });
  assert.equal(await fs.readFile(receipt.artifacts["after.excalidraw"].path, "utf8"), failedBytes);
  assert.deepEqual(await editScene(request, { measureLabel, renderScene: async () => assert.fail("retry must not render") }), receipt);
  assert.equal(await fs.readFile(inputPath, "utf8"), original);
});

test("new nodes must fit their declared region and avoid existing content", async () => {
  const outside = operations(); outside[0].region.width = 50;
  await assert.rejects(applyOperations(fixture(), outside, { measureLabel }), { code: "PLACEMENT_CONFLICT" });
  const overlap = [operations()[0]]; Object.assign(overlap[0], { x: 20, y: 20, region: { x: 0, y: 0, width: 300, height: 200 } });
  await assert.rejects(applyOperations(fixture(), overlap, { measureLabel }), { code: "PLACEMENT_CONFLICT" });
  const crossing = operations(); Object.assign(crossing[0], { y: 0, region: { x: 180, y: 0, width: 180, height: 100 } });
  await assert.rejects(applyOperations(fixture(), crossing, { measureLabel }), { code: "PLACEMENT_CONFLICT" });
});

test("a named region permits intentional containment and sets native frame membership", async () => {
  const scene = fixture();
  scene.elements.push({ id: "zone", type: "frame", x: 180, y: 140, width: 200, height: 120, angle: 0 });
  const request = [operations()[0]];
  request[0].region.containerId = "zone";
  const { candidate } = await applyOperations(scene, request, { measureLabel });
  assert.equal(candidate.elements.find((element) => element.id === "queue").frameId, "zone");
  assert.equal(candidate.elements.find((element) => element.id === "queue-label").frameId, "zone");
  validateScene(candidate);
  delete request[0].region.containerId;
  await assert.rejects(applyOperations(scene, request, { measureLabel }), { code: "PLACEMENT_CONFLICT" });
});

test("all node shapes measure against their native label interior and reject overflow", async () => {
  for (const [type, expectedWidth] of [["rectangle", 130], ["ellipse", Math.round(140 * Math.SQRT1_2) - 10], ["diamond", 60]]) {
    const request = [operations()[0]]; request[0].type = type;
    await applyOperations(fixture(), request, { measureLabel: async ({ text, maxWidth }) => {
      assert.equal(maxWidth, expectedWidth); return { text, width: 50, height: 25 };
    } });
    await assert.rejects(applyOperations(fixture(), request, { measureLabel: async ({ text }) => ({ text, width: 500, height: 25 }) }), { code: "TEXT_OVERFLOW" });
  }
});

test("missing relationships, duplicated IDs, or unsupported connection geometry fail explicitly", async () => {
  const missing = operations(); missing[1].toId = "absent";
  await assert.rejects(applyOperations(fixture(), missing, { measureLabel }), { code: "UNKNOWN_TARGET" });
  const duplicate = operations(); duplicate[2].id = duplicate[1].id;
  await assert.rejects(applyOperations(fixture(), duplicate, { measureLabel }), { code: "ID_CONFLICT" });
  const self = [{ op: "connect", id: "self", fromId: "api", toId: "api" }];
  await assert.rejects(applyOperations(fixture(), self), { code: "UNSUPPORTED_GEOMETRY" });
  const invalid = operations(); invalid[1].gap = NaN;
  await assert.rejects(applyOperations(fixture(), invalid, { measureLabel }), { code: "INVALID_REQUEST" });
});
