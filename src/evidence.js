import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256, validateScene } from "./scene.js";

const exec = promisify(execFile);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, names, context) {
  if (!object(value) || Object.keys(value).some(name => !names.includes(name))) fail("INVALID_EVIDENCE", `Invalid fields in ${context}`);
}
function text(value, context) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail("INVALID_EVIDENCE", `${context} must be nonempty text`);
}
function identifier(value, context) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_EVIDENCE", `Invalid ${context}`);
}
function sourcePath(path, allowRoot = false) {
  if (allowRoot && path === ".") return path;
  if (typeof path !== "string" || !path || path === "." || path.startsWith("/") || /^[A-Za-z]:/.test(path) ||
    /[\\\u0000\r\n]/u.test(path) || posix.normalize(path) !== path || path.split("/").some(part => !part || part === ".." || part === ".git")) {
    fail("SOURCE_BOUNDARY", "Source paths must be normalized repository-relative paths outside .git");
  }
  return path;
}

async function git(repository, args) {
  try {
    const { stdout } = await exec("git", ["--no-pager", "--literal-pathspecs", "-C", repository, ...args], {
      encoding: "buffer", maxBuffer: MAX_SOURCE_BYTES, timeout: 10000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
        GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return stdout;
  } catch { fail("SOURCE_GIT", `Cannot read the requested Git source (${args[0]})`); }
}

async function sourceContext(repositoryPath, source) {
  fields(source, ["kind", "revision"], "source");
  const repository = await fs.realpath(resolve(repositoryPath));
  const top = (await git(repository, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  if (await fs.realpath(top) !== repository) fail("SOURCE_BOUNDARY", "repositoryPath must name the Git repository root");
  if (source.kind === "git") {
    text(source.revision, "source revision");
    const revision = (await git(repository, ["rev-parse", "--verify", "--end-of-options", `${source.revision}^{commit}`])).toString("utf8").trim();
    return { repository, source: { kind: "git", revision } };
  }
  if (source.kind !== "working-tree" || source.revision !== undefined) fail("INVALID_EVIDENCE", "Use a git revision or working-tree source");
  let baseRevision = null;
  try { baseRevision = (await git(repository, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim(); }
  catch (error) { if (error.code !== "SOURCE_GIT") throw error; }
  return { repository, source: { kind: "working-tree", baseRevision } };
}

async function readSource(context, path) {
  let bytes;
  let blob = null;
  if (context.source.kind === "git") {
    const entry = (await git(context.repository, ["ls-tree", "-rz", context.source.revision, "--", path])).toString("utf8").split("\0").filter(Boolean);
    const match = entry.length === 1 && /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/u.exec(entry[0]);
    if (!match || match[3] !== path) fail("SOURCE_BOUNDARY", `Expected a regular committed file at ${path}; symlinks and submodules are unsupported`);
    blob = match[2];
    bytes = await git(context.repository, ["cat-file", "blob", blob]);
  } else {
    let current = context.repository;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch { fail("SOURCE_MISSING", `Cannot read working-tree source: ${path}`); }
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        fail("SOURCE_BOUNDARY", `Working-tree source must not follow symlinks: ${path}`);
      }
      if (i < parts.length - 1) {
        try { await fs.lstat(join(current, ".git")); fail("SOURCE_BOUNDARY", `Nested repositories require a separate association: ${path}`); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      } else if (stat.size > MAX_SOURCE_BYTES) fail("SOURCE_SIZE", `Source file exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
  }
  if (bytes.length > MAX_SOURCE_BYTES) fail("SOURCE_SIZE", `Source file exceeds ${MAX_SOURCE_BYTES} bytes`);
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("SOURCE_ENCODING", `Source must be UTF-8 text: ${path}`); }
  if (content.includes("\0")) fail("SOURCE_ENCODING", `Binary source is unsupported: ${path}`);
  const lines = content.split(/\r?\n/u);
  if (content.endsWith("\n")) lines.pop();
  return { sha256: sha256(bytes), blob, lines };
}

async function readNative(path) {
  const bytes = await fs.readFile(path);
  let scene;
  try { scene = JSON.parse(bytes.toString("utf8")); }
  catch { fail("INVALID_SCENE", "Expected a native Excalidraw JSON file"); }
  const index = validateScene(scene);
  return { bytes, scene, index };
}

function validateMapping(evidence, index) {
  const identities = new Set();
  const elements = new Set();
  const references = new Set(evidence.references.map(reference => reference.id));
  const nodes = new Map();
  const identify = item => {
    identifier(item.semanticId, "semanticId");
    if (identities.has(item.semanticId) || elements.has(item.elementId)) fail("AMBIGUOUS_IDENTITY", "Semantic IDs and mapped element IDs must be unique");
    const element = index.get(item.elementId);
    if (!element || element.isDeleted) fail("UNKNOWN_TARGET", `No live element: ${item.elementId}`);
    identities.add(item.semanticId);
    elements.add(item.elementId);
    return element;
  };
  const checkReferences = (item, allowEmpty = false) => {
    if (!Array.isArray(item.referenceIds) || (!allowEmpty && !item.referenceIds.length) || new Set(item.referenceIds).size !== item.referenceIds.length ||
      item.referenceIds.some(id => !references.has(id))) fail("INVALID_REFERENCE", `Invalid source references for ${item.semanticId}`);
  };
  for (const node of evidence.nodes) {
    fields(node, ["semanticId", "elementId", "referenceIds"], "node");
    const element = identify(node);
    if (["arrow", "line"].includes(element.type)) fail("INVALID_MAPPING", "Map connections as relations, not nodes");
    checkReferences(node);
    nodes.set(node.semanticId, node);
  }
  for (const relation of evidence.relations) {
    fields(relation, ["semanticId", "elementId", "from", "to", "kind", "claim", "referenceIds"], "relation");
    const arrow = identify(relation);
    if (!["import", "call", "assumption"].includes(relation.kind)) fail("INVALID_RELATION", "Relation kind must be import, call, or assumption");
    text(relation.claim, "relation claim");
    checkReferences(relation, relation.kind === "assumption");
    const from = nodes.get(relation.from);
    const to = nodes.get(relation.to);
    if (!from || !to || arrow.type !== "arrow" || arrow.startBinding?.elementId !== from.elementId || arrow.endBinding?.elementId !== to.elementId) {
      fail("INVALID_MAPPING", `Relation ${relation.semanticId} must match the arrow's native start/end bindings`);
    }
  }
}

export async function validateEvidence({ repositoryPath, inputPath, evidence }) {
  text(repositoryPath, "repositoryPath");
  text(inputPath, "inputPath");
  fields(evidence, ["schemaVersion", "source", "scope", "references", "nodes", "relations"], "evidence");
  if (evidence.schemaVersion !== 1) fail("INVALID_EVIDENCE", "Expected evidence schemaVersion 1");
  fields(evidence.scope, ["question", "paths", "coverage", "unknowns"], "analysis scope");
  text(evidence.scope.question, "analysis question");
  if (evidence.scope.coverage !== "partial" || !Array.isArray(evidence.scope.paths) || !evidence.scope.paths.length || !Array.isArray(evidence.scope.unknowns)) {
    fail("INVALID_SCOPE", "Declare scoped paths, partial coverage, and an unknowns array; complete analysis is not established by this module");
  }
  evidence.scope.paths.forEach(path => sourcePath(path, true));
  evidence.scope.unknowns.forEach(value => text(value, "unknown"));
  if (![evidence.references, evidence.nodes, evidence.relations].every(Array.isArray) || !evidence.nodes.length) fail("INVALID_EVIDENCE", "Provide references, at least one mapped node, and relations arrays");
  const native = await readNative(inputPath);
  const context = await sourceContext(repositoryPath, evidence.source);
  const ids = new Set();
  const sources = new Map();
  const references = [];
  for (const reference of evidence.references) {
    fields(reference, ["id", "path", "startLine", "endLine", "symbol", "sha256"], "source reference");
    identifier(reference.id, "reference ID");
    if (ids.has(reference.id)) fail("AMBIGUOUS_IDENTITY", `Duplicate reference ID: ${reference.id}`);
    ids.add(reference.id);
    sourcePath(reference.path);
    if (!evidence.scope.paths.some(path => path === "." || reference.path === path || reference.path.startsWith(`${path}/`))) fail("SOURCE_BOUNDARY", `Reference outside the declared scope: ${reference.path}`);
    if (context.source.kind === "working-tree" && !HASH.test(reference.sha256 ?? "")) fail("INVALID_REFERENCE", "Working-tree references require the inspected file SHA-256");
    if (reference.sha256 !== undefined && !HASH.test(reference.sha256)) fail("INVALID_REFERENCE", "Invalid source SHA-256");
    if (!sources.has(reference.path)) sources.set(reference.path, await readSource(context, reference.path));
    const source = sources.get(reference.path);
    if (reference.sha256 !== undefined && reference.sha256 !== source.sha256) fail("STALE_SOURCE", `Source changed after inspection: ${reference.path}`);
    if (!Number.isSafeInteger(reference.startLine) || !Number.isSafeInteger(reference.endLine) || reference.startLine < 1 || reference.endLine < reference.startLine || reference.endLine > source.lines.length) {
      fail("INVALID_REFERENCE", `Invalid line range in ${reference.path}`);
    }
    const excerpt = source.lines.slice(reference.startLine - 1, reference.endLine).join("\n");
    if (reference.symbol !== undefined) {
      text(reference.symbol, "symbol");
      if (/[\r\n]/u.test(reference.symbol)) fail("INVALID_REFERENCE", "A symbol must fit on one line");
      const escaped = reference.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u").test(excerpt)) fail("INVALID_REFERENCE", `Symbol is absent from the selected lines: ${reference.symbol}`);
    }
    references.push({ ...reference, sha256: source.sha256, blob: source.blob, excerpt });
  }
  validateMapping(evidence, native.index);
  return {
    ...structuredClone(evidence), source: context.source, repositoryPath: context.repository, references,
    sceneHash: sha256(native.bytes),
    validation: { sourceLocations: true, sceneMappings: true, semanticClaims: false, runtimeBehavior: false },
  };
}

async function writeExclusive(path, bytes) {
  const handle = await fs.open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function saveBundle({ repositoryPath, inputPath, outputDir, evidence, generatedPath }, kind) {
  text(outputDir, "outputDir");
  const checked = await validateEvidence({ repositoryPath, inputPath, evidence });
  const delivered = await readNative(inputPath);
  if (sha256(delivered.bytes) !== checked.sceneHash) fail("STALE_INPUT", "The delivered scene changed during evidence validation");
  let generated = null;
  if (kind === "accepted-generated") {
    if (typeof generatedPath !== "string" || !generatedPath.trim()) fail("INVALID_BASELINE", "An accepted generated baseline requires generatedPath");
    generated = await readNative(generatedPath);
    validateMapping(evidence, generated.index);
  }
  const directory = resolve(outputDir);
  await fs.mkdir(dirname(directory), { recursive: true });
  try { await fs.mkdir(directory); }
  catch (error) { if (error.code === "EEXIST") fail("OUTPUT_EXISTS", "Use a new evidence bundle directory; existing baselines are immutable"); throw error; }
  const artifact = (name, bytes) => ({ file: name, sha256: sha256(bytes) });
  const baseline = { kind, priorBaseline: null, delivered: artifact("delivered.excalidraw", delivered.bytes), generated: null };
  await writeExclusive(join(directory, baseline.delivered.file), delivered.bytes);
  if (generated) {
    baseline.generated = artifact("generated.excalidraw", generated.bytes);
    await writeExclusive(join(directory, baseline.generated.file), generated.bytes);
  }
  const bundle = { schemaVersion: 1, status: "complete", evidence: checked, baseline };
  const bytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const bundlePath = join(directory, "evidence.json");
  // Completion is published last; a failed attempt cannot masquerade as an
  // accepted baseline. Native inputs are copied verbatim, never rewritten.
  const temporary = join(directory, "evidence.pending.json");
  await writeExclusive(temporary, bytes);
  await fs.link(temporary, bundlePath);
  await fs.unlink(temporary);
  const directoryHandle = await fs.open(directory, "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  return { bundlePath, sha256: sha256(bytes), bundle };
}

export function associateEvidence(options) {
  if (options.generatedPath !== undefined) fail("INVALID_BASELINE", "Association cannot invent a generated historical baseline");
  return saveBundle(options, "association");
}

export function acceptEvidenceBaseline(options) {
  return saveBundle(options, "accepted-generated");
}

export async function readEvidenceBundle(bundlePath, { expectedHash } = {}) {
  const bytes = await fs.readFile(bundlePath);
  if (expectedHash !== undefined && (!HASH.test(expectedHash) || sha256(bytes) !== expectedHash)) fail("CORRUPT_EVIDENCE", "Evidence manifest hash differs from the retained receipt");
  let bundle;
  try { bundle = JSON.parse(bytes.toString("utf8")); }
  catch { fail("CORRUPT_EVIDENCE", "Invalid evidence manifest JSON"); }
  if (!object(bundle) || bundle.schemaVersion !== 1 || bundle.status !== "complete" || !["association", "accepted-generated"].includes(bundle.baseline?.kind) ||
    bundle.baseline.priorBaseline !== null || bundle.evidence?.schemaVersion !== 1 ||
    ![bundle.evidence.references, bundle.evidence.nodes, bundle.evidence.relations].every(Array.isArray) ||
    !bundle.evidence.nodes.length || bundle.evidence.scope?.coverage !== "partial" ||
    bundle.evidence.validation?.sourceLocations !== true || bundle.evidence.validation?.sceneMappings !== true ||
    bundle.evidence?.validation?.semanticClaims !== false || bundle.evidence?.validation?.runtimeBehavior !== false) fail("CORRUPT_EVIDENCE", "Invalid evidence baseline manifest");
  const referenceIds = new Set();
  for (const reference of bundle.evidence.references) {
    if (!object(reference) || !ID.test(reference.id ?? "") || referenceIds.has(reference.id) ||
      !HASH.test(reference.sha256 ?? "") || typeof reference.excerpt !== "string") fail("CORRUPT_EVIDENCE", "Invalid retained source reference");
    referenceIds.add(reference.id);
  }
  if (bundle.evidence.sceneHash !== bundle.baseline.delivered?.sha256) fail("CORRUPT_EVIDENCE", "Evidence does not identify the delivered scene");
  const readArtifact = async (entry, expectedName) => {
    if (!object(entry) || entry.file !== expectedName || !HASH.test(entry.sha256 ?? "")) fail("CORRUPT_EVIDENCE", "Invalid baseline artifact reference");
    const path = join(dirname(resolve(bundlePath)), expectedName);
    if (!(await fs.lstat(path)).isFile()) fail("CORRUPT_EVIDENCE", "Baseline artifacts must be regular files");
    const native = await readNative(path);
    if (sha256(native.bytes) !== entry.sha256) fail("CORRUPT_EVIDENCE", `Changed baseline artifact: ${expectedName}`);
    validateMapping(bundle.evidence, native.index);
    return native.scene;
  };
  const deliveredScene = await readArtifact(bundle.baseline.delivered, "delivered.excalidraw");
  let generatedScene = null;
  if (bundle.baseline.kind === "accepted-generated") generatedScene = await readArtifact(bundle.baseline.generated, "generated.excalidraw");
  else if (bundle.baseline.generated !== null) fail("CORRUPT_EVIDENCE", "An association must not claim a generated historical baseline");
  return { bundle, deliveredScene, generatedScene };
}
