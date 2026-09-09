import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installMcpConfig, installStatePath, legacyMcpConfigPath, uninstallMcpConfig, userMcpConfigPath } from "../src/config.js";
import { install, uninstall } from "../src/installer.js";
import { readJsonFile, writeJson } from "../src/utils.js";

function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), "excalidraw-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function bridgeEntry(home, port = 3000) {
  return {
    type: "stdio", command: "node",
    args: [join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw", "mcp-bridge.mjs")],
    env: { EXPRESS_SERVER_URL: `http://localhost:${port}` },
  };
}

test("install, upgrade and repeated uninstall preserve unrelated settings", (t) => {
  const home = temporaryHome(t);
  const currentPath = userMcpConfigPath(home);
  const existing = { theme: "dark", mcpServers: { other: { command: "other", env: { TOKEN: "fixture-only" } } } };
  put(currentPath, existing);
  if (process.platform !== "win32") chmodSync(currentPath, 0o640);
  const first = bridgeEntry(home);
  const upgraded = { ...first, env: { ...first.env, EXCALIDRAW_BACKEND_ENTRY: "/fixture/pinned.js" } };
  installMcpConfig(home, first);
  installMcpConfig(home, upgraded);
  const installedBytes = readFileSync(currentPath, "utf8");
  installMcpConfig(home, upgraded);
  assert.equal(readFileSync(currentPath, "utf8"), installedBytes);
  assert.deepEqual(read(currentPath), { ...existing, mcpServers: { ...existing.mcpServers, excalidraw: upgraded } });
  if (process.platform !== "win32") assert.equal(statSync(currentPath).mode & 0o777, 0o640);
  uninstallMcpConfig(home);
  uninstallMcpConfig(home);
  assert.deepEqual(read(currentPath), existing);
  assert.equal(existsSync(installStatePath(home)), false);
});

test("malformed current or legacy configuration blocks install and uninstall before file callbacks", (t) => {
  for (const badPath of [userMcpConfigPath, legacyMcpConfigPath]) {
    for (const action of [installMcpConfig, uninstallMcpConfig]) {
      const home = temporaryHome(t);
      const path = badPath(home);
      put(userMcpConfigPath(home), { mcpServers: { other: { command: "keep" } } });
      put(legacyMcpConfigPath(home), { permissions: { allow: ["Read"] } });
      put(path, "{\n  invalid but important configuration\n");
      const before = [userMcpConfigPath(home), legacyMcpConfigPath(home)].map((p) => readFileSync(p, "utf8"));
      let called = false;
      const callback = () => { called = true; };
      assert.throws(() => action === installMcpConfig
        ? action(home, bridgeEntry(home), callback) : action(home, callback), /Invalid configuration/);
      assert.equal(called, false);
      assert.deepEqual([userMcpConfigPath(home), legacyMcpConfigPath(home)].map((p) => readFileSync(p, "utf8")), before);
      assert.equal(existsSync(installStatePath(home)), false);
    }
  }
});

test("invalid JSON document and server-map shapes are rejected", (t) => {
  for (const value of [null, [], 42, { mcpServers: null }, { mcpServers: [] }, { mcpServers: "invalid" }]) {
    const home = temporaryHome(t);
    const path = userMcpConfigPath(home);
    put(path, JSON.stringify(value));
    const before = readFileSync(path, "utf8");
    assert.throws(() => installMcpConfig(home, bridgeEntry(home)), /Invalid/);
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("a conflicting server is neither overwritten nor claimed by name", (t) => {
  const home = temporaryHome(t);
  const path = userMcpConfigPath(home);
  const foreign = { command: "npx", args: ["-y", "mcp-excalidraw-server"], env: { EXPRESS_SERVER_URL: "http://localhost:3000" } };
  put(path, { mcpServers: { excalidraw: foreign } });
  const before = readFileSync(path, "utf8");
  assert.throws(() => installMcpConfig(home, bridgeEntry(home)), /Conflicting excalidraw entry/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(installStatePath(home)), false);
  assert.deepEqual(uninstallMcpConfig(home).preserved, [path]);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("editing an owned registration blocks upgrade and preserves it on uninstall", (t) => {
  const home = temporaryHome(t);
  const path = userMcpConfigPath(home);
  const entry = bridgeEntry(home);
  installMcpConfig(home, entry);
  const modified = { ...read(path), mcpServers: { excalidraw: { ...entry, env: { ...entry.env, CUSTOM: "user-value" } } } };
  put(path, modified);
  const before = readFileSync(path, "utf8");
  assert.throws(() => installMcpConfig(home, entry), /Conflicting/);
  let filesRemoved = false;
  assert.deepEqual(uninstallMcpConfig(home, () => { filesRemoved = true; }).preserved, [path]);
  assert.equal(filesRemoved, false);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(existsSync(installStatePath(home)), true);
});

test("historical toolkit bridge migrates while unrelated legacy data survives", (t) => {
  for (const includeType of [true, false]) {
    const home = temporaryHome(t);
    const path = legacyMcpConfigPath(home);
    const unrelated = { permissions: { allow: ["Read"] }, mcpServers: { other: { command: "keep" } } };
    const historical = bridgeEntry(home, 4000);
    if (!includeType) delete historical.type;
    put(path, { ...unrelated, mcpServers: { ...unrelated.mcpServers, excalidraw: historical } });
    installMcpConfig(home, bridgeEntry(home));
    assert.deepEqual(read(path), unrelated);
    assert.deepEqual(read(userMcpConfigPath(home)).mcpServers.excalidraw, bridgeEntry(home));
  }
});

test("unowned legacy entry remains byte-identical during setup and uninstall", (t) => {
  const home = temporaryHome(t);
  const path = legacyMcpConfigPath(home);
  put(path, { permissions: {}, mcpServers: { excalidraw: { command: "someone-else" } } });
  const before = readFileSync(path, "utf8");
  assert.deepEqual(installMcpConfig(home, bridgeEntry(home)).preserved, [path]);
  assert.deepEqual(uninstallMcpConfig(home).preserved, [path]);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(read(userMcpConfigPath(home)).mcpServers.excalidraw, undefined);
});

test("an interrupted upgrade receipt recognizes either recorded entry", (t) => {
  for (const installedPort of [3000, 4000]) {
    const home = temporaryHome(t);
    const oldEntry = bridgeEntry(home);
    const newEntry = bridgeEntry(home, 4000);
    put(userMcpConfigPath(home), { mcpServers: { excalidraw: bridgeEntry(home, installedPort) } });
    put(installStatePath(home), { version: 1, entries: [oldEntry, newEntry] });
    installMcpConfig(home, newEntry);
    assert.deepEqual(read(userMcpConfigPath(home)).mcpServers.excalidraw, newEntry);
    assert.deepEqual(read(installStatePath(home)), { version: 1, entries: [newEntry] });
  }
});

test("invalid ownership records fail closed", (t) => {
  const home = temporaryHome(t);
  put(installStatePath(home), { version: 99, entries: [] });
  assert.throws(() => installMcpConfig(home, bridgeEntry(home)), /Invalid toolkit ownership/);
  assert.throws(() => uninstallMcpConfig(home), /Invalid toolkit ownership/);
  assert.equal(existsSync(userMcpConfigPath(home)), false);
});

test("failed file installation leaves configuration and ownership untouched", (t) => {
  const home = temporaryHome(t);
  put(userMcpConfigPath(home), { userSetting: true });
  const before = readFileSync(userMcpConfigPath(home), "utf8");
  assert.throws(() => installMcpConfig(home, bridgeEntry(home), () => { throw new Error("copy failed"); }), /copy failed/);
  assert.equal(readFileSync(userMcpConfigPath(home), "utf8"), before);
  assert.equal(existsSync(installStatePath(home)), false);
});

test("atomic replacement refuses a stale read and removes its temporary file", (t) => {
  const home = temporaryHome(t);
  const path = userMcpConfigPath(home);
  put(path, { first: true });
  const previous = readJsonFile(path);
  put(path, { otherWriter: true });
  assert.throws(() => writeJson(path, { unwanted: true }, previous), /Configuration changed during setup/);
  assert.deepEqual(read(path), { otherWriter: true });
  assert.deepEqual(readdirSync(home), [".claude.json"]);
});

test("symlink configuration is not followed or replaced", { skip: process.platform === "win32" }, (t) => {
  const home = temporaryHome(t);
  const target = join(home, "original.json");
  put(target, { unrelated: true });
  symlinkSync(target, userMcpConfigPath(home));
  assert.throws(() => installMcpConfig(home, bridgeEntry(home)), /symlinks are not modified/);
  assert.deepEqual(read(target), { unrelated: true });
});

test("concurrent toolkit setup fails without touching configuration", (t) => {
  const home = temporaryHome(t);
  mkdirSync(join(home, ".claude", ".excalidraw-toolkit-install.lock"), { recursive: true });
  assert.throws(() => installMcpConfig(home, bridgeEntry(home)), /Setup is locked/);
  assert.equal(existsSync(userMcpConfigPath(home)), false);
});

test("public installer uses temporary home and retains bridge for a modified registration", (t) => {
  const home = temporaryHome(t);
  install(home);
  const config = read(userMcpConfigPath(home));
  const bridge = config.mcpServers.excalidraw.args[0];
  assert.equal(existsSync(bridge), true);
  config.mcpServers.excalidraw.env.CUSTOM = "keep";
  put(userMcpConfigPath(home), config);
  uninstall(home);
  assert.equal(existsSync(bridge), true);
  assert.deepEqual(read(userMcpConfigPath(home)), config);
});

test("public uninstall rejects malformed configuration before deleting installed files", (t) => {
  const home = temporaryHome(t);
  install(home);
  const bridge = read(userMcpConfigPath(home)).mcpServers.excalidraw.args[0];
  put(userMcpConfigPath(home), "broken");
  assert.throws(() => uninstall(home), /Invalid configuration/);
  assert.equal(existsSync(bridge), true);
  assert.equal(readFileSync(userMcpConfigPath(home), "utf8"), "broken");
});

test("public uninstall removes an unchanged installation and is repeatable", (t) => {
  const home = temporaryHome(t);
  put(userMcpConfigPath(home), { mcpServers: { other: { command: "keep" } } });
  install(home);
  const bridge = read(userMcpConfigPath(home)).mcpServers.excalidraw.args[0];
  uninstall(home);
  uninstall(home);
  assert.equal(existsSync(bridge), false);
  assert.equal(existsSync(installStatePath(home)), false);
  assert.deepEqual(read(userMcpConfigPath(home)), { mcpServers: { other: { command: "keep" } } });
});
