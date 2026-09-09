import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installAgentSkills, uninstallAgentSkills } from "../src/agents.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "excalidraw-agents-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "personal home");
  const project = join(root, "project with spaces");
  const cliPath = join(root, "toolkit with spaces.js");
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(cliPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  return { root, home, project, cliPath };
}

const skillPath = (base, target) => join(base, target === "claude" ? ".claude" : ".agents", "skills", "scoped-edit", "SKILL.md");
const receiptPath = (path) => join(dirname(path), ".excalidraw-toolkit.json");
const digest = (content) => createHash("sha256").update(content).digest("hex");

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("project installation uses each client's discovery directory and leaves home untouched", (t) => {
  const options = fixture(t);
  const result = installAgentSkills({ ...options, target: "all" });
  assert.deepEqual(result.ownedPaths, [skillPath(options.project, "claude"), skillPath(options.project, "codex")]);
  assert.deepEqual(result.preservedPaths, []);
  assert.deepEqual(readdirSync(options.home), []);
  for (const path of result.ownedPaths) {
    const content = readFileSync(path, "utf8");
    assert.match(content, /^---\nname: scoped-edit\ndescription:/);
    assert.ok(content.includes(options.cliPath));
    assert.ok(content.includes(process.execPath));
    assert.doesNotMatch(content, /\{\{CLI_COMMAND\}\}|\{\{SHELL_NAME\}\}/);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(path), "utf8")), { owner: "excalidraw-toolkit", version: 1, hashes: [digest(content)] });
  }
  assert.equal(existsSync(join(options.project, ".mcp.json")), false);
  assert.equal(existsSync(join(options.project, ".codex", "config.toml")), false);
});

test("home installation requires explicit user scope", (t) => {
  const { home, cliPath } = fixture(t);
  assert.throws(() => installAgentSkills({ home, cliPath, target: "all" }), /AGENT_PROJECT/);
  assert.deepEqual(readdirSync(home), []);
  const result = installAgentSkills({ home, cliPath, target: "all", scope: "user" });
  assert.deepEqual(result.ownedPaths, [skillPath(home, "claude"), skillPath(home, "codex")]);
  assert.deepEqual(uninstallAgentSkills({ home, target: "all", scope: "user" }).removedPaths, result.ownedPaths);
});

test("same installation is byte-stable and an owned skill can upgrade to a new CLI path", (t) => {
  const options = { ...fixture(t), target: "codex" };
  const [path] = installAgentSkills(options).ownedPaths;
  const first = readFileSync(path);
  const firstReceipt = readFileSync(receiptPath(path));
  installAgentSkills(options);
  assert.deepEqual(readFileSync(path), first);
  assert.deepEqual(readFileSync(receiptPath(path)), firstReceipt);
  const nextCli = join(options.root, "new toolkit.js");
  writeFileSync(nextCli, "// fixture");
  installAgentSkills({ ...options, cliPath: nextCli });
  assert.ok(readFileSync(path, "utf8").includes(nextCli));
  assert.ok(!readFileSync(path, "utf8").includes(options.cliPath));
  assert.deepEqual(JSON.parse(readFileSync(receiptPath(path), "utf8")).hashes, [digest(readFileSync(path))]);
});

test("an unowned same-name skill prevents all-target installation before copying either target", (t) => {
  const options = { ...fixture(t), target: "all" };
  const conflict = skillPath(options.project, "codex");
  put(conflict, "A user's existing skill.\n");
  assert.throws(() => installAgentSkills(options), /AGENT_CONFLICT/);
  assert.equal(readFileSync(conflict, "utf8"), "A user's existing skill.\n");
  assert.equal(existsSync(skillPath(options.project, "claude")), false);
  assert.equal(existsSync(receiptPath(conflict)), false);
});

test("modified skills and their receipts survive upgrade and uninstall", (t) => {
  const options = { ...fixture(t), target: "all" };
  const { ownedPaths } = installAgentSkills(options);
  const modified = ownedPaths[1];
  const content = `${readFileSync(modified, "utf8")}\nUser-specific instructions.\n`;
  writeFileSync(modified, content);
  const receipt = readFileSync(receiptPath(modified));
  assert.throws(() => installAgentSkills(options), /AGENT_CONFLICT/);
  const result = uninstallAgentSkills(options);
  assert.deepEqual(result.preservedPaths, [modified]);
  assert.deepEqual(result.removedPaths, [ownedPaths[0]]);
  assert.equal(readFileSync(modified, "utf8"), content);
  assert.deepEqual(readFileSync(receiptPath(modified)), receipt);
});

test("uninstall removes only owned files, preserving sibling content and other skills", (t) => {
  const options = { ...fixture(t), target: "claude" };
  const [path] = installAgentSkills(options).ownedPaths;
  const sibling = join(dirname(path), "user-notes.md");
  const other = join(options.project, ".claude", "skills", "another", "SKILL.md");
  put(sibling, "Keep these notes.");
  put(other, "Keep this skill.");
  assert.deepEqual(uninstallAgentSkills(options), { removedPaths: [path], preservedPaths: [] });
  assert.equal(readFileSync(sibling, "utf8"), "Keep these notes.");
  assert.equal(readFileSync(other, "utf8"), "Keep this skill.");
  assert.equal(existsSync(receiptPath(path)), false);
  assert.deepEqual(uninstallAgentSkills(options), { removedPaths: [], preservedPaths: [] });
});

test("uninstall preserves files without a receipt and unowned empty directories", (t) => {
  const options = { ...fixture(t), target: "all" };
  const path = skillPath(options.project, "claude");
  const emptyDirectory = dirname(skillPath(options.project, "codex"));
  put(path, "An unrelated same-name skill.");
  mkdirSync(emptyDirectory, { recursive: true });
  assert.deepEqual(uninstallAgentSkills(options), { removedPaths: [], preservedPaths: [path] });
  assert.equal(readFileSync(path, "utf8"), "An unrelated same-name skill.");
  assert.equal(existsSync(emptyDirectory), true);
});

test("malformed or invalid receipts block both operations without changing skills", (t) => {
  for (const receipt of ["invalid JSON", { owner: "someone-else", version: 1, hashes: ["a".repeat(64)] }, { owner: "excalidraw-toolkit", version: 1, hashes: [] }]) {
    const options = { ...fixture(t), target: "claude" };
    const [path] = installAgentSkills(options).ownedPaths;
    const before = readFileSync(path);
    put(receiptPath(path), receipt);
    assert.throws(() => installAgentSkills(options), /Invalid configuration|AGENT_RECEIPT/);
    assert.throws(() => uninstallAgentSkills(options), /Invalid configuration|AGENT_RECEIPT/);
    assert.deepEqual(readFileSync(path), before);
  }
});

test("interrupted upgrade resumes from old or new content and finalizes ownership", (t) => {
  for (const useNewContent of [false, true]) {
    const options = { ...fixture(t), target: "codex" };
    const [path] = installAgentSkills(options).ownedPaths;
    const oldContent = readFileSync(path);
    const nextCli = join(options.root, "next.js");
    writeFileSync(nextCli, "// fixture");
    installAgentSkills({ ...options, cliPath: nextCli });
    const newContent = readFileSync(path);
    if (!useNewContent) writeFileSync(path, oldContent);
    put(receiptPath(path), { owner: "excalidraw-toolkit", version: 1, hashes: [digest(oldContent), digest(newContent)] });
    installAgentSkills({ ...options, cliPath: nextCli });
    assert.deepEqual(readFileSync(path), newContent);
    assert.deepEqual(JSON.parse(readFileSync(receiptPath(path), "utf8")).hashes, [digest(newContent)]);
  }
});

test("a recorded but missing skill can be reinstalled or fully uninstalled", (t) => {
  const options = { ...fixture(t), target: "claude" };
  const [path] = installAgentSkills(options).ownedPaths;
  rmSync(path);
  installAgentSkills(options);
  assert.equal(existsSync(path), true);
  rmSync(path);
  uninstallAgentSkills(options);
  assert.equal(existsSync(receiptPath(path)), false);
});

test("project discovery symlinks cannot redirect writes to personal skills", { skip: process.platform === "win32" }, (t) => {
  const options = { ...fixture(t), target: "codex" };
  symlinkSync(options.home, join(options.project, ".agents"));
  assert.throws(() => installAgentSkills(options), /AGENT_PATH/);
  assert.throws(() => uninstallAgentSkills(options), /AGENT_PATH/);
  assert.deepEqual(readdirSync(options.home), []);
});

test("generated CLI command executes the exact path with spaces and shell punctuation", { skip: process.platform === "win32" }, (t) => {
  const options = { ...fixture(t), target: "claude" };
  options.cliPath = join(options.root, "tool kit's $literal.js");
  writeFileSync(options.cliPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const [path] = installAgentSkills(options).ownedPaths;
  const command = readFileSync(path, "utf8").match(/```sh\n\s*(.+ --help)\n/)[1].trim();
  const output = execFileSync("/bin/sh", ["-c", command], { cwd: options.home, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), ["--help"]);
});

test("invalid target, scope, CLI, or a held lock makes no skill changes", (t) => {
  const options = fixture(t);
  assert.throws(() => installAgentSkills({ ...options, target: "other" }), /AGENT_TARGET/);
  assert.throws(() => installAgentSkills({ ...options, target: "all", scope: "global" }), /AGENT_SCOPE/);
  assert.throws(() => installAgentSkills({ ...options, target: "all", scope: "user" }), /AGENT_SCOPE/);
  assert.throws(() => installAgentSkills({ ...options, target: "all", cliPath: undefined }), /AGENT_CLI/);
  mkdirSync(join(options.project, ".excalidraw-toolkit-agents.lock"));
  assert.throws(() => installAgentSkills({ ...options, target: "all" }), /AGENT_BUSY/);
  assert.deepEqual(readdirSync(options.project), [".excalidraw-toolkit-agents.lock"]);
});
