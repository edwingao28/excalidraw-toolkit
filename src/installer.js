import { execSync, spawn } from "child_process";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { copyDir, logError, logSuccess, logWarn, mergeMcpServers, readJsonSafe, removeMcpServers } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_SOURCE = join(__dirname, "..", "plugins", "excalidraw");
const CANVAS_REPO = "https://github.com/yctimlin/mcp_excalidraw.git";
const CANVAS_DIR_NAME = ".excalidraw-canvas";
const DEFAULT_PORT = "3000";

function getPort() {
  const port = process.env.PORT || DEFAULT_PORT;
  if (!/^\d+$/.test(port)) {
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
      command: "node",
      args: [bridgePath],
      env: { EXPRESS_SERVER_URL: `http://localhost:${port}` },
    },
  };
}

// Claude Code's user-scope MCP registry. `~/.claude/settings.json` is NOT
// read for MCP servers — see https://github.com/edwingao28/excalidraw-skill/issues/15.
function userMcpConfigPath(home) {
  return join(home, ".claude.json");
}

// Old (incorrect) location used before #15 was fixed. Cleaned up on install/uninstall
// so doctor doesn't get confused by stale entries.
function legacyMcpConfigPath(home) {
  return join(home, ".claude", "settings.json");
}

export function install(home) {
  const port = getPort();
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const mcpConfigPath = userMcpConfigPath(home);

  copyDir(PLUGINS_SOURCE, pluginDir, { exclude: ["."] });
  logSuccess("Copied skills to " + pluginDir);

  mergeMcpServers(mcpConfigPath, getMcpConfig(home, port));
  logSuccess("Registered MCP server in " + mcpConfigPath);

  // Sweep stale entries from the pre-#15 location.
  if (existsSync(legacyMcpConfigPath(home))) {
    removeMcpServers(legacyMcpConfigPath(home), ["excalidraw"]);
  }
}

export function uninstall(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit");

  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
    logSuccess("Removed " + pluginDir);
  }

  removeMcpServers(userMcpConfigPath(home), ["excalidraw"]);
  if (existsSync(legacyMcpConfigPath(home))) {
    removeMcpServers(legacyMcpConfigPath(home), ["excalidraw"]);
  }
  logSuccess("Removed MCP server registration");
}

export async function doctor(home) {
  const pluginDir = join(home, ".claude", "plugins", "excalidraw-toolkit", "excalidraw");
  const mcpConfigPath = userMcpConfigPath(home);
  let ok = true;

  const skillPath = join(pluginDir, "skills", "excalidraw", "SKILL.md");
  if (existsSync(skillPath)) {
    logSuccess("Skill files installed");
  } else {
    logError("Skill files not found at " + skillPath);
    ok = false;
  }

  const mcpConfig = readJsonSafe(mcpConfigPath);
  if (mcpConfig.mcpServers?.excalidraw) {
    logSuccess("MCP server registered in " + mcpConfigPath);
  } else {
    logError("MCP server not registered in " + mcpConfigPath);
    console.error("    Run: npx excalidraw-toolkit init");
    ok = false;
  }

  // Warn (don't fail) on a stale entry from the pre-#15 location: Claude Code
  // ignores it for MCP, so it can't break the installation — just noise.
  const legacy = readJsonSafe(legacyMcpConfigPath(home));
  if (legacy.mcpServers?.excalidraw) {
    logWarn("Stale MCP entry in " + legacyMcpConfigPath(home) + " (ignored by Claude Code)");
    console.warn("    Run: npx excalidraw-toolkit init  (will clean it up)");
  }

  // Read port from persisted MCP config (set during init), not env var
  const configuredUrl = mcpConfig.mcpServers?.excalidraw?.env?.EXPRESS_SERVER_URL;
  let port = DEFAULT_PORT;
  if (configuredUrl) {
    try { port = new URL(configuredUrl).port || DEFAULT_PORT; } catch { /* invalid URL */ }
  }

  try {
    const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      logSuccess(`Canvas server running at http://localhost:${port}`);
    } else {
      logError("Canvas server returned " + res.status);
      ok = false;
    }
  } catch {
    logError(`Canvas server not reachable at http://localhost:${port}`);
    console.error("    Run: npx excalidraw-toolkit start");
    ok = false;
  }

  return ok;
}

export async function start(home) {
  const port = getPort();
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
    const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      logSuccess(`Canvas server already running at http://localhost:${port}`);
      openBrowser(port);
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
    env: { ...process.env, PORT: port, HOST: "0.0.0.0" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  writeFileSync(pidFile, String(child.pid));
  logSuccess(`Canvas server started at http://localhost:${port} (pid: ${child.pid})`);

  openBrowser(port);
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

function openBrowser(port) {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${opener} http://localhost:${port}`, { stdio: "ignore" });
    logSuccess(`Opened http://localhost:${port} in browser`);
  } catch {
    console.log(`  Open http://localhost:${port} in your browser`);
  }
}
