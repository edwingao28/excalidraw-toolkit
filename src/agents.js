import { createHash, randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJsonFile, writeJson } from "./utils.js";

const TEMPLATE = fileURLToPath(new URL("../plugins/excalidraw/skills/scoped-edit/SKILL.md", import.meta.url));
const TARGET_DIRS = { claude: ".claude", codex: ".agents" };
const SKILL_NAME = "scoped-edit";
const OWNER = "excalidraw-toolkit";
const hash = (content) => createHash("sha256").update(content).digest("hex");

function targetsFor(target) {
  if (target === "all") return Object.keys(TARGET_DIRS);
  if (!Object.hasOwn(TARGET_DIRS, target)) throw new Error("AGENT_TARGET: expected claude, codex, or all");
  return [target];
}

function baseFor({ home, project, scope = "project" }) {
  if (scope !== "project" && scope !== "user") throw new Error("AGENT_SCOPE: expected project or user");
  const input = scope === "user" ? home : project;
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(scope === "user" ? "AGENT_HOME: user scope requires an explicit home directory" : "AGENT_PROJECT: specify a project directory; user installation requires scope: user");
  }
  if (scope === "user" && project !== undefined) throw new Error("AGENT_SCOPE: specify either project or user scope");
  const base = realpathSync(resolve(input));
  if (!lstatSync(base).isDirectory()) throw new Error("AGENT_DIRECTORY: installation root must be a directory");
  return base;
}

// Project discovery directories must not redirect a project install into a
// personal skill folder or another repository through an existing symlink.
function checkDirectories(base, target) {
  let path = base;
  for (const part of [TARGET_DIRS[target], "skills", SKILL_NAME]) {
    path = join(path, part);
    try {
      if (!lstatSync(path).isDirectory()) throw new Error(`AGENT_PATH: expected a regular directory at ${path}; symlinks are not followed`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path;
}

function readSkill(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`AGENT_FILE: expected a regular skill file at ${path}; symlinks are not followed`);
    return { content: readFileSync(path), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { content: null, mode: 0o644 };
    throw error;
  }
}

function readInstallation(base, target) {
  const directory = checkDirectories(base, target);
  const path = join(directory, "SKILL.md");
  const receiptPath = join(directory, ".excalidraw-toolkit.json");
  const receipt = readJsonFile(receiptPath);
  if (receipt.text !== null) {
    const { owner, version, hashes } = receipt.value;
    if (owner !== OWNER || version !== 1 || !Array.isArray(hashes) || !hashes.length ||
      hashes.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`AGENT_RECEIPT: invalid ownership record at ${receiptPath}`);
    }
  }
  const skill = readSkill(path);
  const owned = receipt.text !== null && skill.content !== null && receipt.value.hashes.includes(hash(skill.content));
  return { directory, path, receiptPath, receipt, ...skill, owned };
}

function withLock(base, action) {
  const lock = join(base, ".excalidraw-toolkit-agents.lock");
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`AGENT_BUSY: another skill install is in progress. If none is running, remove ${lock} and retry.`);
  }
  try { return action(); }
  finally { rmdirSync(lock); }
}

function commandPrefix(cliPath) {
  if (typeof cliPath !== "string" || !cliPath.trim()) throw new Error("AGENT_CLI: cliPath is required");
  const absoluteCliPath = realpathSync(resolve(cliPath));
  if (!lstatSync(absoluteCliPath).isFile() || /[\r\n`]/.test(absoluteCliPath)) {
    throw new Error("AGENT_CLI: expected a regular CLI file with no newlines or backticks in its path");
  }
  const nodePath = process.execPath;
  if (!isAbsolute(nodePath)) throw new Error("AGENT_NODE: Node executable path must be absolute");
  const quote = process.platform === "win32"
    ? (value) => `'${value.replaceAll("'", "''")}'`
    : (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${process.platform === "win32" ? "& " : ""}${quote(nodePath)} ${quote(absoluteCliPath)}`;
}

function replaceSkill(installation, content) {
  const temporary = join(installation.directory, `.SKILL.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", installation.mode);
    fchmodSync(fd, installation.mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!isDeepStrictEqual(readSkill(installation.path).content, installation.content)) {
      throw new Error(`AGENT_CHANGED: skill changed during installation at ${installation.path}; retry after the other writer finishes`);
    }
    renameSync(temporary, installation.path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function installAgentSkills(options) {
  const targets = targetsFor(options.target);
  const base = baseFor(options);
  const prefix = commandPrefix(options.cliPath);
  const content = Buffer.from(readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{CLI_COMMAND}}", prefix)
    .replaceAll("{{SHELL_NAME}}", process.platform === "win32" ? "PowerShell" : "a POSIX shell"));
  const newHash = hash(content);
  return withLock(base, () => {
    const installations = targets.map((target) => readInstallation(base, target));
    for (const installation of installations) {
      if (installation.content !== null && !installation.owned) {
        throw new Error(`AGENT_CONFLICT: preserved modified or unowned skill at ${installation.path}; move or rename it before installation`);
      }
    }
    for (const installation of installations) {
      const finalReceipt = { owner: OWNER, version: 1, hashes: [newHash] };
      if (installation.content?.equals(content)) {
        if (!isDeepStrictEqual(installation.receipt.value, finalReceipt)) {
          writeJson(installation.receiptPath, finalReceipt, installation.receipt);
        }
        continue;
      }
      mkdirSync(installation.directory, { recursive: true });
      // Save the old and intended hashes before the file replacement, allowing
      // retry after an interruption on either side of the atomic rename.
      const hashes = [...new Set([...(installation.receipt.value.hashes || []), newHash])];
      writeJson(installation.receiptPath, { owner: OWNER, version: 1, hashes }, installation.receipt);
      const pendingReceipt = readJsonFile(installation.receiptPath);
      replaceSkill(installation, content);
      writeJson(installation.receiptPath, finalReceipt, pendingReceipt);
    }
    return { ownedPaths: installations.map(({ path }) => path), preservedPaths: [], receiptPaths: installations.map(({ receiptPath }) => receiptPath),
      ...(targets.includes("codex") && options.scope !== "user" ? { codexMcp: {
        command: process.execPath, args: [realpathSync(resolve(options.cliPath)), "mcp", "--project", base],
        configured: false, note: "Register this workspace-scoped server through Codex; skill installation does not modify MCP configuration.",
      } } : {}),
    };
  });
}

export function uninstallAgentSkills(options) {
  const targets = targetsFor(options.target);
  const base = baseFor(options);
  return withLock(base, () => {
    const installations = targets.map((target) => readInstallation(base, target));
    const removedPaths = [];
    const preservedPaths = [];
    for (const installation of installations) {
      if (installation.content === null && installation.receipt.text === null) continue;
      if (installation.content !== null && !installation.owned) {
        preservedPaths.push(installation.path);
        continue;
      }
      if (installation.owned) {
        if (!isDeepStrictEqual(readSkill(installation.path).content, installation.content)) {
          preservedPaths.push(installation.path);
          continue;
        }
        rmSync(installation.path);
        removedPaths.push(installation.path);
      }
      if (installation.receipt.text !== null) rmSync(installation.receiptPath);
      try { rmdirSync(installation.directory); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    }
    return { removedPaths, preservedPaths };
  });
}

export function agentSkillStatus(options) {
  const base = baseFor(options);
  const installations = targetsFor(options.target).map(target => {
    const installation = readInstallation(base, target);
    return {target, path: installation.path, installed: installation.content !== null, owned: installation.owned};
  });
  return {ok: installations.every(value => value.owned), installations};
}
