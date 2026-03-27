import { execSync } from "child_process";
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

const CANVAS_IMAGE = "ghcr.io/yctimlin/mcp_excalidraw-canvas:latest";
const CONTAINER_NAME = "excalidraw-canvas";

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

export function start() {
  // Check if container already running
  try {
    const running = execSync(
      `docker ps --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`,
      { encoding: "utf8" }
    ).trim();
    if (running === CONTAINER_NAME) {
      logSuccess("Canvas server already running at http://localhost:3000");
      return;
    }
  } catch {
    // docker not available, will fail below
  }

  // Check if stopped container exists, remove it
  try {
    execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // no existing container, fine
  }

  // Start container
  try {
    execSync(
      `docker run -d --name ${CONTAINER_NAME} -p 3000:3000 ${CANVAS_IMAGE}`,
      { stdio: "inherit" }
    );
    logSuccess("Canvas server started at http://localhost:3000");
  } catch (err) {
    logError("Failed to start canvas server");
    console.error("    Is Docker running? Try: docker run -d -p 3000:3000 " + CANVAS_IMAGE);
    process.exit(1);
  }

  // Open browser
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${opener} http://localhost:3000`, { stdio: "ignore" });
    logSuccess("Opened http://localhost:3000 in browser");
  } catch {
    console.log("  Open http://localhost:3000 in your browser");
  }
}

export function stop() {
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { stdio: "ignore" });
    execSync(`docker rm ${CONTAINER_NAME}`, { stdio: "ignore" });
    logSuccess("Canvas server stopped");
  } catch {
    logError("No running canvas server found");
  }
}
