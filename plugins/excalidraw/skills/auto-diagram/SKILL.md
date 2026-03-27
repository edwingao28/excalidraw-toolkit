---
name: auto-diagram
description: Automatically analyze a codebase and generate an architecture diagram with zero configuration. Use when the user says "diagram this repo", "visualize the architecture", "auto diagram", "show me the architecture", "what does this codebase look like", or asks for a codebase overview diagram without specifying individual components. Do NOT use when the user provides a specific description, sample diagram, or component list — use the core excalidraw skill instead.
---

# Auto-Diagram: Zero-Config Codebase Visualization

Analyze ANY codebase and generate a complete architecture diagram automatically.
No description needed — you read the code and figure out what to draw.

## Prerequisite Check

Before starting analysis, verify the Excalidraw MCP server is available:

```
mcp__excalidraw__read_diagram_guide()
```

If this fails, tell the user:
> "The Excalidraw MCP server isn't running. Start the canvas server first:
> `docker run -d -p 3000:3000 ghcr.io/yctimlin/mcp_excalidraw-canvas:latest`
> Then open http://localhost:3000 and try again."

---

## Context Budget

To prevent context window blowout on large codebases, follow these hard limits:

| Operation | Limit |
|-----------|-------|
| Grep results per pattern | Max 20 matches (use head_limit) |
| Files read per component | Max 5 files |
| Total tool calls in Phase 2 | Max 15 |
| Total tool calls in Phase 3 | Max 10 |
| If analysis exceeds limits | Proceed with partial results, note gaps to user |

---

## When This Skill Triggers

- "diagram this repo"
- "visualize the architecture"
- "auto diagram"
- "show me how this project is structured"
- "what does this codebase look like"
- Any request for a diagram without the user specifying components

When the user provides specific components, a sample diagram, or a description of what to draw → use the core `excalidraw` skill instead.

---

## Analysis Pipeline

### Phase 1: Project Detection

Run these file checks to identify the project type and tech stack:

1. **Read root files** — check for `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, `mix.exs`, `Makefile`, `Dockerfile`, `docker-compose.yml`, `*.tf`
2. **Scan directory structure** — `ls` the root and first-level subdirectories to identify the layout pattern
3. **Detect project type:**
   - **Monorepo**: `workspaces` in package.json, `lerna.json`, `pnpm-workspace.yaml`, multiple `go.mod` files, `packages/` or `apps/` directories
   - **Microservices**: Multiple `Dockerfile` files, `docker-compose.yml` with 3+ services
   - **Standard app**: Single service with standard directory structure
4. **Check for frameworks** — look for markers:
   - React/Next.js: `next.config.*`, `src/app/`, `src/pages/`
   - Express/Fastify/Hono: `routes/`, `controllers/`, `middleware/`
   - Nest.js: `@nestjs/core` in package.json
   - Django/Flask/FastAPI: `manage.py`, `wsgi.py`, `app.py`, `main.py` with `uvicorn`
   - Spring: `src/main/java/`, `application.properties`
   - Go services: `cmd/`, `internal/`, `pkg/`
   - Rust: `src/main.rs`, `src/lib.rs`
   - Rails: `Gemfile` + `config/routes.rb`
   - Laravel: `artisan`, `app/Http/`
   - Phoenix/Elixir: `mix.exs` + `lib/*_web/`

**Output:** A mental model of the project type, primary language, and framework.

**Monorepo handling:** If monorepo detected, scope analysis to the top-level package structure first. Show one box per package/app. Offer to drill into specific packages on request.

### Phase 2: Component Discovery

Based on project type, identify architectural components. **Stay within context budget: max 15 tool calls.**

#### For Web Applications:
1. **Frontend** — Glob for `*.tsx`, `*.jsx`, `*.vue`, `*.svelte` in `src/`, `app/`, `pages/` (head_limit: 20)
2. **API routes** — Grep for route definitions: `router\.(get|post|put|delete)`, `@(Get|Post|Put|Delete)`, `@app\.route`, `HandleFunc`, `http\.Handle` (head_limit: 20)
3. **Database** — Grep for ORM/schema: `prisma/schema.prisma`, `models.py`, `*.entity.ts`, `migrations/`, `@Entity`, `db.Model` (head_limit: 20)
4. **External services** — Grep for HTTP clients/SDK imports: `axios`, `fetch(`, `requests\.`, `http\.NewRequest`, SDK package names (head_limit: 20)
5. **Message queues** — Grep for queue imports: `amqp`, `kafka`, `bull`, `celery`, `SQS`, `pubsub` (head_limit: 10)
6. **Cache** — Grep for cache layers: `redis`, `memcached`, `cache` in import statements (head_limit: 10)
7. **Auth** — Grep for auth middleware: `passport`, `jwt`, `oauth`, `@Auth`, `middleware.*auth` (head_limit: 10)

#### For Infrastructure:
1. **Services** — Read `docker-compose.yml` service definitions
2. **Cloud resources** — Grep `*.tf` files for `resource "` blocks (head_limit: 20)
3. **K8s** — Glob `**/k8s/*.yaml` or `**/manifests/*.yaml` (head_limit: 20)

#### For Libraries/CLIs:
1. **Entry points** — Find `main`, `bin`, `exports` in package config
2. **Modules** — Map the public API surface (read index/main files)
3. **Dependencies** — Read dependency list from package config

**Output:** A list of 4-12 components with names, types, and key file locations.

### Phase 3: Connection Mapping

Determine how components connect to each other. **Stay within context budget: max 10 tool calls.**

**Strategy:** Don't trace every import. Focus on the entry points and their immediate dependencies.

1. **Read entry point files** — For each major component identified in Phase 2, read the main/index file (max 5 files total). Look for:
   - Import statements that reference OTHER components (not third-party packages)
   - Function calls to other services (HTTP clients, RPC calls, queue publishers)
   - Database connection/query code
   - Event emitters/listeners

2. **Map connection types** — For each connection found, categorize:
   - `REST/HTTP` — fetch/axios/requests calls
   - `SQL/ORM` — database queries
   - `gRPC/RPC` — inter-service calls
   - `Event/Queue` — pub/sub, message queues
   - `Import` — direct module import (same codebase)

3. **Build edge list** — Create directed edges: `ComponentA --[protocol]--> ComponentB`

**If you can't determine connections reliably:** Show components without arrows and note "connections could not be auto-detected from entry point analysis. Try: 'add connections between X and Y'."

**Output:** A list of directed edges with labels.

### Phase 4: Verify with User

Before drawing, present a summary and ask for confirmation:

> "I found **N components** and **M connections** in this codebase:
>
> **Components:** [list with types]
> **Connections:** [list of edges]
>
> Does this look right? Should I add, remove, or rename anything before generating the diagram?"

Wait for user confirmation. If they say "looks good" or similar, proceed. If they suggest changes, incorporate them.

### Phase 5: Layout Selection

Choose layout based on the architecture pattern detected:

| Pattern | Layout | Trigger |
|---------|--------|---------|
| Request/response flow (most web apps) | Vertical flow (top→bottom) | Frontend + API + DB layers detected |
| Data pipeline / ETL | Horizontal pipeline (left→right) | Linear chain of transforms detected |
| Event-driven / microservices | Hub and spoke | Message broker/event bus detected |
| Monolith with modules | Vertical flow with zones | Single service, multiple internal modules |

**Tiebreaking:** If multiple patterns match, prefer the one with more detected components. Default to vertical flow.

**Hybrid architectures:** If both request/response AND event-driven patterns exist, use vertical flow with the event bus as a component in the middle layer, not hub-and-spoke.

### Phase 6: Diagram Generation

Use the `excalidraw` skill's workflow:

1. `mcp__excalidraw__clear_canvas()` — start fresh
2. `mcp__excalidraw__get_canvas_screenshot()` — verify empty
3. Plan coordinates using the sizing rules from the excalidraw skill
4. `mcp__excalidraw__batch_create_elements(elements=[...])` — create all elements in ONE call
5. `mcp__excalidraw__set_viewport({ scrollToContent: true })` — zoom to fit
6. `mcp__excalidraw__get_canvas_screenshot()` — verify result
7. **Run self-critique loop** — follow the Self-Critique Protocol from the core excalidraw skill (Step 6). Fix overlapping labels, hidden arrows, cramped spacing. Max 2 rounds.
8. Offer export and next steps

**Color assignment:** Use the excalidraw skill's color palette. Assign colors by component role:
- Frontend → blue (#a5d8ff/#1971c2)
- Backend/API → purple (#d0bfff/#7048e8)
- Database → green (#b2f2bb/#2f9e44)
- External service → red (#ffc9c9/#e03131)
- Queue/Event → yellow (#fff3bf/#fab005)
- Cache → orange (#ffe8cc/#fd7e14)

**Label format:** Each box should contain:
```
ComponentName
tech-stack
(key detail)
```

Example:
```
API Server
Express.js
/api/* routes
```

---

## Grouping Heuristic (>12 components)

When more than 12 components are discovered:

1. **Group by top-level directory** first (e.g., all files under `services/auth/` → "Auth Service")
2. If a directory contains >3 components, collapse into one zone named after the directory
3. Show the zone as a dashed rectangle containing a single summary box
4. Offer drill-down: "Want me to expand the [zone name] zone into its internal components?"

---

## Constraints

- **Max 12 components** per diagram. If more found, apply grouping heuristic above.
- **Max 20 arrows** per diagram. Show primary data flow paths only. Use dashed lines for secondary connections.
- **Always include a title** with the project name and "Architecture Overview"
- **Always include a legend** if using more than 3 colors

---

## Edge Cases

| Situation | How to Handle |
|-----------|--------------|
| Empty or trivial repo (<5 files) | Generate a simple module diagram showing file relationships |
| Monorepo with many packages | Show package-level view first, offer drill-down per package |
| No clear architecture (scripts, notebooks) | Show file dependency graph instead |
| Can't detect connections | Show components without arrows, note it to user |
| User specifies a subdirectory | Scope analysis to that directory only |
| MCP server not running | Print setup instructions (see Prerequisite Check) |
| Context budget exceeded | Proceed with partial results, tell user what was skipped |

---

## Example: What Auto-Diagram Produces for a Next.js + Prisma App

**User verification prompt:**
> I found **6 components** and **5 connections** in this codebase:
>
> **Components:**
> - Next.js Frontend (pages/, components/) — Frontend
> - API Routes (pages/api/) — Backend/API
> - Prisma ORM (prisma/schema.prisma) — Database
> - PostgreSQL (from DATABASE_URL in .env.example) — Database
> - NextAuth (from imports in [...nextauth].ts) — Auth
> - Stripe API (from stripe SDK imports) — External API
>
> **Connections:**
> - Frontend → API Routes (REST API)
> - API Routes → Prisma ORM (Prisma queries)
> - Prisma ORM → PostgreSQL (SQL)
> - API Routes → NextAuth (auth middleware)
> - API Routes → Stripe API (payment calls)
>
> Does this look right?

**Diagram layout:** Vertical flow, 3 layers

```
┌─────────────────────────────────────────────┐
│  Frontend Layer                              │
│  ┌──────────────┐  ┌──────────────┐         │
│  │ Next.js App  │  │ React        │         │
│  │ pages/       │  │ components/  │         │
│  └──────┬───────┘  └──────────────┘         │
└─────────┼───────────────────────────────────┘
          │ API calls
┌─────────┼───────────────────────────────────┐
│  API Layer                                   │
│  ┌──────▼───────┐  ┌──────────────┐         │
│  │ API Routes   │  │ NextAuth     │         │
│  │ pages/api/   │──│ OAuth flow   │         │
│  └──────┬───────┘  └──────────────┘         │
└─────────┼───────────────────────────────────┘
          │ Prisma queries
┌─────────┼───────────────────────────────────┐
│  Data Layer                                  │
│  ┌──────▼───────┐  ┌──────────────┐         │
│  │ PostgreSQL   │  │ Stripe API   │         │
│  │ via Prisma   │  │ payments     │         │
│  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────┘
```
