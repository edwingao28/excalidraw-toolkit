# Optional managed PR updates

Artifact generation works without publication. `publishDiagramJob` returns
`{status: 'disabled'}` before filesystem or network I/O unless
`publication.enabled` is exactly `true`. The example CLI also defaults off:

```sh
node examples/ci/publish-job.mjs
```

Enable it only from a trusted publisher job, after uploading the verified CI
artifacts and retaining the uploaded file digests. The publisher runs no source
code or diagram generation. Its token stays in the trusted process and is sent
only to the configured GitHub API origin, with redirects disabled. It is never
sent to artifact origins or saved in publication receipts.

```js
import { publishDiagramJob } from './src/publication.js';

await publishDiagramJob({
  receiptPath: '/trusted-download/job.json',
  receiptHash: '<retained CI receipt SHA-256>',
  stateDir: '/restored-publication-state',
  publication: {
    enabled: true,
    owner: 'OWNER', repo: 'REPO', pullNumber: 123,
    actor: 'github-actions[bot]',
    forkPolicy: 'deny',
    visibility: 'public',
    artifactOrigins: ['https://example.com'],
    artifacts: {
      native: {url: 'https://example.com/candidate.excalidraw', sha256: '<uploaded file SHA-256>'},
      preview: {url: 'https://example.com/preview.png', sha256: '<uploaded file SHA-256>'},
      evidence: {url: 'https://example.com/evidence.json', sha256: '<uploaded file SHA-256>'},
      report: {url: 'https://example.com/change-report.json', sha256: '<uploaded file SHA-256>'},
    },
  },
  context: {
    trustedWorkflow: true,
    sourceRepository: 'OWNER/REPO',
    sourceRevision: '<exact head commit>',
  },
}, {token: process.env.GH_TOKEN});
```

The JSON request form can use `examples/ci/publish-job.mjs --enabled --request
/trusted/publication.json`. Keep the token in the publisher's environment, not
in that file. A completed job's native, preview, evidence and report hashes are
checked again. Configured uploaded hashes must match those verified files. The
publisher does not upload files or fetch artifact links: the trusted uploader
must supply durable URLs and enforce the declared access policy.

`public` visibility requires a public destination repository. `repository`
visibility requires a private destination repository and links whose access the
uploader restricts to that repository. Do not expose private artifacts through a
public CDN. A configured actor limits management to that bot's comments; copied
markers in another author's comment are ignored. Changing bot identity requires
explicit ownership reconciliation.

## Credentials and fork boundary

Build this request from verified CI event/run metadata and repository policy.
Never trust `trustedWorkflow`, the destination, the receipt hash, the API origin,
or uploaded artifact URLs supplied by a PR's source files. The caller establishes
trust; this JavaScript API cannot authenticate the caller's assertions. Pin the
publisher code/configuration to the trusted workflow revision. Download artifacts
only from the verified source workflow run, and check its repository, conclusion,
head SHA and expected workflow before exposing credentials.

The context must identify a trusted workflow and the source repository before
any HTTP request. The live PR response independently verifies the destination,
head repository, source commit, visibility and open state. With `forkPolicy:
'deny'`, the source must be the destination itself and a fork PR is refused.
Never execute a fork checkout from `pull_request_target` or a privileged
`workflow_run` job. GitHub documents the risks of running untrusted code in
privileged workflows in its
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

### Fork pull requests

A fork PR's own workflow gets no secrets, so it cannot run a model. Forks are
supported only through a proposal the contributor prepares and commits (see
[contributor-prepared proposals](ci.md#contributor-prepared-proposals)), with
`forkPolicy: 'prepared-proposal'`. Then:

- The context's `sourceRepository` may be the PR's head repository. The live PR
  must report that same head repository and the job's source commit before any write.
- A fork's job must have been qualified by the `prepared-proposal` runner, which
  reads the proposal as Git data and executes nothing from the PR. Any other
  job is refused with `fork-requires-prepared-proposal`.
- The comment says the proposal was prepared in the pull request and checked by
  CI without running its code.

[`fork-pr.yml`](../examples/ci/fork-pr.yml) and
[`fork-publish.yml`](../examples/ci/fork-publish.yml) show the two-workflow
pattern. The unprivileged PR workflow records only the PR number, because
`workflow_run` payloads do not list fork PRs. The privileged `workflow_run`
workflow runs default-branch code only, in two jobs:

1. **qualify** holds a read-only token. It checks the triggering run's event,
   workflow path, conclusion, head SHA and head repository against the live PR
   (`verifyForkRun`). It fetches the PR head as Git objects only, without checkout,
   and qualifies the proposal against the trusted configuration and baseline
   from the default branch (`qualifyForkPullRequest`). This is the job that parses
   and renders PR data.
2. **publish** holds `contents: write` and `pull-requests: write`. It rechecks
   every artifact hash from the qualify job, uploads uniquely named assets to a
   `diagram-artifacts` prerelease (`prepareForkPublication`), and updates the
   managed comment.

The example keeps publication state per run; the comment marker still prevents
duplicates. Persist that state if you need the full intent journal across runs.

Use a token with access to only the configured repository. GitHub's
[issue-comment API](https://docs.github.com/en/rest/issues/comments) supports
managed PR comments and requires Issues write or Pull requests write for comment
mutations; head checks use the [pull-request API](https://docs.github.com/en/rest/pulls/pulls).
Missing tokens and rejected permissions return explicit blocked/failed results.
An optional HTTPS API origin supports a trusted GitHub-compatible endpoint;
HTTP is allowed only on numeric loopback hosts for isolated test fixtures.

## Reconciliation and ordering

A stable marker identifies the API origin, destination PR and diagram config ID.
The comment includes the source revision, job key, receipt hash and artifact
links. Every invocation scans all comment pages (bounded at 10,000 comments)
using fixed API paths. It creates a comment only when the marker is absent,
updates that same bot-owned comment for a new result, and does nothing when the
body already matches. Multiple existing bot-owned matches block publication;
the toolkit does not guess which competing output to delete.

Before each mutation, it durably claims an immutable write intent containing
hashes and a comment ID. An uncertain POST/PATCH response triggers a marker lookup,
not an automatic mutation retry. If lookup finds the intended body, the outcome
is reconciled. If it cannot confirm the outcome, the pending intent survives.
The next invocation looks it up again and cannot blindly create another comment.
If the original request never reached GitHub, an operator must establish that
fact and reconcile the pending intent before allowing a new publication. Retain
the old journal for audit; do not erase it merely to bypass an uncertain outcome.

Persist the complete publication state across ephemeral runners. Shared-state
writers compete for one exclusive intent. Separate copies of that state are not
a distributed lock: configure CI concurrency per repository/PR/diagram and run
one trusted publisher at a time. This provides reconciliation, not exactly-once
remote writes.

The live head is checked before lookup, immediately before mutation, and after
the write. A stale head before mutation makes no writes. A head change during
the API call returns `superseded` with `wrote: true`; a failed final head read
returns `uncertain`. GitHub provides no atomic transaction covering the PR head
and comment update, so a force-push can race the final check. No automatic
rollback is attempted because it could overwrite a newer result. The next
current-head job reconciles the same managed comment.

These tests use a real local HTTP fixture with dropped connections, pagination,
permissions and fork/head changes. Their input is an actual CI job qualified by
three-way refresh replay and native decoded-pixel comparison, then restored with
all proof artifacts for each HTTP case. Missing qualification and changed proof
files block publication before HTTP. They do not establish that a live repository's
token, uploaded URLs or automation policy are correctly configured; validate those
integration boundaries before enabling publication.
