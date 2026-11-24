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

// Bound-text placement as native Excalidraw 0.18.1 computes it
// (computeBoundTextPosition with getContainerCoords and getBoundTextMax*),
// written out independently of the implementation under test.
function nativePosition(container, width, height, textAlign = "center", verticalAlign = "middle") {
  let offsetX = 5, offsetY = 5;
  if (container.type === "ellipse") { offsetX += (container.width / 2) * (1 - Math.sqrt(2) / 2); offsetY += (container.height / 2) * (1 - Math.sqrt(2) / 2); }
  if (container.type === "diamond") { offsetX += container.width / 4; offsetY += container.height / 4; }
  const maxWidth = container.type === "ellipse" ? Math.round((container.width / 2) * Math.sqrt(2)) - 10 : container.type === "diamond" ? Math.round(container.width / 2) - 10 : container.width - 10;
  const maxHeight = container.type === "ellipse" ? Math.round((container.height / 2) * Math.sqrt(2)) - 10 : container.type === "diamond" ? Math.round(container.height / 2) - 10 : container.height - 10;
  const x = container.x + offsetX + (textAlign === "left" ? 0 : textAlign === "right" ? maxWidth - width : maxWidth / 2 - width / 2);
  const y = container.y + offsetY + (verticalAlign === "top" ? 0 : verticalAlign === "bottom" ? maxHeight - height : maxHeight / 2 - height / 2);
  return { x, y, maxWidth, maxHeight };
}

function shapedFixture(type, { angle = 0, textAlign = "center", verticalAlign = "middle" } = {}) {
  const scene = fixture();
  Object.assign(scene.elements[0], { type, x: 20, y: 20, width: 400, height: 200, angle });
  const { x, y } = nativePosition(scene.elements[0], 60, 25, textAlign, verticalAlign);
  Object.assign(scene.elements[1], { x, y, width: 60, height: 25, angle, textAlign, verticalAlign });
  return scene;
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

test("ellipse and diamond labels fit the native inscribed text area and land where Excalidraw places them", async () => {
  for (const type of ["ellipse", "diamond"]) {
    for (const [textAlign, verticalAlign] of [["center", "middle"], ["left", "top"], ["right", "bottom"]]) {
      const scene = shapedFixture(type, { textAlign, verticalAlign });
      const native = nativePosition(scene.elements[0], 120, 50, textAlign, verticalAlign);
      const result = await labelUpdate(scene, "box", "Shared cache", async ({ maxWidth }) => {
        if (textAlign === "center") assert.equal(maxWidth, native.maxWidth);
        return { text: "Shared\ncache", width: 120, height: 50 };
      });
      assertClose(result.properties.x, native.x, `${type} ${textAlign} x`);
      assertClose(result.properties.y, native.y, `${type} ${verticalAlign} y`);
      assert.equal(result.properties.width, 120);
      assert.equal("angle" in result.properties, false);
    }
  }
});

test("text that fits a rectangle but not an ellipse or diamond of the same size overflows", async () => {
  const wide = async () => ({ text: "Shared cache", width: 300, height: 25 });
  const rectangle = shapedFixture("rectangle");
  assert.equal((await labelUpdate(rectangle, "box", "Shared cache", wide)).properties.width, 300);
  for (const type of ["ellipse", "diamond"]) {
    await assert.rejects(labelUpdate(shapedFixture(type), "box", "Shared cache", wide), { code: "TEXT_OVERFLOW" });
  }
  const tall = async () => ({ text: "Shared cache", width: 60, height: 150 });
  for (const type of ["ellipse", "diamond"]) {
    await assert.rejects(labelUpdate(shapedFixture(type), "box", "Shared cache", tall), { code: "TEXT_OVERFLOW" });
  }
});

test("a centered label in a rotated container keeps its angle and native unrotated-frame position", async () => {
  for (const type of ["rectangle", "ellipse", "diamond"]) {
    const scene = shapedFixture(type, { angle: 0.6 });
    const native = nativePosition(scene.elements[0], 140, 50);
    const result = await labelUpdate(scene, "box", "Shared cache", async () => ({ text: "Shared\ncache", width: 140, height: 50 }));
    assertClose(result.properties.x, native.x, `${type} x`);
    assertClose(result.properties.y, native.y, `${type} y`);
    assert.equal("angle" in result.properties, false);
    const { candidate } = await applyOperations(scene, [{ op: "setLabel", targetId: "box", text: "Shared cache" }], {
      measureLabel: async () => ({ text: "Shared\ncache", width: 140, height: 50 }),
    });
    assert.equal(candidate.elements[1].angle, 0.6);
    assert.equal(candidate.elements[0].angle, 0.6);
  }
});

test("rotated containers reject non-centered labels and labels that do not share the angle", async () => {
  const metrics = async () => ({ text: "New", width: 80, height: 25 });
  for (const [textAlign, verticalAlign] of [["left", "middle"], ["center", "top"], ["right", "bottom"]]) {
    await assert.rejects(labelUpdate(shapedFixture("rectangle", { angle: 0.6, textAlign, verticalAlign }), "box", "New", metrics),
      { code: "UNSUPPORTED_TARGET", message: /centered/ });
  }
  const mismatched = shapedFixture("ellipse", { angle: 0.6 }); mismatched.elements[1].angle = 0;
  await assert.rejects(labelUpdate(mismatched, "box", "New", metrics), { code: "UNSUPPORTED_TARGET", message: /share its container's angle/ });
  const rotatedText = shapedFixture("rectangle"); rotatedText.elements[1].angle = 0.3;
  await assert.rejects(labelUpdate(rotatedText, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  const nonFinite = shapedFixture("rectangle"); nonFinite.elements[0].angle = NaN;
  await assert.rejects(labelUpdate(nonFinite, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
});

test("unsupported geometry, fonts, malformed metrics, and absent labels fail explicitly", async () => {
  const metrics = async () => ({ text: "New", width: 80, height: 25 });
  for (const type of ["arrow", "line", "frame"]) {
    const scene = fixture(); scene.elements[0].type = type;
    await assert.rejects(labelUpdate(scene, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  }
  for (const [type, width] of [["rectangle", 10], ["ellipse", 14], ["diamond", 20]]) {
    const tiny = fixture(); Object.assign(tiny.elements[0], { type, width });
    await assert.rejects(labelUpdate(tiny, "box", "New", metrics), { code: "UNSUPPORTED_TARGET", message: /too small/ });
  }
  const rotated = fixture(); rotated.elements[0].angle = 0.1;
  await assert.rejects(labelUpdate(rotated, "box", "New", metrics), { code: "UNSUPPORTED_TARGET" });
  const unbound = fixture(); unbound.elements[0].boundElements = [];
  await assert.rejects(labelUpdate(unbound, "box", "New", metrics), { code: "INVALID_BINDING" });
  const localFont = fixture(); localFont.elements[1].fontFamily = 2;
  await assert.rejects(labelUpdate(localFont, "box", "New", metrics), { code: "UNSUPPORTED_TARGET", message: /System Helvetica/ });
  const unknownFont = fixture(); unknownFont.elements[1].fontFamily = 4;
  await assert.rejects(labelUpdate(unknownFont, "box", "New", metrics), { code: "UNSUPPORTED_TARGET", message: /bundled font/ });
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
