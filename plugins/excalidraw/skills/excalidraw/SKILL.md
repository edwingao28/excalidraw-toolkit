---
name: excalidraw
description: Edit saved native Excalidraw diagrams with scoped file operations, or generate diagrams from specified components, a sample, or a description. Use for diagram edits, data flows, parameter traces, and PNG/SVG exports. For codebase discovery, use auto-diagram.
---

# Excalidraw Diagram Generator (MCP Edition)

For an existing saved diagram, use the file workflow below. For a new diagram, use the live canvas workflow that follows it.

## Edit an existing saved diagram

Load the installed `scoped-edit` skill when the user asks to modify a saved `.excalidraw` file, including recoloring or relabeling it. The project installation places it in `.claude/skills/scoped-edit/SKILL.md` for Claude Code or `.agents/skills/scoped-edit/SKILL.md` for Codex. Its generated command prefix records the absolute Node and CLI paths; keep those paths unchanged.

Follow that skill's inspect → supported request → edited copy → receipt and PNG inspection workflow. `inspect` determines the available operations and target restrictions. Report missing installation or an unsupported operation explicitly. Preserve the saved scene and its original bytes; canvas clearing or regeneration does not implement a scoped edit. The remaining steps apply to new live diagrams.

---

## Mental Model

You are **placing shapes on a 2D canvas** and **drawing arrows between them**.

```
(0,0) ────────── x increases ──────────►
  │
  │   ┌──────────┐      ┌──────────┐
  │   │  Box A   │─────►│  Box B   │
  │   └──────────┘      └──────────┘
  │         │
  y         ▼
  increases ┌──────────┐
  │         │  Box C   │
  ▼         └──────────┘
```

**Everything is (x, y, width, height).** That's it.

---

## The 5 Tools You Actually Need

| Tool | What It Does | When to Use |
|------|-------------|-------------|
| `read_diagram_guide` | Returns color palette + sizing rules | **First call.** Read once, use throughout. |
| `batch_create_elements` | Create many shapes + arrows at once | Main workhorse. Create your whole diagram in 1-2 calls. |
| `get_canvas_screenshot` | Take a photo of the current canvas | **After every batch.** Verify it looks right. |
| `clear_canvas` | Replace the current scene with an empty canvas | Only when the user explicitly requests replacement of the current canvas. |
| `export_to_image` | Save as PNG or SVG | Final step if user wants an image file. |

Other useful tools: `describe_scene` (text description of canvas), `create_from_mermaid` (quick diagram from Mermaid syntax), `export_scene` (save as .excalidraw JSON file), `set_viewport` (zoom/pan to fit), `export_to_excalidraw_url` (shareable link).

---

## How Shapes Work

A shape has: **type, position (x, y), size (width, height), colors, and label text.**

```json
{
  "type": "rectangle",
  "id": "my-box",
  "x": 100,
  "y": 100,
  "width": 180,
  "height": 70,
  "backgroundColor": "#a5d8ff",
  "strokeColor": "#1971c2",
  "roughness": 0,
  "text": "My Service\nPort 8080"
}
```

**Key points:**
- `text` puts a label directly inside the shape (MCP handles the binding for you)
- `roughness: 0` = clean lines. `roughness: 1` = hand-drawn look.
- Use `\n` for multi-line labels
- Shapes: `rectangle`, `ellipse`, `diamond`, `text` (standalone)

---

## How Arrows Work

New arrows connect shapes **by ID**. The MCP creation helper computes endpoint positions; inspect the resulting geometry and screenshot before considering the connection complete.

```json
{
  "type": "arrow",
  "x": 0,
  "y": 0,
  "startElementId": "my-box",
  "endElementId": "other-box",
  "strokeColor": "#1971c2",
  "text": "HTTP"
}
```

**Key points:**
- `startElementId` / `endElementId` = the `id` of the shape to connect to
- Supply the endpoint shape IDs and the coordinates required by the installed tool schema.
- Binding references alone do not guarantee rerouting after a shape moves. Check arrow points, bound labels, and the rendered result after any geometry change.
- `text` adds a label on the arrow
- `strokeStyle: "dashed"` = async/optional flows. `"dotted"` = weak dependency.
- `startArrowhead` / `endArrowhead` = `"arrow"`, `"dot"`, `"triangle"`, `"bar"`, or `null`

---

## Step-by-Step Workflow

### Step 1: Understand What to Draw

Read the codebase. Identify:
- **Components** (services, databases, APIs, queues, frontends)
- **Connections** (which components talk to which, and how)
- **Layers** (group related components into rows or zones)

Record source paths and relevant line ranges or symbols for code-derived components and connections. Distinguish imports, observed call sites, and assumptions; an import or valid source reference alone does not prove a runtime interaction. State unresolved connections and the inspected scope. Proceed with a clear diagram request; ask only when a material ambiguity prevents selecting the content or target.

**When a sample diagram is provided** (ASCII art, text mockup, screenshot, etc.):
- **Preserve ALL text and detail from the sample by default.** Do not simplify, summarize, or omit labels, annotations, bullet points, or sublabels present in the sample.
- Extract every node's full text (titles, subtitles, tool names, metrics, details) and reproduce it verbatim in shape labels using `\n` for multiline.
- Preserve section headers, status annotations (e.g. "Fail = Stop & Notify"), and arrow labels exactly as written.
- Size boxes large enough to fit the full text (increase height/width beyond defaults as needed).
- The sample is the **source of truth** for content — you may improve layout, colors, and styling, but never drop information.

### Step 2: Read the Design Guide

```
mcp__excalidraw__read_diagram_guide()
```

This returns the color palette, sizing rules, and layout best practices. Use it.

### Step 3: Inspect the Current Canvas

Call `query_elements` and `get_canvas_screenshot` before creating elements. Record existing IDs and choose an empty region for the new diagram. Use fresh IDs for this request and preserve unrelated elements.

`clear_canvas` replaces the entire current scene. Use it only when the user explicitly requests that replacement, then inspect the result before drawing. If the user asks to modify existing live content and its target is ambiguous, resolve the target first; the new-diagram recipe does not authorize replacing it.

### Step 4: Plan Your Layout on Paper

Before calling any create tool, sketch the layout mentally:

```
Vertical flow (most common):
  Row 1 (y=0):    Zone backgrounds (large dashed rectangles)
  Row 2 (y=60):   Entry points / Users
  Row 3 (y=350):  Middle layer (APIs, services)
  Row 4 (y=650):  Data layer (databases, storage)

  Columns: x = 40, 440, 840  (spaced 400px apart for labeled arrows)
  Box size: 230 x 160 (standard)  |  200 x 120 (for decision diamonds)
  Spacing between rows: ~200px gap after accounting for box height
  Spacing between boxes in a row: 180px gap (for arrow labels)
```

### Step 5: Create Everything in One Batch

Call `batch_create_elements` with the new diagram's elements, shapes before their arrows. The helper can resolve references to shapes in the same batch. Inspect the response for partial failures; query the request's IDs before retrying so successful elements are not duplicated.

**Order of elements in the array:**
1. Zone backgrounds (large dashed rectangles) — so they render behind everything
2. Shapes (rectangles, ellipses, diamonds) — with `id` set for arrow references
3. Arrows — using `startElementId` / `endElementId`
4. Standalone text labels (titles, annotations)

### Step 6: Self-Critique Loop (automatic)

Inspect every generated diagram, including small diagrams. Check geometry and the actual screenshot before delivery, with at most two corrective passes.

**6a. Record the affected elements**

Limit corrections to the IDs created for this request and record their current values. A snapshot is optional only for a scene exclusively owned by this task. Whole-scene restore replaces other content too; use it only while exclusive ownership and the absence of intervening edits are established. Otherwise, repair the affected fields or report the remaining issue.

**6b. Geometric validation (via query_elements)**

```
mcp__excalidraw__query_elements({})
```

Check element positions and sizes programmatically:

| Check | Detect | Fix |
|-------|--------|-----|
| **Overlapping shapes** | Bounding boxes intersect on both axes | Move one element +200px on x or y |
| **Cramped spacing** | Edges <100px apart | Shift apart, recalculate zone boundaries |
| **Zone not wrapping children** | Zone bounds don't contain all children with 50px padding | Recalculate: leftmost_child_x - 50 to rightmost_child_x + width + 60 |
| **Unconnected shapes** | Shape has no arrows referencing its ID (and should) | Add missing arrow or note to user |

**6c. Visual validation (via screenshot)**

```
mcp__excalidraw__get_canvas_screenshot()
```

Check for issues requiring visual judgment:

| Check | Detect | Fix |
|-------|--------|-----|
| **Arrow labels clipped** | Label text cut off or unreadable | Increase gap between connected shapes to 200px+ |
| **Text too small** | Labels hard to read | Increase to 16px minimum |
| **Title missing** | No diagram title visible | Add text element at y = top_element_y - 60 |
| **Diagram off-center** | Content clustered in one corner | `set_viewport({ scrollToContent: true })` |

**6d. Fix and re-check**

Use supported tools to correct only this request's elements, then inspect the geometry and screenshot again. Keep stable IDs. A shape move may require corresponding bound-label and arrow updates; inspect those dependencies explicitly. Avoid delete-and-recreate repairs that silently discard bindings or metadata. If a safe correction is unavailable, retain the result and report the issue.

**Constraints:**
- Max 2 corrective passes. After 2, deliver the artifacts and state remaining problems. If screenshots cannot be inspected, report visual verification as incomplete.
- Only fix layout/visual issues. Do NOT change architectural content.
- Log what you fixed AND what remains unfixed.

### Step 7: Present to User

```
mcp__excalidraw__set_viewport({ scrollToContent: true })
mcp__excalidraw__get_canvas_screenshot()
```

Show the final screenshot and summarize:
- Components and connections generated
- Auto-fixes applied during self-critique (if any)
- Remaining issues (if any)
- Available next actions (export, refine, drill-down)

### Step 8: Export (if requested)

```
mcp__excalidraw__export_to_image({ format: "png", filePath: "/path/to/output.png" })
mcp__excalidraw__export_scene({ filePath: "/path/to/output.excalidraw" })
// Only when the user requests a shareable link:
mcp__excalidraw__export_to_excalidraw_url()
```

---

## Complete Example: 3-Layer Architecture

This shows exactly what to pass to `batch_create_elements`:

```json
{
  "elements": [
    // --- ZONE BACKGROUNDS (render behind everything) ---
    {
      "type": "rectangle", "id": "zone-frontend",
      "x": 0, "y": 0, "width": 500, "height": 160,
      "backgroundColor": "#e9ecef", "strokeColor": "#868e96",
      "strokeStyle": "dashed", "opacity": 40, "roughness": 0
    },
    {
      "type": "text", "x": 10, "y": 10,
      "text": "Frontend Layer", "fontSize": 14, "strokeColor": "#868e96"
    },
    {
      "type": "rectangle", "id": "zone-backend",
      "x": 0, "y": 200, "width": 500, "height": 160,
      "backgroundColor": "#eebefa", "strokeColor": "#9c36b5",
      "strokeStyle": "dashed", "opacity": 30, "roughness": 0
    },
    {
      "type": "text", "x": 10, "y": 210,
      "text": "Backend Layer", "fontSize": 14, "strokeColor": "#9c36b5"
    },

    // --- SHAPES (give each an id so arrows can reference them) ---
    {
      "type": "rectangle", "id": "react-app",
      "x": 40, "y": 50, "width": 180, "height": 70,
      "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2", "roughness": 0,
      "text": "React App\nFrontend"
    },
    {
      "type": "rectangle", "id": "api-server",
      "x": 40, "y": 250, "width": 180, "height": 70,
      "backgroundColor": "#d0bfff", "strokeColor": "#7048e8", "roughness": 0,
      "text": "API Server\nExpress.js"
    },
    {
      "type": "rectangle", "id": "database",
      "x": 280, "y": 250, "width": 180, "height": 70,
      "backgroundColor": "#b2f2bb", "strokeColor": "#2f9e44", "roughness": 0,
      "text": "PostgreSQL\nDatabase"
    },

    // --- ARROWS (connect shapes by ID) ---
    {
      "type": "arrow", "x": 130, "y": 120,
      "startElementId": "react-app", "endElementId": "api-server",
      "strokeColor": "#1971c2", "text": "REST API"
    },
    {
      "type": "arrow", "x": 220, "y": 285,
      "startElementId": "api-server", "endElementId": "database",
      "strokeColor": "#2f9e44", "text": "SQL"
    },

    // --- TITLE ---
    {
      "type": "text", "x": 100, "y": -40,
      "text": "System Architecture", "fontSize": 24, "strokeColor": "#1e1e1e"
    }
  ]
}
```

---

## Complete Example: Data Flow Diagram (Parameter Threading)

Shows a parameter traced through 5 layers with split/converge paths, decision node, and side annotations:

```json
{
  "elements": [
    // --- TITLE ---
    {"type": "text", "x": 20, "y": 10, "text": "Data Flow: parameter_name Threading", "fontSize": 24, "strokeColor": "#1e1e1e"},
    {"type": "text", "x": 20, "y": 48, "text": "Subtitle describing the trace", "fontSize": 16, "strokeColor": "#868e96"},

    // --- WHY SECTION (top-right, first-principles context) ---
    {"type": "rectangle", "id": "why-bg", "x": 460, "y": 80, "width": 440, "height": 310,
     "backgroundColor": "#e9ecef", "strokeColor": "#868e96", "roughness": 0},
    {"type": "text", "x": 480, "y": 95, "text": "WHY: The Problem", "fontSize": 20, "strokeColor": "#e03131"},
    {"type": "text", "x": 480, "y": 135, "text": "1. What currently happens", "fontSize": 16, "strokeColor": "#1e1e1e"},
    {"type": "text", "x": 480, "y": 195, "text": "2. Why it's expensive/wrong", "fontSize": 16, "strokeColor": "#e03131"},
    {"type": "text", "x": 480, "y": 275, "text": "3. Gap in current design", "fontSize": 16, "strokeColor": "#1e1e1e"},
    {"type": "text", "x": 480, "y": 335, "text": "Solution: what this change does", "fontSize": 16, "strokeColor": "#2f9e44"},

    // --- FLOW BOXES (center column, 150px vertical pitch) ---
    {"type": "rectangle", "id": "l1", "x": 60, "y": 420, "width": 300, "height": 65,
     "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2", "roughness": 0,
     "text": "Entry Point\nfile/path.py"},

    // Split into two paths
    {"type": "rectangle", "id": "l2a", "x": -100, "y": 570, "width": 290, "height": 65,
     "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2", "roughness": 0,
     "text": "Path A\nfile/path_a.py"},
    {"type": "rectangle", "id": "l2b", "x": 230, "y": 570, "width": 290, "height": 65,
     "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2", "roughness": 0,
     "text": "Path B\nfile/path_b.py"},

    // Converge point
    {"type": "rectangle", "id": "l4", "x": 60, "y": 720, "width": 300, "height": 65,
     "backgroundColor": "#eebefa", "strokeColor": "#9c36b5", "roughness": 0,
     "text": "Convergence Point\nfile/path_merge.py"},

    // Decision
    {"type": "diamond", "id": "dec", "x": 110, "y": 870, "width": 200, "height": 120,
     "backgroundColor": "#fff3bf", "strokeColor": "#fab005", "roughness": 0,
     "text": "condition?"},

    // Outcome branches
    {"type": "rectangle", "id": "yes", "x": -100, "y": 1080, "width": 260, "height": 65,
     "backgroundColor": "#ffc9c9", "strokeColor": "#e03131", "roughness": 0,
     "text": "Expensive Operation"},
    {"type": "rectangle", "id": "no", "x": 250, "y": 1080, "width": 220, "height": 65,
     "backgroundColor": "#b2f2bb", "strokeColor": "#2f9e44", "roughness": 0,
     "text": "Skip / Fast Path"},

    // --- ARROWS (bound by ID, auto-routed) ---
    {"type": "arrow", "x": 150, "y": 485, "startElementId": "l1", "endElementId": "l2a",
     "text": "Path A label", "strokeColor": "#1971c2"},
    {"type": "arrow", "x": 280, "y": 485, "startElementId": "l1", "endElementId": "l2b",
     "text": "Path B label", "strokeColor": "#1971c2"},
    {"type": "arrow", "x": 45, "y": 635, "startElementId": "l2a", "endElementId": "l4",
     "text": "data form", "strokeColor": "#9c36b5"},
    {"type": "arrow", "x": 375, "y": 635, "startElementId": "l2b", "endElementId": "l4",
     "text": "data form", "strokeColor": "#1971c2", "strokeStyle": "dashed"},
    {"type": "arrow", "x": 210, "y": 785, "startElementId": "l4", "endElementId": "dec",
     "strokeColor": "#2f9e44"},
    {"type": "arrow", "x": 150, "y": 990, "startElementId": "dec", "endElementId": "yes",
     "text": "True", "strokeColor": "#e03131"},
    {"type": "arrow", "x": 270, "y": 990, "startElementId": "dec", "endElementId": "no",
     "text": "False", "strokeColor": "#2f9e44"},

    // --- LAYER LABELS (left column, gray) ---
    {"type": "text", "x": -100, "y": 420, "text": "Layer 1\nEntry", "fontSize": 14, "strokeColor": "#868e96"},
    {"type": "text", "x": -210, "y": 570, "text": "Layer 2\nBackend", "fontSize": 14, "strokeColor": "#868e96"},

    // --- DATA FORM ANNOTATIONS (right column, orange) ---
    {"type": "text", "x": 570, "y": 440, "text": "Data form: Python bool", "fontSize": 14, "strokeColor": "#e8590c"},
    {"type": "text", "x": 570, "y": 590, "text": "Data form: JSON / arg", "fontSize": 14, "strokeColor": "#e8590c"},
    {"type": "text", "x": 570, "y": 740, "text": "Data form: Dataclass", "fontSize": 14, "strokeColor": "#e8590c"}
  ]
}
```

---

## Color Palette (Quick Reference)

| Component Type | Background | Stroke | When to Use |
|----------------|------------|--------|-------------|
| Frontend/UI | `#a5d8ff` | `#1971c2` | React, Next.js, web apps |
| Backend/API | `#d0bfff` | `#7048e8` | API servers, processors |
| Database | `#b2f2bb` | `#2f9e44` | PostgreSQL, Redis, MongoDB |
| Storage | `#ffec99` | `#f08c00` | S3, file systems |
| AI/ML | `#e599f7` | `#9c36b5` | ML models, AI services |
| External API | `#ffc9c9` | `#e03131` | Third-party services |
| Queue/Event | `#fff3bf` | `#fab005` | Kafka, RabbitMQ, SQS |
| Cache | `#ffe8cc` | `#fd7e14` | Redis cache, Memcached |
| Decision/Gate | `#ffd8a8` | `#e8590c` | Conditionals, routers |
| Zone/Group | `#e9ecef` | `#868e96` | Logical groupings |

**Rule:** Same-role shapes get same colors. Limit to 3-4 fill colors per diagram.

---

## Sizing Rules

**Err on the side of too much space.** Tight spacing is the #1 mistake — arrows and their labels get hidden when boxes are too close. When in doubt, double the gap you think you need. Diagrams that feel "too spread out" in your head almost always look right on screen.

**CRITICAL: Arrow labels need ~120px of clear space between boxes to be visible.** If an arrow has a text label (e.g. "auto deploy", "All pass"), the gap between the two connected boxes MUST be at least 150px. Arrows without labels still need 100px minimum.

| Property | Value | Why |
|----------|-------|-----|
| Box width | 200-240px | Fits multiline labels with breathing room |
| Box height | 120-160px | Fits 3-4 line labels comfortably |
| Horizontal gap (labeled arrows) | **150-200px** | Arrow labels are ~80-120px wide, need clearance on both sides |
| Horizontal gap (unlabeled arrows) | 100-120px | Just the arrow line + breathing room |
| Column spacing (labeled) | 400px | 220px box + 180px gap |
| Column spacing (unlabeled) | 340px | 220px box + 120px gap |
| Row spacing | 280-350px | 150px box + 150px gap for arrows + annotations |
| Font size (labels) | 16px | Default, readable |
| Font size (titles) | 20-24px | Stands out as header |
| Font size (zone labels) | 14px | Subtle, doesn't compete |
| Zone opacity | 25-40 | Background, not foreground |
| Zone padding | 50-60px around children | Zone borders must NOT hug inner boxes |
| Section header to box gap | 40px | Headers need clearance from boxes below |

**Zone sizing rule:** Calculate zone dimensions as: leftmost child x - 50 to rightmost child x + child width + 60 (horizontal), topmost child y - 55 to bottommost child y + child height + 60 (vertical). Always verify the zone fully wraps ALL children with visible padding on every side.

**Arrow visibility test:** Before finalizing, mentally check every labeled arrow — if the label text is longer than half the gap between boxes, increase the gap. Common offenders: "auto deploy", "rollback on failure", "All pass" — these labels are 80-150px wide and get clipped when gaps are <150px.

---

## Layout Patterns

### Vertical Flow (default for most diagrams)

```
Title (y = -40)

[Zone 1: y=0, height=260]
  [Box A: x=40]    [Box B: x=440]    [Box C: x=840]

[Zone 2: y=350, height=260]
  [Box D: x=40]    [Box E: x=440]

[Zone 3: y=700, height=260]
  [Box F: x=240]
```

Arrows flow **top to bottom**. Cross-layer arrows use dashed style.

### Horizontal Pipeline

```
[Source] ──► [Transform 1] ──► [Transform 2] ──► [Output]
  x=40        x=440             x=840             x=1240
```

All at same `y`. Arrows flow **left to right**. Use 400px column spacing for labeled arrows, 340px for unlabeled.

### Hub and Spoke

```
         [Consumer A]
              ▲
              │
[Producer] ──► [Event Bus] ──► [Consumer B]
              │
              ▼
         [Consumer C]
```

Central shape at (300, 300). Spokes at ~200px radius.

### Data Flow Diagram (parameter threading, call chains)

Best for: tracing a parameter/request through architectural layers, showing data transformations at each boundary.

```
 Layer Labels        Main Flow Column          Side Annotations
 (left, gray)        (center, colored)         (right, orange)

  Layer 1      ┌─────────────────────┐         Data form: Python bool
  User API     │  Entry Point        │
               │  file/path.py       │
               └──────┬──────┬───────┘
                      │      │
              ┌───────┘      └────────┐
              ▼                       ▼
  Layer 2  ┌──────────┐    ┌──────────┐        Data form: JSON / bool
  Backend  │ Path A   │    │ Path B   │
           └────┬─────┘    └────┬─────┘
                │               │  (dashed = direct)
                ▼               │
  Layer 3  ┌──────────┐        │               Data form: Dataclass
  HTTP     │ Server   │        │
           └────┬─────┘        │
                └──────┬───────┘  (converge)
                       ▼
  Layer 4  ┌─────────────────────┐             Data form: IPC message
  Manager  │  Manager            │
           └──────┬──────────────┘
                  ▼
  Layer 5  ┌─────────────────────┐             Data form: Conditional
  Executor │  Executor           │
           └──────┬──────────────┘
                  ▼
               ◇ Decision? ◇
              / \
         True/   \False
            ▼     ▼
         [Yes]  [No]
```

**Golden coordinates (validated):**

| Element | x | y | width | height |
|---------|---|---|-------|--------|
| Main boxes | 60 | +150 per row | 300 | 65 |
| Split left | -100 | row_y | 290 | 65 |
| Split right | 230 | row_y | 290 | 65 |
| Decision diamond | 110 | row_y | 200 | 120 |
| Layer labels | -100 to -50 | aligned to box | — | fontSize: 14 |
| Annotations | 570 | aligned to box | — | fontSize: 14 |
| WHY section | 460, y=80 | — | 440 | 310 |

**Three-column structure:**
- **Left column (x < 0):** Layer numbers + names in gray (`#868e96`, fontSize 14)
- **Center column (x: 60–360):** Flow boxes with `ComponentName\nfile/path.py`
- **Right column (x: 570):** Data form annotations in orange (`#e8590c`, fontSize 14)

**Color by layer role:**
- Blue (`#a5d8ff`/`#1971c2`): User-facing API layers
- Purple (`#eebefa`/`#9c36b5`): Internal processing layers
- Green (`#b2f2bb`/`#2f9e44`): Execution layer + "skip/success" outcomes
- Yellow (`#fff3bf`/`#fab005`): Decision nodes
- Red (`#ffc9c9`/`#e03131`): Expensive/dangerous operations
- Gray (`#e9ecef`/`#868e96`): Annotations, zones

**Split and converge pattern:**
- Split: Two arrows from one box, angled down-left and down-right
- Direct skip: Use `strokeStyle: "dashed"` for paths that skip layers
- Converge: Two arrows from different paths into one box below

**"WHY" annotation box (first-principles context):**
Place a gray-background rectangle (top-right, `x: 460`) with 3-4 text items explaining the motivation. Use red stroke for the problem, green stroke for the solution.

---

## Common Mistakes and Fixes

| Mistake | Fix |
|---------|-----|
| Existing content occupies the canvas | Inspect IDs and bounds; preserve existing elements and place the new diagram in an empty region |
| Arrows don't connect | Set `startElementId`/`endElementId` to valid shape `id` values |
| Shapes overlap | Increase spacing. Use 240px column gap, 140px row gap |
| Labels cut off in a new diagram | Increase the affected box size and verify its bound text and arrows; preserve the requested text |
| Can't tell layers apart | Add zone background rectangles with dashed stroke + low opacity |
| Too many colors | Limit to 3-4 fill colors. Same role = same color |
| Diagram too cluttered | Split into multiple diagrams, or use `create_from_mermaid` for quick drafts |
| Arrows cross messily | Rearrange shapes so related ones are adjacent. Vertical flow reduces crossings |
| Annotations overlap with flow | Use 3-column layout: labels (x<0), flow (x:60-360), annotations (x:570+) |
| Lost detail from sample diagram | Sample is source of truth for content. Reproduce ALL text verbatim — titles, subtitles, tool lists, metrics, annotations. Size boxes larger if needed |
| Self-critique finds same issue twice | Fix didn't work — try a different approach (different element, larger gap) |
| Self-critique runs >2 rounds | Stop and present. List remaining issues for user |
| Fixed layout but broke arrows | Inspect affected arrow points and labels, repair only supported dependencies, and verify the screenshot |
| Self-critique made things worse | Repair the recorded affected values; whole-scene restore requires the exclusive-ownership conditions in Step 6 |

---

## Quick Start Templates

### "Draw me a diagram of X"

```python
# 1. Read the code to understand components and connections
# 2. Read the design guide
mcp__excalidraw__read_diagram_guide()
# 3. Inspect existing content and select an empty region
mcp__excalidraw__query_elements({})
mcp__excalidraw__get_canvas_screenshot()
# 4. Create everything in one batch
mcp__excalidraw__batch_create_elements(elements=[...])
# 5. Inspect geometry and screenshot; make at most two scoped corrections
# 6. Present to user, then export if requested
```

### "Quick diagram from description"

```python
# For a new simple diagram, inspect the canvas first (Step 3).
# Use Mermaid only where the tool preserves unrelated content:
mcp__excalidraw__create_from_mermaid(
  mermaidDiagram="graph TD; A[Frontend] -->|REST| B[API]; B -->|SQL| C[Database]"
)
```

---

## Export Options

| Method | Output | Use Case |
|--------|--------|----------|
| `export_to_image(format="png")` | PNG file | Embed in docs, Slack, PRs |
| `export_to_image(format="svg")` | SVG file | Scalable, embed in web pages |
| `export_scene(filePath="...")` | .excalidraw JSON | Editable in excalidraw.com or VS Code |
| `export_to_excalidraw_url()` | Shareable URL | Share with anyone, no file needed |

---

## After Diagram Delivery

Show this message **once per conversation** — only after the **first successful diagram** the user confirms they're happy with. Do not repeat on subsequent diagrams in the same session.

> If you found this useful, I'd love your feedback! Feature requests, bug reports, or just a star:
> **https://github.com/edwingao28/excalidraw-toolkit/issues/13**
