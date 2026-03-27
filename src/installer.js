import { existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { copyDir, logError, logSuccess, mergeMcpServers, readJsonSafe, removeMcpServers } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_SOURCE = join(__dirname, "..", "plugins", "excalidraw");

const MCP_CONFIG = {
  excalidraw: {
    command: "npx",
    args: ["-y", "mcp-excalidraw-server"],
    env: { EXPRESS_SERVER_URL: "http://localhost:3000" },
  },
};

export function install(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const settingsPath = join(home, ".claude", "settings.json");

  copyDir(PLUGINS_SOURCE, pluginDir, { exclude: ["."] });
  logSuccess("Copied skills to " + pluginDir);

  mergeMcpServers(settingsPath, MCP_CONFIG);
  logSuccess("Registered MCP server in " + settingsPath);
}

export function uninstall(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit");
  const settingsPath = join(home, ".claude", "settings.json");

  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    logSuccess("Removed " + pluginDir);
  }

  removeMcpServers(settingsPath, ["excalidraw"]);
  logSuccess("Removed MCP server from settings");
}

export async function doctor(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const settingsPath = join(home, ".claude", "settings.json");
  let ok = true;

  const skillPath = join(pluginDir, "skills", "excalidraw", "SKILL.md");
  if (existsSync(skillPath)) {
    logSuccess("Skill files installed");
  } else {
    logError("Skill files not found at " + skillPath);
    ok = false;
  }

  const settings = readJsonSafe(settingsPath);
  if (settings.mcpServers?.excalidraw) {
    logSuccess("MCP server configured in settings.json");
  } else {
    logError("MCP server not configured in " + settingsPath);
    ok = false;
  }

  try {
    const res = await fetch("http://localhost:3000", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      logSuccess("Canvas server running at http://localhost:3000");
    } else {
      logError("Canvas server returned " + res.status);
      ok = false;
    }
  } catch {
    logError("Canvas server not reachable at http://localhost:3000");
    console.error("    Run: docker run -d -p 3000:3000 ghcr.io/yctimlin/mcp_excalidraw-canvas:latest");
    ok = false;
  }

  return ok;
}
