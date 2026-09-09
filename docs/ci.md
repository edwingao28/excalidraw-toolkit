# Scoped Git and CI artifacts

`runDiagramJob` is a thin invocation of a configured, existing diagram workflow.
It does not choose a model, inspect an entire repository, run a second agent,
adopt a refresh, overwrite the diagram, or publish a comment.

Configure the source scope and a pinned accepted PR9/PR11 baseline:

```json
{
  "schemaVersion": 1,
  "id": "request-flow",
  "sourcePaths": ["src/api", "src/worker"],
  "diagramPath": "docs/request-flow.excalidraw",
  "trigger": "manual",
  "baseline": {"bundlePath": "baseline/evidence.json", "sha256": "<retained manifest SHA-256>"},
  "output": "jobs",
  "execution": {
    "version": "reviewed-workflow-v1",
    "executable": "/absolute/path/to/node",
    "args": ["/absolute/path/to/reviewed-existing-workflow.mjs"],
    "timeoutMs": 300000,
    "forwardEnv": ["ANTHROPIC_API_KEY"]
  }
}
```

Replace the paths and manifest hash with verified values. The executable and
literal argv are explicit; no shell expansion or command templates are supported.
`forwardEnv` names explicitly authorized runtime credentials. GitHub and Actions
credential variables are never forwarded. The minimal inherited environment is
PATH, SYSTEMROOT and TMPDIR; CLI authentication using a home directory must be
configured explicitly in a trusted workflow. This is a process boundary, not a
sandbox against a malicious executable. Do not execute fork-controlled scripts,
configuration or source with credentials.

An event file declares `trigger`, full `baseRevision`, full `sourceRevision`,
`headRef` (for example `refs/heads/main`) and `trusted: true`. The trusted flag
comes from the CI controller's checked event policy, never an incoming PR file.
Untrusted events fail before launching either the executable or an injected
runner. Trigger values are `push`, `pull_request` and `manual`.

```sh
node examples/ci/run-job.mjs --repository /checkout --state /restored-state \
  --config /trusted/diagram-job.json --event /trusted/event.json
```

`examples/ci/diagram-artifacts.yml` demonstrates a manual GitHub Actions trigger
that restores an explicitly selected artifact from a prior trusted run. It needs
a reviewed runtime adapter and its model access; missing access produces a failed
job. Adapting it to push/PR events requires a trusted event classifier, current
head fetching, and a persisted baseline source. Do not switch it to
`pull_request_target` or execute a fork checkout with publishing credentials.

## Existing workflow contract

The executable reads one JSON request from stdin:

```js
{
  schemaVersion: 1, requestId, repositoryPath, baseRevision, sourceRevision,
  sourcePaths, baselineBundlePath, baselineHash, currentPath, outputDir
}
```

Use the same source-evidence and `stageRefresh` commands as the interactive
workflow. Supply the exact proposed source revision, preserve overrides, and
render the resulting native candidate. Never automatically call `adoptRefresh`.
Retain the staged refresh directory under outputDir, write the evidence and report,
then emit one JSON object on stdout pointing to four regular public artifacts:

```json
{
  "status": "ready",
  "artifacts": {
    "native": "candidate.excalidraw",
    "preview": "preview.png",
    "evidence": "evidence.json",
    "report": "change-report.json"
  }
}
```

`unchanged` is also accepted. Evidence uses the raw PR9 schema with an exact Git
revision and scope no wider than configured paths. The report contains
`schemaVersion: 1`, the matching `status`, `sourceRevision`, `baseRevision`,
`changes`, `overrides` and `conflicts` from the staged refresh, plus
`refresh: { "file": "refresh/refresh.json", "sha256": "<retained refresh hash>" }`.
The refresh receipt and its `current.excalidraw`, `generated.excalidraw` and
`candidate.excalidraw` snapshots must remain in that directory. Use `stageRefresh`
with the exact request ID, baseline, current scene and repository paths supplied
by the controller. `runPreparedRefresh` already returns this contract.

Qualification rechecks the source references and recomputes the three-way merge
against the controller's retained baseline and current scene. The candidate,
evidence and reported changes/overrides/conflicts must match that result. Rewriting
candidate hashes cannot conceal a removed manual note or a lost human override.
A runner cannot qualify an arbitrary replacement scene by claiming `ready`.

The preview must use the toolkit's standard native PNG export (light background,
30px padding). Pinned Chromium decodes it and compares every pixel with a fresh
export of the verified candidate. Positive dimensions are limited to 16384px per
side and 16 megapixels. `INVALID_PREVIEW` means the image is unreadable or outside
those bounds; `PREVIEW_MISMATCH` means it does not match the candidate. Regenerate
the preview using the toolkit renderer. Browser setup is required for this check;
`PREVIEW_BROWSER_MISSING` directs the caller to `excalidraw-toolkit setup-preview`.

Nonempty conflicts, missing refresh proof, stale references, invalid bindings,
candidate/report mismatches, unreadable or mismatched previews, unavailable runtime
or timeout produce a durable failed job. A successful child exit code alone is
insufficient. Pixel correspondence and source-location checks do not prove source
claims or visual readability; those remain the agent's acceptance obligations.

For embedding, import `runDiagramJob(options, {runner})`. The injected runner has
the same request/result contract and receives `{signal}`. It must honor aborts.
The subprocess adapter kills its owned process group at the configured timeout.

## Persistence and ordering

Keep `stateDir` outside the checkout. Restore the complete accepted baseline
directory and receipts before every ephemeral run, retaining their hashes. The
job snapshots and verifies its baseline and committed diagram bytes. State keys
use exact source/base commits, head ref, event policy and canonical configuration,
so changing the checkout's absolute path does not change a completed job's key.

Jobs live under `output/id/<job key>/job.json`. All attempts and artifact files
are immutable namespaces. Duplicate completed/failed events reuse and verify
their receipts. A different execution version explicitly permits a new attempt
after a terminal failure. Crashed attempts on the same host can recover through
an exclusive new claim; a foreign unfinished host remains busy. Restore completed
receipts across runners, or explicitly reconcile an unfinished remote claim.

Completed jobs record `verification.method: "three-way-native-v1"`, native preview
dimensions/renderer identity and hashes of the retained refresh and input proof
files. Duplicate/restored jobs verify those files without rerunning the agent or
renderer. Older completed receipts without this qualification are rejected;
change `execution.version` to create a fresh qualified job while retaining the old
evidence. Upload the complete job directory, including input and proof files.

The orchestrator checks the configured Git head before running and after artifact
validation. Superseded jobs retain their evidence but cannot overwrite any newer
job. There is no mutable `latest` output or implicit baseline advancement. Fetch
current refs in CI immediately before each invocation; a stale local ref cannot
establish remote currency. Publication adds a separate live GitHub head check.
Use CI concurrency controls when multiple hosts share a publication destination;
this module does not provide cross-host cancellation or distributed locks.

After explicit adoption, persist the new accepted baseline and configure its
manifest hash for future jobs. Artifact upload should run even on failure so the
failed receipt survives. Visibility follows the repository's artifact access
policy; configure public links only in the optional publisher.
