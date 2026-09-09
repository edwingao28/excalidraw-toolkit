# Source workflow request files

The CLI's workflow handler is `workflowCommand(command, requestPath, values)` in
`src/workflow-commands.js`. Each command reads one JSON request and returns the
public module's JSON result. The CLI owns JSON printing and exit status.

Filesystem paths inside the request are relative to the request file. Repository
source paths inside `evidence.scope` and `evidence.references` remain repository
relative. `--output` can supply an omitted `outputDir`; conflicting output paths
fail before writing. Commands read only their own modules, so source validation
does not load the browser renderer or require a model runtime.

| Command | Request fields | Result |
| --- | --- | --- |
| `validate-evidence` | `repositoryPath`, `inputPath`, `evidence` | Checked source locations, scene mappings and their limits; no files written |
| `associate-evidence` | Validation fields plus `outputDir` | Immutable association of an existing scene; no generated history invented |
| `accept-baseline` | Association fields plus `generatedPath` | Explicitly accepted generated and delivered native snapshots |
| `explain-change` | `repositoryPath`, `base`, `head`, `repositoryUrl`, `target`, `required`, `outputDir` | Native before/after files, matching PNG viewport, source-linked report |

The existing coding agent investigates the selected entry point and path, reads
source files at the declared revision, constructs supported scene edits, and
writes the PR9 evidence object. Use exact Git commits for reproducibility. A valid
source location does not prove a semantic relationship: cite import/call claims
and label assumptions explicitly. Keep unknowns in the scope and preserve native
manual content through the supported editing operations.

Request example:

```json
{
  "repositoryPath": "../source",
  "inputPath": "flow.excalidraw",
  "outputDir": "evidence-bundle",
  "evidence": {
    "schemaVersion": 1,
    "source": {"kind": "git", "revision": "<inspected commit>"},
    "scope": {"question": "How does this request reach the worker?", "paths": ["src"], "coverage": "partial", "unknowns": ["Runtime dispatch was not traced."]},
    "references": [{"id": "handler", "path": "src/api.js", "startLine": 1, "endLine": 3, "symbol": "handle"}],
    "nodes": [{"semanticId": "request:handler", "elementId": "<inspected native ID>", "referenceIds": ["handler"]}],
    "relations": []
  }
}
```

Call `<installed CLI> associate-evidence --request /absolute/request.json`.
Read the returned bundle/hash and inspect the saved native scene and preview.
Baseline acceptance is an explicit action after the result is adopted; a source
association alone is not a last-generated baseline.

For `explain-change`, each `base`/`head` contains `bundlePath`, the requested
`revision`, and retained `expectedHash`. Declare required base/head semantic
node/relation ID arrays in `required`. Choose `article`, `slide`, `canvas`, or an
explicit pixel target in `target`; the native renderer checks effective label
sizes at that target before writing outputs. It preserves unchanged context and
rejects missing required content. See `docs/explain.md` for the complete contract.
