import { execSync, spawn } from "child_process";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { copyDir, logError, logSuccess, mergeMcpServers, readJsonSafe, removeMcpServers } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_SOURCE = join(__dirname, "..", "plugins", "excalidraw");
const CANVAS_REPO = "https://github.com/yctimlin/mcp_excalidraw.git";
const CANVAS_DIR_NAME = ".excalidraw-canvas";

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
    console.error("    Run: npx excalidraw-toolkit start");
    ok = false;
  }

  return ok;
}

export async function start(home) {
  const canvasDir = join(home, CANVAS_DIR_NAME);

  // Clone if not present
  if (!existsSync(canvasDir)) {
    logSuccess("Cloning canvas server...");
    try {
      execSync(`git clone ${CANVAS_REPO} ${canvasDir}`, { stdio: "inherit" });
    } catch {
      logError("Failed to clone canvas server");
      console.error("    Try manually: git clone " + CANVAS_REPO);
      process.exit(1);
    }
  }

  // Install + build if needed
  if (!existsSync(join(canvasDir, "node_modules"))) {
    logSuccess("Installing dependencies...");
    execSync("npm ci", { cwd: canvasDir, stdio: "inherit" });
  }
  if (!existsSync(join(canvasDir, "dist"))) {
    logSuccess("Building...");
    execSync("npm run build", { cwd: canvasDir, stdio: "inherit" });
  }

  // Check if already running
  try {
    const res = await fetch("http://localhost:3000", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      logSuccess("Canvas server already running at http://localhost:3000");
      openBrowser();
      return;
    }
  } catch {
    // not running, start it
  }

  // Write PID file location
  const pidFile = join(canvasDir, ".canvas.pid");

  // Start canvas server in background
  const child = spawn("node", ["dist/server.js"], {
    cwd: canvasDir,
    env: { ...process.env, PORT: "3000", HOST: "0.0.0.0" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  writeFileSync(pidFile, String(child.pid));
  logSuccess("Canvas server started at http://localhost:3000 (pid: " + child.pid + ")");

  openBrowser();
}

export function stop(home) {
  const pidFile = join(home, CANVAS_DIR_NAME, ".canvas.pid");

  if (!existsSync(pidFile)) {
    logError("No canvas PID file found — server may not have been started with this tool");
    return;
  }

  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  try {
    process.kill(pid);
    rmSync(pidFile, { force: true });
    logSuccess("Canvas server stopped (pid: " + pid + ")");
  } catch {
    rmSync(pidFile, { force: true });
    logError("Process " + pid + " not found — may have already stopped");
  }
}

function openBrowser() {
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
