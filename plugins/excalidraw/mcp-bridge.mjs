#!/usr/bin/env node

// Bridge that resolves npm symlinks before running mcp-excalidraw-server.
// When installed globally (e.g. Docker), npm creates symlinks that cause
// the server's import.meta.url guard to fail silently. See GitHub #10.

import { execSync, spawn } from "child_process";
import { realpathSync } from "fs";

const whichCmd = process.platform === "win32" ? "where" : "which";

let binPath;
try {
  binPath = execSync(`${whichCmd} mcp-excalidraw-server`, { encoding: "utf8" }).trim();
} catch {
  // Not in PATH
}

if (binPath) {
  // Resolve symlink to real file so process.argv[1] matches import.meta.url
  const realPath = realpathSync(binPath);
  const child = spawn("node", [realPath], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  // Not globally installed — npx handles download, no symlink issue
  const child = spawn("npx", ["-y", "mcp-excalidraw-server"], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
}
