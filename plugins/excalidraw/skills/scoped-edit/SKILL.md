---
name: scoped-edit
description: Edit a saved .excalidraw diagram while preserving manual content, explain a scoped source flow, or compare a code change with source-linked diagrams. Use the installed toolkit's supported file operations and evidence commands.
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

## Explain a scoped source path

For a source-backed request flow, first establish the user's entry point, question,
repository and source paths. Investigate that scope with the existing coding
agent. Read the actual files at a recorded Git revision and distinguish import,
call and assumption claims. Keep unknown dispatch or runtime behavior explicit.
For a subsystem expansion, retain the surrounding native scene and associate only
newly inspected nodes and relationships; unexamined content stays outside the
declared evidence scope and cannot be inferred obsolete.

Use the saved-scene workflow above to express the inspected flow. Map stable
semantic IDs to inspected native element IDs. Each source reference needs its
repository-relative path and exact line range; each relation must match the native
arrow's endpoints. Label assumptions visibly in the diagram.

When command help advertises `validate-evidence`, write a JSON request with
`repositoryPath`, `inputPath` and the scoped `evidence` object, then run that
command with `--request <file>`. Validation checks locations and mappings; inspect
the cited source yourself before claiming a relationship. Use
`associate-evidence` with `outputDir` to retain an existing diagram's evidence.
Use `accept-baseline` with an explicit `generatedPath` only after the generated
result is adopted. Retain the returned bundle path and manifest hash for refresh.
Request-file filesystem paths resolve relative to the request file. These commands
return JSON; report their concrete errors and any unverified source or visual claim.

## Compare a code change

Retain source-evidence bundles for the exact base and head commits. Keep unchanged
context in the same position, express source changes through supported operations,
and list the required semantic nodes and relations on each side. Use
`explain-change --request <file>` with `repositoryPath`, `base`, `head`,
`repositoryUrl`, `required`, `target` and `outputDir`. Each side supplies its
`bundlePath`, `revision` and retained `expectedHash`.

Choose the user's article, slide or canvas output target before export. Readability
failure requires a deliberate target or composition change; keep required content
visible. Inspect both exported PNGs at their actual size and read the source-linked
change report. Return editable native files, previews and the report with remaining
assumptions. An exported source citation alone does not prove runtime behavior.

## Refresh after a source revision changes

Keep the last accepted generated baseline and current human-edited native scene
as separate inputs. Investigate the changed source within the recorded scope,
prepare the proposed generated scene using stable identities, and update its
evidence. Use `refresh-diagram --request <file>` with `requestId`,
`baselineBundlePath`, `baselineHash`, `currentPath`, `generatedPath`,
`repositoryPath`, `evidence`, `outputDir`, and any explicitly justified
`removedSemanticIds`.

Read the refresh receipt's overrides and conflicts, then inspect the actual
before/after previews. `reconciliation-required` remains unfinished even if an
image exists; a `proposal.png` shows only the source proposal when no valid merged
candidate exists. Resolve uncertain identity mappings and conflicting human/source
intent before staging again. Preserve custom labels, positions and unrelated notes.

When the reviewed candidate is adopted, call `adopt-refresh --request <file>`
with the refresh `receiptPath`, its retained `expectedHash`, and a new baseline
`outputDir`. Retain the resulting bundle/hash for the next revision. The installer
command `update` keeps its existing meaning.

## Generate CI artifacts

Use `ci-diagram --request <file>` only with the user's explicit source paths,
diagram path, trigger, pinned accepted baseline, output state and execution budget.
The request contains `repositoryPath`, `stateDir`, `config` and a trusted CI
`event` with exact commits. Use the existing authorized agent/runtime to prepare
source proposals, or the provided prepared-refresh adapter for an already
investigated proposal. An unavailable model or runtime is a failed job.

Persist the complete baseline and job state across runners. Inspect the job status:
skipped and superseded work are not new completed diagram updates. Validate the
actual native file and preview before reporting a relevant commit's result.
Adoption remains explicit, and generation alone does not publish a PR comment.
