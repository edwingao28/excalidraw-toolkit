# Draw and review in one workspace

Run `excalidraw-toolkit preview diagram.excalidraw` to open an editable working
copy. The native Excalidraw toolbar supports selection, shapes, arrows, text,
freehand annotations, images, and keyboard undo/redo. The input file on disk is
never overwritten.

Choose **Full screen** beside **Fit diagram** to fill the browser window with the
canvas. Drawing tools, selection, version tabs, and undo/redo remain available.
Use **Exit full screen** or press Escape to restore the workspace; Escape inside a
text field finishes that native edit first. The editor stays mounted throughout,
so drawing and undo history survive both modes. Historical snapshots remain read-only.

- **Working** is your editable document. Click an object or edit in the sidebar to
  find it on the canvas. Click it again to clear the selection and fit the entire
  diagram; switching versions keeps that overview. Expand **more objects** to reach
  the rest of the list. Native undo history stays available when you visit snapshots.
- **Before** is the preserved input file or the original input from an edit receipt.
- **Agent proposal** is the returned diagram, displayed read-only. Accept merges its
  changes into your latest work. Discard leaves your working diagram unchanged.

Opening a normal edit receipt shows its After file as an Agent proposal, with its
Before file as the initial working document. Source-evidence and refresh receipts
remain immutable reviews with their original labels and retained exports. Choose
**Edit copy** to draw on a separate copy; those later changes are not source-verified.

## Work with your existing agent

1. Draw or open a diagram, then choose **Save diagram** to download the current file.
2. Give that file and your editing request to Claude Code or Codex with the toolkit
   installed. Ask it to preserve unrelated content and return an edit receipt.
3. Open the returned receipt with `excalidraw-toolkit preview /path/to/receipt.json`.
4. Review Before and Agent proposal. You can draw in Working during review;
   **Accept proposal** preserves independent manual edits, and one native Undo
   reverses the acceptance. **Discard proposal** keeps your working diagram.

Agent requests run in your coding agent. The website provides drawing and review;
an in-page agent conversation is not shipped.

Acceptance stops when changes conflict: for example, both versions move the same
object, delete versus edit an object, modify related bindings, reuse an image ID
with different bytes, or reorder the same objects differently. Nothing is partially
applied. Discard the proposal, keep Working, and save a new input for the agent.
Proposal changes that native undo cannot reliably represent (such as arbitrary
file-level metadata) also require a new proposal. Unknown existing fields and
unrelated manual drawings are retained.

## Save, export, and recover

**Save diagram** downloads the live Working canvas as a native `.excalidraw` file,
including manual additions and image data. **Open file** reopens that file here;
it also remains usable in Excalidraw. Saving or exporting a snapshot uses that
snapshot, not the live working document. PNG export reads the current view and
never includes the workspace UI or focus outline.

A local browser draft is written quietly after changes. Reloading the same preview
URL restores the working document and any pending proposal. Native undo history is
session-only and starts fresh after a reload. Storage failures are visible; use
Save diagram to retain a portable copy. Drafts are specific to this browser and
preview URL, so download before closing or restarting the local preview server.
Opening another file offers to save a working diagram that has not been downloaded.
