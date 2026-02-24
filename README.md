# Excalidraw Diagrams

A Claude Code skill for generating architecture diagrams on a live Excalidraw canvas — from any codebase, in any language.

## What This Does

**Excalidraw Diagrams** lets you turn codebases into visual architecture diagrams without touching a design tool. Point Claude Code at your project, describe what you want to visualize, and watch it build the diagram in real time on a live canvas.

### Key Features

- **Zero Manual Drawing** — Describe what you want. Claude reads your code, identifies components, and draws the diagram.
- **Live Canvas** — Watch shapes and arrows appear in real time in your browser. Not a static image generator.
- **Auto-Routing Arrows** — Connect components by ID. Arrows find the shortest path to shape edges automatically.
- **Color-Coded by Role** — Databases are green, APIs are purple, frontends are blue. Consistent visual language across all diagrams.
- **Any Codebase** — Works with Python, TypeScript, Go, Rust, Java — whatever your project uses.
- **Multiple Exports** — PNG for docs, SVG for web, `.excalidraw` for editing, or a shareable URL.

## Examples

<!-- TODO: Add generated example images -->

### Microservices Architecture

A typical web application with frontend, API gateway, microservices, message queue, and databases.

<!-- ![Microservices Architecture](examples/microservices.png) -->

### CI/CD Pipeline

A horizontal flow showing the journey from code push to production deployment.

<!-- ![CI/CD Pipeline](examples/cicd-pipeline.png) -->

### Event-Driven System

Hub-and-spoke pattern with a central event bus connecting producers and consumers.

<!-- ![Event-Driven System](examples/event-driven.png) -->

### Data Pipeline

ETL flow from data sources through transformation stages to analytics and storage.

<!-- ![Data Pipeline](examples/data-pipeline.png) -->

## Installation

### For Claude Code Users (Plugin)

```bash
# Add the marketplace
/plugin marketplace add edwingao28/excalidraw-skill

# Install the plugin
/plugin install excalidraw@excalidraw-skill
```

### Manual Download

1. Download the `skills/excalidraw/` folder from this repo
2. Place it in `~/.claude/skills/excalidraw/`
3. Restart Claude Code

## Prerequisites

This skill requires the **Excalidraw MCP server** to be running. Add it to your Claude Code MCP config:

```json
{
  "excalidraw": {
    "command": "npx",
    "args": ["@pinkpixel/excalidraw-mcp"]
  }
}
```

Then open the canvas URL printed in the server logs. The canvas must be open in a browser for screenshots and image export to work.

## Usage

### Visualize a Codebase

```
"Draw a diagram of this project's architecture"
```

The skill will:
1. Read your codebase to identify components and connections
2. Clear the canvas and read the design guide
3. Plan a layout with proper spacing and color coding
4. Create all shapes and arrows in a single batch call
5. Screenshot to verify, adjust if needed
6. Export to your preferred format

### Quick Diagram from Description

```
"Draw a microservices diagram with a React frontend, API gateway,
three backend services, a message queue, and a PostgreSQL database"
```

### Trace a Data Flow

```
"Trace how the auth token flows from login to API request to database query"
```

The skill supports parameter threading diagrams — tracing a value through architectural layers with split/converge paths and decision nodes.

### Convert from Mermaid

```
"Create an excalidraw diagram from this mermaid:
graph TD; A[Frontend] -->|REST| B[API]; B -->|SQL| C[Database]"
```

## How It Works

The skill uses **Excalidraw MCP tools** — no raw JSON manipulation needed:

| Tool | Purpose |
|------|---------|
| `batch_create_elements` | Create all shapes + arrows in one call |
| `get_canvas_screenshot` | Visual verification after each step |
| `read_diagram_guide` | Load color palette and sizing rules |
| `export_to_image` | Save as PNG or SVG |
| `export_scene` | Save as editable `.excalidraw` file |
| `export_to_excalidraw_url` | Generate a shareable link |
| `create_from_mermaid` | Quick diagram from Mermaid syntax |

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
| Zone/Group | `#e9ecef` | `#868e96` |

Cloud-specific palettes (AWS, Azure, GCP, Kubernetes) are included in `references/colors.md`.

## Layout Patterns

The skill knows four layout strategies and picks the right one for your diagram:

- **Vertical Flow** — Top-to-bottom layers. Best for web architectures, request flows.
- **Horizontal Pipeline** — Left-to-right stages. Best for CI/CD, data pipelines, ETL.
- **Hub and Spoke** — Central node with radiating connections. Best for event-driven systems.
- **Data Flow** — Multi-column with annotations. Best for parameter threading, call chain traces.

## Files

| File | Purpose |
|------|---------|
| `skills/excalidraw/SKILL.md` | Main skill — workflow, examples, layout patterns, sizing rules |
| `skills/excalidraw/references/colors.md` | Color palettes for default, AWS, Azure, GCP, Kubernetes |

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Excalidraw MCP server](https://www.npmjs.com/package/@pinkpixel/excalidraw-mcp) running and connected
- A browser with the Excalidraw canvas open

## Credits

Created by [@edwingao28](https://github.com/edwingao28) with Claude Code.

## License

MIT — Use it, modify it, share it.
