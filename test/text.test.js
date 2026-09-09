import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOperations, editScene, sha256 } from "../src/scene.js";
import { labelUpdate } from "../src/text.js";

function fixture() {
  return {
    type: "excalidraw", version: 2, appState: { viewBackgroundColor: "#f0f0f0" }, files: {},
    elements: [
      { id: "box", type: "rectangle", x: 20, y: 20, width: 420, height: 140, angle: 0, backgroundColor: "#fff", boundElements: [{ id: "label", type: "text" }] },
      { id: "label", type: "text", containerId: "box", x: 100, y: 65, width: 160, height: 25, angle: 0, fontFamily: 5, fontSize: 20, lineHeight: 1.25, textAlign: "center", verticalAlign: "middle", autoResize: true, text: "Cache", originalText: "Cache", customData: { annotation: "preserve" } },
      { id: "other", type: "rectangle", x: 700, y: 40, width: 200, height: 100, angle: 0, boundElements: [{ id: "other-label", type: "text" }] },
      { id: "other-label", type: "text", containerId: "other", text: "Cache", originalText: "Cache" },
      { id: "note", type: "text", text: "Manually placed", x: 900, y: 70, customData: { style: "keep" } },
    ],
    metadata: { manual: true },
  };
}

test("relabel targets an existing bound text ID and preserves container, duplicate labels, and metadata", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, [{ op: "setLabel", targetId: "box", text: "Shared cache" }], {
    measureLabel: async (specification) => {
      assert.deepEqual(specification, { text: "Shared cache", fontSize: 20, fontFamily: 5, lineHeight: 1.25, maxWidth: 310 });
      return { text: "Shared cache", width: 200, height: 25 };
    },
  });
  const expected = structuredClone(scene);
  Object.assign(expected.elements[1], { text: "Shared cache", originalText: "Shared cache", width: 200, x: 80 });
  assert.deepEqual(candidate, expected);
  assert.deepEqual(changes.map((change) => change.id), ["label"]);
  assert.equal(candidate.elements[1].x + candidate.elements[1].width / 2, scene.elements[1].x + scene.elements[1].width / 2);
});

test("multiline and CJK text keeps the requested content and loaded font metrics", async () => {
  const scene = fixture();
  const result = await labelUpdate(scene, "box", "Shared cache\n共享缓存", async () => ({ text: "Shared cache\n共享缓存", width: 150, height: 50 }));
  assert.deepEqual(result, { targetId: "label", properties: { text: "Shared cache\n共享缓存", originalText: "Shared cache\n共享缓存", width: 150, height: 50, x: 105, y: 52.5 } });
});

test("manual left/right and top/bottom anchors survive a text size change", async () => {
  for (const [textAlign, verticalAlign, x, y] of [["left", "top", 37, 40], ["right", "bottom", 270, 120]]) {
    const scene = fixture();
    Object.assign(scene.elements[1], { textAlign, verticalAlign, x, y });
    const result = await labelUpdate(scene, "box", "New", async () => ({ text: "New", width: 100, height: 50 }));
    assert.equal(result.properties.x, textAlign === "left" ? x : x + 60);
    assert.equal(result.properties.y, verticalAlign === "top" ? y : y - 25);
  }
});

test("a manually sized text box retains its width and horizontal position", async () => {
  const scene = fixture();
  scene.elements[1].autoResize = false;
  const result = await labelUpdate(scene, "box", "Wrapped label", async ({ maxWidth }) => {
    assert.equal(maxWidth, 160);
    return { text: "Wrapped\nlabel", width: 120, height: 50 };
  });
  assert.equal(result.properties.width, 160);
  assert.equal(result.properties.x, 100);
});

test("an overflowing label fails before native files or previews are written", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "excalidraw-text-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.excalidraw");
  const bytes = JSON.stringify(fixture());
  await fs.writeFile(inputPath, bytes);
  let renderCalls = 0;
  const outputDir = join(directory, "output");
  await assert.rejects(editScene({ inputPath, outputDir, requestId: "overflow", baseHash: sha256(bytes), operations: [{ op: "setLabel", targetId: "box", text: "Much longer label" }] }, {
    measureLabel: async () => ({ text: "Much longer label", width: 200, height: 200 }),
    renderScene: async () => { renderCalls++; },
  }), { code: "TEXT_OVERFLOW" });
  assert.equal(await fs.readFile(inputPath, "utf8"), bytes);
  assert.equal(renderCalls, 0);
  const attempts = join(outputDir, "overflow", "attempts");
  const [attempt] = await fs.readdir(attempts);
  assert.deepEqual((await fs.readdir(join(attempts, attempt))).sort(), ["finished.json", "owner.json"]);
  await assert.rejects(fs.access(join(outputDir, "overflow", "receipt.json")), { code: "ENOENT" });
});

test("unsupported geometry, fonts, malformed metrics, and absent labels fail explicitly", async () => {
  const metrics = async () => ({ text: "New", width: 80, height: 25 });
  for (const type of ["ellipse", "diamond", "arrow"]) {
    const scene = fixture(); scene.elements[0].type = type;
    await assert.rejects(labelUpdate(scene, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  }
  const rotated = fixture(); rotated.elements[0].angle = 0.1;
  await assert.rejects(labelUpdate(rotated, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  const unbound = fixture(); unbound.elements[0].boundElements = [];
  await assert.rejects(labelUpdate(unbound, "box", "New", metrics), { code: "INVALID_BINDING" });
  const localFont = fixture(); localFont.elements[1].fontFamily = 2;
  await assert.rejects(labelUpdate(localFont, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  const cjk = fixture(); cjk.elements[1].fontFamily = 1;
  await assert.rejects(labelUpdate(cjk, "box", "共享缓存", metrics), { code: "UNSUPPORTED_FONT_TEXT" });
  await assert.rejects(labelUpdate(fixture(), "box", "New", async () => ({ text: "Lost", width: 80, height: 25 })), { code: "INVALID_TEXT_METRICS" });
  await assert.rejects(labelUpdate(fixture(), "box", "New", async () => ({ text: "New", width: NaN, height: 25 })), { code: "INVALID_TEXT_METRICS" });
});

test("style and label operations share one protected-field transaction", async () => {
  const scene = fixture();
  const { candidate, changes } = await applyOperations(scene, [
    { op: "setStyle", targetId: "box", style: { backgroundColor: "#a5d8ff" } },
    { op: "setLabel", targetId: "box", text: "New" },
  ], { measureLabel: async () => ({ text: "New", width: 70, height: 25 }) });
  assert.equal(candidate.elements[0].backgroundColor, "#a5d8ff");
  assert.equal(candidate.elements[1].originalText, "New");
  assert.deepEqual(changes.map((change) => change.id), ["box", "label"]);
  assert.deepEqual(candidate.elements.slice(2), scene.elements.slice(2));
});
