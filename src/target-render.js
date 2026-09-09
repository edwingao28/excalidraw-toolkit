import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import { servePreview } from "./render.js";

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

async function nativePage(scene, action, argument) {
  const preview = await servePreview(structuredClone(scene));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const origin = new URL(preview.url).origin;
    const failures = new Set();
    page.on("requestfailed", request => { if (!request.url().endsWith("/favicon.ico")) failures.add(request.url()); });
    page.on("response", response => { if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) failures.add(response.url()); });
    await page.route("**/*", route => route.request().url().startsWith(`${origin}/`) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    await page.goto(preview.url);
    await page.waitForFunction(() => window.previewReady || window.previewError, { timeout: 20000 });
    const error = await page.evaluate(() => window.previewError);
    if (error) fail("NATIVE_PREVIEW_FAILED", error);
    if (!await page.evaluate(name => typeof window[name] === "function", action)) {
      fail("TARGET_BUILD_MISSING", "The preview assets do not include the native target renderer; rebuild the preview bundle");
    }
    const result = await page.evaluate(async ({ action, scene, argument }) => {
      let timeout;
      try {
        const value = await Promise.race([window[action](scene, argument), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("NATIVE_RENDER_TIMEOUT: native target preparation exceeded 30 seconds")), 30000);
        })]);
        return { value };
      }
      catch (error) { return { error: error.message }; }
      finally { clearTimeout(timeout); }
    }, { action, scene, argument });
    if (failures.size) fail("NATIVE_ASSET_FAILED", `${failures.size} preview assets failed or attempted external access`);
    if (result.error) {
      const match = /^([A-Z][A-Z_]+):\s*(.*)$/s.exec(result.error);
      fail(match?.[1] ?? "NATIVE_RENDER_FAILED", match?.[2] ?? result.error);
    }
    return { value: result.value, browser: browser.version() };
  } finally {
    if (browser) await browser.close();
    await preview.close();
  }
}

export async function measureScene(scene) {
  return (await nativePage(scene, "measureScene")).value;
}

export async function renderScene(scene, outputPath, viewport) {
  if (!viewport || ![viewport.width, viewport.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) ||
    ![viewport.scale, viewport.offsetX, viewport.offsetY].every(Number.isFinite) || viewport.scale <= 0 || viewport.scale > 1) {
    fail("INVALID_TARGET", "Native target rendering requires exact pixel dimensions and a finite affine transform with 0 < scale <= 1");
  }
  const result = await nativePage(scene, "renderTargetPng", viewport);
  if (typeof result.value !== "string" || !result.value.startsWith("data:image/png;base64,")) fail("INVALID_RENDER", "Native export did not return a PNG");
  const png = Buffer.from(result.value.split(",")[1], "base64");
  if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(16) !== viewport.width || png.readUInt32BE(20) !== viewport.height) fail("INVALID_RENDER", "Native PNG dimensions do not match the target");
  const handle = await fs.open(outputPath, "wx", 0o600);
  try { await handle.writeFile(png); await handle.sync(); } finally { await handle.close(); }
  return { renderer: "@excalidraw/excalidraw@0.18.1", browser: result.browser };
}
