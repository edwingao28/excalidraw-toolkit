import { isDeepStrictEqual } from "node:util";

export const REMOVE_CAPABILITIES = {
  remove: { required: ["targetId"], connections: ["detach", "remove"], behavior: "mark selected native elements and owned labels deleted; connections policy required for connected nodes" },
  disconnect: { required: ["targetId", "end"], end: ["start", "end", "both"], behavior: "detach bindings while preserving the arrow path and its label" },
  preservation: "keep element order, native tombstones, unknown metadata, and image assets; reject deleting frames with retained children",
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function keys(value, permitted) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !permitted.includes(key))) fail("INVALID_REQUEST", "Invalid removal fields");
}

export function planRemovals(scene, operations) {
  const index = new Map(scene.elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const candidate = new Map(scene.elements.map((element) => [element.id, structuredClone(element)]));
  const deleted = new Set();
  const modes = new Map();
  const targets = new Set();
  const disconnects = [];
  const supported = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "image", "frame", "magicframe", "embeddable", "iframe"];

  function owned(id) {
    const element = index.get(id);
    return [id, ...(element.boundElements ?? []).filter((binding) => binding.type === "text").map((binding) => binding.id)];
  }
  function mark(id, mode) {
    for (const childId of owned(id)) {
      deleted.add(childId);
      if (mode) modes.set(childId, mode);
    }
  }

  for (const operation of operations) {
    keys(operation, operation.op === "remove" ? ["op", "targetId", "connections"] : ["op", "targetId", "end"]);
    if (targets.has(operation.targetId)) fail("INVALID_REQUEST", `Repeated removal/disconnection target: ${operation.targetId}`);
    targets.add(operation.targetId);
    const target = index.get(operation.targetId);
    if (!target) fail("UNKNOWN_TARGET", `No live element with ID: ${operation.targetId}`);
    if (operation.op === "disconnect") {
      if (target.type !== "arrow") fail("UNSUPPORTED_TARGET", "disconnect targets an existing arrow");
      if (!["start", "end", "both"].includes(operation.end)) fail("INVALID_REQUEST", "disconnect requires end:'start', 'end', or 'both'");
      disconnects.push(operation);
      continue;
    }
    if (operation.op !== "remove" || !supported.includes(target.type)) fail("UNSUPPORTED_TARGET", "Unsupported removal target");
    if (operation.connections !== undefined && !["detach", "remove"].includes(operation.connections)) fail("INVALID_REQUEST", "connections must be 'detach' or 'remove'");
    const dependentArrows = new Set(owned(target.id).flatMap((id) => (index.get(id).boundElements ?? []).filter((binding) => binding.type === "arrow").map((binding) => binding.id)));
    if (dependentArrows.size && operation.connections === undefined) fail("AMBIGUOUS_REMOVAL", `Removing ${target.id} requires a connections policy for ${[...dependentArrows].join(", ")}`);
    mark(target.id, operation.connections);
    if (operation.connections === "remove") for (const arrowId of dependentArrows) mark(arrowId);
  }

  for (const operation of disconnects) {
    if (deleted.has(operation.targetId)) fail("INVALID_REQUEST", "An arrow cannot be removed and disconnected in the same request");
    const arrow = candidate.get(operation.targetId);
    if (["start", "both"].includes(operation.end)) arrow.startBinding = null;
    if (["end", "both"].includes(operation.end)) arrow.endBinding = null;
  }
  for (const id of deleted) candidate.get(id).isDeleted = true;
  for (const element of candidate.values()) {
    if (element.isDeleted) continue;
    if (element.frameId != null && deleted.has(element.frameId)) fail("AMBIGUOUS_REMOVAL", `Frame ${element.frameId} still contains ${element.id}; remove its children explicitly first`);
    if (element.containerId != null && deleted.has(element.containerId)) fail("AMBIGUOUS_REMOVAL", `Retained text ${element.id} still references a removed container`);
    for (const field of ["startBinding", "endBinding"]) {
      const targetId = element[field]?.elementId;
      if (!deleted.has(targetId)) continue;
      if (modes.get(targetId) !== "detach") fail("AMBIGUOUS_REMOVAL", `Retained arrow ${element.id} still references removed element ${targetId}`);
      element[field] = null;
    }
  }
  for (const element of candidate.values()) {
    if (element.isDeleted || !Array.isArray(element.boundElements)) continue;
    element.boundElements = element.boundElements.filter((binding) => {
      const child = candidate.get(binding.id);
      if (child.isDeleted) return false;
      return binding.type !== "arrow" || child.startBinding?.elementId === element.id || child.endBinding?.elementId === element.id;
    });
  }
  const updates = [];
  for (const before of scene.elements) {
    const after = candidate.get(before.id);
    const properties = {};
    for (const field of ["isDeleted", "boundElements", "startBinding", "endBinding"]) {
      if (!isDeepStrictEqual(before[field], after[field])) properties[field] = after[field];
    }
    if (Object.keys(properties).length) updates.push({ targetId: before.id, properties });
  }
  return updates;
}
