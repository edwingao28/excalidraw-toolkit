#!/usr/bin/env node
// Execute only the backend installed and pinned by this toolkit package.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const entry = process.env.EXCALIDRAW_BACKEND_ENTRY;
if (!entry || !existsSync(entry)) {
  console.error("BACKEND_MISSING: run excalidraw-toolkit init from an installed package to repair the backend path");
  process.exit(1);
}
const child = spawn(process.execPath, [entry], { stdio: "inherit", env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: "1" } });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); });
