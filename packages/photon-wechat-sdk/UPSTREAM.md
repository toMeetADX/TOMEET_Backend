# Upstream provenance

- Repository: https://github.com/photon-hq/spectrum-wechat-beta
- Commit: `4cfefc596a71e90f0a41821a373f4fc9f85eee97`
- Imported paths: `src/`, `LICENSE`
- License: MIT

This fixed source snapshot is used because the beta package is not published to
npm and its Git dependency runs a nested `pnpm install` during `prepare`, which
is not reproducible under the repository's build-script approval policy.

Review the upstream diff and repeat the source-only import before changing the
pinned commit.
