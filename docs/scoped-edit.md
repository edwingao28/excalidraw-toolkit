# Scoped edits to native diagrams

Use the CLI path from the [installation guide](install.md). The same operations are exposed to agents through the installed skill and scoped MCP tools.


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
