import { closeSync, cpSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, join } from "path";

export function copyDir(src, dest, { exclude = [] } = {}) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      return !exclude.some((pattern) => basename(source).startsWith(pattern));
    },
  });
}

export function readJsonFile(filePath) {
  let text;
  let mode;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile()) throw new Error("Expected a regular file (symlinks are not modified)");
    mode = stat.mode & 0o777;
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { value: {}, text: null, mode: 0o600 };
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a JSON object");
    }
    return { value, text, mode };
  } catch {
    // Parser errors can quote configuration values, including credentials.
    throw new Error(`Invalid configuration in ${filePath}: expected a valid JSON object. File was not changed.`);
  }
}

// Missing is safe; malformed or unreadable configuration must never become {}.
export function readJsonSafe(filePath) {
  return readJsonFile(filePath).value;
}

export function writeJson(filePath, data, previous = readJsonFile(filePath)) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", previous.mode);
    fchmodSync(fd, previous.mode);
    writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (readJsonFile(filePath).text !== previous.text) {
      throw new Error(`Configuration changed during setup: ${filePath}. Retry after the other writer finishes.`);
    }
    renameSync(temporary, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export function logSuccess(msg) {
  console.log(`  \u2713 ${msg}`);
}

export function logError(msg) {
  console.error(`  \u2717 ${msg}`);
}

export function logWarn(msg) {
  console.warn(`  \u26a0 ${msg}`);
}
