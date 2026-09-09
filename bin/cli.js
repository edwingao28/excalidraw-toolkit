#!/usr/bin/env node

import { homedir } from "os";
import { parseArgs } from "node:util";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const { values, positionals } = parseArgs({ options: { home: { type: "string" }, json: { type: "boolean" }, "no-open": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } }, allowPositionals: true });
const home = resolve(values.home || homedir());
const command = values.version ? "version" : positionals[0];

function printUsage() {
  console.log(`
${pkg.name} v${pkg.version}

Usage:
  npx ${pkg.name} init       Install skills and configure MCP server for Claude Code
  npx ${pkg.name} start      Start the Excalidraw canvas server
  npx ${pkg.name} stop       Stop the canvas server
  npx ${pkg.name} update     Re-install (overwrites existing skill files)
  npx ${pkg.name} uninstall  Remove skills and MCP config
  npx ${pkg.name} doctor     Check installation health and prerequisites
  npx ${pkg.name} status     Report canvas identity, ownership, and MCP capabilities
  npx ${pkg.name} version    Print version

Options: --home <directory> (isolated installation), --json, --no-open
`);
}

async function main() {
  const { install, uninstall, doctor, start, stop } = await import("../src/installer.js");

  switch (command) {
    case "init":
    case "update":
      console.log(`\n${pkg.name} v${pkg.version} — installing for Claude Code...\n`);
      install(home);
      console.log(`
  Done! Next steps:

  1. Start the canvas server:
     npx ${pkg.name} start

  2. Restart Claude Code and try: "diagram this repo"

  Run 'npx ${pkg.name} doctor' to verify everything is set up correctly.
`);
      break;

    case "start":
      console.log(JSON.stringify(await start(home, { open: !values["no-open"] }), null, 2));
      break;

    case "stop":
      console.log(JSON.stringify(await stop(home), null, 2));
      break;

    case "uninstall":
      console.log(`\n${pkg.name} — uninstalling...\n`);
      const result = uninstall(home);
      console.log(result.preserved.length ? "\n  User configuration and installed files were preserved; see above.\n" : "\n  Uninstalled successfully.\n");
      break;

    case "doctor":
    case "status": {
      const { status } = await import("../src/runtime.js");
      const result = command === "doctor" ? await doctor(home) : await status(home);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      break;
    }

    case "version":
    case "--version":
    case "-v":
      console.log(pkg.version);
      break;

    default:
      printUsage();
      break;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
