# Releasing

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml).
The workflow checks that the tag matches `package.json` and is on `main`, builds, runs the
tests, publishes to npm with provenance, and creates the GitHub release. It authenticates
with npm trusted publishing (OIDC), so the repository stores no npm token.

## One-time setup on npm

A package maintainer links this workflow to the `excalidraw-toolkit` package once.

On npmjs.com, open the package's **Settings**, find **Trusted Publisher**, choose
**GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `edwingao28` |
| Repository | `excalidraw-toolkit` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |
| Allowed actions | allow `npm publish` |

Or, with npm 11.15+ and two-factor authentication enabled on the account:

```sh
npm trust github excalidraw-toolkit --file release.yml \
  --repo edwingao28/excalidraw-toolkit --allow-publish
```

npm does not validate this configuration when it is saved; mistakes surface at publish
time. A new configuration expires if it has not published successfully within two days,
so push the release tag soon after adding it.

After the first trusted publish succeeds, npm recommends setting **Publishing access** to
require two-factor authentication and disallow tokens, then revoking old automation tokens.
Trusted publishing keeps working because it does not use a token.

## Cut a release

1. Merge a change that sets the new `version` in `package.json` and both
   `.claude-plugin/plugin.json` manifests, with any install docs that name the version.
2. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.3.0 -m "excalidraw-toolkit 0.3.0"
   git push origin v0.3.0
   ```

3. Watch the **Release** workflow. When it finishes, check the registry and a clean install:

   ```sh
   npm view excalidraw-toolkit dist-tags
   npm install --prefix "$(mktemp -d)" --omit=dev excalidraw-toolkit@0.3.0
   ```

4. Edit the generated GitHub release notes if needed.

A failed run publishes nothing unless it failed after `npm publish`. A published version
cannot be republished; fix forward with a new patch version.
