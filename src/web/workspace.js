// Browser-only scene bookkeeping. Native restoration is a rendering operation;
// only changes after its first onChange snapshot belong in the saved document.
const bookkeeping = new Set(['version', 'versionNonce', 'updated', 'index']);
const fileBookkeeping = new Set(['created', 'lastRetrieved']);
// The acceptance surface is intentionally limited to native drawing properties.
// Other imported fields are retained, but a proposal cannot rewrite metadata
// which this workspace does not apply through the editor's undo history.
const nativeFields = new Set([
  'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'isDeleted', 'groupIds', 'frameId', 'boundElements', 'link', 'locked', 'customData',
  'backgroundColor', 'strokeColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness',
  'fontSize', 'fontFamily', 'text', 'textAlign', 'verticalAlign', 'containerId', 'originalText', 'autoResize', 'lineHeight',
  'points', 'pressures', 'simulatePressure', 'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead', 'elbowed',
  'fixedSegments', 'startIsSpecial', 'endIsSpecial', 'fileId', 'status', 'scale', 'crop', 'name',
]);
const independentStyle = new Set(['backgroundColor', 'strokeColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness']);
const clone = structuredClone;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const live = element => element && !element.isDeleted;
// Native callbacks can include optional undefined keys; JSON downloads omit them.
const at = (value, key) => value[key] !== undefined && Object.hasOwn(value, key) ? { value: value[key] } : {};
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function changed(a, b, ignored = bookkeeping) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !ignored.has(key) && !same(at(a, key), at(b, key)));
}
function setField(target, source, key) {
  if (Object.hasOwn(source, key)) Object.defineProperty(target, key, { value: clone(source[key]), enumerable: true, writable: true, configurable: true });
  else delete target[key];
}

// This follows scene.js validateScene's native identity, reciprocal binding,
// frame, and image-asset rules without importing its Node-only receipt code.
function validate(scene) {
  if (!object(scene) || scene.type !== 'excalidraw' || !Array.isArray(scene.elements) ||
    (scene.files !== undefined && !object(scene.files))) throw new Error('Invalid Excalidraw document.');
  const index = new Map();
  for (const element of scene.elements) {
    if (!object(element) || typeof element.id !== 'string' || !element.id || typeof element.type !== 'string' || index.has(element.id)) throw new Error('Elements must have unique IDs and native types.');
    index.set(element.id, element);
  }
  const reference = (id, owner) => {
    if (!live(index.get(id))) throw new Error(`${owner}: missing live reference ${id}.`);
    return index.get(id);
  };
  for (const element of scene.elements) {
    if (!live(element)) continue;
    if (element.boundElements != null) {
      if (!Array.isArray(element.boundElements)) throw new Error(`${element.id}: invalid bound elements.`);
      const seen = new Set();
      for (const binding of element.boundElements) {
        if (!object(binding) || typeof binding.id !== 'string' || seen.has(binding.id)) throw new Error(`${element.id}: invalid or duplicate binding.`);
        seen.add(binding.id);
        const target = reference(binding.id, element.id);
        if (binding.type !== target.type || !['text', 'arrow'].includes(binding.type) ||
          (target.type === 'text' && target.containerId !== element.id) ||
          (target.type === 'arrow' && target.startBinding?.elementId !== element.id && target.endBinding?.elementId !== element.id)) throw new Error(`${element.id}: nonreciprocal binding.`);
      }
    }
    if (element.containerId != null) {
      const container = reference(element.containerId, element.id);
      if (element.type !== 'text' || !container.boundElements?.some(binding => binding.id === element.id && binding.type === 'text')) throw new Error(`${element.id}: nonreciprocal text container.`);
    }
    for (const field of ['startBinding', 'endBinding']) {
      const binding = element[field];
      if (binding == null) continue;
      if (!object(binding) || typeof binding.elementId !== 'string') throw new Error(`${element.id}: invalid ${field}.`);
      const target = reference(binding.elementId, element.id);
      if (element.type !== 'arrow' || !target.boundElements?.some(entry => entry.id === element.id && entry.type === 'arrow')) throw new Error(`${element.id}: nonreciprocal ${field}.`);
    }
    if (element.frameId != null && !['frame', 'magicframe'].includes(reference(element.frameId, element.id).type)) throw new Error(`${element.id}: invalid frame.`);
    if (element.type === 'image' && element.fileId != null && !Object.hasOwn(scene.files ?? {}, element.fileId)) throw new Error(`${element.id}: missing image asset ${element.fileId}.`);
  }
  return index;
}

/** Changes have the receipt sidebar's shape, but also support manual reordering. */
export function deriveChanges(before, after) {
  const previous = new Map(before.elements.map(element => [element.id, element]));
  const next = new Map(after.elements.map(element => [element.id, element]));
  const changes = [];
  for (const element of after.elements) {
    const old = previous.get(element.id);
    const fields = old ? changed(old, element) : Object.keys(element);
    if (fields.length) changes.push({ id: element.id, ...(!old ? { created: true } : {}), properties: Object.fromEntries(fields.map(field => [field, {
      before: old?.[field] ?? null, ...(Object.hasOwn(element, field) ? { after: clone(element[field]) } : {}),
    }])) });
  }
  for (const element of before.elements) {
    if (!next.has(element.id) && live(element)) changes.push({ id: element.id, properties: { isDeleted: { before: false, after: true } } });
  }
  return changes;
}

/** appState must contain native serializeAsJSON(..., 'local') persisted fields. */
export function captureWorkingScene(original, elements, appState, files, previousNative) {
  if (!previousNative) return original;
  const previous = new Map(previousNative.elements.map(element => [element.id, element]));
  const current = new Map(elements.map(element => [element.id, element]));
  const stored = new Map(original.elements.map(element => [element.id, element]));
  const candidate = clone(original);
  let dirty = false;
  const reordered = !same(previousNative.elements.map(element => element.id), elements.map(element => element.id));
  const restacked = !same(previousNative.elements.filter(element => current.has(element.id)).map(element => element.id), elements.filter(element => previous.has(element.id)).map(element => element.id));
  const captured = new Map();
  for (const element of elements) {
    const old = previous.get(element.id), existing = stored.get(element.id);
    if (!existing) { captured.set(element.id, clone(element)); dirty = true; continue; }
    const fields = old ? changed(old, element) : [];
    const updated = clone(existing);
    if (fields.length) {
      for (const field of [...fields, ...bookkeeping]) setField(updated, element, field);
      dirty = true;
    } else if (restacked && !same(at(existing, 'index'), at(element, 'index'))) setField(updated, element, 'index');
    captured.set(element.id, updated);
  }
  for (const existing of original.elements) {
    if (current.has(existing.id)) continue;
    const updated = clone(existing);
    if (previous.has(existing.id) && !existing.isDeleted) { updated.isDeleted = true; dirty = true; }
    captured.set(existing.id, updated);
  }
  // Keep imported objects that restoration did not expose, including tombstones.
  candidate.elements = reordered ? [...captured.values()] : original.elements.map(element => captured.get(element.id));
  dirty ||= reordered;
  for (const field of changed(previousNative.appState ?? {}, appState ?? {}, new Set())) {
    candidate.appState ??= {};
    setField(candidate.appState, appState ?? {}, field);
    dirty = true;
  }
  for (const id of changed(previousNative.files ?? {}, files ?? {}, new Set())) {
    // Keep unused assets for native undo; loading or inserting an image may add
    // native defaults to its file record, so copy only fields that actually changed.
    if (!Object.hasOwn(files ?? {}, id)) continue;
    candidate.files ??= {};
    const existing = candidate.files[id];
    const fields = changed(previousNative.files?.[id] ?? {}, files[id], existing ? fileBookkeeping : new Set());
    if (!fields.length) continue;
    const asset = clone(existing ?? {});
    for (const field of fields) setField(asset, files[id], field);
    setField(candidate.files, { [id]: asset }, id);
    dirty = true;
  }
  return dirty ? candidate : original;
}

function orderElements(base, current, proposed, merged, conflicts) {
  const common = new Set(base.elements.filter(element => current.some(item => item.id === element.id) && proposed.some(item => item.id === element.id)).map(element => element.id));
  const order = elements => elements.filter(element => common.has(element.id)).map(element => element.id);
  const initial = order(base.elements), human = order(current), agent = order(proposed);
  if (!same(human, initial) && !same(agent, initial) && !same(human, agent)) {
    conflicts.push({ field: 'elements', message: 'Both versions changed the stacking order differently.' });
    return [];
  }
  const result = same(agent, initial) ? human : agent;
  for (const elements of [current, proposed]) {
    for (let start = 0; start < elements.length;) {
      if (common.has(elements[start].id)) { start++; continue; }
      let end = start;
      while (end < elements.length && !common.has(elements[end].id)) end++;
      const before = start ? elements[start - 1].id : null;
      const after = end < elements.length ? elements[end].id : null;
      if (before && after && result.indexOf(before) > result.indexOf(after)) {
        conflicts.push({ field: 'elements', message: 'A new element overlaps a concurrent stacking-order change.' });
        return [];
      }
      const additions = elements.slice(start, end).map(element => element.id).filter(id => !result.includes(id));
      result.splice(after ? result.indexOf(after) : result.length, 0, ...additions);
      start = end;
    }
  }
  for (const id of merged.keys()) if (!result.includes(id)) result.push(id);
  return result.map(id => merged.get(id));
}

/** Apply a proposal atomically; conflict means the working scene stays untouched. */
export function mergeProposal(base, current, proposed) {
  const conflicts = [];
  let before, human, agent;
  try { before = validate(base); human = validate(current); agent = validate(proposed); }
  catch (error) { return { scene: null, conflicts: [{ field: 'document', message: error.message }] }; }
  const candidate = clone(current);
  const merged = new Map(candidate.elements.map(element => [element.id, element]));
  for (const [id, element] of before) if (!merged.has(id)) merged.set(id, { ...clone(element), isDeleted: true });
  const conflict = (id, field, message) => conflicts.push({ ...(id ? { id } : {}), field, message });
  const structural = [new Set(), new Set()];
  for (const [id, incoming] of agent) {
    const old = before.get(id);
    if (!old) continue; // Undo removes a newly added element as a whole.
    for (const field of changed(old, incoming)) {
      if (field === 'type' || !Object.hasOwn(incoming, field)) conflict(id, field, 'A proposal cannot change an existing native type or remove drawing fields. Use an explicit native value instead.');
      if (!nativeFields.has(field) && !(field === 'lastCommittedPoint' && incoming[field] == null)) conflict(id, field, `The proposal changes unsupported metadata (${field}). Keep it unchanged so acceptance stays undoable.`);
    }
  }
  for (const [id, incoming] of agent) {
    if (before.has(id)) continue;
    if (human.has(id)) { conflict(id, 'id', 'The proposal and working diagram added the same element ID.'); continue; }
    merged.set(id, clone(incoming));
    structural[1].add(id);
  }
  for (const [id, existing] of human) if (!before.has(id)) structural[0].add(id);
  for (const [id, old] of before) {
    const existing = human.get(id), incoming = agent.get(id);
    const humanFields = existing ? changed(old, existing) : ['isDeleted'];
    const agentFields = incoming ? changed(old, incoming) : ['isDeleted'];
    if (!existing || !incoming || changed(existing, incoming).length) {
      if (humanFields.some(field => !independentStyle.has(field))) structural[0].add(id);
      if (agentFields.some(field => !independentStyle.has(field))) structural[1].add(id);
    }
    if (!agentFields.length) continue;
    if (!live(existing) || !live(incoming)) {
      if (Boolean(live(existing)) !== Boolean(live(incoming)) && humanFields.length && agentFields.length) {
        conflict(id, 'isDeleted', 'This element was deleted in one version and edited in the other.'); continue;
      }
      if (!incoming) merged.set(id, { ...clone(existing ?? old), isDeleted: true });
      else if (!humanFields.length) for (const field of agentFields) setField(merged.get(id), incoming, field);
      continue;
    }
    if (humanFields.some(field => !independentStyle.has(field)) && agentFields.some(field => !independentStyle.has(field)) && !same(humanFields.map(field => [field, at(existing, field)]), agentFields.map(field => [field, at(incoming, field)]))) {
      conflict(id, 'element', 'Both versions changed this element’s geometry, text, or relationships.'); continue;
    }
    for (const field of agentFields) {
      if (humanFields.includes(field) && !same(at(existing, field), at(incoming, field))) conflict(id, field, `Both versions changed ${field}.`);
      else setField(merged.get(id), incoming, field);
    }
  }
  // Bound labels and connected endpoints share geometry even across element IDs.
  for (const elements of [base.elements, current.elements, proposed.elements]) {
    for (const element of elements) {
      const references = [...(element.boundElements?.map(binding => binding.id) ?? []), element.containerId, element.startBinding?.elementId, element.endBinding?.elementId, element.frameId].filter(Boolean);
      if (structural[0].has(element.id) && references.some(id => id !== element.id && structural[1].has(id))) conflict(element.id, 'bindings', 'Related elements changed in both versions; review their positions and bindings together.');
    }
  }
  const mergeFields = (initial, existing, incoming, target, prefix) => {
    for (const field of changed(initial, incoming, new Set())) {
      if (!same(at(initial, field), at(existing, field)) && !same(at(existing, field), at(incoming, field))) conflict(null, `${prefix}${field}`, `Both versions changed ${prefix}${field}.`);
      else setField(target, incoming, field);
    }
  };
  const document = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['elements', 'files', 'appState'].includes(key)));
  for (const field of changed(document(base), document(proposed), new Set())) conflict(null, field, `The proposal changes document metadata (${field}). Keep it unchanged so acceptance stays undoable.`);
  const appFields = changed(base.appState ?? {}, proposed.appState ?? {}, new Set());
  for (const field of appFields) {
    if (field !== 'viewBackgroundColor' || typeof proposed.appState[field] !== 'string') conflict(null, `appState.${field}`, `The proposal changes a setting (${field}) outside the workspace's undoable drawing state.`);
  }
  if (appFields.length) {
    candidate.appState ??= {};
    mergeFields(base.appState ?? {}, current.appState ?? {}, proposed.appState ?? {}, candidate.appState, 'appState.');
  }
  for (const [id, asset] of Object.entries(proposed.files ?? {})) {
    if (Object.hasOwn(current.files ?? {}, id)) {
      if (!same(base.files?.[id], asset) && !same(current.files[id], asset)) conflict(null, `files.${id}`, 'An existing image asset cannot be replaced; use a new file ID.');
    } else if (!Object.hasOwn(base.files ?? {}, id)) {
      candidate.files ??= {};
      setField(candidate.files, { [id]: asset }, id);
    }
  }
  candidate.elements = orderElements(base, current.elements, proposed.elements, merged, conflicts);
  if (!conflicts.length) {
    try { validate(candidate); } catch (error) { conflict(null, 'bindings', error.message); }
  }
  return { scene: conflicts.length ? null : candidate, conflicts };
}
