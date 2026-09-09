import { createHash } from "node:crypto";
import { bounds, contains, overlapArea, routeStraightArrow, arrowEndpoints, segmentInsideBox, stationaryStraightPoints } from "./geometry.js";
import { LABEL_CAPABILITIES, measureLabel } from "./text.js";

export const ADD_CAPABILITIES = {
  addNode: "rectangle/ellipse/diamond; explicit stable ID, dimensions, and placement region; optional measured label with its own ID",
  connect: "explicit stable ID and fromId/toId; center-bound straight arrows with reciprocal references",
  collisions: "no new shape overlaps or straight-arrow crossings; region.containerId explicitly permits containment",
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function keys(value, permitted, description) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !permitted.includes(key))) fail("INVALID_REQUEST", `Invalid ${description} fields`);
}

function style(value = {}, fields = ["backgroundColor", "strokeColor"]) {
  keys(value, fields, "style");
  for (const color of Object.values(value)) {
    if (typeof color !== "string" || !(color === "transparent" || /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color))) fail("INVALID_REQUEST", "Styles require hex colors or transparent");
  }
  return value;
}

function nativeElement(id, type, properties) {
  const hash = createHash("sha256").update(id).digest();
  return {
    id, type, x: 0, y: 0, width: 0, height: 0, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: null,
    seed: hash.readUInt32BE(0) & 0x7fffffff,
    version: 1, versionNonce: hash.readUInt32BE(4) & 0x7fffffff,
    isDeleted: false, boundElements: null, updated: 0, link: null, locked: false,
    ...properties,
  };
}

function claimId(id, ids) {
  if (typeof id !== "string" || !id.trim() || id.length > 200) fail("INVALID_REQUEST", "Every new element needs an explicit stable ID of at most 200 characters");
  if (ids.has(id)) fail("ID_CONFLICT", `Element ID already exists: ${id}`);
  ids.add(id);
}

function regionFor(value, scene, node) {
  keys(value, ["x", "y", "width", "height", "containerId"], "region");
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width <= 0 || value.height <= 0) fail("INVALID_REQUEST", "A placement region needs finite positive dimensions");
  const region = bounds(value);
  if (!contains(region, bounds(node))) fail("PLACEMENT_CONFLICT", `Node ${node.id} does not fit its declared region`);
  if (value.containerId !== undefined) {
    const container = scene.elements.find((element) => element.id === value.containerId && !element.isDeleted);
    if (!container || !["rectangle", "frame", "magicframe"].includes(container.type) || container.angle !== 0 || !contains(bounds(container), region)) {
      fail("PLACEMENT_CONFLICT", "region.containerId must identify a containing unrotated rectangle or frame");
    }
    if (["frame", "magicframe"].includes(container.type)) node.frameId = container.id;
  }
}

async function newNode(operation, scene, ids, measure) {
  keys(operation, ["op", "id", "type", "x", "y", "width", "height", "region", "label", "style"], "addNode");
  if (!["rectangle", "ellipse", "diamond"].includes(operation.type)) fail("UNSUPPORTED_TARGET", "addNode supports rectangles, ellipses, and diamonds");
  claimId(operation.id, ids);
  const { x, y, width, height } = operation;
  if (![x, y, width, height].every(Number.isFinite) || width <= 10 || height <= 10) fail("INVALID_REQUEST", "Node dimensions must be finite and larger than 10px");
  const node = nativeElement(operation.id, operation.type, { x, y, width, height, ...style(operation.style) });
  regionFor(operation.region, scene, node);
  if (operation.label === undefined) return [node];
  keys(operation.label, ["id", "text", "fontSize", "fontFamily", "lineHeight"], "label");
  claimId(operation.label.id, ids);
  const { text, fontSize = 20, fontFamily = 5, lineHeight = 1.25 } = operation.label;
  if (typeof text !== "string" || !text.length || /[\u0000-\u0009\u000b-\u001f]/u.test(text) || ![fontSize, lineHeight].every(Number.isFinite) || fontSize <= 0 || lineHeight <= 0) fail("INVALID_REQUEST", "A label needs nonempty text and positive font metrics");
  if (!LABEL_CAPABILITIES.fontFamilies.includes(fontFamily)) fail("UNSUPPORTED_FONT", "A bundled label font is required");
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) && fontFamily !== 5) fail("UNSUPPORTED_FONT_TEXT", "CJK labels require Excalifont");
  const ratio = node.type === "ellipse" ? Math.SQRT1_2 : node.type === "diamond" ? 0.5 : 1;
  const maxWidth = Math.round(width * ratio) - 10;
  const maxHeight = Math.round(height * ratio) - 10;
  const metrics = await measure({ text, fontSize, fontFamily, lineHeight, maxWidth });
  if (!metrics || typeof metrics.text !== "string" || ![metrics.width, metrics.height].every(Number.isFinite) || metrics.width <= 0 || metrics.height <= 0) fail("INVALID_TEXT_METRICS", "Invalid native text metrics");
  if (metrics.text.replaceAll("\n", "").replaceAll(" ", "") !== text.replaceAll("\n", "").replaceAll(" ", "")) fail("INVALID_TEXT_METRICS", "Native wrapping lost requested label content");
  if (metrics.width > maxWidth + 0.001 || metrics.height > maxHeight + 0.001) fail("TEXT_OVERFLOW", `Label ${operation.label.id} cannot fit the requested node`);
  const label = nativeElement(operation.label.id, "text", {
    x: x + (width - metrics.width) / 2, y: y + (height - metrics.height) / 2,
    width: metrics.width, height: metrics.height, text: metrics.text, originalText: text,
    fontSize, fontFamily, lineHeight, textAlign: "center", verticalAlign: "middle",
    containerId: node.id, frameId: node.frameId, autoResize: true, strokeColor: node.strokeColor,
  });
  node.boundElements = [{ id: label.id, type: "text" }];
  return [node, label];
}

function checkPlacement(scene, additions, operations) {
  const all = [...scene.elements, ...additions].filter((element) => !element.isDeleted);
  const nodeOperations = new Map(operations.filter((operation) => operation.op === "addNode").map((operation) => [operation.id, operation]));
  for (const node of additions.filter((element) => nodeOperations.has(element.id))) {
    const within = nodeOperations.get(node.id).region.containerId;
    for (const other of all) {
      if (other.id === node.id || other.containerId === node.id || other.id === within || ["line", "freedraw"].includes(other.type)) continue;
      if (other.type === "arrow") {
        if ([other.startBinding?.elementId, other.endBinding?.elementId].includes(node.id)) continue;
        const points = stationaryStraightPoints(other);
        if (points && segmentInsideBox(...points, bounds(node))) fail("PLACEMENT_CONFLICT", `Node ${node.id} crosses arrow ${other.id}`);
      } else if (overlapArea(bounds(node), bounds(other)) > 0.001) {
        fail("PLACEMENT_CONFLICT", `Node ${node.id} overlaps ${other.id}`);
      }
    }
  }
  const index = new Map(all.map((element) => [element.id, element]));
  for (const arrow of additions.filter((element) => element.type === "arrow")) {
    const points = arrowEndpoints(arrow);
    for (const other of all) {
      if (["arrow", "line", "freedraw"].includes(other.type) || [arrow.startBinding.elementId, arrow.endBinding.elementId].includes(other.id)) continue;
      if (contains(bounds(other), bounds(index.get(arrow.startBinding.elementId))) || contains(bounds(other), bounds(index.get(arrow.endBinding.elementId)))) continue;
      if (segmentInsideBox(...points, bounds(other))) fail("PLACEMENT_CONFLICT", `Connection ${arrow.id} crosses ${other.id}`);
    }
  }
}

export async function planAdditions(scene, operations, options = {}) {
  const ids = new Set(scene.elements.map((element) => element.id));
  const additions = [];
  const updates = new Map();
  for (const operation of operations.filter((operation) => operation.op === "addNode")) additions.push(...await newNode(operation, scene, ids, options.measureLabel ?? measureLabel));
  const index = new Map([...scene.elements, ...additions].filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  for (const operation of operations.filter((operation) => operation.op === "connect")) {
    keys(operation, ["op", "id", "fromId", "toId", "gap", "style"], "connect");
    claimId(operation.id, ids);
    if (operation.fromId === operation.toId) fail("UNSUPPORTED_GEOMETRY", "Self-connections are outside the straight-arrow operation");
    const from = index.get(operation.fromId); const to = index.get(operation.toId);
    if (!from || !to) fail("UNKNOWN_TARGET", "A connection must reference live existing or newly added nodes");
    const gap = operation.gap ?? 10;
    if (!Number.isFinite(gap) || gap < 1) fail("INVALID_REQUEST", "Connection gap must be a finite number of at least 1px");
    const arrow = nativeElement(operation.id, "arrow", {
      points: [[0, 0], [1, 1]], startBinding: { elementId: from.id, focus: 0, gap }, endBinding: { elementId: to.id, focus: 0, gap },
      startArrowhead: null, endArrowhead: "arrow", elbowed: false, ...style(operation.style, ["strokeColor"]),
    });
    Object.assign(arrow, routeStraightArrow(arrow, index));
    additions.push(arrow); index.set(arrow.id, arrow);
    for (const node of [from, to]) {
      const properties = updates.get(node.id)?.properties ?? {};
      const boundElements = [...(properties.boundElements ?? node.boundElements ?? []), { id: arrow.id, type: "arrow" }];
      if (additions.includes(node)) node.boundElements = boundElements;
      else updates.set(node.id, { targetId: node.id, properties: { boundElements } });
    }
  }
  checkPlacement(scene, additions, operations);
  return { additions, updates: [...updates.values()] };
}
