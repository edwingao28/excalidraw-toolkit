# Source evidence and native scene baselines

The evidence module associates a scoped code investigation with an existing native
Excalidraw file. The host coding agent searches the repository, writes claims and
references, and chooses explicit semantic and element IDs. The module checks the
locations and native mappings, then saves an immutable bundle. It does not analyze
programs, infer runtime calls, modify diagrams, or establish complete coverage.

## API

```js
import {
  validateEvidence,
  associateEvidence,
  acceptEvidenceBaseline,
  readEvidenceBundle,
} from "./src/evidence.js";

const options = {
  repositoryPath: "/absolute/repository/root",
  inputPath: "/absolute/delivered.excalidraw",
  evidence: proposal,
};

// Read-only: returns checked references, resolved source revision and scene hash.
const checked = await validateEvidence(options);

// Explicitly associate a preexisting diagram; its earlier generated state is unknown.
const saved = await associateEvidence({ ...options, outputDir: "/new/association" });

// For an actual generated result that has been reviewed and accepted, retain both
// that generated state and the delivered scene, including any manual adjustments.
const accepted = await acceptEvidenceBaseline({
  ...options,
  generatedPath: "/absolute/generated.excalidraw",
  outputDir: "/new/accepted-baseline",
});

// Retain the returned hash independently to detect manifest changes as well.
const { bundle, deliveredScene, generatedScene } = await readEvidenceBundle(
  accepted.bundlePath,
  { expectedHash: accepted.sha256 },
);
```

`validateEvidence` returns a normalized result, not another proposal: its added
provenance fields are output-only. Pass the original proposal to a save method;
the save method validates it again against its input scene and source files.
`saved` and `accepted` contain `bundlePath`, the manifest's `sha256`, and `bundle`.
No CLI, installer or model invocation is provided by this module.

## Proposal schema, version 1

All listed fields are required unless marked optional. Unknown fields are rejected.
Paths use normalized repository-relative `/` separators. `repositoryPath` must be
the Git root, including when reading a working tree.

```json
{
  "schemaVersion": 1,
  "source": { "kind": "git", "revision": "HEAD" },
  "scope": {
    "question": "How does the request handler reach the worker?",
    "paths": ["src/api.js", "src/worker.js"],
    "coverage": "partial",
    "unknowns": ["Caller routing and runtime inputs were not traced."]
  },
  "references": [
    { "id": "handler-call", "path": "src/api.js", "startLine": 3, "endLine": 3, "symbol": "run" },
    { "id": "worker-definition", "path": "src/worker.js", "startLine": 1, "endLine": 1, "symbol": "run" }
  ],
  "nodes": [
    { "semanticId": "request:handler", "elementId": "api-box", "referenceIds": ["handler-call"] },
    { "semanticId": "request:worker", "elementId": "worker-box", "referenceIds": ["worker-definition"] }
  ],
  "relations": [
    {
      "semanticId": "request:handler-to-worker",
      "elementId": "call-arrow",
      "from": "request:handler",
      "to": "request:worker",
      "kind": "call",
      "claim": "The handler contains a call expression for run(input).",
      "referenceIds": ["handler-call"]
    }
  ]
}
```

- A Git `revision` resolves to an exact commit. References read regular blobs at
  that commit, regardless of working-tree changes. Output records commit, blob ID,
  full-file SHA-256, line range and selected excerpt. Git replacement objects and
  inherited Git repository redirection variables are disabled for these reads.
- For uncommitted code, use `source: { "kind": "working-tree" }` and include an
  inspected full-file `sha256` on every reference. A mismatch fails before creating
  a bundle. Output retains each digest and the current HEAD as `baseRevision`, or
  `null` for an unborn repository. HEAD does not certify uncommitted content.
- `startLine` and `endLine` are inclusive, one-based integers. `symbol` is optional;
  if present, its exact token must occur within those lines. This is a location
  check, not a parser's definition or name-resolution result. Use narrow ranges and
  distinct explicit reference IDs when names repeat.
- Optional `sha256` on a Git reference also checks against the inspected content.
  Sources must be UTF-8 regular files of at most 8 MiB. Symlinks, submodules, nested
  working-tree repositories, `.git` paths and traversal are rejected. Each reference
  must lie under one declared scope path; `"."` explicitly permits the whole root.
- `coverage` must be `"partial"`. `unknowns` is required and may be empty; neither
  an empty array nor a large scope establishes completeness. Unseen content is not
  a deletion instruction. No external file is read as part of reference validation.
- Semantic IDs use up to 160 letters, digits, `:`, `.`, `_`, `/` or `-`, starting
  with a letter or digit. They identify concepts chosen for this investigation,
  not labels inferred from the canvas. Reuse them across accepted revisions when
  identity is known. Ambiguous or duplicate semantic IDs and mapped element IDs
  fail; this module never resolves ambiguity by matching display text.
- Node mappings are sparse and require at least one reference. Each points to a
  live native element other than an arrow or line. Unmapped notes, images and other
  diagram content remain intact.
- Relations require explicit `from` and `to` node semantic IDs and a live native
  arrow whose start/end bindings match those nodes. `import` means an authored
  import relationship; `call` means an authored call-expression relationship;
  `assumption` is explicitly conjectural. Imports and calls require references;
  assumptions may have none. A call expression does not establish runtime execution.

Every checked result includes:

```json
{
  "validation": {
    "sourceLocations": true,
    "sceneMappings": true,
    "semanticClaims": false,
    "runtimeBehavior": false
  }
}
```

A valid reference cannot prove that a relation was classified correctly or that a
claim follows from its excerpt. The host agent must explain the inference and the
reviewer must assess it. Present these flags with the evidence; do not relabel the
whole diagram as verified.

## Baseline bundles

Each save requires a new output directory. A bundle contains `evidence.json` and
`delivered.excalidraw`; an accepted generated baseline also contains
`generated.excalidraw`. Native inputs are copied byte-for-byte, preserving IDs,
manual geometry, text, styles, embedded assets and unknown properties. No live
canvas import/export round-trip occurs.

`evidence.json` has `schemaVersion: 1`, `status: "complete"`, the checked `evidence`,
and a `baseline` containing artifact filenames and SHA-256 hashes:

| Baseline kind | Generated state | Prior baseline |
| --- | --- | --- |
| `association` | `null`; no historical generated state is claimed | `null` |
| `accepted-generated` | Captured actual generated native document | `null`; this module creates an initial baseline |

Calling `acceptEvidenceBaseline` is the caller's assertion that the supplied
generated/delivered pair has been accepted. The module cannot establish who created
the files or whether a human approved them. Both files must satisfy the explicit
semantic mappings, but may differ in manual layout and styling. A previously
handwritten diagram must first use association; only an actual subsequent generated
result can establish a generated baseline for later three-way refresh work.

The complete manifest is published atomically after the artifact files are synced.
A failed attempt may leave a partial directory; it is not an accepted baseline.
Choose a new directory for a retry. Completed bundles are never overwritten by the
module. Keep the returned manifest hash with the accepted receipt or version control:
without that independent hash, artifact checks detect changed files but cannot
authenticate a rewritten manifest and matching artifacts.

`readEvidenceBundle` verifies the retained pair and returns both parsed scenes.
It does not need the original scene paths or a still-present source checkout. This
retained pair is the input for later comparison of generated changes against manual
overrides. It does not itself implement refresh, merge, source completeness or
publishing. Working-tree sources retain excerpts and digests, not a full code backup.
