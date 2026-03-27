#!/usr/bin/env node

import { homedir } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const home = homedir();
const command = process.argv[2];

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
  npx ${pkg.name} version    Print version
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
      await start(home);
      break;

    case "stop":
      stop(home);
      break;

    case "uninstall":
      console.log(`\n${pkg.name} — uninstalling...\n`);
      uninstall(home);
      console.log("\n  Uninstalled successfully.\n");
      break;

    case "doctor":
      console.log(`\n${pkg.name} v${pkg.version} — checking installation...\n`);
      const ok = await doctor(home);
      console.log(ok ? "\n  All checks passed.\n" : "\n  Some checks failed. Fix the issues above.\n");
      process.exit(ok ? 0 : 1);
      break;

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
  console.error("Error:", err.message);
  process.exit(1);
});
