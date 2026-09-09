import { backendEntry, configuredPort, runtimeDir, status, mcpClient } from "./runtime.js";
export { start, stop } from "./runtime.js";
import { existsSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { copyDir, logError, logSuccess, logWarn, readJsonSafe } from "./utils.js";

import { installMcpConfig, uninstallMcpConfig, userMcpConfigPath } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_SOURCE = join(__dirname, "..", "plugins", "excalidraw");

function getPort(home) {
  const port = process.env.PORT || String(configuredPort(home));
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    logError("PORT must be a number, got: " + port);
    process.exit(1);
  }
  return port;
}

function getMcpConfig(home, port) {
  const bridgePath = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw", "mcp-bridge.mjs");
  return {
    excalidraw: {
      type: "stdio",
      command: process.execPath,
      args: [bridgePath],
      env: { EXPRESS_SERVER_URL: `http://127.0.0.1:${port}`, EXCALIDRAW_BACKEND_ENTRY: backendEntry(), EXCALIDRAW_NO_AUTOSTART: "1", LOG_FILE_PATH: join(runtimeDir(home), "mcp.log") },
    },
  };
}

export function install(home) {
  const port = getPort(home);
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const mcpConfigPath = userMcpConfigPath(home);

  const result = installMcpConfig(home, getMcpConfig(home, port).excalidraw, () => {
    copyDir(PLUGINS_SOURCE, pluginDir, { exclude: [".", "scoped-edit"] });
  });
  logSuccess("Copied skills to " + pluginDir);
  logSuccess("Registered MCP server in " + mcpConfigPath);
  for (const path of result.preserved) {
    logWarn("Preserved unowned excalidraw entry in " + path);
  }
  return result;
}

export function uninstall(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit");

  const result = uninstallMcpConfig(home, () => {
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
      logSuccess("Removed " + pluginDir);
    }
  });
  for (const path of result.preserved) {
    logWarn("Preserved modified or unowned excalidraw entry in " + path + "; installed files were retained");
  }
  logSuccess("Toolkit-owned MCP registration cleanup complete");
  return result;
}

export async function doctor(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const config = readJsonSafe(userMcpConfigPath(home));
  const checks = {
    skills: existsSync(join(pluginDir, "skills", "excalidraw", "SKILL.md")),
    mcpRegistration: config.mcpServers?.excalidraw?.command === process.execPath && JSON.stringify(config.mcpServers?.excalidraw?.args) === JSON.stringify([join(pluginDir, "mcp-bridge.mjs")]),
    bridge: existsSync(join(pluginDir, "mcp-bridge.mjs")),
    backendEntry: config.mcpServers?.excalidraw?.env?.EXCALIDRAW_BACKEND_ENTRY === backendEntry(),
  };
  const runtime = await status(home, { probeMcp: false });
  const mcp = Object.values(checks).every(Boolean) ? await mcpClient(home, (_client, info) => ({ server: info.server, tools: info.tools.map(t => t.name) }), config.mcpServers.excalidraw) : null;
  return { ...runtime, mcp, checks, ok: runtime.ok && Object.values(checks).every(Boolean) };
}
