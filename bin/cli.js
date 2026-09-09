#!/usr/bin/env node

import { homedir } from "os";
import { parseArgs } from "node:util";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const { values, positionals } = parseArgs({ options: { home: { type: "string" }, json: { type: "boolean" }, "no-open": { type: "boolean" }, target: { type: "string" }, project: { type: "string" }, scope: { type: "string" }, request: { type: "string" }, output: { type: "string" }, publish: { type: "boolean", default: false }, port: { type: "string" }, title: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } }, allowPositionals: true });
const home = resolve(values.home || homedir());
const command = values.help ? "help" : values.version ? "version" : positionals[0];

function printUsage() {
  console.log(`
${pkg.name} v${pkg.version}

Usage:
  npx ${pkg.name} init --target <claude|codex|all> --project <directory>
                            Install owned scoped-edit skills in a project
  npx ${pkg.name} init       Install the legacy Claude Code canvas integration
  npx ${pkg.name} start      Start the Excalidraw canvas server
  npx ${pkg.name} stop       Stop the canvas server
  npx ${pkg.name} update     Re-install (overwrites existing skill files)
  npx ${pkg.name} uninstall  Remove skills and MCP config
  npx ${pkg.name} doctor     Check installation health and prerequisites
  npx ${pkg.name} status     Report canvas identity, ownership, and MCP capabilities
  npx ${pkg.name} setup-preview  Install the pinned Chromium renderer
  npx ${pkg.name} mcp --project <directory>  Serve workspace-scoped edit tools over stdio
  npx ${pkg.name} inspect <scene>  Read native IDs, input hash, and supported operations
  npx ${pkg.name} edit <scene> --request <json> --output <directory>
  npx ${pkg.name} preview <scene-or-receipt>  Review and export a native file
  npx ${pkg.name} validate-evidence --request <json>  Check scoped source references
  npx ${pkg.name} associate-evidence --request <json>  Retain an existing scene's evidence
  npx ${pkg.name} accept-baseline --request <json>  Accept generated/delivered snapshots
  npx ${pkg.name} explain-change --request <json>  Export source-linked revision views
  npx ${pkg.name} refresh-diagram --request <json>  Stage a source refresh with previews
  npx ${pkg.name} adopt-refresh --request <json>  Explicitly accept a reviewed refresh
  npx ${pkg.name} ci-diagram --request <json>  Run an explicitly configured source job
  npx ${pkg.name} publish-diagram --publish --request <json>  Publish an opted-in PR update
  npx ${pkg.name} version    Print version

Options: --home <directory>, --target <claude|codex|all>, --project <directory>,
         --scope user (explicit personal skill installation), --json, --no-open,
         --publish (explicit opt-in; publication defaults off)
`);
}

async function main() {
  if (command === "mcp") {
    if (positionals.length !== 1 || Object.keys(values).some(key => key !== "project" && values[key] !== false)) throw new Error("MCP_OPTIONS: use mcp --project <directory>");
    const { startScopedMcp } = await import("../src/scoped-mcp.js");
    await startScopedMcp(values.project);
    return;
  }
  if (values.target && ["init", "update", "uninstall", "doctor"].includes(command)) {
    const {installAgentSkills, uninstallAgentSkills, agentSkillStatus} = await import("../src/agents.js");
    const options = {home, project: values.project, scope: values.scope || "project", target: values.target, cliPath: __filename};
    let result;
    if (command === "doctor") {
      const {rendererStatus} = await import("../src/render.js");
      result = {...agentSkillStatus(options), renderer: rendererStatus()};
      result.ok = result.ok && result.renderer.ready;
      process.exitCode = result.ok ? 0 : 1;
    } else result = command === "uninstall" ? uninstallAgentSkills(options) : installAgentSkills(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if ((values.project || values.scope) && !values.target) throw new Error("AGENT_TARGET: use --target with --project or --scope");
  const { WORKFLOW_COMMANDS, workflowCommand } = await import("../src/workflow-commands.js");
  if (WORKFLOW_COMMANDS.includes(command)) {
    if (positionals.length !== 1) throw new Error("WORKFLOW_REQUEST: use --request <json> for workflow commands");
    const result = await workflowCommand(command, values.request, values);
    console.log(JSON.stringify(result, null, 2));
    const status = result.receipt?.status ?? result.status;
    if (["failed", "blocked", "uncertain", "busy", "reconciliation-required"].includes(status)) process.exitCode = 1;
    if (command === "publish-diagram" && status === "superseded") process.exitCode = 1;
    return;
  }
  const { install, uninstall, doctor, start, stop } = await import("../src/installer.js");

  switch (command) {
    case "setup-preview": {
      const {setupPreview} = await import("../src/render.js");
      console.log(JSON.stringify(await setupPreview(), null, 2));
      break;
    }
    case "inspect":
    case "edit":
    case "preview": {
      const { sceneCommand } = await import("../src/commands.js");
      console.log(JSON.stringify(await sceneCommand(command, positionals[1], values), null, 2));
      break;
    }
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
  console.error(JSON.stringify({ ok: false, code: err.code, error: err.message }));
  process.exit(1);
});
