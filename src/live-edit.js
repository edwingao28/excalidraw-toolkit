import { promises as fs } from "node:fs";
import { randomInt } from "node:crypto";
import { join, resolve } from "node:path";
import { applyOperations, sceneSummary, sha256, validateScene } from "./scene.js";

const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Live edits go only to the local canvas server the toolkit starts.
function canvasOrigin(canvasUrl) {
  let url;
  try { url = new URL(canvasUrl); } catch { fail("INVALID_CANVAS", "Use the local canvas URL, such as http://127.0.0.1:3000"); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    fail("INVALID_CANVAS", "Live edits use the local canvas at http://127.0.0.1:<port>");
  }
  return url.origin;
}

async function call(origin, path, body, fetcher) {
  let response;
  try {
    response = await fetcher(`${origin}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(45000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { fail("CANVAS_UNAVAILABLE", "The canvas server is not reachable; start it with excalidraw-toolkit start"); }
  if (response.status === 404) fail("CANVAS_UNSUPPORTED", "This canvas server has no live-edit routes; update the toolkit and restart the canvas");
  let value;
  try { value = await response.json(); } catch { fail("CANVAS_FAILED", "The canvas returned an unreadable answer"); }
  if (!response.ok || value?.success === false) fail(typeof value?.code === "string" ? value.code : "CANVAS_FAILED", typeof value?.error === "string" ? value.error : `The canvas returned HTTP ${response.status}`);
  return value;
}

async function snapshot(origin, fetcher) {
  const value = await call(origin, "/api/toolkit/scene/snapshot", {}, fetcher);
  if (value.status !== "ok" || typeof value.sceneVersion !== "string" || !Array.isArray(value.elements)) fail("CANVAS_FAILED", "The canvas returned an invalid snapshot");
  const scene = { type: "excalidraw", version: 2, source: "excalidraw-toolkit-live", elements: value.elements,
    appState: value.appState && typeof value.appState === "object" ? value.appState : {}, files: value.files && typeof value.files === "object" ? value.files : {} };
  validateScene(scene);
  return { sceneVersion: value.sceneVersion, scene };
}

/** Read the open canvas: its scene version, stable IDs and supported operations. */
export async function inspectLiveCanvas({ canvasUrl }, { fetch = globalThis.fetch } = {}) {
  const origin = canvasOrigin(canvasUrl);
  const { sceneVersion, scene } = await snapshot(origin, fetch);
  const summary = sceneSummary(scene);
  return { canvasUrl: origin, sceneVersion, ...summary,
    capabilities: { ...summary.capabilities, output: "applied to the open canvas only while it is still at sceneVersion; the person can undo it" } };
}

/** Apply scoped operations to the open canvas only if it is still at
 * baseVersion. The scene engine is the one saved-file edits use; the canvas
 * page compares versions and applies the candidate in one synchronous step. */
export async function editLiveCanvas({ canvasUrl, baseVersion, requestId, operations, outputDir }, options = {}) {
  const { fetch = globalThis.fetch, renderScene, ...engine } = options;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) fail("INVALID_REQUEST", "requestId must contain 1–80 letters, digits, dots, underscores, or hyphens");
  if (typeof baseVersion !== "string" || !baseVersion) fail("INVALID_REQUEST", "baseVersion must be the sceneVersion returned by live-inspect");
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail("INVALID_REQUEST", "Supply 1–100 scoped operations");
  if (typeof outputDir !== "string" || !outputDir) fail("INVALID_REQUEST", "outputDir is required");
  const origin = canvasOrigin(canvasUrl);
  const directory = join(resolve(outputDir), requestId);
  const receiptPath = join(directory, "receipt.json");
  const requestDigest = sha256(JSON.stringify({ canvasUrl: origin, baseVersion, operations }));
  try {
    const prior = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    if (prior.requestDigest !== requestDigest) fail("REQUEST_CONFLICT", "This requestId belongs to a different live edit; use a new requestId");
    return { ...prior, reused: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  const { sceneVersion, scene } = await snapshot(origin, fetch);
  // The person changed the drawing after it was inspected: plan again.
  if (sceneVersion !== baseVersion) return { status: "stale", baseVersion, sceneVersion };
  const { candidate, changes } = await applyOperations(scene, operations, engine);
  validateScene(candidate);
  // Bump the revision of every changed or created element, as Excalidraw does.
  const before = new Map(scene.elements.map((element) => [element.id, element]));
  const now = Date.now();
  for (const element of candidate.elements) {
    const prior = before.get(element.id);
    if (prior && JSON.stringify(prior) === JSON.stringify(element)) continue;
    element.version = prior ? (prior.version ?? 0) + 1 : Math.max(1, element.version ?? 1);
    element.versionNonce = randomInt(2 ** 31);
    element.updated = now;
  }
  const applied = await call(origin, "/api/toolkit/scene/apply", { baseVersion, elements: candidate.elements, files: candidate.files ?? {} }, fetch);
  // The person edited between the snapshot and the apply; nothing changed.
  if (applied.status === "stale") return { status: "stale", baseVersion, sceneVersion: applied.sceneVersion };
  if (applied.status !== "applied" || typeof applied.sceneVersion !== "string" || !Array.isArray(applied.elements)) fail("CANVAS_FAILED", "The canvas did not confirm the edit");
  const expected = candidate.elements.map((element) => `${element.id}:${element.version}:${element.versionNonce}`);
  const actual = applied.elements.map((element) => `${element.id}:${element.version}:${element.versionNonce}`);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail("CANVAS_MISMATCH", "The canvas reports a different scene after the edit; review it and undo if needed");
  }

  // The edit is on the canvas. Retain what changed, with images for review.
  await fs.mkdir(directory, { recursive: true });
  const artifacts = {};
  for (const [name, value] of [["before.excalidraw", scene], ["after.excalidraw", candidate]]) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await fs.writeFile(join(directory, name), bytes, { flag: "wx" });
    artifacts[name] = { path: join(directory, name), sha256: sha256(bytes) };
  }
  const render = renderScene ?? (await import("./render.js")).renderScene;
  for (const [name, value] of [["before.png", scene], ["after.png", candidate]]) {
    await render(value, join(directory, name));
    artifacts[name] = { path: join(directory, name), sha256: sha256(await fs.readFile(join(directory, name))) };
  }
  const receipt = { schemaVersion: 1, status: "applied", requestId, requestDigest, canvasUrl: origin,
    baseVersion, sceneVersion: applied.sceneVersion, changes, artifacts, receiptPath };
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return receipt;
}
