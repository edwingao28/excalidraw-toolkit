import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {renderScene, servePreview} from '../src/render.js';
import {chromium} from 'playwright';
const exec = promisify(execFile);
const fixture = new URL('./fixtures/annotated.excalidraw', import.meta.url);
const cli = new URL('../bin/cli.js', import.meta.url).pathname;
function temporary(t) {const dir=mkdtempSync(join(tmpdir(),'toolkit-native-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
async function run(args) {const {stdout}=await exec(process.execPath,[cli,...args],{timeout:60000});return JSON.parse(stdout);}

test('CLI edits a complete native file, renders both versions, and reuses the completed result', async t => {
  const dir=temporary(t);const input=join(dir,'input.excalidraw');const request=join(dir,'request.json');
  const original=readFileSync(fixture);writeFileSync(input,original);
  const inspected=await run(['inspect',input]);
  writeFileSync(request,JSON.stringify({requestId:'native-style',baseHash:inspected.baseHash,operations:[{op:'setStyle',targetId:'service',style:{backgroundColor:'#a5d8ff'}}]}));
  const args=['edit',input,'--request',request,'--output',join(dir,'results')];
  const receipt=await run(args);
  assert.deepEqual(await run(args),receipt);
  assert.deepEqual(readFileSync(input),original);
  assert.deepEqual(readFileSync(receipt.artifacts['before.excalidraw'].path),original);
  const expected=JSON.parse(original);expected.elements.find(e=>e.id==='service').backgroundColor='#a5d8ff';
  assert.deepEqual(JSON.parse(readFileSync(receipt.artifacts['after.excalidraw'].path)),expected);
  for(const name of ['before.png','after.png']) {const bytes=readFileSync(receipt.artifacts[name].path);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(bytes.readUInt32BE(16)>600);assert.ok(bytes.readUInt32BE(20)>250);}
  writeFileSync(receipt.artifacts['after.excalidraw'].path,'{}');
  await assert.rejects(run(['preview',receipt.receiptPath,'--no-open']),error=>error.stderr.includes('CORRUPT_RESULT'));
});

test('native rendering refuses an image asset that cannot be loaded locally', async t => {
  const dir=temporary(t);const scene=JSON.parse(readFileSync(fixture));scene.files.asset.dataURL='https://invalid.example/toolkit-missing.png';
  await assert.rejects(renderScene(scene,join(dir,'bad.png')),/PREVIEW_ASSET_FAILED|PREVIEW|image/i);
});


test('failed initial loading remains visible and Open file recovers without a false preparing state', async t => {
  const scene = JSON.parse(readFileSync(fixture));
  const preview = await servePreview(scene);
  t.after(() => preview.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/scene', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"controlled load failure"}' }));
  await page.goto(preview.url);
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /could not be loaded/);
  assert.equal(await page.getByRole('button', { name: 'Dismiss error' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Opening your diagram', exact: true }).count(), 0);
  assert.equal(await page.locator('#status').innerText(), 'Preview unavailable');
  assert.equal(await page.getByRole('button', { name: 'Export PNG', exact: true }).isEnabled(), false);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await (await chooser).setFiles(fixture.pathname);
  await page.waitForFunction(() => window.previewReady);
  assert.equal(await page.evaluate(() => window.previewError), undefined);
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), scene);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Export PNG', exact: true }).isEnabled(), true);
  assert.match(await page.locator('#status').innerText(), /Viewing a read-only copy/);
});

test('review transitions wait for a fitted view, survive rapid keyboard changes, and retain exact exports', async t => {
  const dir = temporary(t);
  const before = JSON.parse(readFileSync(fixture));
  const after = structuredClone(before);
  after.elements.find(element => element.id === 'service').backgroundColor = '#a5d8ff';
  const proposal = structuredClone(before);
  proposal.elements.find(element => element.id === 'service').backgroundColor = '#b2f2bb';
  await renderScene(before, join(dir, 'retained.png'));
  const retained = readFileSync(join(dir, 'retained.png'));
  const preview = await servePreview(after, { beforeScene: before, proposalScene: proposal,
    previewPngs: { before: retained }, review: { kind: 'source-refresh', status: 'reconciliation-required',
      viewLabels: { before: 'Before', proposal: 'Source proposal', after: 'Partial candidate' }, conflicts: [], overrides: [], changes: [],
      source: { revision: '0123456789abcdef', scope: { question: 'Review the scoped change', paths: ['src/service.js'], unknowns: ['Runtime behavior'] } } } });
  t.after(() => preview.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(preview.url);
  await page.waitForFunction(() => window.previewReady);
  const afterPng = await page.evaluate(() => window.renderPng());
  // Pause one real browser dissolve to inspect readiness while both snapshots
  // are visible, without timing assertions tied to a particular machine.
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    window.transitionCount = 0;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.matches('.view-snapshot')) {
        window.transitionCount++;
        if (window.transitionCount === 1) {
          window.testAnimations = [animation];
          animation.pause(); animation.currentTime = 110;
          window.transitionPaused = true;
        }
      }
      return animation;
    };
  });
  await page.getByRole('tab', { name: 'Before', exact: true }).click();
  await page.waitForFunction(() => window.transitionPaused);
  assert.ok(await page.evaluate(() => window.testAnimations.length === 1));
  assert.ok(await page.evaluate(() => window.testAnimations.every(animation => animation.effect.getTiming().duration === 220)));
  assert.equal(await page.evaluate(() => window.previewReady), false);
  assert.equal(await page.locator('#canvas-panel').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#native').isEnabled(), false);
  assert.equal(await page.locator('#png').isEnabled(), false);
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), before);
  await page.evaluate(() => window.testAnimations.forEach(animation => animation.play()));
  await page.waitForFunction(() => window.previewReady);
  const nativeDownload = page.waitForEvent('download');
  await page.locator('#native').click();
  assert.deepEqual(JSON.parse(readFileSync(await (await nativeDownload).path())), before);
  const pngDownload = page.waitForEvent('download');
  await page.locator('#png').click();
  assert.deepEqual(readFileSync(await (await pngDownload).path()), retained);

  await page.getByRole('tab', { name: 'Before', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.previewReady && document.querySelector('#proposal-tab').getAttribute('aria-selected') === 'true');
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), proposal);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'proposal-tab');
  assert.match(await page.locator('.canvas-caption').innerText(), /Source proposal/);
  await page.evaluate(() => { document.querySelector('#after-tab').click(); document.querySelector('#before-tab').click(); document.querySelector('#after-tab').click(); });
  await page.waitForFunction(() => window.previewReady && document.querySelector('#after-tab').getAttribute('aria-selected') === 'true');
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), after);
  assert.match(await page.locator('.canvas-caption').innerText(), /Partial candidate/);
  const genericPng = page.waitForEvent('download');
  await page.locator('#png').click();
  assert.deepEqual(readFileSync(await (await genericPng).path()), Buffer.from(afterPng.split(',')[1], 'base64'));

  // Switching while an export waits for fonts must not change its scene or name.
  await page.evaluate(() => {
    const waiting = new Promise(resolve => { window.releaseFonts = resolve; });
    Object.defineProperty(document.fonts, 'ready', { configurable: true, get: () => waiting });
  });
  const inFlightPng = page.waitForEvent('download');
  await page.locator('#png').click();
  await page.getByRole('tab', { name: 'Before', exact: true }).click();
  await page.evaluate(() => { delete document.fonts.ready; window.releaseFonts(); });
  const exported = await inFlightPng;
  assert.match(exported.suggestedFilename(), /-after\.png$/);
  assert.deepEqual(readFileSync(await exported.path()), Buffer.from(afterPng.split(',')[1], 'base64'));
  await page.waitForFunction(() => window.previewReady);
  await page.getByRole('tab', { name: 'Partial candidate', exact: true }).click();
  await page.waitForFunction(() => window.previewReady);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transitionCount = await page.evaluate(() => window.transitionCount);
  await page.getByRole('tab', { name: 'Before', exact: true }).click();
  await page.waitForFunction(() => window.previewReady);
  assert.equal(await page.evaluate(() => window.transitionCount), transitionCount);
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), before);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { document.querySelector('.view-snapshot').animate = undefined; });
  await page.getByRole('tab', { name: 'Partial candidate', exact: true }).click();
  await page.waitForFunction(() => window.previewReady);
  assert.deepEqual(await page.evaluate(() => window.sceneForPreview()), after);
  assert.deepEqual(errors, []);
});
