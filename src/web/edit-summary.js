const live = element => element && !element.isDeleted;
const connection = element => ['arrow', 'line'].includes(element?.type);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const geometry = ['x', 'y', 'width', 'height', 'angle', 'points'];
const bookkeeping = new Set(['id', 'seed', 'version', 'versionNonce', 'updated', 'boundElements', 'isDeleted']);
const styles = { backgroundColor: 'Fill', strokeColor: 'Stroke', fillStyle: 'Fill pattern', strokeWidth: 'Stroke width', strokeStyle: 'Stroke pattern', opacity: 'Opacity', roughness: 'Sketchiness', roundness: 'Corners', fontSize: 'Text size', fontFamily: 'Font family', textAlign: 'Text alignment', verticalAlign: 'Vertical alignment', lineHeight: 'Line height', startArrowhead: 'Start marker', endArrowhead: 'End marker' };

export function elementLabel(element, elements) {
  if (!element) return 'Unknown element';
  const label = element.name || element.originalText || element.text || elements.filter(item => live(item) && item.type === 'text' && item.containerId === element.id).map(item => item.originalText || item.text).filter(Boolean).join(' ');
  return typeof label === 'string' && label.trim() ? label.trim() : `${element.type[0].toUpperCase()}${element.type.slice(1)}`;
}

function endpoints(element) { return [element.startBinding?.elementId ?? null, element.endBinding?.elementId ?? null]; }
function connectionLabel(element, elements) {
  const [start, end] = endpoints(element);
  if (!start && !end) return 'connection';
  return [start, end].map(id => id ? elementLabel(elements.find(item => item.id === id), elements) : 'unbound end').join(' → ');
}

// The server verifies receipts. This presentation uses their before/after scenes;
// it does not promote a field count or reciprocal bindings into extra edits.
export function summarizeEdits(beforeScene, afterScene, changes) {
  if (!beforeScene || !afterScene || !Array.isArray(changes)) return null;
  const before = new Map(beforeScene.elements.map(element => [element.id, element]));
  const after = new Map(afterScene.elements.map(element => [element.id, element]));
  const summaries = [];
  const push = (id, kind, text, details = []) => summaries.push({ id: `${id}:${kind}`, kind, text, details });
  for (const change of changes) {
    const old = before.get(change.id), next = after.get(change.id);
    if (!live(old) && !live(next)) continue;
    const element = live(next) ? next : old;
    const elements = live(next) ? afterScene.elements : beforeScene.elements;
    const label = elementLabel(element, elements);
    const isConnection = connection(element);
    if (!live(old) || !live(next)) {
      const added = live(next);
      // A new/deleted bound label is part of its new/deleted parent.
      const parentId = element.type === 'text' && element.containerId;
      if (parentId && Boolean(live(before.get(parentId))) !== Boolean(live(after.get(parentId)))) continue;
      push(change.id, added ? 'added' : 'removed', `${added ? (isConnection ? 'Connected' : 'Added') : 'Removed'} ${isConnection ? connectionLabel(element, elements) : label}`);
      continue;
    }
    const fields = new Set(Object.keys(change.properties || {}).filter(key => !same(old[key], next[key]) && !bookkeeping.has(key)));
    const consume = keys => keys.forEach(key => fields.delete(key));
    const oldLabel = elementLabel(old, beforeScene.elements);
    if (['text', 'originalText', 'name'].some(key => fields.has(key))) {
      if (oldLabel !== label) push(change.id, 'renamed', `Renamed ${oldLabel} → ${label}`);
      consume(['text', 'originalText', 'name']);
      if (element.type === 'text') consume(element.containerId ? ['x', 'y', 'width', 'height', 'autoResize'] : ['width', 'height', 'autoResize']);
    }
    if (isConnection && !same(endpoints(old), endpoints(next))) {
      push(change.id, 'reconnected', `Reconnected ${connectionLabel(next, afterScene.elements)}`, [{ label: 'Previously', value: connectionLabel(old, beforeScene.elements) }]);
      consume(geometry);
    }
    if (isConnection) {
      consume(['startBinding', 'endBinding']);
      // Native arrows follow moved/resized endpoints; their routing is supporting geometry.
      if (endpoints(next).some(id => before.has(id) && after.has(id) && geometry.some(key => !same(before.get(id)[key], after.get(id)[key])))) consume(geometry);
    }
    if (element.type === 'text' && element.containerId) {
      const oldParent = before.get(element.containerId), newParent = after.get(element.containerId);
      if (oldParent && newParent && geometry.some(key => !same(oldParent[key], newParent[key]))) consume(geometry);
      if (['fontSize', 'fontFamily', 'lineHeight', 'textAlign', 'verticalAlign'].some(key => fields.has(key))) consume(['x', 'y', 'width', 'height']);
    }
    if (geometry.some(key => fields.has(key))) {
      const kind = isConnection ? 'adjusted' : fields.has('width') || fields.has('height') ? 'resized' : fields.has('angle') ? 'rotated' : 'moved';
      push(change.id, kind, `${kind[0].toUpperCase()}${kind.slice(1)} ${isConnection ? connectionLabel(next, afterScene.elements) : label}`);
      consume(geometry);
    }
    const details = Object.entries(styles).filter(([key]) => fields.has(key)).map(([key, label]) => ({ label, before: old[key], after: next[key] }));
    if (details.length) push(change.id, 'styled', `Restyled ${label}`, details);
    consume(Object.keys(styles));
    if (fields.size) push(change.id, 'updated', `Updated ${label}`);
  }
  return summaries;
}

export function formatTechnicalChanges(changes) {
  return JSON.stringify(changes, (_key, value) => typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(2)) : value, 2);
}

export function displayValue(value) {
  if (value == null) return 'None';
  if (typeof value === 'number') return Number(value.toFixed(2)).toString();
  if (typeof value === 'string') return value || 'Empty';
  return JSON.stringify(value);
}
