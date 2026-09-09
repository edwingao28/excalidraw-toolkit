import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LABEL_CAPABILITIES, labelUpdate } from "./text.js";
import { MOVE_CAPABILITIES, moveUpdates } from "./geometry.js";
import { ADD_CAPABILITIES, planAdditions } from "./additions.js";

const STYLE_TYPES = ["rectangle", "ellipse", "diamond"];
const STYLE_FIELDS = ["backgroundColor", "strokeColor"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value, permitted, description) {
  if (!object(value) || Object.keys(value).some((key) => !permitted.includes(key))) {
    fail("INVALID_REQUEST", `Invalid fields in ${description}`);
  }
}

export function validateScene(scene) {
  if (!object(scene) || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    fail("INVALID_SCENE", "Expected a native Excalidraw document with an elements array");
  }
  if (scene.files !== undefined && !object(scene.files)) fail("INVALID_SCENE", "Invalid scene files");
  const index = new Map();
  for (const element of scene.elements) {
    if (!object(element) || typeof element.id !== "string" || !element.id || typeof element.type !== "string") {
      fail("INVALID_SCENE", "Every element must have a nonempty ID and type");
    }
    if (index.has(element.id)) fail("DUPLICATE_ID", `Duplicate element ID: ${element.id}`);
    index.set(element.id, element);
  }
  const live = (id, owner) => {
    const target = index.get(id);
    if (!target || target.isDeleted) fail("INVALID_BINDING", `${owner}: missing live reference ${id}`);
    return target;
  };
  for (const element of scene.elements) {
    // Deleted objects retain their native undo metadata, including old references.
    if (element.isDeleted) continue;
    if (element.boundElements != null) {
      if (!Array.isArray(element.boundElements)) fail("INVALID_BINDING", `${element.id}: invalid boundElements`);
      const seen = new Set();
      for (const binding of element.boundElements) {
        if (!object(binding) || typeof binding.id !== "string" || seen.has(binding.id)) {
          fail("INVALID_BINDING", `${element.id}: invalid or duplicate bound element`);
        }
        seen.add(binding.id);
        const child = live(binding.id, element.id);
        if (binding.type !== child.type || !["text", "arrow"].includes(binding.type)) {
          fail("INVALID_BINDING", `${element.id}: unsupported bound element reference`);
        }
        if (child.type === "text" && child.containerId !== element.id) {
          fail("INVALID_BINDING", `${element.id}: nonreciprocal text binding`);
        }
        if (child.type === "arrow" && child.startBinding?.elementId !== element.id && child.endBinding?.elementId !== element.id) {
          fail("INVALID_BINDING", `${element.id}: nonreciprocal arrow binding`);
        }
      }
    }
    if (element.containerId != null) {
      const container = live(element.containerId, element.id);
      if (element.type !== "text" || !container.boundElements?.some((entry) => entry.id === element.id && entry.type === "text")) {
        fail("INVALID_BINDING", `${element.id}: nonreciprocal container binding`);
      }
    }
    for (const field of ["startBinding", "endBinding"]) {
      const binding = element[field];
      if (binding == null) continue;
      if (!object(binding) || typeof binding.elementId !== "string") fail("INVALID_BINDING", `${element.id}: invalid ${field}`);
      const target = live(binding.elementId, element.id);
      if (element.type !== "arrow" || !target.boundElements?.some((entry) => entry.id === element.id && entry.type === "arrow")) {
        fail("INVALID_BINDING", `${element.id}: nonreciprocal ${field}`);
      }
    }
    if (element.frameId != null && !["frame", "magicframe"].includes(live(element.frameId, element.id).type)) {
      fail("INVALID_BINDING", `${element.id}: frameId does not reference a frame`);
    }
    if (element.type === "image" && element.fileId != null && !Object.hasOwn(scene.files ?? {}, element.fileId)) {
      fail("MISSING_ASSET", `${element.id}: missing image asset ${element.fileId}`);
    }
  }
  return index;
}

async function readScene(inputPath) {
  const bytes = await fs.readFile(inputPath);
  let scene;
  try { scene = JSON.parse(bytes.toString("utf8")); }
  catch { fail("INVALID_SCENE", "The input is not valid JSON"); }
  validateScene(scene);
  return { bytes, scene, hash: sha256(bytes) };
}

export async function inspectScene(inputPath) {
  const { scene, hash } = await readScene(inputPath);
  const index = new Map(scene.elements.map((element) => [element.id, element]));
  return {
    inputPath: resolve(inputPath),
    baseHash: hash,
    capabilities: {
      operations: ["setStyle", "setLabel", "move", "addNode", "connect"],
      ...ADD_CAPABILITIES,
      move: MOVE_CAPABILITIES,
      setLabel: LABEL_CAPABILITIES,
      setStyle: { elementTypes: STYLE_TYPES, fields: STYLE_FIELDS, colors: "hex RGB/RGBA or transparent" },
      output: "edited copy; original is never overwritten",
    },
    elements: scene.elements.map((element) => ({
      id: element.id, type: element.type, isDeleted: Boolean(element.isDeleted),
      label: element.text ?? element.boundElements?.filter((binding) => binding.type === "text").map((binding) => index.get(binding.id)?.text).join("\n"),
      x: element.x, y: element.y, width: element.width, height: element.height, angle: element.angle,
      groupIds: element.groupIds, frameId: element.frameId, containerId: element.containerId,
      boundElements: element.boundElements, startBinding: element.startBinding, endBinding: element.endBinding,
    })),
    assetIds: Object.keys(scene.files ?? {}),
  };
}

function styleUpdate(scene, operation) {
  keys(operation, ["op", "targetId", "style"], "operation");
  if (operation.op !== "setStyle") fail("UNSUPPORTED_OPERATION", `Unsupported operation: ${operation.op}`);
  const target = scene.elements.find((element) => element.id === operation.targetId && !element.isDeleted);
  if (!target) fail("UNKNOWN_TARGET", `No live element with ID: ${operation.targetId}`);
  if (!STYLE_TYPES.includes(target.type)) fail("UNSUPPORTED_TARGET", `Style edits do not support ${target.type}`);
  keys(operation.style, STYLE_FIELDS, "style");
  if (!Object.keys(operation.style).length) fail("INVALID_REQUEST", "style must contain at least one color");
  for (const [field, color] of Object.entries(operation.style)) {
    if (typeof color !== "string" || !(color === "transparent" || /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color))) {
      fail("INVALID_REQUEST", `Invalid ${field}: use a hex color or transparent`);
    }
  }
  return { targetId: target.id, properties: operation.style };
}

function applyUpdates(scene, updates, additions = []) {
  const candidate = structuredClone(scene);
  candidate.elements.push(...structuredClone(additions));
  const next = new Map(candidate.elements.map((element) => [element.id, element]));
  const allowed = new Map();
  for (const { targetId, properties } of updates) {
    const fields = allowed.get(targetId) ?? new Set();
    for (const [field, value] of Object.entries(properties)) {
      if (fields.has(field)) fail("INVALID_REQUEST", `Repeated assignment: ${targetId}.${field}`);
      fields.add(field);
      next.get(targetId)[field] = value;
    }
    allowed.set(targetId, fields);
  }
  validateScene(candidate);
  const protectedCopy = structuredClone(candidate);
  const changes = [];
  for (let i = 0; i < scene.elements.length; i++) {
    const before = scene.elements[i];
    const after = candidate.elements[i];
    const properties = {};
    for (const field of allowed.get(before.id) ?? []) {
      if (!isDeepStrictEqual(before[field], after[field])) {
        properties[field] = { before: before[field] ?? null, after: after[field] };
      }
      if (Object.hasOwn(before, field)) protectedCopy.elements[i][field] = before[field];
      else delete protectedCopy.elements[i][field];
    }
    if (Object.keys(properties).length) changes.push({ id: before.id, properties });
  }
  protectedCopy.elements.length = scene.elements.length;
  if (!isDeepStrictEqual(scene, protectedCopy)) fail("PROTECTED_CHANGE", "The candidate changed a protected value");
  for (const element of candidate.elements.slice(scene.elements.length)) {
    changes.push({ id: element.id, created: true, properties: Object.fromEntries(Object.entries(element).map(([field, after]) => [field, { before: null, after }])) });
  }
  return { candidate, changes };
}

function checkOperations(scene, operations) {
  validateScene(scene);
  if (!Array.isArray(operations) || !operations.length) fail("INVALID_REQUEST", "operations must be a nonempty array");
}

export function applyStyleOperations(scene, operations) {
  checkOperations(scene, operations);
  return applyUpdates(scene, operations.map((operation) => styleUpdate(scene, operation)));
}

async function applyExistingOperations(scene, operations, options = {}) {
  checkOperations(scene, operations);
  const moves = operations.filter((operation) => operation?.op === "move");
  for (const operation of moves) keys(operation, ["op", "targetId", "x", "y"], "move operation");
  const geometry = moves.length ? moveUpdates(scene, moves) : [];
  const positioned = geometry.length ? applyUpdates(scene, geometry).candidate : scene;
  const updates = [];
  for (const operation of operations.filter((operation) => operation?.op !== "move")) {
    if (operation?.op === "setLabel") {
      keys(operation, ["op", "targetId", "text"], "label operation");
      updates.push(await labelUpdate(positioned, operation.targetId, operation.text, options.measureLabel));
    } else {
      updates.push(styleUpdate(positioned, operation));
    }
  }
  if (!geometry.length) return applyUpdates(scene, updates);
  // Validate repeated semantic assignments separately. A move and a relabel may
  // both compute text coordinates, so merge those authorized derived fields.
  applyUpdates(positioned, updates);
  const combined = new Map(geometry.map((update) => [update.targetId, update]));
  for (const update of updates) combined.set(update.targetId, { ...update, properties: { ...combined.get(update.targetId)?.properties, ...update.properties } });
  return applyUpdates(scene, [...combined.values()]);
}

export async function applyOperations(scene, operations, options = {}) {
  checkOperations(scene, operations);
  const additionOperations = operations.filter((operation) => ["addNode", "connect"].includes(operation?.op));
  const existingOperations = operations.filter((operation) => !["addNode", "connect"].includes(operation?.op));
  const existing = existingOperations.length ? await applyExistingOperations(scene, existingOperations, options) : { candidate: scene, changes: [] };
  if (!additionOperations.length) return existing;
  const { additions, updates } = await planAdditions(existing.candidate, additionOperations, options);
  const combined = new Map(existing.changes.map((change) => [change.id, { targetId: change.id, properties: Object.fromEntries(Object.entries(change.properties).map(([field, value]) => [field, value.after])) }]));
  for (const update of updates) combined.set(update.targetId, { ...update, properties: { ...combined.get(update.targetId)?.properties, ...update.properties } });
  return applyUpdates(scene, [...combined.values()], additions);
}

async function writeDurable(path, contents) {
  const handle = await fs.open(path, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeDurable(temp, `${JSON.stringify(value, null, 2)}\n`);
  try { await fs.link(temp, path); await syncDirectory(dirname(path)); }
  finally { await fs.unlink(temp); }
}

async function readJSON(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function claimAttempt(jobDir) {
  const claimsDir = join(jobDir, "claims");
  await fs.mkdir(claimsDir, { recursive: true });
  const generations = (await fs.readdir(claimsDir)).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number.parseInt(name)).sort((a, b) => a - b);
  const previous = generations.at(-1) ?? 0;
  if (previous) {
    const owner = await readJSON(join(claimsDir, `${previous}.json`));
    const finished = await readJSON(join(jobDir, "attempts", owner.attemptId, "finished.json"));
    // Claims are never unlinked. A crashed attempt can only be succeeded by a new
    // generation, avoiding the stale-lock removal race with another retry.
    if (!finished && (owner.hostname !== hostname() || alive(owner.pid))) {
      fail("REQUEST_BUSY", "This request has an active or unverifiable owner; retry after it exits");
    }
  }
  const attemptId = randomUUID();
  const attemptDir = join(jobDir, "attempts", attemptId);
  await fs.mkdir(attemptDir, { recursive: true });
  const owner = { attemptId, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  const ownerPath = join(attemptDir, "owner.json");
  await writeDurable(ownerPath, JSON.stringify(owner));
  try { await fs.link(ownerPath, join(claimsDir, `${previous + 1}.json`)); await syncDirectory(claimsDir); }
  catch (error) {
    if (error.code === "EEXIST") fail("REQUEST_BUSY", "Another attempt claimed this request; retry later");
    throw error;
  }
  return attemptDir;
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function deriveSceneChanges(before, after) {
  validateScene(before);
  validateScene(after);
  if (!isDeepStrictEqual({ ...before, elements: [] }, { ...after, elements: [] }) || after.elements.length < before.elements.length) {
    fail("CORRUPT_RESULT", "The completed scene changed protected document fields or removed native history");
  }
  const changes = [];
  for (let i = 0; i < after.elements.length; i++) {
    const previous = before.elements[i], current = after.elements[i];
    if (!previous) {
      changes.push({ id: current.id, created: true, properties: Object.fromEntries(Object.entries(current).map(([field, value]) => [field, { before: null, after: value }])) });
      continue;
    }
    if (previous.id !== current.id) fail("CORRUPT_RESULT", "The completed scene reordered or replaced existing element identities");
    const properties = {};
    for (const field of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (!isDeepStrictEqual(previous[field], current[field])) {
        properties[field] = { before: previous[field] ?? null, ...(Object.hasOwn(current, field) ? { after: current[field] } : {}) };
      }
    }
    if (Object.keys(properties).length) changes.push({ id: previous.id, properties });
  }
  return changes;
}

export async function verifyReceipt(receiptPath, { expectedDigest } = {}) {
  const path = resolve(receiptPath), jobDir = dirname(path);
  const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const exactFields = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  const readRegular = async file => {
    try {
      if (!(await fs.lstat(file)).isFile()) fail("CORRUPT_RESULT", "Completed files must be regular files");
      return await fs.readFile(file);
    } catch { fail("CORRUPT_RESULT", `Cannot read completed file: ${basename(file)}`); }
  };
  let receipt, recorded;
  try {
    receipt = JSON.parse(await readRegular(path));
    recorded = JSON.parse(await readRegular(join(jobDir, "request.json")));
  } catch { fail("CORRUPT_RESULT", "The completed receipt or recorded request is invalid"); }
  if (!exactFields(recorded, ["digest", "inputPath", "requestId", "baseHash", "operations"]) ||
    !hash(recorded.digest) || !hash(recorded.baseHash) || typeof recorded.inputPath !== "string" || resolve(recorded.inputPath) !== recorded.inputPath ||
    typeof recorded.requestId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(recorded.requestId) ||
    recorded.requestId !== basename(jobDir) || !Array.isArray(recorded.operations) || !recorded.operations.length || recorded.operations.some(operation => !object(operation))) {
    fail("CORRUPT_RESULT", "The completed request record has an invalid shape or identity");
  }
  const { digest, ...request } = recorded;
  if (digest !== sha256(canonical(request)) || (expectedDigest !== undefined && digest !== expectedDigest)) fail("CORRUPT_RESULT", "The completed request no longer matches its digest");
  const names = ["before.excalidraw", "after.excalidraw", "before.png", "after.png"];
  if (!exactFields(receipt, ["schemaVersion", "status", "requestId", "requestDigest", "inputPath", "inputHash", "outputHash", "changes", "validation", "artifacts", "receiptPath"]) ||
    receipt.schemaVersion !== 1 || receipt.status !== "complete" || receipt.receiptPath !== path || basename(path) !== "receipt.json" ||
    receipt.requestId !== recorded.requestId || receipt.requestDigest !== digest || receipt.inputPath !== recorded.inputPath || receipt.inputHash !== recorded.baseHash || !hash(receipt.outputHash) ||
    !Array.isArray(receipt.changes) || !exactFields(receipt.artifacts, names) ||
    !isDeepStrictEqual(receipt.validation, { uniqueIds: true, bindings: true, protectedValues: true, previews: true })) {
    fail("CORRUPT_RESULT", "The completed receipt has inconsistent identity, hashes or validation metadata");
  }
  const documents = {};
  let attemptDir;
  for (const name of names) {
    const artifact = receipt.artifacts[name];
    if (!exactFields(artifact, ["path", "sha256"]) || typeof artifact.path !== "string" || !hash(artifact.sha256)) fail("CORRUPT_RESULT", `Invalid completed artifact: ${name}`);
    const directory = dirname(artifact.path);
    if (dirname(directory) !== join(jobDir, "attempts") || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(basename(directory)) ||
      artifact.path !== join(directory, name) || (attemptDir && directory !== attemptDir)) fail("CORRUPT_RESULT", "Completed artifacts must belong to one attempt in this result directory");
    if (!attemptDir) {
      for (const directoryPath of [dirname(directory), directory]) {
        try { if (!(await fs.lstat(directoryPath)).isDirectory()) fail("CORRUPT_RESULT", "Attempt directories cannot be symlinks"); }
        catch { fail("CORRUPT_RESULT", "Cannot read the completed attempt directory"); }
      }
    }
    attemptDir = directory;
    const bytes = await readRegular(artifact.path);
    if (sha256(bytes) !== artifact.sha256) fail("CORRUPT_RESULT", `Changed completed artifact: ${name}`);
    if (name.endsWith(".excalidraw")) {
      try { documents[name] = JSON.parse(bytes); validateScene(documents[name]); }
      catch { fail("CORRUPT_RESULT", `Invalid completed native scene: ${name}`); }
    } else if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail("CORRUPT_RESULT", `Invalid completed PNG: ${name}`);
  }
  const beforeScene = documents["before.excalidraw"], afterScene = documents["after.excalidraw"];
  const changes = deriveSceneChanges(beforeScene, afterScene);
  if (receipt.inputHash !== receipt.artifacts["before.excalidraw"].sha256 || receipt.outputHash !== receipt.artifacts["after.excalidraw"].sha256 ||
    !isDeepStrictEqual(receipt.changes, changes)) fail("CORRUPT_RESULT", "The receipt hashes or change summary disagree with the retained native scenes");
  return { receipt, beforeScene, afterScene };
}

export async function editScene({ inputPath, outputDir, ...request }, options = {}) {
  keys(request, ["requestId", "baseHash", "operations"], "request");
  if (typeof request.requestId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(request.requestId)) {
    fail("INVALID_REQUEST", "requestId must contain 1–80 letters, digits, dots, underscores, or hyphens and start with a letter or digit");
  }
  if (typeof request.baseHash !== "string" || !/^[\da-f]{64}$/.test(request.baseHash)) fail("INVALID_REQUEST", "baseHash must be the SHA-256 returned by inspect");
  if (typeof inputPath !== "string" || typeof outputDir !== "string") fail("INVALID_REQUEST", "inputPath and outputDir are required");
  const input = resolve(inputPath);
  const jobDir = join(resolve(outputDir), request.requestId);
  const digest = sha256(canonical({ inputPath: input, ...request }));
  await fs.mkdir(jobDir, { recursive: true });
  const requestPath = join(jobDir, "request.json");
  try { await publishJSON(requestPath, { digest, inputPath: input, ...request }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const recorded = await readJSON(requestPath);
  if (recorded.digest !== digest) fail("REQUEST_CONFLICT", "This requestId is already associated with a different request");
  const receiptPath = join(jobDir, "receipt.json");
  const completed = await readJSON(receiptPath);
  if (completed) return (await verifyReceipt(receiptPath, { expectedDigest: digest })).receipt;
  const attemptDir = await claimAttempt(jobDir);
  try {
    // A prior owner may have completed between our first receipt read and claim.
    const latest = await readJSON(receiptPath);
    if (latest) return (await verifyReceipt(receiptPath, { expectedDigest: digest })).receipt;
    const { bytes, scene, hash } = await readScene(input);
    if (hash !== request.baseHash) fail("STALE_INPUT", "Input changed after inspection; inspect it again before editing");
    const { candidate, changes } = await applyOperations(scene, request.operations, options);
    const after = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    const render = options.renderScene ?? (await import("./render.js")).renderScene;
    await writeDurable(join(attemptDir, "before.excalidraw"), bytes);
    await writeDurable(join(attemptDir, "after.excalidraw"), after);
    for (const [name, document] of [["before.png", scene], ["after.png", candidate]]) {
      await render(freeze(structuredClone(document)), join(attemptDir, name));
      const png = await fs.readFile(join(attemptDir, name));
      if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) fail("INVALID_RENDER", `Renderer did not create a PNG: ${name}`);
      const handle = await fs.open(join(attemptDir, name), "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const artifacts = {};
    for (const name of ["before.excalidraw", "after.excalidraw", "before.png", "after.png"]) {
      const path = join(attemptDir, name);
      artifacts[name] = { path, sha256: sha256(await fs.readFile(path)) };
    }
    if (artifacts["before.excalidraw"].sha256 !== hash || artifacts["after.excalidraw"].sha256 !== sha256(after)) {
      fail("PROTECTED_CHANGE", "A native artifact changed during preview generation");
    }
    const receipt = {
      schemaVersion: 1, status: "complete", requestId: request.requestId, requestDigest: digest,
      inputPath: input, inputHash: hash, outputHash: sha256(after), changes,
      validation: { uniqueIds: true, bindings: true, protectedValues: true, previews: true },
      artifacts, receiptPath,
    };
    await publishJSON(receiptPath, receipt);
    return receipt;
  } finally {
    await publishJSON(join(attemptDir, "finished.json"), { finishedAt: new Date().toISOString() });
  }
}
