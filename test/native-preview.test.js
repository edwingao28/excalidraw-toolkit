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
