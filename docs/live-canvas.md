# Create diagrams on a live canvas

This is a separate Claude Code workflow for creating new diagrams. For edits to a saved file, use [scoped editing](scoped-edit.md). Set `TOOLKIT_CLI` using the [installation guide](install.md).

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


## Codebase overview


Just say **"diagram this repo"**. No description needed.

The auto-diagram skill runs a 6-phase pipeline:
1. **Detect** project type (monorepo, microservices, standard app) and framework (Next.js, Django, Go, Rails, etc.)
2. **Discover** components (frontend, API routes, database, queues, cache, auth, external services)
3. **Map** connections with source references, distinguishing imports, observed calls, and assumptions
4. **State scope** and unresolved questions, then proceed with the requested diagram; clarify only material ambiguity
5. **Choose layout** (vertical flow, horizontal pipeline, hub-and-spoke, or zoned modules)
6. **Generate** the diagram on the live canvas with color-coded components

Analysis is bounded to selected files and entry points. The result names its scope and gaps; detected imports alone do not prove runtime calls.

## Review and correction

The agent inspects the generated artifact and makes at most two corrective passes within the requested scope:

1. **Inspect** the saved-file receipt and before/after PNGs, or query and screenshot a new live diagram
2. **Check** label fit, arrow endpoints, readability, and preserved surrounding content
3. **Correct** only supported operations on the intended elements, then inspect again
4. **Deliver** the native file and preview with any remaining issues or missing verification stated

Existing saved diagrams use scoped file edits. Live-canvas creation preserves unrelated elements; clearing requires an explicit request to replace the current canvas. A snapshot is a convenience for an exclusively owned live scene, not a transaction or a guarantee that every visual issue is repaired.

## Described diagrams

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
| ![Markdown](../examples/microservices-markdown.png) | ![Excalidraw](../examples/microservices-excalidraw.png) |

### CI/CD Pipeline

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](../examples/cicd-pipeline-markdown.png) | ![Excalidraw](../examples/cicd-pipeline-excalidraw.png) |

### Event-Driven System

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](../examples/event-driven-markdown.png) | ![Excalidraw](../examples/event-driven-excalidraw.png) |

### Data Pipeline

| Markdown | Excalidraw |
|:---:|:---:|
| ![Markdown](../examples/data-pipeline-markdown.png) | ![Excalidraw](../examples/data-pipeline-excalidraw.png) |


## Color palette


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

Cloud-specific palettes (AWS, Azure, GCP, Kubernetes) are included in the [palette reference](../plugins/excalidraw/skills/excalidraw/references/colors.md).


The packaged backend is `mcp-excalidraw-server` 2.0.0. Other servers with similarly named tools need their own qualification. See the [runtime reference](runtime.md).
