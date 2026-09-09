import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readEvidenceBundle, validateEvidence } from "./evidence.js";
import { sha256, validateScene } from "./scene.js";

export const OUTPUT_TARGETS = Object.freeze({
  article: Object.freeze({ name: "article", width: 1200, height: 800, padding: 40, minimumFontSize: 18 }),
  slide: Object.freeze({ name: "slide", width: 1920, height: 1080, padding: 64, minimumFontSize: 24 }),
  canvas: Object.freeze({ name: "canvas", width: 1600, height: 1000, padding: 40, minimumFontSize: 16 }),
});
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GEOMETRY = ["x", "y", "width", "height", "angle", "points", "frameId", "groupIds"];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
function fail(code, message, details) { throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) }); }
function targetSize(target) {
  const value = typeof target === "string" ? OUTPUT_TARGETS[target] : target;
  if (!value || typeof value.name !== "string" || !value.name.trim() ||
    ![value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) ||
    !Number.isFinite(value.padding) || value.padding < 0 || value.padding * 2 >= Math.min(value.width, value.height) ||
    !Number.isFinite(value.minimumFontSize) || value.minimumFontSize < 1) {
    fail("INVALID_TARGET", "Choose article, slide, canvas, or explicit dimensions, padding and minimumFontSize (pixels)");
  }
  return { name: value.name, width: value.width, height: value.height, padding: value.padding, minimumFontSize: value.minimumFontSize };
}
function repositoryLink(value) {
  let url;
  try { url = new URL(value); } catch { fail("INVALID_SOURCE_URL", "Provide an HTTPS GitHub-compatible repository URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) {
    fail("INVALID_SOURCE_URL", "Provide an HTTPS GitHub-compatible repository URL without credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "").replace(/\.git$/, "")}`;
}
function projection(value, fields) { return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])); }
function pathSegment(value) { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function label(element, index) {
  return element.type === "text" ? element.originalText ?? element.text : (element.boundElements ?? [])
    .filter(binding => binding.type === "text").map(binding => index.get(binding.id)).map(text => text.originalText ?? text.text).join("\n");
}
function descriptions(side, kind, url) {
  const evidence = side.bundle.evidence;
  const index = validateScene(side.deliveredScene);
  const references = new Map(evidence.references.map(reference => [reference.id, reference]));
  return new Map(evidence[kind].map(item => {
    const sources = item.referenceIds.map(id => {
      const reference = references.get(id);
      if (!reference) fail("INVALID_COMPARISON", `Missing source reference: ${id}`);
      const { path, startLine, endLine, symbol, excerpt, sha256: hash, blob } = reference;
      return { id, revision: evidence.source.revision, path, startLine, endLine, ...(symbol ? { symbol } : {}), excerpt, sha256: hash, blob,
        url: `${url}/blob/${evidence.source.revision}/${path.split("/").map(pathSegment).join("/")}#L${startLine}-L${endLine}` };
    });
    const element = index.get(item.elementId);
    if (!element || element.isDeleted) fail("MISSING_REQUIRED", `Mapped element is absent: ${item.elementId}`);
    const caption = label(element, index);
    if (kind === "relations" && item.kind === "assumption" && !/^assumption(?:\s|:|$)/iu.test(caption.trim())) {
      fail("UNLABELED_ASSUMPTION", `Give ${item.semanticId} a native bound label starting with Assumption before exporting`);
    }
    return [item.semanticId, { ...structuredClone(item), label: caption, sources,
      certainty: kind === "nodes" ? "source-located" : item.kind === "assumption" ? "assumption" : "source-cited",
      semanticClaimsVerified: false, runtimeBehaviorVerified: false }];
  }));
}
function meaning(item, kind) {
  return { ...projection(item, kind === "nodes" ? ["label"] : ["from", "to", "kind", "claim", "label"]),
    // Line movement or a change elsewhere in the file is citation churn, not a
    // change to the selected concept. Excerpts still expose changed evidence.
    sources: item.sources.map(source => projection(source, ["path", "symbol", "excerpt"]))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
function assertStable(base, head, changes) {
  const before = validateScene(base.deliveredScene);
  const after = validateScene(head.deliveredScene);
  const conflicts = [];
  const check = (a, b, semanticId) => {
    if (!isDeepStrictEqual(projection(a, GEOMETRY), projection(b, GEOMETRY))) conflicts.push({ semanticId, baseElementId: a.id, headElementId: b.id });
  };
  for (const change of [...changes.nodes, ...changes.relations].filter(item => item.status === "unchanged")) {
    const a = before.get(change.before.elementId);
    const b = after.get(change.after.elementId);
    check(a, b, change.semanticId);
    const texts = element => (element.boundElements ?? []).filter(binding => binding.type === "text");
    const oldTexts = texts(a), newTexts = texts(b);
    if (oldTexts.length !== newTexts.length) fail("UNSTABLE_CONTEXT", `Changed label mapping for unchanged context: ${change.semanticId}`);
    oldTexts.forEach((binding, i) => check(before.get(binding.id), after.get(newTexts[i].id), change.semanticId));
  }
  const mapped = new Set([...base.bundle.evidence.nodes, ...base.bundle.evidence.relations].map(item => item.elementId));
  for (const [id, element] of before) {
    const next = after.get(id);
    if (mapped.has(id) || element.isDeleted || !next || next.isDeleted) continue;
    const content = value => Object.fromEntries(Object.entries(value).filter(([key]) => ![...GEOMETRY, "version", "versionNonce", "updated"].includes(key)));
    if (isDeepStrictEqual(content(element), content(next))) check(element, next, null);
  }
  if (conflicts.length) fail("UNSTABLE_CONTEXT", "Unchanged context moved between scenes; align it explicitly before comparison", conflicts);
}

// Pure planning over checked, retained snapshots. Use loadComparison at the I/O
// boundary to recheck both snapshots against their requested Git revisions.
export function planComparison({ base, head, target = "article", required, repositoryUrl }) {
  const url = repositoryLink(repositoryUrl);
  for (const [name, side] of Object.entries({ base, head })) {
    const evidence = side?.bundle?.evidence;
    if (evidence?.source?.kind !== "git" || !COMMIT.test(evidence.source.revision) || evidence.scope?.coverage !== "partial" ||
      evidence.validation?.sourceLocations !== true || evidence.validation?.sceneMappings !== true ||
      evidence.validation?.semanticClaims !== false || evidence.validation?.runtimeBehavior !== false) {
      fail("INVALID_COMPARISON", `${name} requires checked evidence at an exact Git commit; working-tree evidence cannot stand in for a PR revision`);
    }
  }
  if (base.bundle.evidence.repositoryPath !== head.bundle.evidence.repositoryPath) fail("INVALID_COMPARISON", "Compare revisions of one repository");
  const changes = {};
  for (const kind of ["nodes", "relations"]) {
    const before = descriptions(base, kind, url), after = descriptions(head, kind, url);
    for (const [name, entries] of [["base", before], ["head", after]]) {
      const ids = required?.[name]?.[kind];
      if (!Array.isArray(ids) || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length || (kind === "nodes" && !ids.length)) {
        fail("INVALID_REQUIRED", "Declare required base/head nodes and relations as explicit semantic ID arrays");
      }
      const missing = ids.filter(id => !entries.has(id));
      if (missing.length) fail("MISSING_REQUIRED", `Missing required ${name} ${kind}`, missing);
    }
    changes[kind] = [...new Set([...before.keys(), ...after.keys()])].sort().map(semanticId => {
      const a = before.get(semanticId), b = after.get(semanticId);
      return { semanticId, status: !a ? "added" : !b ? "removed" : isDeepStrictEqual(meaning(a, kind), meaning(b, kind)) ? "unchanged" : "changed",
        before: a ?? null, after: b ?? null };
    });
  }
  assertStable(base, head, changes);
  return { schemaVersion: 1, target: targetSize(target), required: structuredClone(required), repositoryUrl: url,
    base: { revision: base.bundle.evidence.source.revision, scope: structuredClone(base.bundle.evidence.scope), scene: structuredClone(base.deliveredScene) },
    head: { revision: head.bundle.evidence.source.revision, scope: structuredClone(head.bundle.evidence.scope), scene: structuredClone(head.deliveredScene) },
    changes, validation: { sourceLocations: true, sceneMappings: true, requiredMappings: true, unchangedContext: true,
      semanticClaims: false, runtimeBehavior: false, completeCoverage: false, renderedReadability: false } };
}

export async function loadComparison({ repositoryPath, base, head, ...options }) {
  const load = async side => {
    if (typeof side?.bundlePath !== "string" || typeof side.revision !== "string" || !side.revision.trim()) fail("INVALID_COMPARISON", "Each side requires bundlePath and the requested Git revision");
    const snapshot = await readEvidenceBundle(side.bundlePath, { expectedHash: side.expectedHash });
    const retained = snapshot.bundle.evidence;
    if (retained.source.kind !== "git") fail("INVALID_COMPARISON", "PR comparisons require committed source evidence");
    const proposal = projection(retained, ["schemaVersion", "scope", "nodes", "relations"]);
    proposal.source = { kind: "git", revision: side.revision };
    proposal.references = retained.references.map(reference => projection(reference, ["id", "path", "startLine", "endLine", "symbol", "sha256"]));
    const inputPath = join(dirname(resolve(side.bundlePath)), "delivered.excalidraw");
    const checked = await validateEvidence({ repositoryPath, inputPath, evidence: proposal });
    if (checked.source.revision !== retained.source.revision) fail("REVISION_MISMATCH", "A bundle must describe the exact requested revision, even when its referenced files are unchanged");
    if (checked.sceneHash !== retained.sceneHash || !isDeepStrictEqual(checked.references, retained.references)) fail("CORRUPT_EVIDENCE", "Retained evidence differs from the native scene or committed source");
    return { ...snapshot, inputPath, bundle: { ...snapshot.bundle, evidence: checked } };
  };
  const [before, after] = await Promise.all([load(base), load(head)]);
  const plan = planComparison({ ...options, base: before, head: after });
  return { ...plan, inputs: {
    base: { bundlePath: resolve(base.bundlePath), inputPath: before.inputPath, sha256: before.bundle.evidence.sceneHash },
    head: { bundlePath: resolve(head.bundlePath), inputPath: after.inputPath, sha256: after.bundle.evidence.sceneHash },
  } };
}

export function checkReadability(plan, measurements) {
  const target = targetSize(plan.target);
  const boxes = [], labels = [];
  for (const side of ["base", "head"]) {
    const metrics = measurements[side];
    if (!metrics || !/^@excalidraw\/excalidraw@/.test(metrics.renderer ?? "") || metrics.fontsLoaded !== true || !Array.isArray(metrics.text) || !Array.isArray(metrics.visibleElementIds)) {
      fail("INVALID_RENDER_METRICS", "Measure native restored scenes with loaded fonts before export");
    }
    const box = value => value && [value.x, value.y, value.width, value.height].every(Number.isFinite) && value.width >= 0 && value.height >= 0;
    if (!box(metrics.bounds) || metrics.bounds.width <= 0 || metrics.bounds.height <= 0) fail("INVALID_RENDER_METRICS", "Native scene bounds must be finite and nonempty");
    boxes.push(metrics.bounds);
    const visible = new Set(metrics.visibleElementIds);
    const required = [...plan.required[side].nodes, ...plan.required[side].relations];
    const entries = [...plan.changes.nodes, ...plan.changes.relations].map(change => change[side === "base" ? "before" : "after"]).filter(Boolean);
    const missing = entries.filter(item => required.includes(item.semanticId) && !visible.has(item.elementId)).map(item => item.semanticId);
    if (missing.length) fail("MISSING_REQUIRED", `Required ${side} content is not visible in the native render`, missing);
    const text = new Map();
    const index = validateScene(plan[side].scene);
    for (const metric of metrics.text) {
      if (!metric || text.has(metric.id) || index.get(metric.id)?.type !== "text" || !visible.has(metric.id) || !box(metric) ||
        !Number.isFinite(metric.fontSize) || metric.fontSize <= 0 || metric.height <= 0) fail("INVALID_RENDER_METRICS", "Invalid or duplicate native text metrics");
      text.set(metric.id, metric);
      boxes.push(metric);
      labels.push({ side, ...metric });
    }
    for (const element of plan[side].scene.elements) {
      if (!element.isDeleted && element.type === "text" && (element.text ?? "").trim() && element.opacity !== 0) {
        if (!text.has(element.id)) fail("INVALID_RENDER_METRICS", `Native measurement omitted text: ${side}/${element.id}`);
      }
    }
    for (const item of entries.filter(item => required.includes(item.semanticId))) {
      const element = index.get(item.elementId);
      const hiddenLabels = (element.boundElements ?? []).filter(binding => binding.type === "text" && !visible.has(binding.id));
      if (hiddenLabels.length) fail("MISSING_REQUIRED", `Required ${side} content has a hidden label: ${item.semanticId}`);
    }
  }
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  const width = Math.max(...boxes.map(box => box.x + box.width)) - x;
  const height = Math.max(...boxes.map(box => box.y + box.height)) - y;
  const { padding, minimumFontSize } = target;
  const scale = Math.min(1, (target.width - 2 * padding) / width, (target.height - 2 * padding) / height);
  const failures = labels.filter(label => label.fontSize * scale + 0.001 < minimumFontSize)
    .map(label => ({ side: label.side, elementId: label.id, fontSize: label.fontSize, effectiveFontSize: label.fontSize * scale, minimumFontSize }));
  if (failures.length) fail("INSUFFICIENT_READABILITY", "Labels are too small at the requested output size; enlarge the target, recompose the view, or explicitly increase label sizes", failures);
  return { ...target, scale, offsetX: (target.width - width * scale) / 2 - x * scale, offsetY: (target.height - height * scale) / 2 - y * scale,
    bounds: { x, y, width, height }, minimumEffectiveFontSize: labels.length ? Math.min(...labels.map(label => label.fontSize * scale)) : null,
    labels: labels.map(label => ({ ...label, effectiveFontSize: label.fontSize * scale })),
    renderers: { base: measurements.base.renderer, head: measurements.head.renderer } };
}

function markdown(report) {
  const escape = value => String(value).replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char])).replace(/[\\`*_[\]]/g, "\\$&").replaceAll("\n", " ");
  const lines = ["# Source-linked change comparison", "", `Base: ${report.base.revision}`, `Head: ${report.head.revision}`, "",
    `Target: ${report.target.name}, ${report.target.width} × ${report.target.height} px; minimum label size ${report.target.minimumFontSize} px.`, "",
    "Changes describe these scoped diagrams and selected source excerpts. A removed mapping does not prove source deletion. Source-cited claims are not semantically or runtime verified; assumptions remain assumptions.", ""];
  for (const kind of ["nodes", "relations"]) {
    lines.push(`## ${kind === "nodes" ? "Nodes" : "Relationships"}`, "");
    for (const change of report.changes[kind]) {
      lines.push(`- **${change.status}** ${escape(change.semanticId)}`);
      for (const [side, item] of [["base", change.before], ["head", change.after]]) {
        if (!item) continue;
        const sources = item.sources.map(source => `[${escape(`${source.path}:${source.startLine}-${source.endLine}`)}](${source.url})`).join(", ");
        lines.push(`  - ${side}: ${escape(item.claim ?? item.label)} — ${item.certainty}${sources ? `; ${sources}` : "; no source citation"}.`);
      }
    }
    lines.push("");
  }
  for (const side of ["base", "head"]) {
    lines.push(`## ${side === "base" ? "Base" : "Head"} scope`, "", escape(report[side].scope.question), "");
    for (const unknown of report[side].scope.unknowns) lines.push(`- ${escape(unknown)}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
async function writeExclusive(path, bytes) {
  const handle = await fs.open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function exportComparison({ outputDir, ...request }, options = {}) {
  if (typeof outputDir !== "string" || !outputDir.trim()) fail("INVALID_OUTPUT", "Provide a new output directory");
  const plan = await loadComparison(request);
  const renderer = options.measureScene && options.renderScene ? options : { ...(await import("./target-render.js")), ...options };
  if (typeof renderer.measureScene !== "function" || typeof renderer.renderScene !== "function") fail("RENDERER_UNAVAILABLE", "A native measureScene and renderScene adapter is required");
  const measured = await Promise.all(["base", "head"].map(side => renderer.measureScene(structuredClone(plan[side].scene))));
  const viewport = checkReadability(plan, { base: measured[0], head: measured[1] });
  const native = {};
  for (const side of ["base", "head"]) {
    native[side] = await fs.readFile(plan.inputs[side].inputPath);
    if (sha256(native[side]) !== plan.inputs[side].sha256) fail("STALE_INPUT", `The ${side} native scene changed during planning`);
  }
  // No output directory or artifact exists before both readability checks pass.
  const directory = resolve(outputDir);
  await fs.mkdir(dirname(directory), { recursive: true });
  try { await fs.mkdir(directory); } catch (error) { if (error.code === "EEXIST") fail("OUTPUT_EXISTS", "Comparison outputs are immutable; choose a new directory"); throw error; }
  const artifacts = {};
  for (const [side, name] of [["base", "before"], ["head", "after"]]) {
    const nativeName = `${name}.excalidraw`, pngName = `${name}.png`;
    await writeExclusive(join(directory, nativeName), native[side]);
    await renderer.renderScene(structuredClone(plan[side].scene), join(directory, pngName), projection(viewport, ["width", "height", "padding", "scale", "offsetX", "offsetY"]));
    const png = await fs.readFile(join(directory, pngName));
    if (png.length < 33 || !png.subarray(0, 8).equals(PNG) || png.subarray(12, 16).toString() !== "IHDR" ||
      png.readUInt32BE(16) !== viewport.width || png.readUInt32BE(20) !== viewport.height) fail("INVALID_RENDER", "Renderer must produce a PNG at the exact requested target dimensions");
    if (!(await fs.readFile(join(directory, nativeName))).equals(native[side])) fail("PROTECTED_CHANGE", "The renderer changed a retained native artifact");
    const imageHandle = await fs.open(join(directory, pngName), "r");
    try { await imageHandle.sync(); } finally { await imageHandle.close(); }
    for (const [file, bytes] of [[nativeName, native[side]], [pngName, png]]) artifacts[file] = { file, sha256: sha256(bytes) };
  }
  const report = { ...plan, base: projection(plan.base, ["revision", "scope"]), head: projection(plan.head, ["revision", "scope"]),
    status: "complete", viewport, artifacts, validation: { ...plan.validation, renderedReadability: true, targetDimensions: true, semanticClaims: false, runtimeBehavior: false } };
  const prose = Buffer.from(markdown(report));
  await writeExclusive(join(directory, "changes.md"), prose);
  artifacts["changes.md"] = { file: "changes.md", sha256: sha256(prose) };
  const pending = join(directory, "comparison.pending.json"), reportPath = join(directory, "comparison.json");
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeExclusive(pending, bytes);
  await fs.link(pending, reportPath);
  await fs.unlink(pending);
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  return { reportPath, sha256: sha256(bytes), report };
}
