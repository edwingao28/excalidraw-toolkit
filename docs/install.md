# Install and connect your agent

## Source checkout or packed archive


The current workflows are implemented on `main`; npm 0.2.0 has not been published. The [README quickstart](../README.md#get-started) runs directly from a built checkout. To install a separate archive, clone the repository first and use Node 24.15+ in the 24.x line (or Node 26+), Git, `tar`, and npm 12.0.2. Set these paths to your checkout and dedicated output/install directories:

```sh
TOOLKIT_SOURCE="/absolute/path/to/excalidraw-toolkit"
TOOLKIT_ARCHIVES="/absolute/path/to/toolkit-archives"
TOOLKIT_INSTALL="/absolute/path/to/toolkit-install"

cd "$TOOLKIT_SOURCE"
npx --yes npm@12.0.2 ci
mkdir -p "$TOOLKIT_ARCHIVES"
npx --yes npm@12.0.2 pack --pack-destination "$TOOLKIT_ARCHIVES"
npx --yes npm@12.0.2 install --prefix "$TOOLKIT_INSTALL" --omit=dev --ignore-scripts \
  "$TOOLKIT_ARCHIVES/excalidraw-toolkit-0.2.0.tgz"

TOOLKIT_CLI="$TOOLKIT_INSTALL/node_modules/excalidraw-toolkit/bin/cli.js"
node "$TOOLKIT_CLI" init --target all --project "/absolute/path/to/project"
node "$TOOLKIT_CLI" setup-preview
node "$TOOLKIT_CLI" doctor --target all --project "/absolute/path/to/project"
```

`pack` builds the distributable before creating the archive. The archive installation uses those built assets; it does not run a consumer build. Commands below use the same `TOOLKIT_CLI` path.

Use `--target claude` or `--target codex` for one client. Project discovery uses `.claude/skills/scoped-edit` and `.agents/skills/scoped-edit`. Start a new client session in that project and ask to edit your saved diagram. The installed skill records the absolute CLI path; keep that installation directory available. `--scope user` explicitly selects personal installation instead of a project. Ownership hashes protect modified or unrelated skills during update and uninstall. Separate installed Claude Code skill/CLI and Codex scoped-MCP sessions have completed native editing and preview review. A successful `doctor` checks the installed skill, not whether a model has loaded or followed it.

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
codex mcp add excalidraw_toolkit -- node "$TOOLKIT_CLI" mcp --project "$TOOLKIT_PROJECT"
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
node "$TOOLKIT_CLI" uninstall --target all --project "/absolute/path/to/project"
```


## Linux browser dependencies

`setup-preview` downloads Chromium. On a minimal Linux host, install the required system libraries with Playwright before rendering. From the source checkout:

```sh
npx playwright install --with-deps chromium
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
