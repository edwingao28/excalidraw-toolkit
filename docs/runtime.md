# Packaged runtime

The toolkit pins `mcp-excalidraw-server@2.0.0` and compiles its MCP and server entries, including their required dependencies, into `dist/runtime` at build time. The canvas assets are rebuilt at pack time from upstream commit `713706e967ed21db1d9264748fa01c6af961c792`; the source archive digest and exact dependency lock live in `scripts/canvas-source.json` and `scripts/canvas-lock.json`. Generated manifests record source and output hashes and retain license notices. `npm run build` produces the canvas, runtime and preview assets during development. Source builds use Node.js 24.15 or newer and npm 12.0.2; older npm versions can loop when resolving bundled dependency overrides (npm/cli#9227). The resulting package supports Node.js 20 or newer.

Build-time transforms point the server's frontend and font routes at the packaged assets. At startup the toolkit checks the runtime manifest's pinned upstream identity and the selected compiled entry's digest, then executes that entry. It generates no source in the user's home and does not resolve the upstream build dependency at runtime. Bundling keeps the reviewed runtime dependencies intact because consumer npm installs do not apply a dependency package's `overrides`.

```sh
PORT=4400 excalidraw-toolkit init --home /path/to/isolated-home
excalidraw-toolkit start --home /path/to/isolated-home --no-open
excalidraw-toolkit doctor --home /path/to/isolated-home
excalidraw-toolkit stop --home /path/to/isolated-home
```

`init` persists one local port in its owned MCP registration. `start`, `stop`, `status`, and `doctor` read that value. `status` probes the pinned MCP package; `doctor` probes the actual installed bridge and registration, including its environment. Neither probe autostarts a canvas. `doctor` succeeds only when the installed files, registration, MCP handshake, required tools, and live canvas pass.

Startup binds to loopback and waits for the expected service, PID and launch identity. A different service or unowned canvas fails explicitly. `stop` requires the persisted launch identity as well as the live PID; the port alone never authorizes a signal. Logs and ownership receipts live in `<home>/.excalidraw-toolkit/`. Timeouts and failures return a nonzero exit and JSON error. Inspect the log and active processes before removing a stale `start.lock` after a killed installer.

The MCP process starts in that runtime directory. Native file exports are restricted there by upstream unless the caller explicitly configures `EXCALIDRAW_EXPORT_DIR`; use an absolute path under the allowed directory. File-based scoped edits use their separately declared output directory. MCP scene export and import expose the upstream canvas contract; they do not promise preservation of arbitrary existing native document metadata.

To qualify a release, run the tests, build and pack, install the archive into a separate directory, then run setup, doctor, actual MCP create/export/import, and uninstall there. Source tests alone do not qualify the archive. npm publication is a separate action.
