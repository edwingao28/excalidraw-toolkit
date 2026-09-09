// Regression against the built frontend, using an isolated local HTTP/WS fixture.
// Run after build:canvas. --install-browser provisions the pinned test Chromium in CI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, 'dist/canvas');
const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json')));
const workspace = join(root, '.cache/canvas', manifest.inputSha256);
const require = createRequire(join(workspace, 'package.json'));
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const fonts = join(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
const output = join(root, '.cache/canvas-font-tests');
mkdirSync(output, { recursive: true });
if (process.argv.includes('--install-browser')) {
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Chromium installation failed');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixture = (family = 1, text = 'Installed runtime') => [
  { id: 'service', type: 'rectangle', x: 100, y: 100, width: 250, height: 100, backgroundColor: '#dbeafe', boundElements: [{ id: 'label', type: 'text' }] },
  { id: 'label', type: 'text', x: 110, y: 125, width: 230, height: 50, containerId: 'service', text, originalText: text, fontSize: 16, fontFamily: family, textAlign: 'center', verticalAlign: 'middle', autoResize: true, lineHeight: 1.25 },
];

async function harness(t, options = {}) {
  let scene = fixture();
  let failFonts = options.failFonts ?? false;
  const fontRequested = deferred();
  const gate = options.holdFonts ? deferred() : null;
  let lastSync;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (path === '/api/elements') return json({ success: true, elements: scene });
    if (path === '/api/files') return json({ success: true, files: {} });
    if (path === '/api/elements/sync' && req.method === 'POST') {
      let body = ''; for await (const bytes of req) body += bytes;
      lastSync = JSON.parse(body); return json({ success: true, count: lastSync.elements.length });
    }
    const isFont = path.startsWith('/assets/fonts/');
    if (isFont) {
      fontRequested.resolve();
      if (gate) await gate.promise;
      if (failFonts) { res.writeHead(503); res.end('fixture font unavailable'); return; }
    }
    const base = isFont ? fonts : assets;
    const relative = isFont ? path.slice('/assets/fonts/'.length) : path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(base, relative);
    if (!file.startsWith(base + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.send(JSON.stringify({ type: 'initial_elements', elements: scene, files: {} })));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const externalRequests = [];
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/') || /^(data|blob):/.test(route.request().url())) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(() => {
    window.__textDraws = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      const result = fill.call(this, text, x, y, ...args);
      if (String(text).includes('Installed')) {
        const m = this.measureText(text), matrix = this.getTransform();
        window.__textDraws.push({ text, font: this.font, width: m.width, canvasWidth: this.canvas.width,
          left: matrix.e + (x - m.actualBoundingBoxLeft) * matrix.a,
          right: matrix.e + (x + m.actualBoundingBoxRight) * matrix.a,
          png: this.canvas.toDataURL() });
      }
      return result;
    };
  });
  t.after(async () => { gate?.resolve(); await browser.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(r => ws.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  await page.goto(origin);
  const sync = async () => {
    lastSync = undefined;
    const response = page.waitForResponse(r => r.url().endsWith('/api/elements/sync'));
    await page.getByRole('button', { name: 'Sync to Backend', exact: true }).click();
    await response;
    return lastSync;
  };
  return { page, origin, externalRequests, fontRequested, gate, sync,
    setFailFonts(value) { failFonts = value; },
    setScene(value) { scene = value; for (const socket of ws.clients) socket.send(JSON.stringify({ type: 'initial_elements', elements: scene, files: {} })); },
  };
}

async function assertFullLabel(h, name) {
  await h.page.getByRole('button', { name: 'Sync to Backend', exact: true }).waitFor();
  await h.page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Sync to Backend' && !b.disabled));
  const native = await h.sync();
  const label = native.elements.find(e => e.id === 'label');
  assert.equal(label.text, 'Installed runtime');
  assert.equal(label.originalText, 'Installed runtime');
  const expectedWidth = await h.page.evaluate(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '16px Virgil'; return c.measureText('Installed runtime').width; });
  assert.ok(expectedWidth > 130, 'actual Virgil loaded rather than the 108px fallback');
  assert.ok(Math.abs(label.width - expectedWidth) < 0.01, 'native geometry uses loaded font metrics');
  const draws = await h.page.evaluate(() => window.__textDraws);
  assert.ok(draws.length);
  for (const draw of draws) {
    assert.ok(Math.abs(draw.width - expectedWidth) < 0.01, 'first and subsequent paints use the loaded font');
    assert.ok(draw.left >= 0 && draw.right <= draw.canvasWidth, 'first and last glyph fit the actual text raster');
  }
  assert.deepEqual(h.externalRequests, [], 'all requested assets remain local');
  await h.page.screenshot({ path: join(output, `${name}.png`) });
  writeFileSync(join(output, `${name}-text.png`), Buffer.from(draws.at(-1).png.split(',')[1], 'base64'));
  writeFileSync(join(output, `${name}.json`), JSON.stringify({ native, draws: draws.map(({ png, ...rest }) => rest), externalRequests: h.externalRequests }, null, 2));
}

test('cold canvas load measures before drawing and keeps both label edge glyphs', { timeout: 20000 }, async t => {
  const h = await harness(t);
  await assertFullLabel(h, 'cold');
  // A later scene can request another family and CJK fallback after startup.
  h.setScene(fixture(5, '原生字体'));
  await h.page.waitForFunction(() => [...document.fonts].some(f => f.family === 'Xiaolai' && f.status === 'loaded'));
  const native = await h.sync();
  assert.equal(native.elements.find(e => e.id === 'label').text, '原生字体');
  assert.deepEqual(h.externalRequests, []);
});

test('font failure pauses sync; a healthy cold reload recovers', { timeout: 20000 }, async t => {
  const h = await harness(t, { failFonts: true });
  await h.page.getByText('Canvas could not be loaded. Sync is paused to protect your saved scene.').waitFor();
  assert.equal(await h.page.getByRole('button', { name: 'Sync to Backend', exact: true }).isDisabled(), true);
  assert.deepEqual(await h.page.evaluate(() => window.__textDraws), []);
  h.setFailFonts(false);
  h.externalRequests.length = 0;
  await h.page.reload();
  await assertFullLabel(h, 'recovered');
});

test('a delayed old font failure cannot replace or pause a newer full scene', { timeout: 20000 }, async t => {
  const h = await harness(t, { holdFonts: true });
  await h.fontRequested.promise;
  h.setScene([{ id: 'newer', type: 'rectangle', x: 10, y: 20, width: 80, height: 90 }]);
  const before = await h.sync();
  assert.deepEqual(before.elements.map(e => e.id), ['newer']);
  h.setFailFonts(true);
  h.gate.resolve();
  await h.page.waitForFunction(() => [...document.fonts].some(f => f.family === 'Virgil' && f.status === 'error'));
  const after = await h.sync();
  assert.deepEqual(after.elements.map(e => e.id), ['newer']);
  assert.equal(await h.page.getByRole('button', { name: 'Sync to Backend', exact: true }).isDisabled(), false);
});
