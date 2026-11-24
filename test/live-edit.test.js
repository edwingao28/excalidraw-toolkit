import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editLiveCanvas, inspectLiveCanvas } from "../src/live-edit.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zz1kAAAAASUVORK5CYII=", "base64");
const renderScene = async (_scene, path) => fs.writeFile(path, PNG);
const element = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0, strokeColor: "#1e1e1e",
  backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [],
  frameId: null, roundness: null, seed: 1, version: 3, versionNonce: 7, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra });

// Mimics the patched canvas page: a scene, a version derived from element
// versions, and a compare-and-apply that refuses a stale base.
async function canvas(t, { onApply, status } = {}) {
  const state = { elements: [element("api"), element("worker", { x: 300 })], requests: [] };
  const version = () => state.elements.map(item => `${item.id}:${item.version}`).join("|");
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    state.requests.push(request.url);
    const reply = (code, value) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (status) return reply(status.code, status.body);
    if (request.url === "/api/toolkit/scene/snapshot") return reply(200, { success: true, status: "ok", sceneVersion: version(), elements: state.elements, files: {}, appState: {} });
    if (request.url === "/api/toolkit/scene/apply") {
      const { baseVersion, elements } = JSON.parse(body);
      await onApply?.(state);
      if (baseVersion !== version()) return reply(200, { success: true, status: "stale", sceneVersion: version() });
      state.elements = elements;
      return reply(200, { success: true, status: "applied", sceneVersion: version(), elements: state.applied ?? elements });
    }
    reply(404, { success: false, error: "not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directory = await fs.mkdtemp(join(tmpdir(), "toolkit-live-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { state, canvasUrl: `http://127.0.0.1:${server.address().port}`, outputDir: directory };
}

const style = [{ op: "setStyle", targetId: "api", style: { backgroundColor: "#a5d8ff" } }];

test("live inspect reports the open canvas's scene version and stable IDs", async t => {
  const c = await canvas(t);
  const inspected = await inspectLiveCanvas({ canvasUrl: c.canvasUrl });
  assert.equal(inspected.sceneVersion, "api:3|worker:3");
  assert.deepEqual(inspected.elements.map(item => item.id), ["api", "worker"]);
  assert.ok(inspected.capabilities.operations.includes("setStyle"));
});

test("a live edit applies the scene engine's candidate, bumps changed elements and keeps a receipt", async t => {
  const c = await canvas(t);
  const { sceneVersion } = await inspectLiveCanvas({ canvasUrl: c.canvasUrl });
  const receipt = await editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: sceneVersion, requestId: "blue-api", operations: style, outputDir: c.outputDir }, { renderScene });
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.baseVersion, sceneVersion);
  assert.equal(receipt.sceneVersion, "api:4|worker:3");
  const [api, worker] = c.state.elements;
  assert.equal(api.backgroundColor, "#a5d8ff");
  assert.equal(api.version, 4);
  assert.notEqual(api.versionNonce, 7);
  assert.deepEqual(worker, element("worker", { x: 300 }), "unchanged elements keep their revision");
  for (const name of ["before.excalidraw", "after.excalidraw", "before.png", "after.png"]) assert.ok((await fs.stat(receipt.artifacts[name].path)).isFile());
  const again = await editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: sceneVersion, requestId: "blue-api", operations: style, outputDir: c.outputDir }, { renderScene });
  assert.equal(again.reused, true);
  assert.equal(c.state.requests.filter(url => url.endsWith("/apply")).length, 1);
  await assert.rejects(editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: sceneVersion, requestId: "blue-api",
    operations: [{ ...style[0], style: { backgroundColor: "#ffc9c9" } }], outputDir: c.outputDir }, { renderScene }), { code: "REQUEST_CONFLICT" });
});

test("a canvas changed after inspection, or between snapshot and apply, is stale and unchanged", async t => {
  const c = await canvas(t);
  const { sceneVersion } = await inspectLiveCanvas({ canvasUrl: c.canvasUrl });
  c.state.elements[1] = { ...c.state.elements[1], x: 500, version: 4 };
  const before = structuredClone(c.state.elements);
  const stale = await editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: sceneVersion, requestId: "late", operations: style, outputDir: c.outputDir }, { renderScene });
  assert.deepEqual(stale, { status: "stale", baseVersion: sceneVersion, sceneVersion: "api:3|worker:4" });
  assert.deepEqual(c.state.elements, before);
  assert.equal(c.state.requests.filter(url => url.endsWith("/apply")).length, 0, "a stale snapshot is not even sent");

  const racing = await canvas(t, { onApply: state => { state.elements[1] = { ...state.elements[1], version: 9 }; } });
  const current = (await inspectLiveCanvas({ canvasUrl: racing.canvasUrl })).sceneVersion;
  const raced = await editLiveCanvas({ canvasUrl: racing.canvasUrl, baseVersion: current, requestId: "race", operations: style, outputDir: racing.outputDir }, { renderScene });
  assert.equal(raced.status, "stale");
  assert.equal(racing.state.elements[0].backgroundColor, "transparent");
  await assert.rejects(fs.stat(join(racing.outputDir, "race")), { code: "ENOENT" });
});

test("canvas errors, a mismatched confirmation and non-local URLs fail explicitly", async t => {
  const multiple = await canvas(t, { status: { code: 409, body: { success: false, code: "MULTIPLE_CANVASES", error: "close other tabs" } } });
  await assert.rejects(inspectLiveCanvas({ canvasUrl: multiple.canvasUrl }), { code: "MULTIPLE_CANVASES" });
  const old = await canvas(t, { status: { code: 404, body: { error: "Cannot POST" } } });
  await assert.rejects(inspectLiveCanvas({ canvasUrl: old.canvasUrl }), { code: "CANVAS_UNSUPPORTED" });
  const wrong = await canvas(t);
  wrong.state.applied = [element("api"), element("worker", { x: 300 })];
  const { sceneVersion } = await inspectLiveCanvas({ canvasUrl: wrong.canvasUrl });
  await assert.rejects(editLiveCanvas({ canvasUrl: wrong.canvasUrl, baseVersion: sceneVersion, requestId: "mismatch", operations: style, outputDir: wrong.outputDir }, { renderScene }), { code: "CANVAS_MISMATCH" });
  for (const canvasUrl of ["https://127.0.0.1:3000", "http://example.com:3000", "http://127.0.0.1:3000/api", "http://user@127.0.0.1:3000", "not a url"]) {
    await assert.rejects(inspectLiveCanvas({ canvasUrl }), { code: "INVALID_CANVAS" });
  }
  await assert.rejects(inspectLiveCanvas({ canvasUrl: "http://127.0.0.1:9" }), { code: "CANVAS_UNAVAILABLE" });
  await assert.rejects(editLiveCanvas({ canvasUrl: wrong.canvasUrl, baseVersion: "", requestId: "x", operations: style, outputDir: wrong.outputDir }), { code: "INVALID_REQUEST" });
  await assert.rejects(editLiveCanvas({ canvasUrl: wrong.canvasUrl, baseVersion: sceneVersion, requestId: "../x", operations: style, outputDir: wrong.outputDir }), { code: "INVALID_REQUEST" });
});

test("the CLI inspects and edits the canvas on the configured port and exits 2 when stale", async t => {
  const { execFile } = await import("node:child_process");
  const run = args => new Promise(resolve => execFile(process.execPath, [new URL("../bin/cli.js", import.meta.url).pathname, ...args],
    { timeout: 120000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  const c = await canvas(t);
  const port = new URL(c.canvasUrl).port;
  const inspected = JSON.parse((await run(["live-inspect", "--port", port])).stdout);
  assert.equal(inspected.sceneVersion, "api:3|worker:3");
  const requestPath = join(c.outputDir, "request.json");
  await fs.writeFile(requestPath, JSON.stringify({ baseVersion: inspected.sceneVersion, requestId: "cli-edit", operations: style }));
  const edited = await run(["live-edit", "--port", port, "--request", requestPath, "--output", join(c.outputDir, "out")]);
  assert.equal(edited.code, 0);
  assert.equal(JSON.parse(edited.stdout).status, "applied");
  assert.equal(c.state.elements[0].backgroundColor, "#a5d8ff");
  await fs.writeFile(requestPath, JSON.stringify({ baseVersion: inspected.sceneVersion, requestId: "cli-stale", operations: style }));
  const stale = await run(["live-edit", "--port", port, "--request", requestPath, "--output", join(c.outputDir, "out")]);
  assert.equal(stale.code, 2);
  assert.equal(JSON.parse(stale.stdout).status, "stale");
  await fs.writeFile(requestPath, JSON.stringify({ baseVersion: "x", requestId: "cli-extra", operations: style, canvasUrl: "http://127.0.0.1:1" }));
  assert.equal((await run(["live-edit", "--port", port, "--request", requestPath, "--output", join(c.outputDir, "out")])).code, 1);
});
