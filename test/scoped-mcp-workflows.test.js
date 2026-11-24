import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { acceptEvidenceBaseline, associateEvidence } from "../src/evidence.js";
import { adoptRefresh } from "../src/refresh.js";

const exec = promisify(execFile);
const cli = new URL("../bin/cli.js", import.meta.url).pathname;

function scene(queued = false, { moved = 0, workerFill } = {}) {
  const elements = [];
  for (const [id, x, text] of [["api", 40 + moved, "API"], ...(queued ? [["queue", 370, "Queue"]] : []), ["worker", 700, "Worker"]]) {
    elements.push({ id, type: "rectangle", x, y: 40, width: 180, height: 80, angle: 0, boundElements: [{ id: `${id}-label`, type: "text" }],
      ...(id === "worker" && workerFill ? { backgroundColor: workerFill } : {}) },
    { id: `${id}-label`, type: "text", x: x + 20, y: 60, width: 120, height: 35, fontSize: 28, fontFamily: 5, lineHeight: 1.25,
      text, originalText: text, angle: 0, containerId: id });
  }
  for (const [id, from, to] of queued ? [["enqueue", "api", "queue"], ["consume", "queue", "worker"]] : [["direct", "api", "worker"]]) {
    const a = elements.find(element => element.id === from), b = elements.find(element => element.id === to);
    a.boundElements.push({ id, type: "arrow" }); b.boundElements.push({ id, type: "arrow" });
    elements.push({ id, type: "arrow", x: a.x + a.width, y: 80, width: b.x - a.x - a.width, height: 0, angle: 0,
      points: [[0, 0], [b.x - a.x - a.width, 0]], startBinding: { elementId: from }, endBinding: { elementId: to } });
    // Assumed relations must say so on the diagram before they can be exported.
    if (id === "consume") {
      elements.at(-1).boundElements = [{ id: "consume-label", type: "text" }];
      elements.push({ id: "consume-label", type: "text", x: 520, y: 135, width: 360, height: 35, fontSize: 28, fontFamily: 5, lineHeight: 1.25,
        text: "Assumption: delivery", originalText: "Assumption: delivery", containerId: "consume" });
    }
  }
  return { type: "excalidraw", version: 2, elements, files: {}, appState: { viewBackgroundColor: "#faf9f5" } };
}

function evidence(revision, queued = false) {
  return { schemaVersion: 1, source: { kind: "git", revision },
    scope: { question: "How does the handler reach the worker?", paths: ["src"], coverage: "partial", unknowns: ["Runtime delivery was not observed."] },
    references: [
      { id: "handler", path: "src/api.js", startLine: 2, endLine: 2, symbol: "handle" },
      { id: "worker", path: "src/worker.js", startLine: 1, endLine: 1, symbol: "run" },
      ...(queued ? [{ id: "queue", path: "src/queue.js", startLine: 1, endLine: 1, symbol: "enqueue" }] : []),
    ],
    nodes: [
      { semanticId: "request:api", elementId: "api", referenceIds: ["handler"] },
      { semanticId: "request:worker", elementId: "worker", referenceIds: ["worker"] },
      ...(queued ? [{ semanticId: "request:queue", elementId: "queue", referenceIds: ["queue"] }] : []),
    ],
    relations: queued ? [
      { semanticId: "request:enqueue", elementId: "enqueue", from: "request:api", to: "request:queue", kind: "call", claim: "handle contains enqueue(input).", referenceIds: ["handler"] },
      { semanticId: "request:consume", elementId: "consume", from: "request:queue", to: "request:worker", kind: "assumption", claim: "An external consumer runs queued jobs.", referenceIds: [] },
    ] : [{ semanticId: "request:direct", elementId: "direct", from: "request:api", to: "request:worker", kind: "call", claim: "handle contains run(input).", referenceIds: ["handler"] }],
  };
}

// The configured project is itself the Git repository, as in a normal checkout.
async function setup(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "toolkit-mcp-workflows-")));
  const project = join(directory, "project");
  await fs.mkdir(join(project, "src"), { recursive: true });
  await fs.mkdir(join(project, "diagrams"));
  const git = async (...args) => (await exec("git", ["-C", project, ...args])).stdout.trim();
  const commit = async message => {
    await git("add", "src");
    await git("-c", "user.name=Workflow fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  await git("init", "-b", "main");
  await fs.writeFile(join(project, "src/api.js"), 'import { run } from "./worker.js";\nexport function handle(input) { return run(input); }\n');
  await fs.writeFile(join(project, "src/worker.js"), "export function run(input) { return input; }\n");
  const baseRevision = await commit("test: direct call");
  const write = async (name, value) => { await fs.writeFile(join(project, name), `${JSON.stringify(value, null, 2)}\n`); return join(project, name); };
  const baseScene = await write("diagrams/base.excalidraw", scene(false));
  const base = await associateEvidence({ repositoryPath: project, inputPath: baseScene, evidence: evidence(baseRevision), outputDir: join(project, ".evidence/base") });
  await fs.writeFile(join(project, "src/api.js"), 'import { enqueue } from "./queue.js";\nexport function handle(input) { return enqueue(input); }\n');
  await fs.writeFile(join(project, "src/queue.js"), "export function enqueue(input) { return pending.push(input); }\n");
  const headRevision = await commit("test: add queue");
  const headScene = await write("diagrams/head.excalidraw", scene(true));
  const head = await associateEvidence({ repositoryPath: project, inputPath: headScene, evidence: evidence(headRevision, true), outputDir: join(project, ".evidence/head") });

  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--project", project], stderr: "pipe" });
  const client = new Client({ name: "scoped-mcp-workflows", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  return { directory, project, git, write, call, client, baseRevision, headRevision, base, head };
}

function ok(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.ok, true);
  return result.structuredContent;
}
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.code, code, JSON.stringify(result.structuredContent));
}

test("explain_change renders a source-linked comparison inside the project and returns prose and images", { timeout: 240000 }, async t => {
  const f = await setup(t);
  const listed = await f.client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ["inspect_scene", "edit_scene", "read_preview", "explain_change", "refresh_diagram"]);
  assert.equal(listed.tools.find(tool => tool.name === "explain_change").inputSchema.additionalProperties, false);
  const request = {
    requestId: "queue-change",
    base: { bundlePath: ".evidence/base/evidence.json", revision: f.baseRevision, expectedHash: f.base.sha256 },
    head: { bundlePath: ".evidence/head/evidence.json", revision: f.headRevision, expectedHash: f.head.sha256 },
    required: { base: { nodes: ["request:api", "request:worker"], relations: ["request:direct"] },
      head: { nodes: ["request:api", "request:queue", "request:worker"], relations: ["request:enqueue", "request:consume"] } },
    target: "article", repositoryUrl: "https://github.com/example/request-flow",
  };
  const response = await f.call("explain_change", request);
  const result = ok(response);
  assert.equal(result.projectRoot, f.project);
  assert.equal(result.reportPath, ".excalidraw-toolkit/explain/queue-change/comparison.json");
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.validation.renderedReadability, true);
  assert.equal(result.report.changes.nodes.find(change => change.semanticId === "request:queue").status, "added");
  assert.equal(result.report.changes.relations.find(change => change.semanticId === "request:direct").status, "removed");
  assert.deepEqual(result.images.map(image => [image.name, image.included]), [["before", true], ["after", true]]);
  assert.ok(response.content.some(part => part.type === "text" && part.text.includes("request:queue")));
  assert.equal(response.content.filter(part => part.type === "image").length, 2);
  for (const name of ["before.excalidraw", "after.excalidraw", "before.png", "after.png", "changes.md", "comparison.json"]) {
    assert.ok((await fs.lstat(join(f.project, ".excalidraw-toolkit/explain/queue-change", name))).isFile(), name);
  }
  const png = await fs.readFile(join(f.project, ".excalidraw-toolkit/explain/queue-change/after.png"));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 800]);
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.project, "diagrams/head.excalidraw"))), scene(true));

  error(await f.call("explain_change", request), "OUTPUT_EXISTS");
  error(await f.call("explain_change", { ...request, requestId: "escape", base: { ...request.base, bundlePath: "../outside/evidence.json" } }), "WORKSPACE_PATH");
  error(await f.call("explain_change", { ...request, requestId: "absolute", base: { ...request.base, bundlePath: join(f.project, ".evidence/base/evidence.json") } }), "WORKSPACE_PATH");
  await fs.symlink(join(f.project, ".evidence/base"), join(f.project, "linked-bundle"), "dir");
  error(await f.call("explain_change", { ...request, requestId: "linked", base: { ...request.base, bundlePath: "linked-bundle/evidence.json" } }), "WORKSPACE_PATH");
  error(await f.call("explain_change", { ...request, requestId: "extra", outputDir: "/tmp/elsewhere" }), "INVALID_REQUEST");
  error(await f.call("explain_change", { ...request, requestId: "repo-escape", repositoryPath: ".." }), "WORKSPACE_PATH");
  await assert.rejects(fs.stat(join(f.project, ".excalidraw-toolkit/explain/linked")), { code: "ENOENT" });
});

test("refresh_diagram stages a three-way candidate with previews and leaves adoption to an explicit step", { timeout: 240000 }, async t => {
  const f = await setup(t);
  const baselineScene = join(f.project, "diagrams/base.excalidraw");
  const baseline = await acceptEvidenceBaseline({ repositoryPath: f.project, inputPath: baselineScene, generatedPath: baselineScene,
    evidence: evidence(f.baseRevision), outputDir: join(f.project, ".evidence/baseline") });
  const current = await f.write("diagrams/current.excalidraw", scene(false, { moved: 30 }));
  const currentBytes = await fs.readFile(current);
  await f.write("diagrams/generated.excalidraw", scene(false, { workerFill: "#d0ebff" }));
  const request = { requestId: "refresh-1", currentPath: "diagrams/current.excalidraw", generatedPath: "diagrams/generated.excalidraw",
    evidence: evidence(f.headRevision), baselineBundlePath: ".evidence/baseline/evidence.json", baselineHash: baseline.sha256 };

  const response = await f.call("refresh_diagram", request);
  const result = ok(response);
  assert.equal(result.status, "ready");
  assert.equal(result.reused, false);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.receiptPath, ".excalidraw-toolkit/refresh/refresh-1/refresh.json");
  assert.match(result.receiptHash, /^[a-f0-9]{64}$/);
  const candidate = JSON.parse(await fs.readFile(join(f.project, result.candidatePath)));
  assert.equal(candidate.elements.find(element => element.id === "api").x, 70, "the human move survives");
  assert.equal(candidate.elements.find(element => element.id === "worker").backgroundColor, "#d0ebff", "the generated change lands");
  assert.deepEqual(result.images.map(image => image.name), ["before", "after"]);
  assert.equal(response.content.filter(part => part.type === "image").length, 2);
  assert.deepEqual(await fs.readFile(current), currentBytes, "staging never changes the current diagram");

  const again = ok(await f.call("refresh_diagram", request));
  assert.equal(again.reused, true);
  assert.equal(again.receiptHash, result.receiptHash);

  const adopted = await adoptRefresh({ receiptPath: join(f.project, result.receiptPath), expectedHash: result.receiptHash, outputDir: join(f.project, ".evidence/adopted") });
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.bundle.evidence.source.revision, f.headRevision);

  error(await f.call("refresh_diagram", { ...request, requestId: "refresh-1", currentPath: result.candidatePath }), "WORKSPACE_PATH");
  error(await f.call("refresh_diagram", { ...request, requestId: "orphan-hash", baselineBundlePath: undefined }), "INVALID_REQUEST");
  error(await f.call("refresh_diagram", { ...request, requestId: "escape", generatedPath: "../generated.excalidraw" }), "WORKSPACE_PATH");
  error(await f.call("refresh_diagram", { ...request, requestId: "extra", outputDir: "elsewhere" }), "INVALID_REQUEST");
  await assert.rejects(fs.stat(join(f.project, ".excalidraw-toolkit/refresh/escape")), { code: "ENOENT" });
});
