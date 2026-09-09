# Draw and review in one workspace

Run `excalidraw-toolkit preview diagram.excalidraw` to open an editable working
copy. The native Excalidraw toolbar supports selection, shapes, arrows, text,
freehand annotations, images, and keyboard undo/redo. The input file on disk is
never overwritten.

- **Working** is your editable document. Click an object or edit in the sidebar to
  find it on the canvas. Native undo history stays available when you visit snapshots.
- **Before** is a preserved snapshot. Preparing an agent edit captures a new Before
  from the working document at that moment.
- **Agent proposal** is the returned diagram, displayed read-only. Accept merges its
  changes into your latest work. Discard leaves your working diagram unchanged.

Opening a normal edit receipt shows its After file as an Agent proposal, with its
Before file as the initial working document. Source-evidence and refresh receipts
remain immutable reviews with their original labels and retained exports. Choose
**Edit copy** to draw on a separate copy; those later changes are not source-verified.

## Work with your existing agent

1. Draw or open a diagram. Select the elements you want your agent to work on.
2. Describe the edit in the sidebar and choose **Prepare agent edit**. This downloads
   the complete current diagram and captures the exact proposal base.
3. Attach that file and the displayed instructions to Claude Code, Codex, or your
   preferred agent. You can continue drawing in Working while it runs.
4. Choose **Load proposal** and open the returned `.excalidraw` file.
5. Review Before, the proposal, and your current Working diagram. **Accept proposal**
   preserves independent manual edits; one native Undo reverses the acceptance.

The sidebar prepares a file handoff. It does not run a model or connect a ChatGPT or
Claude subscription inside the website. An in-page agent conversation remains a
future integration.

Acceptance stops when changes conflict: for example, both versions move the same
object, delete versus edit an object, modify related bindings, reuse an image ID
with different bytes, or reorder the same objects differently. Nothing is partially
applied. Discard the proposal, keep Working, and prepare a new input for the agent.
Proposal changes that native undo cannot reliably represent (such as arbitrary
file-level metadata) also require a new proposal. Unknown existing fields and
unrelated manual drawings are retained.

## Save, export, and recover

**Save diagram** downloads the live Working canvas as a native `.excalidraw` file,
including manual additions and image data. **Open file** reopens that file here;
it also remains usable in Excalidraw. Saving or exporting a snapshot uses that
snapshot, not the live working document. PNG export reads the current view and
never includes the workspace UI or focus outline.

A local browser draft is written after changes. **Saved in this browser** appears
only after the storage transaction completes. Reloading the same preview URL
restores the working document and any pending proposal. Native undo history is
session-only and starts fresh after a reload. Storage failures are visible; use
Save diagram to retain a portable copy. Drafts are specific to this browser and
preview URL, so download before closing or restarting the local preview server.
Opening another file offers to save a working diagram that has not been downloaded.
