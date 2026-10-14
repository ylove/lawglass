# Local legislation fixtures

Only the manifest, documentation and download tooling are committed. Real
legislation files live in the gitignored `fixtures/downloads/`; never commit them
or their `.mismatch` copies. CI uses generated samples from `tests/synth/` and
does not download these files.

Fetch all six public documents with Node ≥22.13:

```sh
npm ci
npm run fixtures:fetch
```

To fetch a subset:

```sh
npm run fixtures:fetch -- --only us-s202-119-is,oh-sb113-136-in
```

The script validates the manifest, verifies SHA-256 and byte size, and skips
matching local files. Text fixtures use `.txt`; other extensions match their
manifest format. Each request has a 60-second timeout. Failures produce a nonzero
exit code, and a summary table reports every selected fixture.

Government sites sometimes re-render documents, especially PDFs. A mismatch is
saved with a `.mismatch` suffix and its new hash and size are printed. Review the
source before deliberately updating the manifest's `sha256`, `bytes` and
`retrievedAt`, then run the fetch again. The script never updates the manifest.

Local integration tests import `fixturePath(name)` or
`describeWithFixture(name, fn)` from `tests/support/fixtures.ts`. Only verified
files are returned; suites skip with fetch instructions when files are missing
or invalid. Eval code can use `readManifest`, `fixtureFilename` and
`verifyFixture` from `scripts/fixture-manifest.ts` without importing Vitest.
