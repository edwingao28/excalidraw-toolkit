import {readFileSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {inspectScene, editScene, validateScene, verifyReceipt} from './scene.js';
import {renderScene, servePreview} from './render.js';
import {openBrowser} from './runtime.js';

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

export async function sceneCommand(command, inputPath, values) {
  if (!inputPath) throw new Error('INPUT_REQUIRED: provide a native scene or preview receipt path');
  if (command === 'inspect') return inspectScene(inputPath);
  if (command === 'edit') {
    if (!values.request || !values.output) throw new Error('REQUEST_REQUIRED: provide --request <json> and --output <directory>');
    return editScene({...readJSON(values.request), inputPath, outputDir: values.output}, {renderScene});
  }
  let scene = readJSON(inputPath);
  let beforeScene;
  let changes;
  if (scene?.type !== 'excalidraw') {
    const verified = await verifyReceipt(inputPath);
    changes = verified.receipt.changes;
    beforeScene = verified.beforeScene;
    scene = verified.afterScene;
  }
  validateScene(scene);
  if (beforeScene) validateScene(beforeScene);
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT_INVALID: use an integer from 0 to 65535');
  const preview = await servePreview(scene, {beforeScene, changes, title: values.title || basename(inputPath).replace(/\.(excalidraw|json)$/, ''), port});
  if (!values['no-open']) openBrowser(preview.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await preview.close(); process.exit(0);});
  return {url: preview.url, inputPath: resolve(inputPath), mode: beforeScene ? 'comparison' : 'preview'};
}
