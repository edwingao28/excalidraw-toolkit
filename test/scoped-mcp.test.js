import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderScene } from "../src/render.js";
import { sha256 } from "../src/scene.js";

const cli = new URL("../bin/cli.js", import.meta.url).pathname;
const fixture = new URL("./fixtures/annotated.excalidraw", import.meta.url);
const outputs = ".excalidraw-toolkit/edits";

async function setup(t, { missingPreview = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "toolkit-scoped-mcp-")));
  const project = join(directory, "project");
  await fs.mkdir(project);
  const original = await fs.readFile(fixture);
  await fs.writeFile(join(project, "input.excalidraw"), original);
  let serverCli = cli;
  const installed = join(directory, "installed-toolkit");
  if (missingPreview) {
    for (const folder of ["src", "bin", "dist"]) await fs.mkdir(join(installed, folder), { recursive: true });
    await fs.cp(new URL("../src/", import.meta.url), join(installed, "src"), { recursive: true });
    for (const file of ["package.json", "bin/cli.js"]) {
      await fs.copyFile(new URL(`../${file}`, import.meta.url), join(installed, file));
    }
    await fs.symlink(await fs.realpath(new URL("../node_modules", import.meta.url)), join(installed, "node_modules"), "dir");
    serverCli = join(installed, "bin/cli.js");
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverCli, "mcp", "--project", project], stderr: "pipe" });
  let stderr = "";
  transport.stderr.on("data", bytes => { stderr += bytes; });
  const client = new Client({ name: "scoped-mcp-acceptance", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => { await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  const request = { inputPath: "input.excalidraw", requestId: "native-edit", baseHash: sha256(original), operations: [
    { op: "setStyle", targetId: "service", style: { backgroundColor: "#a5d8ff" } },
    { op: "setLabel", targetId: "service", text: "API gateway" },
  ] };
  return { directory, project, original, client, call, request, installed, stderr: () => stderr };
}

function ok(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.ok, true);
  return result.structuredContent;
}
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.ok, false);
  if (code) assert.equal(result.structuredContent.code, code);
}

test("stdio discovers scoped tools and edits with native previews, preservation and completed retries", { timeout: 120000 }, async t => {
  const { project, original, client, call, request, stderr } = await setup(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ["inspect_scene", "edit_scene", "read_preview"]);
  assert.equal(listed.tools[1].inputSchema.additionalProperties, false);
  const inspected = ok(await call("inspect_scene", { inputPath: "input.excalidraw" }));
  assert.equal(inspected.projectRoot, project);
  assert.equal(inspected.inputPath, "input.excalidraw");
  assert.equal(inspected.baseHash, sha256(original));
  assert.ok(["setStyle", "setLabel"].every(op => inspected.capabilities.operations.includes(op)));
  assert.equal(inspected.elements.find(element => element.id === "service").label, "API service");
  const response = await call("edit_scene", request);
  const result = ok(response), receipt = result.receipt;
  assert.equal(receipt.receiptPath, join(project, outputs, request.requestId, "receipt.json"));
  assert.deepEqual(await fs.readFile(join(project, "input.excalidraw")), original);
  assert.deepEqual(await fs.readFile(receipt.artifacts["before.excalidraw"].path), original);
  const before = JSON.parse(original), after = JSON.parse(await fs.readFile(receipt.artifacts["after.excalidraw"].path));
  const protectedCopy = structuredClone(after);
  const beforeLabel = before.elements.find(element => element.id === "service-label");
  const afterLabel = after.elements.find(element => element.id === "service-label");
  assert.equal(afterLabel.originalText, "API gateway");
  assert.equal(afterLabel.containerId, "service");
  assert.equal(after.elements.find(element => element.id === "service").backgroundColor, "#a5d8ff");
  for (const field of ["text", "originalText", "width", "height", "x", "y"]) protectedCopy.elements.find(element => element.id === "service-label")[field] = beforeLabel[field];
  protectedCopy.elements.find(element => element.id === "service").backgroundColor = before.elements.find(element => element.id === "service").backgroundColor;
  assert.deepEqual(protectedCopy, before);
  const images = response.content.filter(block => block.type === "image");
  assert.equal(images.length, 2);
  for (const [i, name] of ["before.png", "after.png"].entries()) {
    const bytes = Buffer.from(images[i].data, "base64");
    assert.equal(images[i].mimeType, "image/png");
    assert.equal(sha256(bytes), receipt.artifacts[name].sha256);
    assert.ok(bytes.readUInt32BE(16) > 600);
    assert.ok(bytes.readUInt32BE(20) > 250);
    assert.equal(result.images[i].included, true);
  }
  const nativeControl = join(project, "native-control.png");
  await renderScene(after, nativeControl);
  assert.equal(sha256(await fs.readFile(nativeControl)), receipt.artifacts["after.png"].sha256);
  assert.deepEqual(ok(await call("read_preview", { requestId: request.requestId })), result);
  assert.deepEqual(ok(await call("edit_scene", request)), result);
  assert.equal((await fs.readdir(join(project, outputs, request.requestId, "attempts"))).length, 1);
  error(await call("edit_scene", { ...request, operations: [{ op: "setLabel", targetId: "service", text: "Other" }] }), "REQUEST_CONFLICT");
  const priorFiles = [receipt.receiptPath, ...Object.values(receipt.artifacts).map(artifact => artifact.path)];
  const priorBytes = await Promise.all(priorFiles.map(path => fs.readFile(path)));
  const nextRequest = {
    inputPath: relative(project, receipt.artifacts["after.excalidraw"].path), requestId: "native-follow-up", baseHash: receipt.outputHash,
    operations: [{ op: "setStyle", targetId: "service", style: { strokeColor: "#123456" } }],
  };
  const next = ok(await call("edit_scene", nextRequest));
  assert.equal(next.receipt.inputHash, receipt.outputHash);
  assert.equal(JSON.parse(await fs.readFile(next.receipt.artifacts["after.excalidraw"].path)).elements.find(element => element.id === "service").strokeColor, "#123456");
  for (const [i, path] of priorFiles.entries()) assert.deepEqual(await fs.readFile(path), priorBytes[i]);
  error(await call("edit_scene", { ...nextRequest, requestId: request.requestId }), "WORKSPACE_PATH");
  const changed = Buffer.from(await fs.readFile(receipt.artifacts["after.png"].path));
  changed[changed.length - 1] ^= 1;
  await fs.writeFile(receipt.artifacts["after.png"].path, changed);
  error(await call("read_preview", { requestId: request.requestId }), "CORRUPT_RESULT");
  error(await call("edit_scene", request), "CORRUPT_RESULT");
  // Updating a digest cannot turn an undecodable PNG into a usable preview.
  const broken = Buffer.from(images[1].data, "base64").subarray(0, 100);
  await fs.writeFile(receipt.artifacts["after.png"].path, broken);
  receipt.artifacts["after.png"].sha256 = sha256(broken);
  await fs.writeFile(receipt.receiptPath, JSON.stringify(receipt));
  error(await call("read_preview", { requestId: request.requestId }), "CORRUPT_RESULT");
  // A retained PNG can be too large for inline MCP transport. Its native image
  // remains valid with trailing bytes, and its new artifact hash is explicit.
  const oversized = Buffer.concat([Buffer.from(images[1].data, "base64"), Buffer.alloc(2 * 1024 * 1024)]);
  await fs.writeFile(receipt.artifacts["after.png"].path, oversized);
  receipt.artifacts["after.png"].sha256 = sha256(oversized);
  await fs.writeFile(receipt.receiptPath, JSON.stringify(receipt));
  const largeResponse = await call("read_preview", { requestId: request.requestId });
  const large = ok(largeResponse);
  assert.equal(large.images[1].included, false);
  assert.match(large.images[1].reason, /2 MiB/);
  assert.equal(large.images[1].path, receipt.artifacts["after.png"].path);
  assert.equal(largeResponse.content.filter(block => block.type === "image").length, 1);
  assert.equal(stderr(), "");
});

test("stdio rejects path escapes and extra execution/output arguments without writing a result", async t => {
  const { directory, project, call, request } = await setup(t);
  for (const inputPath of ["../outside.excalidraw", join(directory, "outside.excalidraw"), "nested/../../outside.excalidraw", "input.excalidraw\0", "..\\outside.excalidraw", "./input.excalidraw"]) {
    error(await call("inspect_scene", { inputPath }), "WORKSPACE_PATH");
    error(await call("edit_scene", { ...request, inputPath }), "WORKSPACE_PATH");
  }
  for (const field of ["outputDir", "command", "module", "receiptPath"]) {
    error(await call("edit_scene", { ...request, [field]: directory }), "INVALID_REQUEST");
  }
  error(await call("read_preview", { requestId: "../outside" }), "INVALID_REQUEST");
  error(await call("edit_scene", { ...request, requestId: "../outside" }), "INVALID_REQUEST");
  error(await call("arbitrary_command", { command: "ls" }), "UNKNOWN_TOOL");
  await assert.rejects(fs.access(join(project, outputs)), { code: "ENOENT" });
});

test("stdio rejects symlinked inputs, output parents and retained request internals", async t => {
  const { directory, project, original, call, request } = await setup(t);
  const outside = join(directory, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, "input.excalidraw"), original);
  await fs.symlink(join(outside, "input.excalidraw"), join(project, "linked.excalidraw"));
  await fs.symlink(outside, join(project, "linked-parent"));
  error(await call("inspect_scene", { inputPath: "linked.excalidraw" }), "WORKSPACE_PATH");
  error(await call("inspect_scene", { inputPath: "linked-parent/input.excalidraw" }), "WORKSPACE_PATH");
  const job = `${outputs}/${request.requestId}`;
  for (const rel of [".excalidraw-toolkit", outputs, job, `${job}/claims`, `${job}/attempts`, `${job}/receipt.json`]) {
    await fs.mkdir(dirname(join(project, rel)), { recursive: true });
    await fs.symlink(outside, join(project, rel));
    error(await call("edit_scene", request), "WORKSPACE_PATH");
    error(await call("read_preview", { requestId: request.requestId }), "WORKSPACE_PATH");
    await fs.rm(join(project, ".excalidraw-toolkit"), { recursive: true, force: true });
  }
  assert.deepEqual(await fs.readdir(outside), ["input.excalidraw"]);
});

test("stdio refuses forged recovery paths and lets the core reject unsupported operations", async t => {
  const { project, call, request } = await setup(t);
  const job = join(project, outputs, request.requestId);
  await fs.mkdir(join(job, "claims"), { recursive: true });
  await fs.writeFile(join(job, "claims", "1.json"), JSON.stringify({ attemptId: "../../../../outside", pid: 1, hostname: "example" }));
  error(await call("edit_scene", request), "CORRUPT_RESULT");
  error(await call("read_preview", { requestId: request.requestId }), "CORRUPT_RESULT");
  await assert.rejects(fs.access(join(job, "request.json")), { code: "ENOENT" });
  await fs.rm(job, { recursive: true });
  error(await call("edit_scene", { ...request, operations: [{ op: "unknownOperation", targetId: "service", style: { backgroundColor: "#000000" } }] }), "UNSUPPORTED_OPERATION");
  await assert.rejects(fs.access(join(job, "receipt.json")), { code: "ENOENT" });
});

test("stdio rejects nonregular input and claim files without waiting for a FIFO writer", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const { project, call, request } = await setup(t);
  execFileSync("mkfifo", [join(project, "pipe.excalidraw")]);
  error(await call("inspect_scene", { inputPath: "pipe.excalidraw" }), "WORKSPACE_PATH");
  error(await call("edit_scene", { ...request, inputPath: "pipe.excalidraw" }), "WORKSPACE_PATH");
  const claims = join(project, outputs, request.requestId, "claims");
  await fs.mkdir(claims, { recursive: true });
  execFileSync("mkfifo", [join(claims, "1.json")]);
  error(await call("edit_scene", request), "WORKSPACE_PATH");
  error(await call("read_preview", { requestId: request.requestId }), "WORKSPACE_PATH");
});

test("stdio reports native renderer failures, retains no completed receipt and blocks remote image requests", { timeout: 120000 }, async t => {
  const { project, original, call, request } = await setup(t);
  let requests = 0;
  const canary = createServer((_request, response) => { requests++; response.writeHead(200, { "Content-Type": "image/png" }); response.end(Buffer.from(JSON.parse(original).files.asset.dataURL.split(",")[1], "base64")); });
  await new Promise(resolve => canary.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => canary.close(resolve)));
  const scene = JSON.parse(original);
  scene.files.asset.dataURL = `http://127.0.0.1:${canary.address().port}/must-not-be-requested.png`;
  const bytes = Buffer.from(JSON.stringify(scene));
  await fs.writeFile(join(project, "input.excalidraw"), bytes);
  const failed = { ...request, baseHash: sha256(bytes), operations: request.operations.slice(0, 1) };
  error(await call("edit_scene", failed));
  assert.equal(requests, 0);
  await assert.rejects(fs.access(join(project, outputs, request.requestId, "receipt.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(join(project, "input.excalidraw")), bytes);
  // The failed attempt has finished, so the identical request can recover after
  // its runtime dependency is repaired. Here the same invalid asset still fails.
  error(await call("edit_scene", failed));
  assert.equal((await fs.readdir(join(project, outputs, request.requestId, "attempts"))).length, 2);
  assert.equal(requests, 0);
});

test("stdio recovers the identical request after the missing native preview build is repaired", { timeout: 120000 }, async t => {
  const { project, original, call, request, installed } = await setup(t, { missingPreview: true });
  const failed = await call("edit_scene", request);
  error(failed);
  assert.match(failed.structuredContent.error, /PREVIEW_BUILD_MISSING/);
  const job = join(project, outputs, request.requestId);
  await assert.rejects(fs.access(join(job, "receipt.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(join(project, "input.excalidraw")), original);
  await fs.symlink(new URL("../dist/preview", import.meta.url).pathname, join(installed, "dist", "preview"), "dir");
  const result = ok(await call("edit_scene", request));
  assert.equal(result.receipt.status, "complete");
  assert.equal((await fs.readdir(join(job, "attempts"))).length, 2);
  assert.deepEqual(ok(await call("edit_scene", request)), result);
  assert.equal((await fs.readdir(join(job, "attempts"))).length, 2);
  assert.deepEqual(await fs.readFile(join(project, "input.excalidraw")), original);
});
