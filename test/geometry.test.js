import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOperations, editScene, sha256, validateScene } from "../src/scene.js";
import { arrowEndpoints, centerEndpoint, centerOf, routeStraightArrow } from "../src/geometry.js";

function fixture() {
  const shape = (id, type, x, y) => ({ id, type, x, y, width: 100, height: 80, angle: 0, roundness: null, groupIds: ["flow"], boundElements: [{ id: "edge", type: "arrow" }], customData: { preserve: true } });
  const a = shape("a", "rectangle", 0, 0);
  const b = shape("b", "ellipse", 300, 0);
  const label = { id: "label", type: "text", x: 20, y: 25, width: 60, height: 25, angle: 0, containerId: "a", text: "API", originalText: "API", textAlign: "center", verticalAlign: "middle", fontSize: 20, fontFamily: 5, lineHeight: 1.25, autoResize: true };
  a.boundElements.push({ id: "label", type: "text" });
  const arrow = { id: "edge", type: "arrow", x: 110, y: 40, width: 178, height: 0, angle: 0, points: [[0, 0], [178, 0]], startBinding: { elementId: "a", focus: 0, gap: 10 }, endBinding: { elementId: "b", focus: 0, gap: 12 }, boundElements: null, customData: { preserve: "route" } };
  const scene = { type: "excalidraw", version: 2, appState: { gridSize: 20 }, files: {}, elements: [a, label, b, arrow, { id: "note", type: "text", x: 700, y: 300, width: 100, height: 30, angle: 0, text: "Manual note" }] };
  validateScene(scene);
  return scene;
}

test("moving a shape translates its label and preserves every protected field", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, [{ op: "move", targetId: "a", x: -80, y: 0 }]);
  assert.equal(candidate.elements[0].x, -80);
  assert.equal(candidate.elements[1].x, -60);
  assert.equal(candidate.elements[1].y, 25);
  assert.deepEqual(candidate.elements[2], scene.elements[2]);
  assert.deepEqual(candidate.elements[4], scene.elements[4]);
  assert.deepEqual(candidate.elements[3].startBinding, scene.elements[3].startBinding);
  assert.deepEqual(candidate.elements[3].endBinding, scene.elements[3].endBinding);
  assert.deepEqual(arrowEndpoints(candidate.elements[3]), [[30, 40], [288, 40]]);
  assert.deepEqual(changes.map((change) => change.id), ["a", "label", "edge"]);
  assert.deepEqual(Object.keys(changes[0].properties), ["x"]);
  assert.deepEqual(Object.keys(changes[2].properties).sort(), ["points", "width", "x"]);
  validateScene(candidate);
});

test("a changed slope reanchors both native bound endpoints while the stationary shape stays unchanged", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [{ op: "move", targetId: "b", x: 400, y: 120 }]);
  const [start, end] = arrowEndpoints(candidate.elements[3]);
  assert.deepEqual(candidate.elements[0], scene.elements[0]);
  assert.deepEqual(candidate.elements[1], scene.elements[1]);
  assert.notEqual(start[1], 40);
  const a = candidate.elements[0];
  const b = candidate.elements[2];
  assert.deepEqual(start, centerEndpoint(a, centerOf(b), 10));
  assert.deepEqual(end, centerEndpoint(b, centerOf(a), 12));
  assert.deepEqual(candidate.elements[3].endBinding, scene.elements[3].endBinding);
});

test("all supported shapes use their native expanded outline for center bindings", () => {
  for (const [type, expected] of [["rectangle", [60, 60]], ["diamond", [30.5, 30.5]], ["ellipse", [60 / Math.sqrt(2), 60 / Math.sqrt(2)]]]) {
    const actual = centerEndpoint({ id: "shape", type, x: -50, y: -50, width: 100, height: 100, angle: 0, roundness: null }, [200, 200], 10);
    assert.ok(Math.abs(actual[0] - expected[0]) < 0.001);
    assert.ok(Math.abs(actual[1] - expected[1]) < 0.001);
  }
});

test("a single bound endpoint moves while the free endpoint remains exactly fixed", async () => {
  const scene = fixture();
  scene.elements[3].endBinding = null;
  scene.elements[2].boundElements = null;
  const oldFree = arrowEndpoints(scene.elements[3])[1];
  const { candidate } = await applyOperations(scene, [{ op: "move", targetId: "a", x: 0, y: 100 }]);
  assert.deepEqual(arrowEndpoints(candidate.elements[3])[1], oldFree);
});

test("moving both ends in one request updates a shared arrow only once", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, [
    { op: "move", targetId: "a", x: 0, y: 150 },
    { op: "move", targetId: "b", x: 300, y: 150 },
  ]);
  assert.deepEqual(arrowEndpoints(candidate.elements[3]), [[110, 190], [288, 190]]);
  assert.equal(changes.filter((change) => change.id === "edge").length, 1);
});

test("bound arrow text preserves its manual offset from the segment midpoint", async () => {
  const scene = fixture();
  scene.elements[3].boundElements = [{ id: "arrow-label", type: "text" }];
  scene.elements.push({ id: "arrow-label", type: "text", x: 160, y: 45, width: 60, height: 20, angle: 0, containerId: "edge", text: "HTTP" });
  const { candidate } = await applyOperations(scene, [{ op: "move", targetId: "a", x: -80, y: 0 }]);
  assert.equal(candidate.elements[5].x, 120);
  assert.equal(candidate.elements[5].y, 45);
  assert.equal(candidate.elements[5].text, "HTTP");
});

test("existing zone containment and native frame membership survive movement", async () => {
  const scene = fixture();
  scene.elements.push({ id: "zone", type: "rectangle", x: -100, y: -100, width: 600, height: 400, angle: 0 });
  const { candidate } = await applyOperations(scene, [{ op: "move", targetId: "a", x: -50, y: 100 }]);
  assert.deepEqual(candidate.elements[5], scene.elements[5]);
  await assert.rejects(applyOperations(scene, [{ op: "move", targetId: "a", x: -150, y: 0 }]), { code: "GEOMETRY_COLLISION" });
  scene.elements[5].type = "frame";
  scene.elements[0].frameId = "zone";
  await assert.rejects(applyOperations(scene, [{ op: "move", targetId: "a", x: -150, y: 0 }]), { code: "GEOMETRY_COLLISION" });
});

test("unrelated existing overlaps and unsupported arrow paths remain unchanged", async () => {
  const scene = fixture();
  scene.elements.push({ id: "old-overlap", type: "text", x: 700, y: 300, width: 100, height: 30, angle: 0, text: "Already overlapping" });
  scene.elements.push({ id: "manual-unrelated", type: "arrow", x: 800, y: 0, width: 60, height: 40, angle: 0.3, elbowed: true, points: [[0, 0], [20, 30], [60, 40]] });
  const { candidate } = await applyOperations(scene, [{ op: "move", targetId: "a", x: -50, y: 0 }]);
  assert.deepEqual(candidate.elements.slice(4), scene.elements.slice(4));
});

test("new box overlaps and straight-arrow crossings reject before mutation", async () => {
  const scene = fixture();
  await assert.rejects(applyOperations(scene, [{ op: "move", targetId: "a", x: 270, y: 10 }]), { code: "GEOMETRY_COLLISION" });
  scene.elements.push({ id: "blocker", type: "rectangle", x: 180, y: 90, width: 70, height: 30, angle: 0 });
  await assert.rejects(applyOperations(scene, [{ op: "move", targetId: "b", x: 300, y: 160 }]), { code: "GEOMETRY_COLLISION" });
  const stationary = fixture();
  stationary.elements.push({ id: "stationary-arrow", type: "arrow", x: -60, y: -60, angle: 0, points: [[0, 0], [0, 200]] });
  await assert.rejects(applyOperations(stationary, [{ op: "move", targetId: "a", x: -80, y: 0 }]), { code: "GEOMETRY_COLLISION" });
});

test("connected unsupported geometry or a manual path fails explicitly", async () => {
  for (const mutate of [
    (scene) => { scene.elements[3].elbowed = true; },
    (scene) => { scene.elements[3].angle = 0.2; },
    (scene) => { scene.elements[3].points.splice(1, 0, [100, 40]); },
    (scene) => { scene.elements[3].startBinding.focus = 0.2; },
    (scene) => { scene.elements[3].startBinding.fixedPoint = [1, 0.5]; },
    (scene) => { scene.elements[3].points[0][1] = 10; },
    (scene) => { scene.elements[0].roundness = { type: 3 }; },
  ]) {
    const scene = fixture(); mutate(scene);
    await assert.rejects(applyOperations(scene, [{ op: "move", targetId: "a", x: -50, y: 0 }]), { code: "UNSUPPORTED_GEOMETRY" });
  }
});

test("move and relabel compose using the translated text anchor", async () => {
  const scene = fixture();
  const { candidate } = await applyOperations(scene, [
    { op: "setLabel", targetId: "a", text: "New API" },
    { op: "move", targetId: "a", x: -80, y: 0 },
  ], { measureLabel: async () => ({ text: "New API", width: 80, height: 25 }) });
  assert.equal(candidate.elements[1].x, -70);
  assert.equal(candidate.elements[1].text, "New API");
});

test("failed geometry leaves original bytes and produces no completed receipt", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "excalidraw-move-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.excalidraw");
  const bytes = JSON.stringify(fixture());
  await fs.writeFile(inputPath, bytes);
  await assert.rejects(editScene({ inputPath, outputDir: directory, requestId: "bad-move", baseHash: sha256(bytes), operations: [{ op: "move", targetId: "a", x: 270, y: 10 }] }, { renderScene: async () => assert.fail("render must not run") }), { code: "GEOMETRY_COLLISION" });
  assert.equal(await fs.readFile(inputPath, "utf8"), bytes);
  await assert.rejects(fs.access(join(directory, "bad-move", "receipt.json")), { code: "ENOENT" });
});
