# Live validation

A small sample app and its diagram, used by the manual
[Live validation workflow](../../.github/workflows/live-validation.yml) to run one
real, model-backed diagram refresh end to end: Claude Code proposes the diagram
change, the toolkit qualifies it, and the result is published as a managed comment
on a draft sandbox PR.

## What a run does

1. **sandbox** recreates the `live-validation` branch as `main` plus the scripted
   source change in `change.mjs` (requests now go through a queue), pushes it, and
   finds or opens a draft PR from it.
2. **generate** builds the accepted baseline at `main` from `evidence.json` (which
   names no commit, so it never points at a squashed-away SHA), then runs the CI job
   with the [Claude Code adapter](../ci/claude-code-adapter.mjs). Claude Code runs
   headless with read-only tools, an empty `HOME`, user settings only and no MCP
   servers, and returns the regenerated scene and evidence as validated JSON. The
   toolkit then checks the evidence against the commit, recomputes the three-way
   merge and pixel-checks the preview. This is the only job with the model token,
   and it has no write permission.
3. **move-head** (only with `stale-head`) pushes another commit to the sandbox
   branch, so publishing must refuse the now-stale result.
4. **publish** uploads the four artifacts to the `diagram-artifacts` prerelease and
   creates or updates the managed comment on the sandbox PR.

## Running it

Actions → **Live validation** → **Run workflow**. Suggested sequence:

1. A normal run: the PR gets a diagram comment.
2. A second normal run: the same comment is updated for the new sandbox commit.
3. A run with **stale-head** checked: publishing ends `blocked` with
   `source-head-changed`, and the comment is unchanged.

Before the first run:

- The `CLAUDE_CODE_OAUTH_TOKEN` repository secret must be valid. Each run spends up
  to `max-budget-usd` (default 2) from that account.
- Either allow GitHub Actions to create pull requests (Settings → Actions → General)
  or open a draft PR from `live-validation` to `main` once by hand.

The sandbox PR and branch are for validation only; do not merge them.

## Locally

`test/live-validation.test.js` runs the same scripts against a temporary repository
with a stand-in for the `claude` CLI, so the harness is checked on every CI run
without model access.
