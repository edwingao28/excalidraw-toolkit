import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProposal, captureWorkingScene, deriveChanges } from '../src/web/workspace.js';
import { validateScene } from '../src/scene.js';

const clone = structuredClone;
const box = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 80, backgroundColor: '#fff', version: 1, versionNonce: 42, ...extra });
const doc = (elements = [box('a'), box('b')], extra = {}) => ({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#fff' }, files: {}, ...extra });
const modify = (scene, id, extra) => Object.assign(scene.elements.find(element => element.id === id), extra);
const bound = () => doc([
  box('a', { boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] }),
  { id: 'label', type: 'text', containerId: 'a', text: 'API', x: 10, y: 10, width: 70, height: 20 },
  { id: 'arrow', type: 'arrow', x: 100, y: 40, points: [[0, 0], [100, 0]], startBinding: { elementId: 'a', focus: 0, gap: 1 }, endBinding: null },
]);
function conflict(base, current, proposed, field) {
  const inputs = clone([base, current, proposed]);
  const result = mergeProposal(base, current, proposed);
  assert.equal(result.scene, null);
  assert.ok(result.conflicts.some(item => item.field === field), JSON.stringify(result.conflicts));
  assert.deepEqual([base, current, proposed], inputs, 'a rejected proposal never changes its inputs');
}

test('merges agent styling with manual geometry, drawings, assets, and unknown fields', () => {
  const base = doc(undefined, { futureDocument: { owner: 'human' } });
  modify(base, 'a', { futureElement: { tags: ['original'] } });
  const current = clone(base), proposed = clone(base);
  modify(current, 'a', { x: 140, width: 180, version: 3, versionNonce: 99, futureElement: { tags: ['annotated'] } });
  current.elements.push({ id: 'pen', type: 'freedraw', points: [[0, 0], [8, 9]], pressure: [0.5, 0.7] }, { id: 'photo', type: 'image', fileId: 'upload' });
  current.files.upload = { id: 'upload', dataURL: 'data:image/png;base64,AA==', futureAsset: 'keep' };
  current.futureDocument = { owner: 'human', note: 'private' };
  modify(proposed, 'a', { backgroundColor: '#ff0', version: 2, versionNonce: 88 });
  proposed.elements.push(box('agent-node'));
  const inputs = clone([base, current, proposed]);
  const result = mergeProposal(base, current, proposed);
  assert.deepEqual(result.conflicts, []);
  validateScene(result.scene);
  assert.deepEqual(result.scene.elements[0], { ...current.elements[0], backgroundColor: '#ff0' });
  assert.deepEqual(result.scene.elements.map(element => element.id), ['a', 'b', 'pen', 'photo', 'agent-node']);
  assert.deepEqual(result.scene.files, current.files);
  assert.deepEqual(result.scene.futureDocument, current.futureDocument);
  assert.deepEqual([base, current, proposed], inputs);
});

test('preserves manual metadata and merges only undoable canvas settings', () => {
  const base = doc(undefined, { future: { enabled: true } });
  const current = clone(base), proposed = clone(base);
  current.appState.gridSize = 20;
  current.future.note = 'manual';
  proposed.appState.viewBackgroundColor = '#eeeeee';
  const { scene, conflicts } = mergeProposal(base, current, proposed);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(scene.appState, { gridSize: 20, viewBackgroundColor: '#eeeeee' });
  assert.deepEqual(scene.future, current.future);
  proposed.future = { enabled: false };
  conflict(base, current, proposed, 'future');
  proposed.future = clone(base.future);
  proposed.appState.gridSize = 10;
  conflict(base, current, proposed, 'appState.gridSize');
  proposed.appState = clone(base.appState);
  proposed.source = 'another exporter';
  conflict(base, current, proposed, 'source');
  delete proposed.source;
  modify(proposed, 'a', { customMetadata: 'cannot be applied through this workspace' });
  conflict(base, current, proposed, 'customMetadata');
});

test('rejects same-field styling and coupled geometry changes, ignoring only bookkeeping', () => {
  const base = doc(), current = clone(base), proposed = clone(base);
  modify(current, 'a', { backgroundColor: '#00f', version: 8 });
  modify(proposed, 'a', { backgroundColor: '#f00', version: 2 });
  conflict(base, current, proposed, 'backgroundColor');
  modify(current, 'a', { backgroundColor: '#fff', x: 120 });
  modify(proposed, 'a', { backgroundColor: '#fff', y: 220 });
  conflict(base, current, proposed, 'element');
  modify(proposed, 'a', { y: 0, x: 120 });
  assert.deepEqual(mergeProposal(base, current, proposed).conflicts, []);
  modify(current, 'a', { x: 0, seed: 7 });
  modify(proposed, 'a', { x: 0, seed: 8 });
  conflict(base, current, proposed, 'element');
});

test('deletion conflicts with edits but accepts unchanged and bookkeeping-only objects', () => {
  const base = doc(), current = clone(base), proposed = clone(base);
  modify(current, 'a', { version: 30, versionNonce: 200, updated: 123 });
  modify(proposed, 'a', { isDeleted: true });
  assert.equal(mergeProposal(base, current, proposed).scene.elements[0].isDeleted, true);
  modify(current, 'a', { futureNote: 'do not delete' });
  conflict(base, current, proposed, 'isDeleted');
  const manualDelete = clone(base), proposalEdit = clone(base);
  manualDelete.elements.splice(0, 1);
  modify(proposalEdit, 'a', { backgroundColor: '#ff0' });
  conflict(base, manualDelete, proposalEdit, 'isDeleted');
  modify(proposalEdit, 'a', { backgroundColor: '#fff' });
  modify(proposalEdit, 'b', { backgroundColor: '#ff0' });
  const result = mergeProposal(base, manualDelete, proposalEdit);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.scene.elements.find(element => element.id === 'a').isDeleted, true);
  assert.equal(result.scene.elements.find(element => element.id === 'b').backgroundColor, '#ff0');
});

test('rejects added ID collisions and never partially applies unrelated proposal changes', () => {
  const base = doc(), current = clone(base), proposed = clone(base);
  current.elements.push(box('collision', { text: 'manual' }));
  proposed.elements.push(box('collision', { text: 'agent' }));
  modify(proposed, 'a', { backgroundColor: '#ff0' });
  conflict(base, current, proposed, 'id');
});

test('keeps manual stacking order and detects concurrent incompatible order changes', () => {
  const base = doc([box('a'), box('b'), box('c')]);
  const current = clone(base), proposed = clone(base);
  current.elements.reverse();
  modify(proposed, 'a', { backgroundColor: '#ff0' });
  assert.deepEqual(mergeProposal(base, current, proposed).scene.elements.map(element => element.id), ['c', 'b', 'a']);
  proposed.elements = [proposed.elements[1], proposed.elements[0], proposed.elements[2]];
  conflict(base, current, proposed, 'elements');
  const inserted = clone(base);
  inserted.elements.splice(1, 0, box('new'));
  conflict(base, current, inserted, 'elements');
});

test('merges ordered additions from either side without moving existing objects', () => {
  const base = doc(), current = clone(base), proposed = clone(base);
  current.elements.splice(1, 0, box('manual'));
  proposed.elements.splice(1, 0, box('agent-1'), box('agent-2'));
  const { scene, conflicts } = mergeProposal(base, current, proposed);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(scene.elements.map(element => element.id), ['a', 'manual', 'agent-1', 'agent-2', 'b']);
});

test('validates reciprocal text and arrow bindings and related geometry together', () => {
  const base = bound(), current = clone(base), proposed = clone(base);
  modify(current, 'a', { x: 200 });
  modify(proposed, 'label', { text: 'New API', width: 95 });
  conflict(base, current, proposed, 'bindings');
  const safe = clone(base);
  modify(safe, 'a', { strokeColor: '#00f' });
  assert.deepEqual(mergeProposal(base, current, safe).conflicts, []);
  const dangling = clone(base);
  modify(dangling, 'a', { boundElements: [] });
  conflict(base, base, dangling, 'document');
  const identical = clone(base);
  modify(identical, 'a', { x: 100 });
  modify(identical, 'label', { x: 110 });
  assert.deepEqual(mergeProposal(base, identical, identical).conflicts, []);
});

test('preserves image assets and rejects missing assets or replacement under an existing ID', () => {
  const base = doc([{ id: 'image', type: 'image', fileId: 'asset' }], { files: { asset: { id: 'asset', dataURL: 'data:image/png;base64,AA==', unknown: 'keep' } } });
  const proposed = clone(base);
  proposed.files.asset.dataURL = 'data:image/png;base64,BB==';
  conflict(base, base, proposed, 'files.asset');
  proposed.files.asset = clone(base.files.asset);
  proposed.files.new = { id: 'new', dataURL: 'data:image/png;base64,BB==' };
  proposed.elements.push({ id: 'new-image', type: 'image', fileId: 'new' });
  const result = mergeProposal(base, base, proposed);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.scene.files, proposed.files);
  delete proposed.files.new;
  conflict(base, base, proposed, 'document');
});

test('capture ignores first-load normalization and bookkeeping-only callbacks', () => {
  const original = doc([box('a', { future: 'retained' })], { futureDocument: { value: 1 } });
  const restored = clone(original);
  delete restored.elements[0].future;
  modify(restored, 'a', { strokeWidth: 1, version: 2, versionNonce: 99, index: 'a0' });
  assert.equal(captureWorkingScene(original, restored.elements, restored.appState, restored.files), original);
  const callback = clone(restored);
  modify(callback, 'a', { version: 9, versionNonce: 120, updated: 100, index: 'a9' });
  assert.equal(captureWorkingScene(original, callback.elements, callback.appState, callback.files, restored), original);
  assert.equal(original.elements[0].future, 'retained');
  original.files.asset = { id: 'asset', dataURL: 'data:image/png;base64,AA==', created: 1 };
  restored.files = clone(original.files);
  const loadedFiles = { asset: { ...restored.files.asset, lastRetrieved: 1234 } };
  assert.equal(captureWorkingScene(original, restored.elements, restored.appState, loadedFiles, restored), original);
});

test('captures real native edits and images while retaining normalized-away unknown fields', () => {
  const original = doc([box('a', { future: { value: 1 }, unknownEmpty: null })], { futureDocument: 'keep' });
  const previous = clone(original);
  delete previous.elements[0].future;
  delete previous.elements[0].unknownEmpty;
  previous.elements[0].strokeWidth = 1;
  const native = clone(previous);
  modify(native, 'a', { x: 200, version: 3, versionNonce: 70 });
  native.elements.push({ id: 'image', type: 'image', fileId: 'uploaded' });
  native.files.uploaded = { id: 'uploaded', dataURL: 'data:image/png;base64,AA==', mimeType: 'image/png' };
  native.appState.viewBackgroundColor = '#fafafa';
  const saved = captureWorkingScene(original, native.elements, native.appState, native.files, previous);
  assert.deepEqual(saved.elements[0], { ...original.elements[0], x: 200, version: 3, versionNonce: 70 });
  assert.deepEqual(saved.files, native.files);
  assert.equal(saved.futureDocument, 'keep');
  assert.equal(saved.appState.viewBackgroundColor, '#fafafa');
  assert.deepEqual(original.elements[0].future, { value: 1 });
  validateScene(saved);
  const next = clone(native);
  modify(next, 'a', { x: 0, version: 4, versionNonce: 90 });
  const undone = captureWorkingScene(saved, next.elements, next.appState, next.files, native);
  assert.equal(undone.elements[0].x, 0);
  assert.deepEqual(undone.elements[0].future, { value: 1 });
});

test('capture retains deleted history, unused assets, and imported unrendered elements', () => {
  const original = doc([box('a'), box('history', { isDeleted: true, future: 'keep' })], { files: { unused: { id: 'unused', dataURL: 'data:image/png;base64,AA==' } } });
  const previous = { elements: [clone(original.elements[0])], appState: clone(original.appState), files: clone(original.files) };
  const saved = captureWorkingScene(original, [], original.appState, {}, previous);
  assert.deepEqual(saved.elements, [{ ...original.elements[0], isDeleted: true }, original.elements[1]]);
  assert.deepEqual(saved.files, original.files);
});

test('deriveChanges supports native additions, deletions, and field removals without bookkeeping noise', () => {
  const before = doc([box('a', { link: 'https://example.com' }), box('b')]);
  const after = clone(before);
  after.elements.reverse();
  modify(after, 'a', { version: 7, versionNonce: 9 });
  delete after.elements[1].link;
  after.elements[0].isDeleted = true;
  after.elements.push({ id: 'note', type: 'text', text: 'Manual note' });
  const changes = deriveChanges(before, after);
  assert.deepEqual(changes[0], { id: 'b', properties: { isDeleted: { before: null, after: true } } });
  assert.deepEqual(changes[1], { id: 'a', properties: { link: { before: 'https://example.com' } } });
  assert.equal(changes[2].id, 'note');
  assert.equal(changes[2].created, true);
});


test('adding native elements does not stamp normalized indices onto untouched imported objects', () => {
  const original = doc([box('a', { future: 'keep' })]);
  const previous = clone(original);
  previous.elements[0].index = 'a0';
  const native = clone(previous);
  native.elements.push(box('new', { index: 'a1' }));
  const saved = captureWorkingScene(original, native.elements, native.appState, native.files, previous);
  assert.deepEqual(saved.elements[0], original.elements[0]);
  assert.equal(saved.elements[1].id, 'new');
  const reverse = clone(native);
  reverse.elements.reverse();
  reverse.elements[0].index = 'a0';
  reverse.elements[1].index = 'a1';
  const reordered = captureWorkingScene(saved, reverse.elements, reverse.appState, reverse.files, native);
  assert.deepEqual(reordered.elements.map(element => element.id), ['new', 'a']);
  assert.equal(reordered.elements[1].index, 'a1');
});


test('rejects existing seeds, type mutations, and removals that native updates cannot undo', () => {
  const base = doc([box('a', { seed: 7, customData: { note: 'retain' } })]);
  for (const [field, value] of [['seed', 8], ['type', 'ellipse']]) {
    const proposed = clone(base); proposed.elements[0][field] = value;
    conflict(base, base, proposed, field);
  }
  const proposed = clone(base); delete proposed.elements[0].customData;
  conflict(base, base, proposed, 'customData');
  const added = clone(base); added.elements.push(box('new', { seed: 9 }));
  assert.deepEqual(mergeProposal(base, base, added).conflicts, []);
});


test('native undefined fields and their absence in JSON describe the same proposal base', () => {
  const base = doc([box('a', { customData: undefined })]);
  const proposed = JSON.parse(JSON.stringify(base));
  proposed.elements[0].backgroundColor = '#ff0';
  assert.deepEqual(mergeProposal(base, base, proposed).conflicts, []);
});
