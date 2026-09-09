import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSceneChanges } from '../src/scene.js';
import { summarizeEdits, formatTechnicalChanges, displayValue } from '../src/web/edit-summary.js';

const node = (id, label) => [
  { id, type: 'rectangle', x: 0, y: 0, width: 200, height: 80, isDeleted: false, boundElements: [{ id: `${id}-label`, type: 'text' }] },
  { id: `${id}-label`, type: 'text', text: label, originalText: label, x: 50, y: 20, width: 100, height: 20, containerId: id, isDeleted: false },
];
const arrow = (id, start, end) => ({ id, type: 'arrow', startBinding: start ? { elementId: start } : null, endBinding: end ? { elementId: end } : null, isDeleted: false });
const scene = elements => ({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} });
function withBindings(value) {
  const copy = structuredClone(value);
  for (const element of copy.elements) if (element.boundElements) element.boundElements = element.boundElements.filter(binding => binding.type !== 'arrow');
  for (const element of copy.elements.filter(element => element.type === 'arrow' && !element.isDeleted)) {
    for (const binding of [element.startBinding, element.endBinding].filter(Boolean)) copy.elements.find(item => item.id === binding.elementId).boundElements.push({ id: element.id, type: 'arrow' });
  }
  return copy;
}
function summarize(before, after) {
  before = withBindings(before); after = withBindings(after);
  return summarizeEdits(before, after, deriveSceneChanges(before, after));
}

test('queue insertion summarizes the topology and rename without reciprocal bindings or label metrics', () => {
  const before = scene([...node('api', 'API service'), ...node('worker', 'Worker'), arrow('direct', 'api', 'worker')]);
  const after = structuredClone(before);
  Object.assign(after.elements[1], { text: 'Public API', originalText: 'Public API', width: 121.3784319, x: 39.31078405 });
  after.elements[0].boundElements.push({ id: 'enqueue', type: 'arrow' });
  after.elements[2].boundElements.push({ id: 'delivery', type: 'arrow' });
  after.elements[4].isDeleted = true;
  after.elements.push(...node('queue', 'Queue'), arrow('enqueue', 'api', 'queue'), arrow('delivery', 'queue', 'worker'));
  const snapshot = structuredClone({ before, after });
  assert.deepEqual(summarize(before, after).map(item => item.text), [
    'Renamed API service → Public API', 'Removed API service → Worker', 'Added Queue', 'Connected Public API → Queue', 'Connected Queue → Worker',
  ]);
  assert.deepEqual({ before, after }, snapshot);
});

test('moving a node includes its bound label and attached routing as one edit', () => {
  const before = scene([...node('api', 'API'), ...node('worker', 'Worker'), { ...arrow('direct', 'api', 'worker'), x: 0, points: [[0, 0], [100, 0]] }]);
  const after = structuredClone(before);
  after.elements[2].x += 80;
  after.elements[3].x += 80;
  after.elements[4].points[1][0] += 80;
  assert.deepEqual(summarize(before, after).map(item => item.text), ['Moved Worker']);
});

test('style edits use human labels and retain their actual before/after values', () => {
  const before = scene(node('worker', 'Worker'));
  before.elements[0].backgroundColor = '#ffffff';
  const after = structuredClone(before);
  after.elements[0].backgroundColor = '#a5d8ff';
  after.elements[0].strokeWidth = 2.1234567;
  const [change] = summarize(before, after);
  assert.equal(change.text, 'Restyled Worker');
  assert.deepEqual(change.details, [{ label: 'Fill', before: '#ffffff', after: '#a5d8ff' }, { label: 'Stroke width', before: undefined, after: 2.1234567 }]);
});

test('summary targets preserve complete element IDs without changing either scene or receipt', () => {
  const before = scene([...node('api:primary', 'API'), ...node('old:queue', 'Old queue')]);
  const after = structuredClone(before);
  Object.assign(after.elements[1], { text: 'Public API', originalText: 'Public API' });
  after.elements[2].isDeleted = after.elements[3].isDeleted = true;
  after.elements.push(...node('new:queue', 'Queue'));
  const changes = deriveSceneChanges(before, after);
  const original = structuredClone({ before, after, changes });
  assert.deepEqual(summarizeEdits(before, after, changes).map(({ elementId, kind }) => ({ elementId, kind })), [
    { elementId: 'api:primary-label', kind: 'renamed' },
    { elementId: 'old:queue', kind: 'removed' },
    { elementId: 'new:queue', kind: 'added' },
  ]);
  assert.deepEqual({ before, after, changes }, original);
});

test('reconnections use endpoint identities while retaining the prior route', () => {
  const before = scene([...node('api', 'API'), ...node('worker', 'Worker'), ...node('queue', 'Queue'), arrow('direct', 'api', 'worker')]);
  const after = structuredClone(before);
  after.elements[6].endBinding.elementId = 'queue';
  assert.deepEqual(summarize(before, after).map(({ text, details }) => ({ text, details })), [{ text: 'Reconnected API → Queue', details: [{ label: 'Previously', value: 'API → Worker' }] }]);
});

test('unsupported changes remain visible and unknown endpoints are not invented', () => {
  const before = scene(node('api', 'API'));
  const after = structuredClone(before);
  after.elements[0].link = 'https://example.com';
  after.elements.push(arrow('unbound', 'api', null));
  assert.deepEqual(summarize(before, after).map(item => item.text), ['Updated API', 'Connected API → unbound end']);
  assert.equal(summarizeEdits(null, after, []), null);
});

test('technical changes format nested objects as JSON and round display only', () => {
  const changes = [{ id: 'label', properties: { x: { before: 11.1234567, after: 18.998765 }, boundElements: { before: [], after: [{ id: 'label', type: 'text' }] } } }];
  const original = structuredClone(changes);
  const formatted = formatTechnicalChanges(changes);
  assert.equal(JSON.parse(formatted)[0].properties.x.after, 19);
  assert.match(formatted, /"id": "label"/);
  assert.doesNotMatch(formatted, /\[object Object\]/);
  assert.equal(displayValue([{ id: 'label' }]), '[{"id":"label"}]');
  assert.equal(displayValue(1.234567), '1.23');
  assert.deepEqual(changes, original);
});
