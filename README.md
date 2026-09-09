# Excalidraw Toolkit

Scoped editing of saved Excalidraw files for Claude Code and Codex, plus a separate live-canvas workflow for new diagrams. Ask to recolor or relabel an existing diagram, or say **"diagram this repo"** to build an overview from inspected source.

```
> diagram this repo

I found 6 components and 5 connections:
  - Next.js Frontend → API Routes (REST)
  - API Routes → Prisma ORM → PostgreSQL (SQL)
  - API Routes → NextAuth (auth) + Stripe API (payments)

[Building diagram on live canvas...]
```

## Install

These features are a development candidate; version 0.2.0 has not been published to the registry. Build the checkout containing these changes and install its archive in a stable directory. Use Node.js 24 and npm 12.0.2 for this build:

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

Use `--target claude` or `--target codex` for one client. Project discovery uses `.claude/skills/scoped-edit` and `.agents/skills/scoped-edit`. Start a new client session in that project and ask to edit your saved diagram. The installed skill records the absolute CLI path; keep that installation directory available. `--scope user` explicitly selects personal installation instead of a project. Ownership hashes protect modified or unrelated skills during update and uninstall. These client installation routes are implemented; actual packed-client discovery and editing acceptance must pass separately for Claude Code and Codex before either is release-qualified. A successful `doctor` checks the installed skill, not whether a model has loaded or followed it.

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

For new live-canvas diagrams in Claude Code, use the separate MCP setup. It is not needed for saved-file editing:

```bash
node "$TOOLKIT_CLI" init
node "$TOOLKIT_CLI" start
```

`init` copies skills to `~/.claude/plugins/` and configures the MCP server. `start` launches the pinned, packaged canvas and opens your browser after its identity and readiness checks pass. Node.js 20 or newer is required; runtime setup does not clone or build a Git repository.

Setup writes the user-scope MCP entry to `~/.claude.json` and records its exact value in `~/.claude/plugins/excalidraw-toolkit/install-state.json`. Other settings and MCP servers are preserved. Invalid JSON or a conflicting `excalidraw` entry stops setup before configuration changes; move or rename the conflicting entry to keep both integrations. Configuration files are replaced atomically with their existing permissions. Symlinked configuration is rejected rather than replaced.

An older entry pointing to this toolkit's own bridge can be migrated from `~/.claude/settings.json`. A generic `npx mcp-excalidraw-server` entry cannot establish ownership and is left intact. Uninstall removes only unchanged owned entries. If an entry was modified or is unowned, it and the installed bridge files are retained and reported for manual inspection.

Setup operations are serialized by a local lock. A crash can leave the lock directory named in the error; remove it only after confirming no setup process is running. Writes also check for intervening changes from other applications, but this is not an atomic transaction with an external editor or across both configuration files. An interrupted upgrade retains the old and intended entry in its ownership record so setup can resume.

Restart Claude Code and try: **"diagram this repo"**

Verify setup with:

```bash
node "$TOOLKIT_CLI" doctor
node "$TOOLKIT_CLI" status --json
```

Run `npm test` from the source checkout after building. Tests use temporary configuration and owned runtime fixtures; they do not write your real home configuration.

## What You Get

### Scoped edits to saved diagrams

Install the pinned renderer once, then inspect a native file to obtain its hash, element IDs, and supported operations:

```bash
node "$TOOLKIT_CLI" setup-preview
node "$TOOLKIT_CLI" inspect "architecture.excalidraw"
```

Save a request as `edit.json`, using the returned `baseHash` and target ID:

```json
{
  "requestId": "recolor-api-001",
  "baseHash": "<hash from inspect>",
  "operations": [
    { "op": "setStyle", "targetId": "api", "style": { "backgroundColor": "#a5d8ff" } }
  ]
}
```

```bash
node "$TOOLKIT_CLI" edit "architecture.excalidraw" --request "edit.json" --output "results"
node "$TOOLKIT_CLI" preview "results/recolor-api-001/receipt.json"
```

The command returns a receipt linking `before.excalidraw`, `after.excalidraw`, and
before/after PNG previews. It preserves the input bytes, image assets, unknown
metadata, deleted elements, IDs, order, and every field outside the requested
style properties. Native rendering consumes a separate copy of each scene.

`setStyle` changes fill or stroke colors on rectangles, ellipses, and diamonds.
Use hex RGB/RGBA colors or `transparent`.

`setLabel` updates an unrotated rectangle's existing bound text:

```json
{ "op": "setLabel", "targetId": "api", "text": "Shared cache" }
```

It measures and wraps using the bundled native Excalidraw fonts, while preserving
the container, font size, alignment, and existing text anchor. Manually sized text
boxes retain their width. A label that cannot fit returns `TEXT_OVERFLOW` before
writing candidate files. Bundled font families 1, 3, 5, 6, 7, 8, and 9 are supported;
CJK text requires Excalifont (5) with its bundled Xiaolai fallback. System Helvetica,
rotated labels, and labels on other container shapes are currently unsupported.
Unrelated element types pass through unchanged; unsupported targets or operations
fail explicitly. A label repair requires a new scoped request, never an implicit
font shrink or container resize.

`move` places a supported shape at absolute coordinates:

```json
{ "op": "move", "targetId": "worker", "x": 600, "y": 200 }
```

| Geometry | Movement support |
| --- | --- |
| Unrotated rectangle, ellipse, diamond | Translate the shape and its existing bound label. |
| Straight two-point arrow, center bindings (`focus: 0`) | Reanchor both bound ends using the original binding gaps; free endpoints remain fixed. |
| Bound arrow label | Preserve its offset from the segment midpoint and its existing text metrics. |
| Rotated shapes/labels, elbow or multipoint arrows, fixed-point or nonzero-focus bindings | Reject when connected to the requested move; unrelated objects remain unchanged. |
| Rounded shapes with bound arrows | Reject because this version does not reproduce rounded-outline routing. |
| Nested containers | Reject moving the container alone; existing frame membership and zone containment are preserved when moving a child. |

Paths must already match their center bindings; a manually adjusted route is not
replaced automatically. Multiple moves in one request update shared arrows once.
A combined move/relabel request moves first, then measures the new label at its
translated anchor. New or worsened bounding-box overlaps and new straight-arrow
crossings fail with `GEOMETRY_COLLISION`; unrelated existing overlaps remain intact.
This check is conservative for nonrectangular shapes and is not an automatic
layout engine. Inspect the delivered preview before adopting the result.

`addNode` and `connect` add content with explicit stable IDs:

```json
[
  {
    "op": "addNode", "id": "queue", "type": "rectangle",
    "x": 200, "y": 160, "width": 140, "height": 80,
    "region": { "x": 180, "y": 150, "width": 180, "height": 100 },
    "label": { "id": "queue-label", "text": "Queue" }
  },
  { "op": "connect", "id": "enqueue", "fromId": "api", "toId": "queue" },
  { "op": "connect", "id": "dequeue", "fromId": "queue", "toId": "worker" }
]
```

Put these operations in the same request envelope used above. New IDs, including
label IDs, must not collide with any existing or deleted element. Native seeds and
version nonces derive from those IDs, so recovery recreates the same candidate.
An explicitly repeated relationship under a different ID is a separate addition.

Nodes require a placement region and explicit dimensions. Labels use the native
font measurement and fit rules; rectangle, ellipse, and diamond interiors are
supported. A region may include `containerId` to authorize placement inside an
existing rectangle or frame. Frames also establish native `frameId` membership.
New overlaps or straight-arrow crossings fail rather than rearranging other
content. Connections reuse the supported center-binding geometry with a default
10px gap. Existing moves and label/style edits run before additions; newly added
nodes can be connected in that request and edited further in a subsequent request.

`remove` marks an element and its owned bound labels deleted. A connected node
requires an explicit choice for its arrows:

```json
{ "op": "remove", "targetId": "obsolete-service", "connections": "remove" }
```

Use `connections: "detach"` to retain the arrows as free-ended paths, including
their labels. To remove just an obsolete edge, use
`{"op":"remove","targetId":"old-edge"}`. Native tombstones retain their other
fields, and image assets remain in the document. Removing a frame with retained
children fails; identify those children explicitly if they should also be removed.

`disconnect` detaches selected arrow endpoints while keeping its path and label:

```json
{ "op": "disconnect", "targetId": "old-edge", "end": "both" }
```

`end` accepts `start`, `end`, or `both`. Reciprocal bindings on retained objects
are updated without changing the remaining connected endpoint. Removal and
disconnection run before moves, relabeling, and additions, so a single request can
replace a direct connection with a queue flow without leaving an intermediate
diagram. The receipt lists every changed ID/property; the original snapshot remains
the recovery artifact.

A retry with the same request ID and payload returns its existing verified
bundle. Different payloads under that ID conflict. Failed attempts can be retried;
interrupted attempts recover in a new attempt after their owner exits. Concurrent
attempts return `REQUEST_BUSY`; keep the result directory on the same host.
If the source changed before a new attempt, inspect it again and create a new
request. A completed retry always returns its recorded result, even if the source
subsequently changed. Inspect the previews and reopen the delivered native file
before adopting it; the command does not overwrite an open editor's file.

### Auto-Diagram — Codebase Overview

Just say **"diagram this repo"**. No description needed.

The auto-diagram skill runs a 6-phase pipeline:
1. **Detect** project type (monorepo, microservices, standard app) and framework (Next.js, Django, Go, Rails, etc.)
2. **Discover** components (frontend, API routes, database, queues, cache, auth, external services)
3. **Map** connections with source references, distinguishing imports, observed calls, and assumptions
4. **State scope** and unresolved questions, then proceed with the requested diagram; clarify only material ambiguity
5. **Choose layout** (vertical flow, horizontal pipeline, hub-and-spoke, or zoned modules)
6. **Generate** the diagram on the live canvas with color-coded components

Analysis is bounded to selected files and entry points. The result names its scope and gaps; detected imports alone do not prove runtime calls.

### Agentic Self-Critique

The agent inspects the generated artifact and makes at most two corrective passes within the requested scope:

1. **Inspect** the saved-file receipt and before/after PNGs, or query and screenshot a new live diagram
2. **Check** label fit, arrow endpoints, readability, and preserved surrounding content
3. **Correct** only supported operations on the intended elements, then inspect again
4. **Deliver** the native file and preview with any remaining issues or missing verification stated

Existing saved diagrams use scoped file edits. Live-canvas creation preserves unrelated elements; clearing requires an explicit request to replace the current canvas. A snapshot is a convenience for an exclusively owned live scene, not a transaction or a guarantee that every visual issue is repaired.

### Described Diagrams

When you know what you want, describe it:

```
"Draw a microservices architecture with: React frontend, API Gateway,
Auth Service, User Service, Order Service, RabbitMQ, PostgreSQL, Redis"
```

Or trace data flows:

```
"Trace how the auth token flows from login to API request to database query"
```

Or convert from Mermaid:

```
"Create an excalidraw diagram from this mermaid:
graph TD; A[Frontend] -->|REST| B[API]; B -->|SQL| C[Database]"
```

## Examples

Same prompt, two renderers: **Markdown** (Mermaid via `create_from_mermaid`) vs **Excalidraw** (native canvas via `batch_create_elements`).

### Microservices Architecture

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](examples/microservices-markdown.png) | ![Excalidraw](examples/microservices-excalidraw.png) |

### CI/CD Pipeline

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](examples/cicd-pipeline-markdown.png) | ![Excalidraw](examples/cicd-pipeline-excalidraw.png) |

### Event-Driven System

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](examples/event-driven-markdown.png) | ![Excalidraw](examples/event-driven-excalidraw.png) |

### Data Pipeline

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](examples/data-pipeline-markdown.png) | ![Excalidraw](examples/data-pipeline-excalidraw.png) |

## Architecture

The package ships the CLI, skills, and built assets:

| Layer | What ships |
|-------|------------|
| **Native file editing** | Scoped CLI operations, receipts, and an isolated preview renderer; Chromium is installed with `setup-preview` |
| **Skills** | A client-installed `scoped-edit` skill with an absolute CLI path, plus the legacy live-canvas skills |
| **MCP backend** | Node bundles built from pinned [mcp-excalidraw-server](https://github.com/yctimlin/mcp_excalidraw) 2.0.0 with source and output hashes |
| **Live canvas** | Rebuilt frontend and fonts served locally after identity and readiness checks |

Incoming canvas labels load their bundled font faces before layout is measured. If a required font fails to load, scene replacement and backend sync remain paused; after restoring the local assets, reload the page to retry failed browser font faces. Helvetica uses the operating system font rather than a bundled face.

![Architecture](examples/architecture.png)

## How It Works

Choose the workflow by task:

| Skill | Triggers On | Does |
|-------|-------------|------|
| **scoped-edit** | Edits to an existing saved `.excalidraw` file | Inspects capabilities and IDs, applies scoped edits, checks previews, returns artifacts |
| **auto-diagram** | "diagram this repo", "visualize the architecture" | Analyzes codebase, discovers components, generates diagram |
| **excalidraw** | "draw a diagram of X", user provides description/sample | Renders user-specified diagrams with precise layout control |

The new-diagram branches of `auto-diagram` and `excalidraw` use the live MCP canvas:

| Tool | Purpose |
|------|---------|
| `batch_create_elements` | Create all shapes + arrows in one call |
| `get_canvas_screenshot` | Visual verification after each step |
| `query_elements` | Geometric validation for self-critique |
| `snapshot_scene` / `restore_snapshot` | Optional checkpoint for an exclusively owned live scene |
| `export_to_image` | Save as PNG or SVG |
| `export_scene` | Save as editable `.excalidraw` file |
| `export_to_excalidraw_url` | Generate a shareable link |

## Color Palette

Every component type gets a consistent color:

| Component | Background | Stroke |
|-----------|------------|--------|
| Frontend/UI | `#a5d8ff` | `#1971c2` |
| Backend/API | `#d0bfff` | `#7048e8` |
| Database | `#b2f2bb` | `#2f9e44` |
| AI/ML | `#e599f7` | `#9c36b5` |
| Queue/Event | `#fff3bf` | `#fab005` |
| External API | `#ffc9c9` | `#e03131` |
| Storage | `#ffec99` | `#f08c00` |
| Cache | `#ffe8cc` | `#fd7e14` |
| Zone/Group | `#e9ecef` | `#868e96` |

Cloud-specific palettes (AWS, Azure, GCP, Kubernetes) are included in `references/colors.md`.

## CLI Commands

Use the installed absolute CLI path from the installation example:

```sh
node "$TOOLKIT_CLI" --help
node "$TOOLKIT_CLI" init --target all --project "/absolute/path/to/project"
node "$TOOLKIT_CLI" doctor --target all --project "/absolute/path/to/project"
node "$TOOLKIT_CLI" inspect "/absolute/path/diagram.excalidraw"
node "$TOOLKIT_CLI" setup-preview
node "$TOOLKIT_CLI" version

# Separate Claude Code live-canvas integration
node "$TOOLKIT_CLI" init
node "$TOOLKIT_CLI" start
node "$TOOLKIT_CLI" status --json
node "$TOOLKIT_CLI" stop
node "$TOOLKIT_CLI" update       # refresh unchanged owned installation files/config
node "$TOOLKIT_CLI" uninstall    # preserve modified or unowned configuration
```

Use `--target all --project "/absolute/path/to/project"` with `uninstall` to remove the unchanged owned project skills. `inspect` reports the installed operation set and restrictions; unsupported edits return a limitation instead of regenerating the scene.

## Backend Support

The live-canvas integration targets the packaged `mcp-excalidraw-server` 2.0.0 backend and checks its identity. Other servers with similar tool names are not qualified by that check. Saved-file editing uses the native CLI and does not require an MCP registration.

## Requirements

- Node.js 24 and npm 12.0.2 to build this candidate; the package declares Node.js 20 or newer for runtime
- Claude Code or Codex CLI for their respective scoped-edit skill routes; real-client acceptance is tracked separately above
- Chromium installed by `setup-preview` for native PNG previews
- A browser for the separate live canvas (default http://localhost:3000)

## Credits

Created by [@edwingao28](https://github.com/edwingao28) with Claude Code.

## License

MIT
