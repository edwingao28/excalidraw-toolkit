import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLabel } from "../src/text.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../src/scene.js";

test("native bundled font metrics wrap text at the supplied width", async () => {
  const specification = { text: "Shared cache", fontSize: 20, fontFamily: 5, lineHeight: 1.25 };
  const wide = await measureLabel({ ...specification, maxWidth: 200 });
  const narrow = await measureLabel({ ...specification, maxWidth: 80 });
  assert.equal(wide.text, specification.text);
  assert.ok(wide.width > 80 && wide.width <= 200);
  assert.equal(wide.height, 25);
  assert.equal(narrow.text, "Shared\ncache");
  assert.ok(narrow.width <= 80);
  assert.equal(narrow.height, 50);
});

test("native Excalifont and bundled CJK fallback measure multilingual lines", async () => {
  const result = await measureLabel({ text: "Shared cache\n共享缓存", fontSize: 20, fontFamily: 5, lineHeight: 1.25, maxWidth: 160 });
  assert.equal(result.text, "Shared cache\n共享缓存");
  assert.ok(result.width > 0 && result.width <= 160);
  assert.equal(result.height, 50);
});

test("every advertised bundled family loads and uses its own metrics", async () => {
  const specification = { text: "Worker queue", fontSize: 20, lineHeight: 1.25, maxWidth: 220 };
  const widths = [];
  for (const fontFamily of [1, 3, 5, 6, 7, 8, 9]) {
    const result = await measureLabel({ ...specification, fontFamily });
    assert.equal(result.text, specification.text);
    assert.ok(result.width > 0 && result.width <= 220);
    widths.push(result.width);
  }
  assert.notEqual(widths[0], widths[1]);
});

test("missing Chromium gives the toolkit recovery command before writing label candidates", async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "toolkit-missing-label-browser-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const browserPath = join(root, "empty-browsers"), inputPath = join(root, "input.excalidraw"), outputDir = join(root, "output");
  await fs.mkdir(browserPath);
  const bytes = JSON.stringify({ type: "excalidraw", elements: [
    { id: "box", type: "rectangle", x: 0, y: 0, width: 300, height: 100, angle: 0, boundElements: [{ id: "label", type: "text" }] },
    { id: "label", type: "text", containerId: "box", x: 10, y: 10, width: 100, height: 25, angle: 0, text: "Cache", fontSize: 20, fontFamily: 5,
      lineHeight: 1.25, textAlign: "left", verticalAlign: "top", autoResize: true },
  ] });
  await fs.writeFile(inputPath, bytes);
  const request = { inputPath, outputDir, requestId: "missing-browser", baseHash: sha256(bytes), operations: [{ op: "setLabel", targetId: "box", text: "Shared cache" }] };
  const script = `const {editScene}=await import(process.argv[1]);try{await editScene(JSON.parse(process.argv[2]));process.exitCode=2;}catch(error){console.log(JSON.stringify({code:error.code,message:error.message}));}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, new URL("../src/scene.js", import.meta.url).href, JSON.stringify(request)],
    { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath }, timeout: 10000 });
  const result = JSON.parse(stdout);
  assert.equal(result.code, "PREVIEW_BROWSER_MISSING");
  assert.match(result.message, /excalidraw-toolkit setup-preview/);
  assert.equal(await fs.readFile(inputPath, "utf8"), bytes);
  const jobDir = join(outputDir, request.requestId);
  await assert.rejects(fs.stat(join(jobDir, "receipt.json")), { code: "ENOENT" });
  for (const attempt of await fs.readdir(join(jobDir, "attempts"))) {
    const files = await fs.readdir(join(jobDir, "attempts", attempt));
    assert.equal(files.some(file => /\.(?:excalidraw|png)$/.test(file)), false);
  }
  assert.deepEqual(await fs.readdir(browserPath), []);
});
