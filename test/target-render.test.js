import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { measureScene, renderScene } from "../src/target-render.js";

const scene = elements => ({ type: "excalidraw", version: 2, elements, files: {}, appState: { viewBackgroundColor: "#faf9f5" } });
const text = (id, value, extra = {}) => ({ id, type: "text", x: 30, y: 40, width: 1, height: 70,
  fontSize: 28, fontFamily: 5, lineHeight: 1.25, angle: 0, textAlign: "left", verticalAlign: "top", text: value, opacity: 100, strokeColor: "#26251f", ...extra });
async function output(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "toolkit native target "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return join(directory, "target.png");
}
async function inkBounds(path) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async data => {
      const image = new Image(); image.src = data; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (Math.abs(pixels[i] - 250) + Math.abs(pixels[i + 1] - 249) + Math.abs(pixels[i + 2] - 245) > 30) {
          x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
        }
      }
      return { width: canvas.width, height: canvas.height, x1, y1, x2, y2 };
    }, `data:image/png;base64,${(await fs.readFile(path)).toString("base64")}`);
  } finally { await browser.close(); }
}

test("native glyph bounds include loaded Latin/CJK ink beyond stale declared width and match delivered pixels", async t => {
  const input = scene([text("caption", "Shared worker\n共享缓存")]);
  const original = structuredClone(input);
  const metrics = await measureScene(input);
  assert.equal(metrics.fontsLoaded, true); assert.equal(metrics.renderer, "@excalidraw/excalidraw@0.18.1");
  assert.deepEqual(metrics.visibleElementIds, ["caption"]);
  assert.ok(metrics.text[0].width > 100); assert.equal(metrics.text[0].fontSize, 28);
  const path = await output(t);
  await renderScene(input, path, { width: 700, height: 300, scale: 1, offsetX: 0, offsetY: 0 });
  const ink = await inkBounds(path), glyph = metrics.text[0];
  assert.equal(ink.width, 700); assert.equal(ink.height, 300);
  assert.ok(Math.abs(ink.x1 - glyph.x) <= 3); assert.ok(Math.abs(ink.y1 - glyph.y) <= 3);
  assert.ok(Math.abs(ink.x2 - glyph.x - glyph.width) <= 3); assert.ok(Math.abs(ink.y2 - glyph.y - glyph.height) <= 3);
  assert.deepEqual(input, original);
  await assert.rejects(renderScene(input, path, { width: 700, height: 300, scale: 1, offsetX: 0, offsetY: 0 }), { code: "EEXIST" });
});

test("native target export applies exact shared pixel scale and translation without saving the viewport anchor", async t => {
  const input = scene([{ id: "box", type: "rectangle", x: 100, y: 100, width: 200, height: 100, angle: 0,
    strokeColor: "#26251f", backgroundColor: "#26251f", fillStyle: "solid", strokeWidth: 1, roughness: 0, opacity: 100 }]);
  const original = structuredClone(input), path = await output(t);
  await renderScene(input, path, { width: 640, height: 400, scale: 0.5, offsetX: 25, offsetY: 35 });
  const ink = await inkBounds(path);
  assert.deepEqual([ink.width, ink.height], [640, 400]);
  assert.ok(Math.abs(ink.x1 - 75) <= 1); assert.ok(Math.abs(ink.y1 - 85) <= 1);
  assert.ok(Math.abs(ink.x2 - 175) <= 1); assert.ok(Math.abs(ink.y2 - 135) <= 1);
  assert.deepEqual(input, original);
});

test("native bound-arrow label position comes from the arrow, not stale label coordinates", async () => {
  const input = scene([
    { id: "from", type: "rectangle", x: 100, y: 50, width: 100, height: 60, boundElements: [{ id: "arrow", type: "arrow" }] },
    { id: "to", type: "rectangle", x: 400, y: 50, width: 100, height: 60, boundElements: [{ id: "arrow", type: "arrow" }] },
    { id: "arrow", type: "arrow", x: 200, y: 80, width: 200, height: 0, angle: 0, points: [[0, 0], [200, 0]],
      startBinding: { elementId: "from" }, endBinding: { elementId: "to" }, boundElements: [{ id: "caption", type: "text" }] },
    text("caption", "Queue", { x: 999, y: 999, width: 90, height: 35, containerId: "arrow" }),
  ]);
  const metrics = await measureScene(input), caption = metrics.text.find(item => item.id === "caption");
  assert.ok(caption.x > 230 && caption.x < 320); assert.ok(caption.y > 40 && caption.y < 90);
  assert.equal(input.elements.at(-1).x, 999);
});

test("unqualified fonts/frames and a clipped target fail explicitly without output", async t => {
  await assert.rejects(measureScene(scene([text("caption", "Worker", { fontFamily: 2 })])), { code: "UNSUPPORTED_FONT" });
  await assert.rejects(measureScene(scene([{ id: "frame", type: "frame", x: 0, y: 0, width: 200, height: 200 }])), { code: "UNSUPPORTED_TARGET_SCENE" });
  const path = await output(t);
  await assert.rejects(renderScene(scene([text("caption", "Worker", { width: 200 })]), path,
    { width: 100, height: 100, scale: 1, offsetX: 0, offsetY: 0 }), { code: "TARGET_CLIPPING" });
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});
