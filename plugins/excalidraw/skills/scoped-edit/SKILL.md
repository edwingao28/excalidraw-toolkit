---
name: scoped-edit
description: Edit an existing saved .excalidraw diagram with scoped changes, preserved manual content, and before/after artifacts. Use for recoloring or relabeling a saved scene, or another edit explicitly supported by the installed toolkit.
---

# Edit a saved Excalidraw scene

Use the installed toolkit's native file workflow. The separate live-canvas MCP integration is not required for this skill. When the workspace-scoped tools `inspect_scene`, `edit_scene` and `read_preview` are available, use them for saved-file edits. This is the supported route for Codex's default macOS shell sandbox, which cannot launch the native renderer. Never change sandbox or approval settings to make an edit work.

With those MCP tools: call `inspect_scene` with a project-relative `inputPath`, read its actual IDs/hash/capabilities, then call `edit_scene` with the same path, a stable `requestId`, the inspected `baseHash`, and supported `operations` as described below. Outputs use the server's fixed project-local directory. Call `read_preview` with that request ID to inspect the verified before/after images. If images are omitted for size, read the returned PNG files with the client's image tool. Return the actual native/preview/receipt paths and qualify any unverified claims. Matching retries use the same ID and payload; changed payloads need a new ID.

For a CLI-capable client, follow these equivalent steps:

1. Discover the installed command contract. If the command below still contains template braces, report that this skill template has not been installed. Otherwise, run this exact prefix in {{SHELL_NAME}}; keep the executable and CLI paths unchanged when selecting subcommands:

   ```sh
   {{CLI_COMMAND}} --help
   ```

   Read command help; `inspect` returns the installed capabilities. Continue only when the requested operation is supported. An unavailable command or capability is a concrete limitation to report; a replacement drawing does not satisfy a scoped edit.

2. Run `inspect <input.excalidraw>` with that prefix and the user's actual, shell-quoted input path. Read `baseHash`, `elements`, and `capabilities` from its JSON output. Resolve the intended existing element IDs and relevant bound text. Ask a focused question only if the requested target or change remains ambiguous after inspection.

3. Write a request JSON file using a file-writing tool, with `requestId`, the exact inspected `baseHash`, and an `operations` array. Resolve every `targetId` from inspection. Supported operation shapes include:

   ```json
   {"op":"setStyle","targetId":"<inspected ID>","style":{"backgroundColor":"#a5d8ff"}}
   ```

   ```json
   {"op":"setLabel","targetId":"<inspected ID>","text":"Shared cache"}
   ```

   Select only operations actually returned in `capabilities`. Run `edit <input.excalidraw> --request <request.json> --output <directory>` with the installed prefix and each real path shell-quoted. Save the result as an edited copy and keep the original. Use one request ID for the same operation; on an uncertain result, retry with the same ID and identical payload. A changed payload needs a new request ID. Let the toolkit enforce protected fields and reject stale input or unsupported dependencies.

4. Read the completed receipt and inspect the actual before/after PNG files using the client's image-reading tool. Use `preview <receipt.json>` when advertised and an interactive view is useful; opening that view does not substitute for inspecting the saved PNGs. Check the requested edit, surrounding labels, and unrelated manual content. If image inspection is unavailable, state that visual verification was not completed. If the renderer reports `PREVIEW_BROWSER_MISSING`, run `setup-preview` with the installed prefix and retry the same request. Treat a failed or incomplete receipt as unfinished work; use the reported error to choose the next step. Use at most two corrective candidates, then report an unresolved visual problem. Any corrective edit must stay within the user's authorized change and the installed operation set.

5. Return links to the editable result, before/after previews, and receipt. Summarize the change and any unresolved limitation. Claim preservation, completion, or visual quality only when supported by the receipt, saved files, and images you actually inspected.

The native input remains the presentation authority, including its image assets, ordering, settings, and unknown fields. Use the supported edit path throughout; do not clear a live canvas or regenerate the scene to perform a saved-file edit.
