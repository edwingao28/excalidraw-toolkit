# Refresh while retaining manual edits

Refresh compares three native documents: the last accepted **generated** scene,
the current human-edited scene, and a newly proposed generated scene. The prior
delivered scene is retained as evidence of acceptance; it does not replace the
generated scene as the comparison base. That distinction keeps manual adjustments
visible across successive refreshes.

Staging writes a candidate and a report. It never overwrites the human scene or
advances its accepted baseline. Adoption is an explicit second call after the
candidate, preview and source claims have been reviewed.

## API

```js
import { stageRefresh, adoptRefresh } from "./src/refresh.js";

const staged = await stageRefresh({
  requestId: "queue-refactor-1",
  baselineBundlePath: "/accepted/evidence.json",
  baselineHash: retainedBaselineHash,
  currentPath: "/diagrams/current.excalidraw",
  generatedPath: "/proposals/next.excalidraw",
  repositoryPath: "/repository/root",
  evidence: nextEvidenceProposal,
  removedSemanticIds: [],
  outputDir: "/review/queue-refactor-1",
});

// Caller renders/inspects the candidate and reviews the source claims here.
// Only call adoption when the user or configured workflow adopts this result.
const accepted = await adoptRefresh({
  receiptPath: staged.receiptPath,
  expectedHash: staged.sha256,
  outputDir: "/accepted/queue-refactor-1",
});
```

The evidence proposal uses [evidence schema version 1](evidence.md). Staging checks
its references against the proposed generated scene, resolves Git refs to exact
commits and retains source file digests. Adoption checks those same pinned
references again; a later `HEAD` cannot substitute a new commit. Changed
working-tree source digests require a new proposal.

`mergeGeneratedScenes({ baselineGenerated, current, proposedGenerated,
baselineEvidence, proposedEvidence, removedSemanticIds })` exposes the pure merge
for callers that already hold checked evidence and native scenes. It returns
`{ status, candidate, changes, overrides, conflicts }`. The file API performs
source-reference and artifact-hash checks in addition to that merge.

## Merge rules

Each explicit semantic ID retains its native element ID. Mapped nodes and arrows,
plus their bound text, define the source-owned portion of the scene. Map a bound
label through its container; do not map it twice. Everything outside that portion
starts as the exact current scene content and remains untouched.

For each supported native field:

| Human compared with generated baseline | Proposed source compared with baseline | Result |
| --- | --- | --- |
| Unchanged | Changed | Apply the proposed field |
| Changed | Unchanged | Keep the human override |
| Changed | Changed to the same value | Keep that shared value |
| Changed | Changed differently | Keep the human value and report a conflict |

Fields include label content and typography, position/size, styles, groups/frames,
arrow geometry and bindings. Arrays such as `points` and `boundElements` are one
field, not guessed element-by-element merges. Unknown fields and volatile native
metadata on existing elements remain current. Scene-level state, unmanaged objects
and unused assets are retained. Source-owned images may introduce or update their
referenced assets; incompatible manual asset changes are conflicts.
An asset shared with a live unmanaged image cannot be replaced: the merge reports
`UNMANAGED_ASSET_CONFLICT` and retains its current bytes. Give the source-owned image
a new asset ID in the proposal, or explicitly reconcile ownership of every copy.

New semantic IDs require new native IDs. A missing known semantic ID, a changed
native ID, an ambiguous bound-label identity, or a human-deleted target requires
reconciliation. Display text is never used to guess a rename. An association-only
bundle has no historical generated baseline and also requires reconciliation.

Removal requires `removedSemanticIds` explicitly listing known concepts absent
from the new mapping. Their old references must lie within the new analysis scope.
An old assumption without any source references has unknown removal scope and must
be reconciled explicitly. The objects and dependent labels become native tombstones only when unchanged by
the human; unrelated objects are never inferred to be obsolete from partial source
coverage. A manually modified deletion target or a surviving native dependency
blocks adoption. This module does not infer source completeness or prove that an
authored removal was semantically justified.

Native bindings are validated after merging. If incompatible partial changes would
leave dangling or nonreciprocal bindings, `candidate` is `null` and the report has a
topology conflict. Object spread and field assignment do not reroute bound arrows.
The proposal must contain valid native geometry; callers must render and inspect
the merged result for layout, text fit and readability before adoption.

## Receipts and adoption

`stageRefresh` returns `{ receiptPath, sha256, receipt, reused }`. Its immutable
directory contains `refresh.json`, exact `current.excalidraw` and
`generated.excalidraw` snapshots, and `candidate.excalidraw` when a valid native
candidate exists. The receipt is published atomically after those files are synced.

The receipt has `schemaVersion: 1`, the normalized `request`, its `requestDigest`,
`proposedEvidence`, `changes`, `overrides`, `conflicts`, and relative artifact names
with SHA-256 hashes. `changes` names changed semantic IDs, native IDs and fields;
`overrides` names retained human fields. A field conflict includes the baseline,
human and proposed value, with field presence recorded separately from `null`.

| Status | Meaning | Adoption |
| --- | --- | --- |
| `ready` | Merge completed without identity/field/topology conflicts | Explicit adoption permitted after caller review |
| `unchanged` | The accepted source revision, inspected file digests and analysis scope are unchanged | Returns the prior baseline; creates no new baseline |
| `reconciliation-required` | Missing baseline, uncertain identity, competing edits or invalid merged topology | Blocked; resolve and stage a new request |

The same source revision and scope keeps the current native bytes, even if a new
generation proposes different layout. Scope identity includes the analysis
question, declared paths and inspected file digests. Working-tree comparisons use
the inspected digests rather than assuming HEAD represents uncommitted content.
This prevents incidental regeneration from churning a previously accepted scene.

Repeating an unchanged request into the same completed output verifies its retained
files and returns its existing receipt. Different inputs cannot reuse that
directory. Failed attempts can leave partial directories; choose a new output path
for recovery. There is no shared mutable scene store or background process.

`adoptRefresh` requires the retained receipt hash, verifies all native snapshots and
the previous baseline, and refuses if the original human file has changed since
staging. It copies the proposed generated and adopted candidate scenes into a new
accepted evidence bundle. It then saves `adoption.json` linking old/new baseline
hashes to the staged receipt hash. The prior baseline and human file remain intact.
Repeated adoption into the same completed directory returns the same accepted
bundle. An incomplete adoption directory requires a new output path.

`adoption.json` provides lineage beside the version-1 evidence manifest, whose
`priorBaseline` remains `null`. The caller selects the newly returned baseline and
delivered copy for subsequent work only after adoption succeeds. No global pointer
is updated. A failure before adoption returns cannot implicitly select a baseline.

Retain receipt hashes independently. These checks detect accidental replacement;
they do not authenticate an attacker who can rewrite both artifacts and their
trusted hashes. The module does not merge atomically with arbitrary external
editors, render previews, certify semantic claims, or publish artifacts.


## Reviewing a staged refresh

The `refresh-diagram` command retains a `previews.json` manifest alongside its
native receipt. Open that receipt directly:

```sh
excalidraw-toolkit preview ./review/queue-refactor-1/refresh.json
```

Before shows the human scene at staging time; Source proposal shows the generated
input; Candidate shows the merged output. A topology failure omits the Candidate
tab instead of disguising the proposal as a successful merge. Partial candidates
are visibly marked as needing reconciliation. The sidebar shows conflicts,
preserved overrides, proposal revision, and scoped unknowns. Numeric conflict
values are rounded to two decimal places for display; native files stay exact.

Opening a refresh rechecks native and preview hashes, the preview manifest's
receipt identity, source evidence and the three-way merge. Edited status or
conflict metadata cannot turn a failed refresh into a ready preview. Keep the
accepted baseline and inspected source repository available for these checks.
`readVerifiedRefresh(receiptPath, { expectedHash })` exposes the read-only native
and source verification for other local review clients.

The screen has no adoption control. It reports the staged status; it does not
infer whether a later command adopted that receipt. Use `adopt-refresh` explicitly
after reviewing the candidate. Exporting a view copies that selected native scene
or PNG and does not advance the accepted baseline.

When a view has a retained PNG in `previews.json`, the review downloads those
verified bytes. A separate source-proposal view without a retained PNG uses the
native renderer; its download does not claim an earlier retained preview hash.
