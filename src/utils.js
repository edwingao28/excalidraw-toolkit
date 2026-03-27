import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export function copyDir(src, dest, { exclude = [] } = {}) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const basename = source.split("/").pop();
      if (exclude.length > 0 && exclude.some((pattern) => basename.startsWith(pattern))) {
        return false;
      }
      return true;
    },
  });
}

export function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function mergeMcpServers(settingsPath, mcpConfig) {
  const settings = readJsonSafe(settingsPath);
  if (!settings.mcpServers) settings.mcpServers = {};
  Object.assign(settings.mcpServers, mcpConfig);
  writeJson(settingsPath, settings);
}

export function removeMcpServers(settingsPath, serverNames) {
  const settings = readJsonSafe(settingsPath);
  if (!settings.mcpServers) return;
  for (const name of serverNames) {
    delete settings.mcpServers[name];
  }
  writeJson(settingsPath, settings);
}

export function logSuccess(msg) {
  console.log(`  \u2713 ${msg}`);
}

export function logError(msg) {
  console.error(`  \u2717 ${msg}`);
}
