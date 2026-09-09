import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/preview');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Diagram review · Excalidraw Toolkit</title><link rel="stylesheet" href="./assets/preview.css"></head><body><div id="app"><p class="boot-message" role="status">Opening your diagram…</p></div><script type="module" src="./assets/preview.js"></script></body></html>`;
export async function servePreview(scene, { port = 0, title, beforeScene, changes, review, previewPngs } = {}) {
  if (!existsSync(resolve(assets, 'preview.js'))) throw new Error('PREVIEW_BUILD_MISSING: reinstall the packed toolkit or run npm run build');
  const token = randomBytes(18).toString('hex');
  const prefix = `/${token}/`;
  const bytes = JSON.stringify(scene);
  const retainedPngs = Object.fromEntries(Object.entries(previewPngs ?? {}).filter(([view, png]) => ['before', 'after', 'proposal'].includes(view) && Buffer.isBuffer(png)).map(([view, png]) => [view, Buffer.from(png)]));
  const context = JSON.stringify({ title: typeof title === 'string' ? title : null, beforeScene: beforeScene ?? null, changes: Array.isArray(changes) ? changes : null, review: review ?? null, retainedPngViews: Object.keys(retainedPngs) });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || !pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const resource = pathname.slice(prefix.length);
    if (!resource) { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (resource === 'scene') { res.setHeader('Content-Type', 'application/json'); res.end(bytes); return; }
    if (resource === 'context') { res.setHeader('Content-Type', 'application/json'); res.end(context); return; }
    const pngView = /^exports\/(before|after|proposal)\.png$/.exec(resource)?.[1];
    if (pngView && retainedPngs[pngView]) { res.setHeader('Content-Type', 'image/png'); res.end(retainedPngs[pngView]); return; }
    const file = resolve(assets, resource.replace(/^assets\//, ''));
    if (!resource.startsWith('assets/') || !file.startsWith(assets + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    try { res.end(readFileSync(file)); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export async function renderScene(scene, outputPath) {
  const preview = await servePreview(scene);
  let browser;
  try {
    if (!rendererStatus().ready) throw new Error('PREVIEW_BROWSER_MISSING: run excalidraw-toolkit setup-preview to install the pinned Chromium renderer');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const origin = new URL(preview.url).origin;
    const failedAssets = new Set();
    page.on('requestfailed', request => { if (!request.url().endsWith('/favicon.ico')) failedAssets.add(request.url()); });
    page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) failedAssets.add(response.url()); });
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    await page.goto(preview.url);
    await page.waitForFunction(() => window.previewReady || window.previewError, { timeout: 20000 });
    const error = await page.evaluate(() => window.previewError);
    if (error) throw new Error(error);
    const data = await page.evaluate(() => window.renderPng());
    if (failedAssets.size) throw new Error(`PREVIEW_ASSET_FAILED: ${[...failedAssets].join(', ')}`);
    const png = Buffer.from(data.split(',')[1], 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PREVIEW_INVALID: expected a PNG');
    writeFileSync(outputPath, png, { flag: 'wx', mode: 0o600 });
    return { renderer: '@excalidraw/excalidraw@0.18.1', browser: browser.version() };
  } finally { if (browser) await browser.close(); await preview.close(); }
}

export function rendererStatus() {
  const executablePath = chromium.executablePath();
  return {ready: existsSync(executablePath), executablePath, renderer: '@excalidraw/excalidraw@0.18.1'};
}
export async function setupPreview() {
  if (rendererStatus().ready) return rendererStatus();
  const {createRequire} = await import('node:module');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const cli = resolve(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  await promisify(execFile)(process.execPath, [cli, 'install', 'chromium'], {timeout: 180000, maxBuffer: 4 * 1024 * 1024});
  const status = rendererStatus();
  if (!status.ready) throw new Error('PREVIEW_BROWSER_MISSING: browser installation did not produce the expected executable');
  return status;
}
