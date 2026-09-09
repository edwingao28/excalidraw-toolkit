import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { isDeepStrictEqual } from "util";
import { readJsonFile, writeJson } from "./utils.js";

export const userMcpConfigPath = (home) => join(home, ".claude.json");
export const legacyMcpConfigPath = (home) => join(home, ".claude", "settings.json");
export const installStatePath = (home) => join(home, ".claude", "plugins", "excalidraw-toolkit", "install-state.json");

function withInstallLock(home, action) {
  const parent = join(home, ".claude");
  const lock = join(parent, ".excalidraw-toolkit-install.lock");
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Setup is locked: ${lock}. If no other setup is running, remove this directory and retry.`);
  }
  try {
    return action();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

function readConfig(path) {
  const document = { path, ...readJsonFile(path) };
  const servers = document.value.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`Invalid mcpServers in ${path}; expected an object. File was not changed.`);
  }
  return document;
}

function readState(home) {
  const document = { path: installStatePath(home), ...readJsonFile(installStatePath(home)) };
  if (document.text === null) return { ...document, value: { version: 1, entries: [] } };
  const { version, entries } = document.value;
  if (version !== 1 || !Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error(`Invalid toolkit ownership record: ${document.path}. File was not changed.`);
  }
  return document;
}

// Only the historical command pointing into this toolkit's own directory can
// be adopted without a receipt. The generic npx command is not proof of ownership.
function isHistoricalToolkitEntry(home, entry) {
  const url = entry?.env?.EXPRESS_SERVER_URL;
  if (typeof url !== "string" || !/^http:\/\/localhost:\d+$/.test(url)) return false;
  return isDeepStrictEqual(entry, {
    ...(entry.type === "stdio" ? { type: "stdio" } : {}),
    command: "node",
    args: [join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw", "mcp-bridge.mjs")],
    env: { EXPRESS_SERVER_URL: url },
  });
}

function ownsEntry(home, state, entry) {
  return state.value.entries.some((owned) => isDeepStrictEqual(owned, entry)) ||
    (state.text === null && isHistoricalToolkitEntry(home, entry));
}

function save(document, value) {
  if (document.text !== null && isDeepStrictEqual(document.value, value)) return document;
  writeJson(document.path, value, document);
  return { path: document.path, ...readJsonFile(document.path) };
}

function withoutEntry(document) {
  const mcpServers = { ...document.value.mcpServers };
  delete mcpServers.excalidraw;
  return { ...document.value, mcpServers };
}

export function installMcpConfig(home, desiredEntry, installFiles = () => {}) {
  return withInstallLock(home, () => {
    const current = readConfig(userMcpConfigPath(home));
    const legacy = readConfig(legacyMcpConfigPath(home));
    let state = readState(home);
    const existing = current.value.mcpServers?.excalidraw;
    if (existing !== undefined && !ownsEntry(home, state, existing)) {
      throw new Error(`Conflicting excalidraw entry in ${current.path}. Move or rename it before setup; it was not changed.`);
    }
    const legacyEntry = legacy.value.mcpServers?.excalidraw;
    const migrateLegacy = legacyEntry !== undefined && ownsEntry(home, state, legacyEntry);
    const preserved = legacyEntry !== undefined && !migrateLegacy ? [legacy.path] : [];

    installFiles();
    // Record both sides before replacing configuration. An interrupted upgrade
    // can recognize either entry on retry; no unrelated value is authorized.
    const entries = [...state.value.entries, ...(existing === undefined ? [] : [existing]),
      ...(migrateLegacy ? [legacyEntry] : []), desiredEntry];
    state = save(state, { version: 1, entries: entries.filter((entry, index) =>
      entries.findIndex((other) => isDeepStrictEqual(entry, other)) === index) });
    save(current, { ...current.value, mcpServers: { ...current.value.mcpServers, excalidraw: desiredEntry } });
    if (migrateLegacy) save(legacy, withoutEntry(legacy));
    save(state, { version: 1, entries: [desiredEntry] });
    return { preserved };
  });
}

export function uninstallMcpConfig(home, uninstallFiles = () => {}) {
  return withInstallLock(home, () => {
    const documents = [readConfig(userMcpConfigPath(home)), readConfig(legacyMcpConfigPath(home))];
    const state = readState(home);
    const preserved = [];
    for (const document of documents) {
      const entry = document.value.mcpServers?.excalidraw;
      if (entry === undefined) continue;
      if (ownsEntry(home, state, entry)) save(document, withoutEntry(document));
      else preserved.push(document.path);
    }
    // Keep the receipt and installed files when a user-modified registration
    // remains: it may still refer to the toolkit bridge.
    if (preserved.length === 0) {
      uninstallFiles();
      rmSync(state.path, { force: true });
    }
    return { preserved };
  });
}
