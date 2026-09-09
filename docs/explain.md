# Source-linked before/after comparisons

Compare two scoped evidence bundles at exact Git revisions. The host agent supplies
the diagrams, evidence and required content. This module compares their semantic
identities, preserves both native files, and exports separate images at one shared
viewport. It does not discover architecture, prove program behavior, change layout,
or publish a PR comment.

```js
import { loadComparison, exportComparison } from "./src/explain.js";

const request = {
  repositoryPath: "/absolute/repository",
  repositoryUrl: "https://github.com/owner/repository",
  base: {
    bundlePath: "/evidence/base/evidence.json",
    expectedHash: "<retained manifest SHA-256>",
    revision: "main",
  },
  head: {
    bundlePath: "/evidence/head/evidence.json",
    expectedHash: "<retained manifest SHA-256>",
    revision: "feature-branch",
  },
  required: {
    base: { nodes: ["request:api", "request:worker"], relations: ["request:direct"] },
    head: {
      nodes: ["request:api", "request:queue", "request:worker"],
      relations: ["request:enqueue", "request:consume"],
    },
  },
  target: "article",
};

// Read-only plan; refs resolve now, and every source location is checked again.
const plan = await loadComparison(request);

// Native rendering is injectable. Without adapters, the module loads the native
// measureScene/renderScene exports from ./target-render.js.
const result = await exportComparison(
  { ...request, outputDir: "/new/pr-comparison" },
  { measureScene, renderScene },
);
```

Each bundle must describe the exact commit to which its requested revision resolves.
An empty commit still has a different identity, even if all cited files match.
Working-tree evidence is rejected for this workflow. Base and head paths, excerpts,
blob IDs, digests and symbols are rechecked independently against their own commits;
a dirty checkout does not change either side. Keep `expectedHash` from the accepted
bundle receipt to detect manifest replacement. Source links use GitHub-compatible
`/blob/<commit>/<path>#L<start>-L<end>` URLs over HTTPS, including GitHub Enterprise
hosts. The URL is caller-supplied presentation metadata, not proof of remote origin.

`planComparison({base, head, target, required, repositoryUrl})` is the pure API.
Its base/head arguments are checked snapshots returned by `readEvidenceBundle`.
It neither reads Git nor authenticates supplied objects; use `loadComparison` at an
external input boundary. Both planning functions return separate base/head scenes,
exact revisions, scopes, change records, target, required content and validation
flags. `loadComparison` also retains input artifact paths and hashes.

## Change meaning and stable context

Change records use explicit semantic IDs and `added`, `removed`, `changed`, or
`unchanged`. Node comparison includes the selected source excerpts and native label
content. Relation comparison additionally includes endpoints, kind and authored claim.
Moved source line numbers or changes elsewhere in the same file do not alone change
a concept; both original citation locations remain in the report. Labels do not
establish identity. A missing mapping is a removal from this scoped comparison,
not proof that code was deleted or that unseen content no longer exists.

The report keeps these certainty labels visible:

| Label | Meaning |
| --- | --- |
| `source-located` | A node maps to checked source locations. |
| `source-cited` | An authored import/call relationship has checked citations; the claim itself is unverified. |
| `assumption` | An explicitly conjectural relationship, possibly without citations. |

`semanticClaims`, `runtimeBehavior` and `completeCoverage` always remain false.
Passing source-location, mapping, geometry or image checks never upgrades a claim.
The fixture's direct call is replaced by an evidenced enqueue call and an explicitly
assumed queue-to-worker delivery relationship. Its required sets name all three
relationships across the two sides; omitting one fails before export.
Every assumption relation must also have a native bound label beginning with
`Assumption` (case-insensitive). Otherwise `UNLABELED_ASSUMPTION` stops the export.
The label must remain visible and pass the same typography gate as other text;
the sidecar report alone cannot make an unlabeled speculative arrow acceptable.

Unchanged mapped nodes/relations, their bound labels, and common unchanged unmapped
content must keep their geometry. A mismatch raises `UNSTABLE_CONTEXT` with the
affected identities. The module leaves both inputs intact so the host can reconcile
their layout explicitly. It does not guess new arrow routes. Native output files
retain the accepted bytes, IDs, coordinates, manual notes and unknown properties.

## Output dimensions and readability

The target dimensions are the delivered PNG dimensions at one device pixel per
output pixel. Inspect the images at that size; downscaling them in a document needs
another check at that document's intended dimensions.

| Target | Width × height | Padding | Minimum label font size |
| --- | --- | --- | --- |
| `article` | 1200 × 800 px | 40 px | 18 px |
| `slide` | 1920 × 1080 px | 64 px | 24 px |
| `canvas` | 1600 × 1000 px | 40 px | 16 px |

For another intended size, supply
`{name, width, height, padding, minimumFontSize}`. Width/height are positive integer
pixels, capped at 8192 per axis. The typography thresholds are explicit product
defaults, not a claim of universal accessibility at every viewing distance.

`measureScene(scene)` must restore the native scene and load its actual bundled
fonts, then return this contract without writing artifacts:

```js
{
  renderer: "@excalidraw/excalidraw@0.18.1",
  fontsLoaded: true,
  bounds: { x: 40, y: 40, width: 840, height: 175 }, // native scene coordinates
  visibleElementIds: ["api", "api-label", "worker", "worker-label", "direct", "note"],
  text: [
    { id: "api-label", fontSize: 28, x: 60, y: 60, width: 50, height: 35 },
    // Every visible nonempty text element, measured with the loaded native font.
  ],
}
```

Text bounds must reflect the measured glyph/layout extents after native restoration,
including extents that exceed stale declared element dimensions. Required mapped
elements and their labels must be visible. Missing measurements fail; the module
does not substitute estimated character widths. Both scene bounds and all text
bounds contribute to a single union viewport. For union origin `(x, y)` and size
`(w, h)`, the transform is:

```text
scale   = min(1, (target.width - 2*padding)/w, (target.height - 2*padding)/h)
offsetX = (target.width - w*scale)/2 - x*scale
offsetY = (target.height - h*scale)/2 - y*scale
pixelX  = sceneX*scale + offsetX
pixelY  = sceneY*scale + offsetY
```

Both images use this exact transform. Offsets are pixel translations, not scene
origins. No native coordinates are rewritten. Every measured text element must keep
`fontSize * scale >= minimumFontSize`. `checkReadability(plan, {base, head})` exposes
this pure gate and returns the shared viewport, effective font sizes and renderer
identities. `INSUFFICIENT_READABILITY` includes the failing side, element ID and
effective size. Increase the target, recompose the view, or explicitly enlarge labels
before retrying. The export does not silently shrink text to force success.

`renderScene(scene, outputPath, {width, height, padding, scale, offsetX, offsetY})`
must apply that affine transform to the loaded native scene, create an exclusive PNG
at exactly `width × height`, and preserve the supplied scene. Adapters receive clones.
Core checks PNG identity/dimensions and preserves native bytes. Renderer correctness,
font loading, glyph coverage and clipping need an actual native integration check;
test doubles are contract checks only. The typography gate does not certify diagram
meaning, contrast, arrow routing, or overall visual quality. Inspect the actual
delivered images before accepting the explanation; this API makes no model critique
call and performs no automatic repair loop.

## Artifacts and failure states

A successful new directory contains `before.excalidraw`, `after.excalidraw`,
`before.png`, `after.png`, `changes.md`, and `comparison.json`. The complete JSON
receipt includes artifact hashes, separate source scopes/revisions, change records,
citations, required content, measured viewport and narrow validation flags. Preserve
its returned SHA-256 independently. Existing comparison directories are never
overwritten; there is no implicit publishing or latest-result alias.

Readability, missing content, source-validation and context-conflict failures happen
before creating the output directory or invoking rendering. A later renderer or
filesystem failure may leave partial artifacts, but no `comparison.json` completion
receipt. Choose a new directory after resolving the failure. An output is successful
only when that complete receipt exists and the artifact checks pass.

Run `node --test test/explain.test.js` for the scoped comparison, revision, required
content, geometry, target/readability, immutable-output and renderer-contract checks.
These tests use temporary Git repositories and synthetic measurement/PNG doubles;
they do not claim native visual acceptance.

Open the completed receipt to review both native scenes and their source context:

```sh
excalidraw-toolkit preview ./comparison/comparison.json
```

The sidebar follows the selected Before/After view, showing native node labels,
relationship claims, exact-revision source links, and scoped unknowns. Opening a
receipt rechecks all retained native/PNG hashes and rebuilds the comparison from
its evidence bundles and Git source. Keep those bundles and the source repository
available. Hand-edited claims or stale files fail before a preview is served.
This review checks source locations and diagram identity; it does not establish
that a claim is semantically correct or that the runtime follows the depicted path.

PNG downloads from a comparison review return the exact retained image for the
selected view, preserving its declared article, slide or canvas dimensions. The
local preview serves those checked bytes under its private token URL; it does not
re-render the export at the review window's size.
