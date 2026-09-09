import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { servePreview } from '../src/render.js';

const fixture = new URL('./fixtures/annotated.excalidraw', import.meta.url);
const readScene = page => page.evaluate(() => JSON.parse(JSON.stringify(window.sceneForPreview())));
const live = scene => scene.elements.filter(element => !element.isDeleted);
const tool = (page, name) => page.locator('.working-layer label').filter({ has: page.getByRole('radio', { name, exact: true }) });

async function openWorkspace(t, init, propose) {
  const original = JSON.parse(readFileSync(fixture));
  const proposed = propose?.(structuredClone(original));
  const preview = await servePreview(proposed || original, proposed ? { beforeScene: original } : {});
  t.after(() => preview.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  // Headless Chromium cannot operate the OS file picker. Exercise Excalidraw's
  // native file-input fallback, also used by browsers without that picker API.
  await page.addInitScript(() => { delete window.showOpenFilePicker; });
  if (init) await page.addInitScript(init);
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(preview.url);
  await page.waitForFunction(() => window.previewReady);
  if (proposed) await version(page, 'Working');
  assert.equal(await page.getByRole('tab', { name: 'Working', exact: true }).getAttribute('aria-selected'), 'true');
  return { page, original, proposal: proposed };
}

async function version(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForFunction(id => window.previewReady && document.getElementById(id)?.getAttribute('aria-selected') === 'true', { Working: 'working-tab', Before: 'before-tab', 'Agent proposal': 'after-tab' }[name]);
}

async function downloadScene(page, trigger) {
  const downloading = page.waitForEvent('download');
  await trigger.click();
  const download = await downloading;
  return { scene: JSON.parse(readFileSync(await download.path())), name: download.suggestedFilename() };
}

async function chooseScene(page, name, scene) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name, exact: true }).click();
  await (await choosing).setFiles({ name: 'working.excalidraw', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(scene)) });
}

async function loadScene(page, name, scene) {
  await chooseScene(page, name, scene);
  await page.waitForFunction(id => window.previewReady && document.getElementById(id)?.getAttribute('aria-selected') === 'true', 'working-tab');
  if (name === 'Open file') await page.waitForFunction(() => document.title.startsWith('working ·'));
}

async function draw(page, type, { x = 0.67, y = 0.76 } = {}) {
  const previous = new Set(live(await readScene(page)).map(element => element.id));
  const canvas = await page.locator('#canvas-panel').boundingBox();
  const point = { x: canvas.x + canvas.width * x, y: canvas.y + canvas.height * y };
  await tool(page, type === 'freedraw' ? 'Draw' : 'Rectangle').click();
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  if (type === 'freedraw') {
    await page.mouse.move(point.x + 25, point.y - 15, { steps: 3 });
    await page.mouse.move(point.x + 55, point.y + 20, { steps: 4 });
    await page.mouse.move(point.x + 90, point.y - 5, { steps: 4 });
  } else await page.mouse.move(point.x + 105, point.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(ids => window.sceneForPreview().elements.some(element => !element.isDeleted && !ids.includes(element.id)), [...previous]);
  const added = live(await readScene(page)).filter(element => !previous.has(element.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].type, type);
  return { element: added[0], point };
}

async function writeText(page, text) {
  const canvas = await page.locator('#canvas-panel').boundingBox();
  await tool(page, 'Text').click();
  await page.mouse.click(canvas.x + canvas.width * 0.56, canvas.y + canvas.height * 0.88);
  await page.locator('textarea.excalidraw-wysiwyg').fill(text);
  await page.keyboard.press('Escape');
  await page.waitForFunction(text => window.sceneForPreview().elements.some(element => !element.isDeleted && element.text === text), text);
  return live(await readScene(page)).find(element => element.text === text);
}

async function insertImage(page, dataURL) {
  const ids = live(await readScene(page)).map(element => element.id);
  const choosing = page.waitForEvent('filechooser');
  await tool(page, 'Insert image').click();
  await (await choosing).setFiles({ name: 'manual-reference.png', mimeType: 'image/png', buffer: Buffer.from(dataURL.split(',')[1], 'base64') });
  await page.waitForFunction(ids => {
    const scene = window.sceneForPreview();
    return scene.elements.some(element => !element.isDeleted && element.type === 'image' && !ids.includes(element.id) && scene.files[element.fileId]);
  }, ids);
  const canvas = await page.locator('#canvas-panel').boundingBox();
  await page.mouse.move(canvas.x + canvas.width * 0.49, canvas.y + canvas.height * 0.72);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.49 + 50, canvas.y + canvas.height * 0.72 + 50, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(ids => window.sceneForPreview().elements.some(element => !element.isDeleted && element.type === 'image' && !ids.includes(element.id) && element.width > 0 && element.height > 0), ids);
  return live(await readScene(page)).find(element => element.type === 'image' && !ids.includes(element.id));
}

async function waitForDraft(page, scene) {
  // waitForFunction treats a returned Promise as truthy; await each IndexedDB
  // read explicitly so reload cannot race a pending autosave transaction.
  await page.evaluate(async expected => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('excalidraw-toolkit', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const draft = await new Promise((resolve, reject) => {
          const read = db.transaction('drafts').objectStore('drafts').get(location.pathname);
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        });
        if (JSON.stringify(draft?.working) === expected) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('The current working diagram was not saved to IndexedDB.');
    } finally { db.close(); }
  }, JSON.stringify(scene));
}

test('native drawing, text, and freehand survive review, browser recovery, and exact save/reopen', async t => {
  const { page, original } = await openWorkspace(t);
  assert.deepEqual(await readScene(page), original);
  assert.doesNotMatch(await page.locator('body').innerText(), /Work with an agent|Editable canvas|Saved in this browser|Agent input downloaded/);
  assert.equal(await page.getByRole('textbox', { name: 'Describe the edit', exact: true }).count(), 0);
  const rectangle = (await draw(page, 'rectangle')).element;
  const freehand = (await draw(page, 'freedraw', { x: 0.79, y: 0.64 })).element;
  assert.ok(freehand.points.length > 2);
  const image = await insertImage(page, original.files.asset.dataURL);
  const note = await writeText(page, 'Manual retry boundary');
  const working = await readScene(page);
  assert.equal(live(working).length, live(original).length + 4);
  for (const element of original.elements) assert.deepEqual(working.elements.find(value => value.id === element.id), element, `untouched ${element.id} is preserved`);
  assert.deepEqual(working.files.asset, original.files.asset);
  const pixels = await page.evaluate(urls => Promise.all(urls.map(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixels: [...context.getImageData(0, 0, image.width, image.height).data] };
  })), [working.files[image.fileId].dataURL, original.files.asset.dataURL]);
  assert.deepEqual(pixels[0], pixels[1], 'native image import preserves the inserted pixels');
  assert.deepEqual(working.customMetadata, original.customMetadata);
  assert.deepEqual(working.appState.customSetting, original.appState.customSetting);

  await version(page, 'Before');
  assert.deepEqual(await readScene(page), original);
  assert.equal(await page.locator('.working-layer').getByRole('button', { name: 'Undo', exact: true, includeHidden: true }).isVisible(), false, 'hidden native controls do not leak into snapshots');
  assert.equal(await page.locator('.working-layer').isVisible(), false);
  await version(page, 'Working');
  assert.deepEqual(await readScene(page), working);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(id => !window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);
  assert.ok(live(await readScene(page)).some(element => element.id === rectangle.id));
  assert.ok(live(await readScene(page)).some(element => element.id === freehand.id));
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(id => window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);

  const saved = (await downloadScene(page, page.locator('#native'))).scene;
  assert.deepEqual(saved, await readScene(page));
  const pngDownload = page.waitForEvent('download');
  await page.locator('#png').click();
  const png = readFileSync(await (await pngDownload).path());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16) > 600);
  await waitForDraft(page, saved);
  await page.reload();
  await page.waitForFunction(() => window.previewReady);
  assert.deepEqual(await readScene(page), saved, 'a completed local draft survives reload');
  await version(page, 'Before');
  assert.deepEqual(await readScene(page), original, 'draft recovery keeps the preserved comparison snapshot');
  await version(page, 'Working');
  await loadScene(page, 'Open file', saved);
  assert.deepEqual(await readScene(page), saved, 'a native download reopens without dropping drawings, bindings, files, or metadata');
});

test('receipt proposal merges over later manual work and acceptance is one native undo action', async t => {
  const { page, original, proposal } = await openWorkspace(t, undefined, proposal => {
    proposal.elements.find(element => element.id === 'service').backgroundColor = '#a5d8ff';
    proposal.elements.find(element => element.id === 'worker').backgroundColor = '#d0ebff';
    proposal.elements.push(
      { ...structuredClone(proposal.elements.find(element => element.id === 'service')), id: 'agent-component', x: 850, y: 100, groupIds: [], boundElements: null },
      { ...structuredClone(proposal.elements.find(element => element.id === 'image')), id: 'agent-image', x: 850, y: 300, fileId: 'agent-asset' },
    );
    proposal.files['agent-asset'] = { ...structuredClone(proposal.files.asset), id: 'agent-asset' };
    return proposal;
  });
  const rectangle = (await draw(page, 'rectangle')).element;
  await page.keyboard.press('Escape');
  const note = await writeText(page, 'Keep this later manual decision');
  const beforeAcceptance = await readScene(page);
  await version(page, 'Agent proposal');
  assert.equal(await page.getByRole('tab', { name: 'Agent proposal', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(live(await readScene(page)).some(element => element.id === note.id), false, 'the imported proposal remains an inspectable snapshot');
  await version(page, 'Before');
  assert.deepEqual(await readScene(page), original, 'Before is the preserved receipt input');
  assert.equal(live(await readScene(page)).some(element => element.id === note.id), false, 'Before excludes later manual edits');
  await version(page, 'Agent proposal');
  assert.equal(await page.getByRole('button', { name: 'Accept proposal', exact: true }).isEnabled(), true, await page.locator('.proposal-bar').innerText());
  await page.getByRole('button', { name: 'Accept proposal', exact: true }).click();
  await page.waitForFunction(() => window.previewReady && document.querySelector('#working-tab')?.getAttribute('aria-selected') === 'true');
  const accepted = await readScene(page);
  assert.equal(accepted.elements.find(element => element.id === 'service').backgroundColor, '#a5d8ff');
  assert.equal(accepted.elements.find(element => element.id === 'worker').backgroundColor, '#d0ebff');
  assert.ok(live(accepted).some(element => element.id === 'agent-component'));
  assert.ok(live(accepted).some(element => element.id === 'agent-image'));
  assert.deepEqual(accepted.elements.find(element => element.id === note.id), beforeAcceptance.elements.find(element => element.id === note.id));
  assert.deepEqual(accepted.elements.find(element => element.id === 'request'), original.elements.find(element => element.id === 'request'));
  assert.deepEqual(accepted.files.asset, original.files.asset);
  assert.deepEqual(accepted.files['agent-asset'], proposal.files['agent-asset']);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => window.sceneForPreview().elements.find(element => element.id === 'service').backgroundColor === 'transparent');
  assert.equal((await readScene(page)).elements.find(element => element.id === 'worker').backgroundColor, 'transparent', 'one undo reverses every changed proposal element');
  assert.equal(live(await readScene(page)).some(element => element.id === 'agent-component' || element.id === 'agent-image'), false, 'the same undo removes all proposal-created elements');
  assert.ok(live(await readScene(page)).some(element => element.id === note.id), 'one undo reverses only proposal acceptance');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(id => !window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);
  assert.ok(live(await readScene(page)).some(element => element.id === rectangle.id), 'native manual history survives snapshot visits and proposal acceptance');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(id => window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(() => window.sceneForPreview().elements.find(element => element.id === 'service').backgroundColor === '#a5d8ff');
  assert.equal((await readScene(page)).elements.find(element => element.id === 'worker').backgroundColor, '#d0ebff');
  assert.ok(live(await readScene(page)).some(element => element.id === note.id));
  assert.ok(live(await readScene(page)).some(element => element.id === 'agent-component'));
  assert.ok(live(await readScene(page)).some(element => element.id === 'agent-image'));
  assert.deepEqual((await readScene(page)).files['agent-asset'], proposal.files['agent-asset'], 'redo keeps the added image bytes available');
});

test('a conflicting receipt proposal cannot overwrite a manual edit and can be discarded', async t => {
  const { page, original } = await openWorkspace(t, undefined, proposal => {
    proposal.elements.find(element => element.id === 'service').x += 100;
    return proposal;
  });
  const element = original.elements.find(element => element.id === 'service');
  await page.locator('.object-list').getByRole('button', { name: 'Show API service', exact: true }).click();
  await page.locator('.working-layer').getByRole('button', { name: 'Delete', exact: true }).waitFor();
  await page.locator('.working-layer .excalidraw').press('ArrowRight');
  await page.waitForFunction(({ id, x }) => window.sceneForPreview().elements.find(element => element.id === id)?.x !== x, { id: element.id, x: element.x });
  const manual = await readScene(page);
  await version(page, 'Agent proposal');
  assert.equal(await page.getByRole('button', { name: 'Accept proposal', exact: true }).isEnabled(), false);
  assert.match(await page.locator('body').innerText(), /Both versions changed/);
  await version(page, 'Working');
  assert.deepEqual(await readScene(page), manual);
  await version(page, 'Agent proposal');
  await page.getByRole('button', { name: 'Discard proposal', exact: true }).click();
  await page.waitForFunction(() => window.previewReady && document.querySelector('#working-tab')?.getAttribute('aria-selected') === 'true');
  assert.deepEqual(await readScene(page), manual);
});

test('opening another file can be cancelled or save the exact working diagram first', async t => {
  const { page, original } = await openWorkspace(t);
  await draw(page, 'rectangle');
  const manual = await readScene(page);
  const replacement = structuredClone(original);
  replacement.elements.find(element => element.id === 'service').backgroundColor = '#ffd8a8';
  await chooseScene(page, 'Open file', replacement);
  const dialog = page.getByRole('dialog', { name: 'Keep your working diagram', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await readScene(page), manual);

  await chooseScene(page, 'Open file', replacement);
  await dialog.waitFor();
  const backup = await downloadScene(page, dialog.getByRole('button', { name: 'Save & open', exact: true }));
  assert.deepEqual(backup.scene, manual);
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.previewReady && document.title.startsWith('working ·'));
  assert.deepEqual(await readScene(page), replacement);
  await version(page, 'Before');
  assert.deepEqual(await readScene(page), replacement, 'replacement opens a new document with its own preserved snapshot');
});

test('unrenderable receipt proposals fail before acceptance and leave Working recoverable', async t => {
  for (const [id, fields] of [['zero-size', { type: 'rectangle', width: 0, height: 0 }], ['unsupported', { type: 'not-a-native-shape' }]]) {
    const { page, original } = await openWorkspace(t, undefined, proposal => {
      proposal.elements.push({ ...structuredClone(proposal.elements.find(element => element.id === 'service')), id, x: 850, y: 100, groupIds: [], boundElements: null, ...fields });
      return proposal;
    });
    assert.equal(await page.getByRole('button', { name: 'Accept proposal', exact: true }).isEnabled(), false);
    assert.match(await page.locator('.proposal-bar').innerText(), /cannot display|supported|native type/i);
    assert.deepEqual(await readScene(page), original);
    await page.getByRole('button', { name: 'Discard proposal', exact: true }).click();
    assert.deepEqual((await downloadScene(page, page.locator('#native'))).scene, original);
  }
});

test('browser draft storage failure is visible while native saving remains available', async t => {
  const { page } = await openWorkspace(t, () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drafts') throw new DOMException('Controlled full browser storage', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await draw(page, 'rectangle');
  await page.getByRole('alert').filter({ hasText: 'Draft could not be saved. Download your diagram to keep changes.' }).waitFor();
  assert.equal(await page.getByText('Saved in this browser', { exact: true }).count(), 0);
  const working = await readScene(page);
  assert.deepEqual((await downloadScene(page, page.locator('#native'))).scene, working);
  assert.equal(await page.getByRole('tab', { name: 'Working', exact: true }).getAttribute('aria-selected'), 'true');
});

test('full screen keeps native drawing and undo, with read-only snapshots and a mobile exit', async t => {
  const { page, original } = await openWorkspace(t);
  const app = page.locator('.review-app');
  const enter = page.getByRole('button', { name: 'Full screen', exact: true });
  const exit = page.getByRole('button', { name: 'Exit full screen', exact: true });
  const fit = page.getByRole('button', { name: 'Fit diagram', exact: true });
  assert.equal(await fit.evaluate(element => element.nextElementSibling?.getAttribute('aria-label')), 'Full screen', 'full screen sits immediately after Fit diagram');
  assert.equal(await enter.getAttribute('aria-pressed'), 'false');
  const normalCanvas = await page.locator('#canvas-panel').boundingBox();
  await enter.click();
  await page.waitForFunction(() => document.querySelector('.review-app.is-fullscreen'));
  assert.equal(await exit.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.review-header').isVisible(), false);
  assert.equal(await page.getByRole('complementary', { name: 'Diagram details', includeHidden: true }).isVisible(), false);
  assert.equal(await tool(page, 'Rectangle').isVisible(), true);
  const expandedCard = await page.locator('.canvas-card').boundingBox();
  assert.equal(expandedCard.x, 0);
  assert.equal(expandedCard.y, 0, 'normal workspace padding does not offset the full-screen canvas');
  const expandedCanvas = await page.locator('#canvas-panel').boundingBox();
  assert.ok(expandedCanvas.width > normalCanvas.width);
  assert.ok(expandedCanvas.width >= 1438 && expandedCanvas.height >= 800, 'the canvas fills the desktop viewport beneath its controls');
  const rectangle = (await draw(page, 'rectangle')).element;
  const note = await writeText(page, 'Full-screen annotation');
  assert.equal(await exit.isVisible(), true, 'Escape commits native text without exiting full screen');
  const drawn = await readScene(page);
  await exit.click();
  assert.equal(await app.evaluate(element => element.classList.contains('is-fullscreen')), false);
  assert.equal(await page.locator('.review-header').isVisible(), true);
  assert.equal(await page.getByRole('complementary', { name: 'Diagram details' }).isVisible(), true);
  assert.deepEqual(await readScene(page), drawn, 'exiting preserves the live scene');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(id => !window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);
  assert.ok(live(await readScene(page)).some(element => element.id === rectangle.id), 'the first Undo removes only the native text action');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(id => !window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), rectangle.id);
  assert.equal(live(await readScene(page)).length, live(original).length, 'the next Undo reaches the drawing made while expanded');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(id => window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), rectangle.id);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(id => window.sceneForPreview().elements.some(element => element.id === id && !element.isDeleted), note.id);

  await enter.click();
  await tool(page, 'Selection').click();
  const focusedCanvas = await page.locator('#canvas-panel').boundingBox();
  await page.mouse.click(focusedCanvas.x + focusedCanvas.width * 0.94, focusedCanvas.y + focusedCanvas.height * 0.9);
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.working-layer'))), true, 'Escape is exercised from the native canvas, not the full-screen button');
  await page.keyboard.press('Escape');
  await enter.waitFor();
  assert.ok(live(await readScene(page)).some(element => element.id === note.id));

  await version(page, 'Before');
  await enter.click();
  assert.equal(await tool(page, 'Rectangle').isVisible(), false, 'full screen does not expose working tools in a historical snapshot');
  const snapshotCanvas = await page.locator('#canvas-panel').boundingBox();
  await page.mouse.move(snapshotCanvas.x + 150, snapshotCanvas.y + 250);
  await page.mouse.down();
  await page.mouse.move(snapshotCanvas.x + 260, snapshotCanvas.y + 310, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await readScene(page), original, 'canvas gestures do not edit a full-screen snapshot');
  await exit.click();
  await version(page, 'Working');
  assert.ok(live(await readScene(page)).some(element => element.id === rectangle.id));

  await page.setViewportSize({ width: 390, height: 844 });
  await enter.click();
  const mobileCanvas = await page.locator('#canvas-panel').boundingBox();
  const mobileExit = await exit.boundingBox();
  assert.ok(mobileCanvas.width >= 388 && mobileCanvas.height > 650, 'mobile full screen uses the available viewport');
  assert.ok(mobileExit.x >= 0 && mobileExit.x + mobileExit.width <= 390 && mobileExit.y >= 0 && mobileExit.y + mobileExit.height < 844, 'the exit stays reachable on mobile');
  await fit.click();
  await exit.click();
  assert.equal(await page.locator('.review-header').isVisible(), true);
  assert.ok(live(await readScene(page)).some(element => element.id === rectangle.id));
});
