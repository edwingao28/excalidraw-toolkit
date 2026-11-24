import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium } from "playwright";
import { editLiveCanvas, inspectLiveCanvas } from "../src/live-edit.js";

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }).on("error", reject);
});
const post = async (url, body, method = "POST") => (await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
async function until(check, message, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch {}
    if (Date.now() > deadline) throw new Error(message);
    await delay(250);
  }
}

// The real pinned server with the toolkit's routes, and a real canvas page.
async function liveCanvas(t) {
  const home = await fs.mkdtemp(join(tmpdir(), "toolkit-live-canvas-"));
  const port = await freePort();
  const canvasUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [new URL("../src/canvas-server.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", EXCALIDRAW_TOOLKIT_HOME: home, EXCALIDRAW_TOOLKIT_LAUNCH_ID: randomUUID(), LOG_FILE_PATH: join(home, "backend.log") },
    stdio: "ignore",
  });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); child.kill("SIGKILL"); await fs.rm(home, { recursive: true, force: true }); });
  await until(async () => (await fetch(`${canvasUrl}/health`)).ok, "canvas server did not start");
  const page = await browser.newPage();
  await page.goto(canvasUrl);
  await until(async () => (await post(`${canvasUrl}/api/toolkit/scene/snapshot`, {})).status === "ok", "canvas page did not become ready");
  return { canvasUrl, browser, page, home, outputDir: join(home, "live") };
}

test("a live edit lands in the open canvas only at the inspected version and syncs back to the server", { timeout: 180000 }, async t => {
  const c = await liveCanvas(t);
  // Other web pages and rebound hostnames cannot reach the live-edit routes.
  const { request } = await import("node:http");
  const raw = (path, headers) => new Promise((resolve, reject) => {
    const call = request(`${c.canvasUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    call.on("error", reject); call.end("{}");
  });
  const port = new URL(c.canvasUrl).port;
  for (const [path, headers] of [["/api/toolkit/scene/snapshot", { Origin: "https://evil.example" }], ["/api/toolkit/scene/apply", { Origin: "https://evil.example" }],
    ["/api/toolkit/scene/result", { Origin: "null" }], ["/api/toolkit/scene/snapshot", { Host: `rebound.example:${port}` }]]) {
    const refused = await raw(path, headers);
    assert.deepEqual([refused.status, refused.body.code], [403, "FORBIDDEN_ORIGIN"], `${path} ${JSON.stringify(headers)}`);
  }
  assert.equal((await raw("/api/toolkit/scene/snapshot", { Origin: c.canvasUrl })).status, 200);
  for (const [id, x] of [["api", 80], ["worker", 380]]) {
    assert.equal((await post(`${c.canvasUrl}/api/elements`, { id, type: "rectangle", x, y: 80, width: 180, height: 90 })).success, true);
  }
  const inspected = await until(async () => {
    const value = await inspectLiveCanvas({ canvasUrl: c.canvasUrl });
    return value.elements.filter(element => !element.isDeleted).length === 2 && value;
  }, "seeded elements did not reach the canvas");

  const receipt = await editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: inspected.sceneVersion, requestId: "blue-api",
    operations: [{ op: "setStyle", targetId: "api", style: { backgroundColor: "#a5d8ff" } }], outputDir: c.outputDir });
  assert.equal(receipt.status, "applied");
  assert.notEqual(receipt.sceneVersion, inspected.sceneVersion);
  const after = await inspectLiveCanvas({ canvasUrl: c.canvasUrl });
  assert.equal(after.sceneVersion, receipt.sceneVersion);
  const snapshot = await post(`${c.canvasUrl}/api/toolkit/scene/snapshot`, {});
  assert.equal(snapshot.elements.find(element => element.id === "api").backgroundColor, "#a5d8ff");
  assert.equal(snapshot.elements.find(element => element.id === "worker").backgroundColor, "transparent");
  await until(async () => (await (await fetch(`${c.canvasUrl}/api/elements/api`)).json()).element?.backgroundColor === "#a5d8ff", "the edit was not synced to the server");
  for (const name of ["before.png", "after.png"]) assert.ok((await fs.stat(receipt.artifacts[name].path)).size > 1000);

  // Someone changes the drawing after it was inspected: the edit is refused.
  assert.equal((await post(`${c.canvasUrl}/api/elements/worker`, { backgroundColor: "#ffc9c9" }, "PUT")).success, true);
  await until(async () => (await inspectLiveCanvas({ canvasUrl: c.canvasUrl })).sceneVersion !== after.sceneVersion, "the update did not reach the canvas");
  const stale = await editLiveCanvas({ canvasUrl: c.canvasUrl, baseVersion: after.sceneVersion, requestId: "late",
    operations: [{ op: "setStyle", targetId: "api", style: { backgroundColor: "#b2f2bb" } }], outputDir: c.outputDir });
  assert.equal(stale.status, "stale");

  // The page itself refuses a stale base, independent of the toolkit's check.
  const current = await post(`${c.canvasUrl}/api/toolkit/scene/snapshot`, {});
  const refused = await post(`${c.canvasUrl}/api/toolkit/scene/apply`, { baseVersion: after.sceneVersion, elements: [] });
  assert.deepEqual([refused.status, refused.sceneVersion], ["stale", current.sceneVersion]);
  assert.equal((await post(`${c.canvasUrl}/api/toolkit/scene/snapshot`, {})).elements.filter(element => !element.isDeleted).length, 2);

  // With a second open canvas there is no single current drawing.
  const second = await c.browser.newPage();
  await second.goto(c.canvasUrl);
  await until(async () => (await post(`${c.canvasUrl}/api/toolkit/scene/snapshot`, {})).code === "MULTIPLE_CANVASES", "a second canvas was not refused");
  await assert.rejects(inspectLiveCanvas({ canvasUrl: c.canvasUrl }), { code: "MULTIPLE_CANVASES" });
});
