# From agent request to verified diagram

This example updates documentation for Excalidraw Toolkit itself. An existing nine-node diagram explains the saved-file CLI workflow: inspect a scene, apply a scoped edit, retain native copies, render previews, and publish a completed receipt. The requested edit adds the actual MCP entry and image response, bringing the diagram to eleven nodes while preserving its layout and handwritten notes.

Both views describe [the same source revision, `8b03314`](https://github.com/edwingao28/excalidraw-toolkit/tree/8b033142aa429a998057734b3c095e5c94816174). The starting diagram deliberately covers the CLI path. Adding the MCP path expands its scope; it does not depict a code migration or claim that the demo implemented a new interface.

Native files:

- [Existing CLI overview](toolkit-pipeline-before.excalidraw)
- [Overview with the MCP path](toolkit-pipeline-after.excalidraw)

**Actual agent edit:** a fresh Codex session read the pinned source, discovered `inspect_scene`, and performed two `addNode` and three `connect` operations through the scoped MCP server. It reviewed the actual before/after PNGs and called `read_preview`. Independent checks confirmed the original bytes, all 31 existing elements except three required reciprocal binding additions, unique IDs, native metadata, and artifact hashes. The result contains 38 elements: eleven shapes, twelve arrows, fourteen text elements, and one freehand underline.

The starting diagram and annotations were prepared for this documentation example. The after file is the actual agent output. This is a reproducible maintenance task, not evidence of production adoption or runtime behavior.

## The documentation task

The diagram should help a new contributor answer two questions: where do CLI and agent requests reach the same editing engine, and what happens before an edit can be reported complete?

The existing path remains useful on its own. Its two new branches explain that MCP validates project-relative paths before entering that engine, then checks the saved receipt and decodes retained PNGs before returning images to the agent.

Concise prompt:

> Extend this existing saved-edit pipeline with the scoped MCP path in src/scoped-mcp.js. Add its entry in the empty upper slot, connect it to inspection and the request gate, and add the verified image response beside the completed receipt. Show the project boundary and receipt checking plus PNG decoding. Keep every existing node, label, arrow geometry, and handwritten note. Inspect the source and supported operations, then return the editable copy, before/after PNGs, and receipt.

Full task specification:

> Extend this existing saved-edit pipeline with the scoped MCP interface implemented in src/scoped-mcp.js at commit 8b033142aa429a998057734b3c095e5c94816174. Add a blue “MCP entry / Project boundary” node in the empty upper slot (x630, y150, 240×100), connected to Inspect input and Request gate. Add a blue “Verified images / Receipt + decode” node beside Commit receipt (x930, y580, 240×100), connected from Commit receipt. Both nodes use 24px labels. These additions explain MCP's project-relative paths and preview() rechecking the saved receipt and decoding actual PNG bytes; note the 2 MiB inline limit in the response. Preserve every existing node, label, arrow geometry, and handwritten note; permit only the exact reciprocal binding additions needed for new connections. Inspect capabilities and the cited source first. Use native scoped operations and return the editable result, actual before/after PNGs, and receipt.

## Read the flow against the source

Boxes summarize stages; they are not all separate functions or services. Arrows describe calls, execution order, or data moving between stages.

| Stage | What the code does | Source |
|---|---|---|
| CLI request | Dispatches inspect or calls the shared edit engine with request JSON. | [commands.js:11–16](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/commands.js#L11-L16) |
| Inspect input | Validates the native file; returns IDs, its byte hash, and supported operations. | [scene.js:107–139](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L107-L139) |
| Request gate | Retains request identity, reuses verified completion for an identical retry, claims an attempt, and rejects stale input. | [scene.js:407–432](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L407-L432) |
| Scoped edits | Applies supported operations to a clone; validates bindings and the permitted write-set. | [scene.js:158–194](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L158-L194), [operation dispatch](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L242-L255) |
| Native copies | Writes the original bytes and the edited native document into the attempt directory. | [scene.js:433–437](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L433-L437) |
| Render PNGs | Renders both native documents with Excalidraw in Chromium. | [scene.js:438–444](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L438-L444), [render.js:36–66](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/render.js#L36-L66) |
| Commit receipt | Hashes retained artifacts and publishes the completed receipt after rendering succeeds. | [scene.js:445–460](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L445-L460) |
| Verify receipt | Rechecks recorded request identity, artifact hashes, native bindings, and the actual native change summary. | [scene.js:347–404](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scene.js#L347-L404) |
| Compare views | Opens the verified before/after documents in the review interface. | [commands.js:30–43](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/commands.js#L30-L43) |
| MCP entry — added | Enforces the project boundary, then calls the same inspection and editing functions. | [scoped-mcp.js:89–103](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scoped-mcp.js#L89-L103), [164–189](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scoped-mcp.js#L164-L189) |
| Verified images — added | Calls receipt verification, checks image hashes, decodes PNG bytes, and returns inline images within the size limit. | [scoped-mcp.js:135–152](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scoped-mcp.js#L135-L152), [PNG decoding](https://github.com/edwingao28/excalidraw-toolkit/blob/8b033142aa429a998057734b3c095e5c94816174/src/scoped-mcp.js#L54-L77) |

The CLI and MCP entry arrows represent direct calls to `inspectScene` and `editScene`. The core calls `applyOperations` and `renderScene`. Inspection supplies IDs and a hash **through the caller**; `inspectScene` does not call `editScene`.

The candidate → copies → renderer → receipt arrows show execution order inside `editScene`. Copies are written before rendering. A failed render can leave retained attempt files without a completed receipt.

The receipt → comparison and receipt → images paths consume saved artifacts. The MCP image branch independently invokes `verifyReceipt`; it does not bypass verification or use the interactive review UI. Both `edit_scene` responses and `read_preview` use this branch.

## What preservation means here

Keep the original file unchanged and retain all existing object IDs, text, positions, styles, arrow geometry, embedded assets, and unknown fields. Preserve both manual notes and their freehand decoration.

New arrows require reciprocal references in their existing endpoint shapes' `boundElements`. Those specific additions are necessary native metadata changes, not changes to the preserved layout. New shapes, bound labels, and arrows need distinct stable IDs. Arrow IDs use the `edge-` prefix to keep them distinct from node IDs.

Receipt verification and PNG decoding establish saved-content checks, not visual quality. The agent and a separate visual review checked the actual images for readable labels, correct connections, and preserved notes. This saved-edit path does not call the separate pixel-comparison verifier used by other workflows. Source references explain the inspected code; they do not establish runtime behavior.
