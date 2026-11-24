# Install and connect your agent

## Install from npm

Use Node.js 20+ and npm. These commands use a POSIX shell and install the released package with its built browser assets:

```sh
npm install --global excalidraw-toolkit@0.2.0

TOOLKIT_NODE="$(node -p 'process.execPath')"
TOOLKIT_CLI="$(npm root --global)/excalidraw-toolkit/bin/cli.js"
TOOLKIT_PROJECT="/absolute/path/to/your-project"
"$TOOLKIT_NODE" "$TOOLKIT_CLI" setup-preview
"$TOOLKIT_NODE" "$TOOLKIT_CLI" init --target all --project "$TOOLKIT_PROJECT"
"$TOOLKIT_NODE" "$TOOLKIT_CLI" doctor --target all --project "$TOOLKIT_PROJECT"
```

Set `TOOLKIT_PROJECT` to an existing project. Use `--target claude` or `--target codex` for one client. Project discovery uses `.claude/skills/scoped-edit` and `.agents/skills/scoped-edit`. Start a new client session in that project and ask to edit your saved diagram. `--scope user` explicitly selects personal skill installation instead of a project.

The installed skill records the absolute Node and CLI paths. Keep both installations available; rerun `init` and update any MCP registration if either path changes, such as when switching Node versions. Ownership hashes protect modified or unrelated skills during update and uninstall. A successful `doctor` checks the installed skill and Chromium executable, not whether a model has loaded or followed the skill.

### Install without a global prefix

To keep the toolkit in a dedicated writable directory, use this alternative, then run `setup-preview`, `init`, and `doctor` as above:

```sh
TOOLKIT_INSTALL="/absolute/path/to/toolkit-install"
npm install --prefix "$TOOLKIT_INSTALL" --omit=dev excalidraw-toolkit@0.2.0
TOOLKIT_NODE="$(node -p 'process.execPath')"
TOOLKIT_CLI="$TOOLKIT_INSTALL/node_modules/excalidraw-toolkit/bin/cli.js"
```

Use a stable directory. A temporary `npx` cache is unsuitable for the absolute paths recorded by the installed skill and persistent MCP connection.

### Update an existing installation

Install `excalidraw-toolkit@0.2.0` again using the same global or local-prefix command, then refresh each project's owned skill and renderer:

```sh
"$TOOLKIT_NODE" "$TOOLKIT_CLI" setup-preview
"$TOOLKIT_NODE" "$TOOLKIT_CLI" update --target all --project "$TOOLKIT_PROJECT"
"$TOOLKIT_NODE" "$TOOLKIT_CLI" doctor --target all --project "$TOOLKIT_PROJECT"
```

For a move from 0.1.0, `init --target … --project …` adds the saved-file workflow. For the separate live-canvas installation, see [live-canvas setup](live-canvas.md). These skill commands do not upgrade the npm package itself.

### Codex connection for scoped edits

Codex's default macOS shell sandbox cannot launch Chromium. Connect the toolkit
as a standard STDIO MCP server for saved-file edits. The server is fixed to one
project directory and exposes only native inspection, validated edits and verified
previews. It exposes no shell execution and rejects outside-project paths, traversal and existing symlinks. Use a trusted workspace: concurrent directory replacement by another local process is outside these filesystem checks.

After installing the project skill and Chromium above, register the server using
Codex's own configuration command:

```sh
TOOLKIT_PROJECT="/absolute/path/to/project"
# Inspect an existing same-name entry before registering; preserve conflicts.
codex mcp get excalidraw_toolkit
codex mcp add excalidraw_toolkit -- "$TOOLKIT_NODE" "$TOOLKIT_CLI" mcp --project "$TOOLKIT_PROJECT"
```

`codex mcp add` is a persistent user registration. Use an unused name if an existing
entry belongs to another installation. The project skill installer prints the
exact server command and arguments but does not modify Codex configuration. A
trusted project's `.codex/config.toml` or per-invocation `-c mcp_servers.…` settings
can also register the same command. Start a new Codex session and verify that
`inspect_scene`, `edit_scene` and `read_preview` are available.

The agent uses paths relative to the configured project. Edited copies and
receipts live under `.excalidraw-toolkit/edits/`; preview responses include the
verified before/after images when they fit the response limit. The original file
is preserved. Changing projects requires a connection rooted at the new project.
This connection supplies scoped edits; source-comparison and CI commands use the
CLI on a host that can run the renderer.

Remove a registration through Codex when you no longer need it, after checking
that it still points to this installation:

```sh
codex mcp get excalidraw_toolkit
codex mcp remove excalidraw_toolkit
```

Project skill uninstall removes only its owned skill files. It does not delete a
separately registered MCP connection. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

```sh
"$TOOLKIT_NODE" "$TOOLKIT_CLI" uninstall --target all --project "$TOOLKIT_PROJECT"
```

After removing the owned skills and any MCP registration, a global npm installation can be removed with `npm uninstall --global excalidraw-toolkit`.

## Source checkout or packed archive

For development, use Node 24.15+ in the 24.x line (or Node 26+), Git, `tar`, and npm 12.0.2:

```sh
git clone https://github.com/edwingao28/excalidraw-toolkit.git
cd excalidraw-toolkit
npx --yes npm@12.0.2 ci
npx --yes npm@12.0.2 run build
TOOLKIT_NODE="$(node -p 'process.execPath')"
TOOLKIT_CLI="$PWD/bin/cli.js"
```

Run `setup-preview`, `init`, and `doctor` from the npm instructions with these paths. Keep the checkout available because the installed skill references it. A checkout follows its Git revision; it is independent of the npm release version. Use `git rev-parse HEAD` to record the source revision being built.

To build and install a separate archive, set dedicated output/install directories from the checkout:

```sh
TOOLKIT_ARCHIVES="/absolute/path/to/toolkit-archives"
TOOLKIT_INSTALL="/absolute/path/to/toolkit-install"
mkdir -p "$TOOLKIT_ARCHIVES"
npx --yes npm@12.0.2 pack --pack-destination "$TOOLKIT_ARCHIVES"
npx --yes npm@12.0.2 install --prefix "$TOOLKIT_INSTALL" --omit=dev --ignore-scripts \
  "$TOOLKIT_ARCHIVES/excalidraw-toolkit-0.2.0.tgz"
TOOLKIT_CLI="$TOOLKIT_INSTALL/node_modules/excalidraw-toolkit/bin/cli.js"
```

`pack` builds the distributable before creating the archive. Installation uses those built assets and does not run a consumer build. Run `setup-preview`, `init`, and `doctor` with the new CLI path, and update any MCP registration to use it.

## Linux browser dependencies

`setup-preview` downloads Chromium. On a minimal Linux host, install the required system libraries with Playwright before rendering. Use the Playwright version pinned by this release:

```sh
npx --yes playwright@1.63.0 install --with-deps chromium
```

The system-package step may need administrator privileges. The [CI example](../examples/ci/diagram-artifacts.yml) installs the same build and browser prerequisites on Ubuntu.

## Development checks

From the source checkout, with the build prerequisites above:

```sh
npx --yes npm@12.0.2 ci
npx --yes npm@12.0.2 run build
npx playwright install chromium
node --test
```

The tests use temporary configuration and task-owned runtimes. The test matrix builds under Node 24, then checks runtime behavior under Node 20 and 24.

## A separate live-canvas workflow

New diagrams can use the Claude Code live-canvas integration. Its setup and lifecycle are covered in [live-canvas workflows](live-canvas.md); bare `init` selects that integration, while `init --target … --project …` installs the saved-file skill.
