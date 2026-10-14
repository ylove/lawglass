# Accepted risks

Known supply-chain risks we have looked at and decided to carry. Each entry says why and when to
revisit it. The full audit matrix (#189) will fold these in.

## onnxruntime-web prerelease (transitive)

- **What:** `@huggingface/transformers@4.3.1` depends on `onnxruntime-web` at a `1.31.0-dev.*`
  prerelease build (with a matching `onnxruntime-common` prerelease nested under it). We do not
  choose these versions; they come from the pinned transformers.js release.
- **Risk:** prerelease builds get less review than tagged releases, and `npm audit` and OSV match
  advisories against version ranges that dev builds may not map onto cleanly.
- **Why accepted:** it is the version the transformers.js maintainers ship and test with. The
  local backend only runs the two pinned models, whose files are checked against the SHA-256 values
  in `models.lock.json` before loading. Overriding the version would put us on an untested
  combination. Install scripts are skipped in CI jobs that do not need them (`--ignore-scripts`).
- **Revisit:** when `@huggingface/transformers` moves to a stable `onnxruntime-web`, or when
  OSV/`npm audit` reports an advisory against it. Dependabot's 7-day cooldown applies to the bump.
