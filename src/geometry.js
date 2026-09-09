const TYPES = ["rectangle", "ellipse", "diamond"];
const EPSILON = 0.001;

export const MOVE_CAPABILITIES = {
  elementTypes: TYPES,
  geometry: "unrotated shapes and labels; bound frames retain containment",
  arrows: "straight two-point arrows; center focus 0; finite nonnegative gaps; no fixed points, elbows, or rounded bound shapes",
  routing: "reanchor both bound ends; preserve free endpoints, bindings, and label offsets",
  collisions: "reject new bounding-box overlaps and straight-arrow crossings; preserve existing containment",
};

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function bounds(element) {
  if (!element || ![element.x, element.y, element.width, element.height].every(Number.isFinite)) return null;
  const angle = element.angle ?? 0;
  const width = Math.abs(element.width * Math.cos(angle)) + Math.abs(element.height * Math.sin(angle));
  const height = Math.abs(element.width * Math.sin(angle)) + Math.abs(element.height * Math.cos(angle));
  const center = centerOf(element);
  return { left: center[0] - width / 2, top: center[1] - height / 2, right: center[0] + width / 2, bottom: center[1] + height / 2 };
}

export function contains(outer, inner) {
  return outer && inner && outer.left <= inner.left + EPSILON && outer.top <= inner.top + EPSILON && outer.right >= inner.right - EPSILON && outer.bottom >= inner.bottom - EPSILON;
}

function overlapArea(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

export function centerOf(element) {
  return [element.x + element.width / 2, element.y + element.height / 2];
}

function supportedShape(element, connected = false) {
  if (!element || !TYPES.includes(element.type) || element.angle !== 0 || !bounds(element) || element.width <= 0 || element.height <= 0) {
    fail("UNSUPPORTED_GEOMETRY", "Movement requires unrotated rectangle, ellipse, or diamond geometry");
  }
  if (connected && element.roundness != null && element.type !== "ellipse") {
    fail("UNSUPPORTED_GEOMETRY", "Bound arrows on rounded shapes are not supported by this move operation");
  }
}

export function centerEndpoint(element, toward, gap = 1) {
  supportedShape(element, true);
  if (!Number.isFinite(gap) || gap < 0 || !toward?.every(Number.isFinite)) fail("UNSUPPORTED_GEOMETRY", "Invalid arrow endpoint geometry");
  const center = centerOf(element);
  if (gap === 0) return center;
  const dx = toward[0] - center[0];
  const dy = toward[1] - center[1];
  if (Math.hypot(dx, dy) < EPSILON) fail("GEOMETRY_COLLISION", "A connection cannot route between coincident centers");
  // Native 0.18.1 offsets unrounded outlines by binding.gap. Diamonds also
  // retain getDiamondPoints' pixel rounding, which is asymmetric by one pixel.
  if (element.type === "diamond") {
    const midX = element.x + Math.floor(element.width / 2) + 1;
    const midY = element.y + Math.floor(element.height / 2) + 1;
    const vertices = [[midX, element.y - gap], [element.x + element.width + gap, midY], [midX, element.y + element.height + gap], [element.x - gap, midY]];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      const edgeX = b[0] - a[0]; const edgeY = b[1] - a[1];
      const denominator = dx * edgeY - dy * edgeX;
      if (Math.abs(denominator) < EPSILON) continue;
      const t = ((a[0] - center[0]) * edgeY - (a[1] - center[1]) * edgeX) / denominator;
      const u = ((a[0] - center[0]) * dy - (a[1] - center[1]) * dx) / denominator;
      if (t > 0 && t < 1 && u >= -EPSILON && u <= 1 + EPSILON) return [center[0] + dx * t, center[1] + dy * t];
    }
    fail("GEOMETRY_COLLISION", "A connection endpoint lies inside its bound diamond");
  }
  const rx = element.width / 2 + gap;
  const ry = element.height / 2 + gap;
  const divisor = element.type === "ellipse" ? Math.hypot(dx / rx, dy / ry)
    : Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  if (divisor <= 1) fail("GEOMETRY_COLLISION", "A connection endpoint lies inside its bound shape");
  return [center[0] + dx / divisor, center[1] + dy / divisor];
}

export function arrowEndpoints(arrow) {
  if (arrow.type !== "arrow" || arrow.angle !== 0 || arrow.elbowed || arrow.fixedSegments?.length
    || !Array.isArray(arrow.points) || arrow.points.length !== 2 || arrow.points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
    || ![arrow.x, arrow.y].every(Number.isFinite)) {
    fail("UNSUPPORTED_GEOMETRY", "Connected arrows must be unrotated, straight two-point paths");
  }
  for (const binding of [arrow.startBinding, arrow.endBinding]) {
    if (binding && (binding.focus !== 0 || binding.fixedPoint != null || !Number.isFinite(binding.gap) || binding.gap < 0)) {
      fail("UNSUPPORTED_GEOMETRY", "Connected arrows require center bindings with finite gaps");
    }
  }
  return arrow.points.map(([x, y]) => [arrow.x + x, arrow.y + y]);
}

export function routeStraightArrow(arrow, index) {
  const [oldStart, oldEnd] = arrowEndpoints(arrow);
  const startShape = arrow.startBinding && index.get(arrow.startBinding.elementId);
  const endShape = arrow.endBinding && index.get(arrow.endBinding.elementId);
  if (arrow.startBinding && !startShape || arrow.endBinding && !endShape) fail("INVALID_BINDING", "An arrow references a missing shape");
  const startCenter = startShape ? centerOf(startShape) : oldStart;
  const endCenter = endShape ? centerOf(endShape) : oldEnd;
  const start = startShape ? centerEndpoint(startShape, endCenter, arrow.startBinding.gap) : oldStart;
  const end = endShape ? centerEndpoint(endShape, startCenter, arrow.endBinding.gap) : oldEnd;
  const direction = [endCenter[0] - startCenter[0], endCenter[1] - startCenter[1]];
  if ((end[0] - start[0]) * direction[0] + (end[1] - start[1]) * direction[1] <= EPSILON) fail("GEOMETRY_COLLISION", "Bound shapes leave no space for the connection");
  return { x: start[0], y: start[1], width: Math.abs(end[0] - start[0]), height: Math.abs(end[1] - start[1]), points: [[0, 0], [end[0] - start[0], end[1] - start[1]]] };
}

function segmentInsideBox(start, end, box) {
  if (!box) return false;
  const limits = [[box.left + EPSILON, box.right - EPSILON], [box.top + EPSILON, box.bottom - EPSILON]];
  let low = 0;
  let high = 1;
  for (let axis = 0; axis < 2; axis++) {
    const difference = end[axis] - start[axis];
    if (Math.abs(difference) < EPSILON) {
      if (start[axis] <= limits[axis][0] || start[axis] >= limits[axis][1]) return false;
    } else {
      const intersections = limits[axis].map((value) => (value - start[axis]) / difference).sort((a, b) => a - b);
      low = Math.max(low, intersections[0]); high = Math.min(high, intersections[1]);
      if (low >= high) return false;
    }
  }
  return low < high;
}

function areaElement(element) {
  return !element.isDeleted && !["arrow", "line", "freedraw"].includes(element.type);
}

function stationaryStraightPoints(element) {
  if (element.type !== "arrow" || element.elbowed || element.points?.length !== 2 || !element.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return null;
  const points = element.points.map(([x, y]) => [element.x + x, element.y + y]);
  if (![element.x, element.y, element.angle ?? 0].every(Number.isFinite)) return null;
  const center = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
  const angle = element.angle ?? 0;
  return points.map(([x, y]) => [center[0] + (x - center[0]) * Math.cos(angle) - (y - center[1]) * Math.sin(angle), center[1] + (x - center[0]) * Math.sin(angle) + (y - center[1]) * Math.cos(angle)]);
}

function validateCollisions(before, after, changed) {
  const previous = new Map(before.elements.map((element) => [element.id, element]));
  for (const element of after.elements.filter((element) => changed.has(element.id))) {
    const old = previous.get(element.id);
    if (element.type === "arrow") {
      const [start, end] = arrowEndpoints(element);
      const [oldStart, oldEnd] = arrowEndpoints(old);
      for (const other of after.elements.filter(areaElement)) {
        if ([element.startBinding?.elementId, element.endBinding?.elementId, element.id].includes(other.id) || other.containerId === element.id) continue;
        if (segmentInsideBox(start, end, bounds(other)) && !segmentInsideBox(oldStart, oldEnd, bounds(previous.get(other.id)))) {
          fail("GEOMETRY_COLLISION", `Moving ${element.id} introduces a crossing through ${other.id}`);
        }
      }
      continue;
    }
    if (!areaElement(element)) continue;
    for (const other of after.elements.filter((other) => !other.isDeleted && other.type === "arrow" && !changed.has(other.id))) {
      if ([other.startBinding?.elementId, other.endBinding?.elementId].includes(element.id) || element.containerId === other.id) continue;
      const points = stationaryStraightPoints(other);
      if (points && segmentInsideBox(...points, bounds(element)) && !segmentInsideBox(...points, bounds(old))) {
        fail("GEOMETRY_COLLISION", `Moving ${element.id} introduces a crossing with ${other.id}`);
      }
    }
    for (const other of after.elements.filter(areaElement)) {
      if (other.id === element.id || other.containerId === element.id || element.containerId === other.id) continue;
      const oldOther = previous.get(other.id);
      const oldBounds = bounds(old);
      const oldOtherBounds = bounds(oldOther);
      const newBounds = bounds(element);
      const otherBounds = bounds(other);
      if (contains(oldOtherBounds, oldBounds)) {
        if (!contains(otherBounds, newBounds)) fail("GEOMETRY_COLLISION", `Moving ${element.id} would leave its existing container ${other.id}`);
        continue;
      }
      if (contains(oldBounds, oldOtherBounds) && contains(newBounds, otherBounds)) continue;
      if (overlapArea(newBounds, otherBounds) > overlapArea(oldBounds, oldOtherBounds) + EPSILON) {
        fail("GEOMETRY_COLLISION", `Moving ${element.id} introduces or worsens an overlap with ${other.id}`);
      }
    }
  }
}

export function moveUpdates(scene, operations) {
  const index = new Map(scene.elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const candidate = structuredClone(scene);
  const next = new Map(candidate.elements.map((element) => [element.id, element]));
  const updates = new Map();
  const moved = new Set();
  const arrows = new Set();
  const update = (id, properties) => {
    updates.set(id, { targetId: id, properties: { ...updates.get(id)?.properties, ...properties } });
    Object.assign(next.get(id), properties);
  };
  for (const { targetId, x, y } of operations) {
    if (moved.has(targetId)) fail("INVALID_REQUEST", `Repeated move target: ${targetId}`);
    moved.add(targetId);
    const target = index.get(targetId);
    if (!target) fail("UNKNOWN_TARGET", `No live element with ID: ${targetId}`);
    supportedShape(target);
    if (![x, y].every(Number.isFinite)) fail("INVALID_REQUEST", "Move coordinates must be finite numbers");
    const dx = x - target.x;
    const dy = y - target.y;
    if (dx === 0 && dy === 0) continue;
    const labels = target.boundElements?.filter((binding) => binding.type === "text") ?? [];
    if (labels.length > 1) fail("UNSUPPORTED_GEOMETRY", "A moved shape can have at most one bound label");
    for (const other of scene.elements.filter(areaElement)) {
      if (other.id !== targetId && other.containerId !== targetId && contains(bounds(target), bounds(other))) {
        fail("UNSUPPORTED_GEOMETRY", "Moving a container with nested content requires an explicit group operation");
      }
    }
    update(targetId, { x, y });
    for (const binding of target.boundElements ?? []) {
      if (binding.type === "arrow") { arrows.add(binding.id); continue; }
      const label = index.get(binding.id);
      if (!label || label.containerId !== targetId || label.angle !== 0 || !bounds(label)) fail("UNSUPPORTED_GEOMETRY", "A moved label needs unrotated native geometry");
      update(label.id, { x: label.x + dx, y: label.y + dy });
    }
    if (target.frameId != null && !contains(bounds(index.get(target.frameId)), bounds(next.get(targetId)))) {
      fail("GEOMETRY_COLLISION", `Moving ${targetId} would leave its existing frame`);
    }
  }
  for (const id of arrows) {
    const arrow = index.get(id);
    const oldPoints = arrowEndpoints(arrow);
    const expected = arrowEndpoints({ ...arrow, ...routeStraightArrow(arrow, index) });
    if (oldPoints.some((point, i) => Math.hypot(point[0] - expected[i][0], point[1] - expected[i][1]) > EPSILON)) {
      fail("UNSUPPORTED_GEOMETRY", "The existing arrow path does not match its center bindings; preserve it as a manual route");
    }
    const properties = routeStraightArrow(arrow, next);
    update(id, properties);
    const newPoints = arrowEndpoints(next.get(id));
    for (const binding of arrow.boundElements ?? []) {
      const label = index.get(binding.id);
      if (binding.type !== "text" || !label || label.containerId !== id || label.angle !== 0 || !bounds(label)) fail("UNSUPPORTED_GEOMETRY", "Unsupported arrow label geometry");
      update(label.id, {
        x: label.x + (newPoints[0][0] + newPoints[1][0] - oldPoints[0][0] - oldPoints[1][0]) / 2,
        y: label.y + (newPoints[0][1] + newPoints[1][1] - oldPoints[0][1] - oldPoints[1][1]) / 2,
      });
    }
  }
  validateCollisions(scene, candidate, new Set(updates.keys()));
  return [...updates.values()];
}
