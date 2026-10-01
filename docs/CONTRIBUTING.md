# Contributing

Everything required runs **offline**. No provider account, no API key, no paid
endpoint, no GPU.

## Setup

```bash
npm ci --ignore-scripts
npm run check
```

Node 24+ is required. The project is TypeScript/ESM with no runtime
dependencies; `tsx` and `typescript` are dev-only.

`npm run check` is the full gate:

| Step | What it proves |
| --- | --- |
| `typecheck` | `src/` compiles under `tsconfig.json`. |
| `typecheck:tests` | `test/` compiles under `tsconfig.tests.json`. |
| `test` | The whole suite, offline. |
| `build` | `dist/` is emitted. |

## The test suite

```bash
npm test                                        # everything
node --import tsx --test test/provider.test.ts   # one file
node --import tsx --test --test-name-pattern "timeout"   # one behaviour
```

Tests never contact a real provider. HTTP is stubbed or pointed at a loopback
server. If you add a test that needs a live endpoint, gate it behind an
environment variable and skip it by default — the CI job must keep passing
without credentials.

## Provider fixtures

Two distinct things, do not confuse them:

- **`fixtures/verify/cases.json`** — labelled cases for `semantic_verify_task`.
  `scripts/verify-fixture-set.ts` is the single schema and balance contract:
  it refuses a `pass-candidate` label while the policy is uncalibrated, and it
  refuses lexically duplicated criteria so the suite cannot be padded. Run
  `npm run verify:experiment`.
- **`npm run conformance:smoke`** — protocol conformance against a local stub.
  Proves the transport, the case matrix and the report shape. It proves nothing
  about any real runtime.

Live conformance and live verification are opt-in and never run in CI:

```bash
SEMANTIC_ENDPOINT=... npm run conformance
SEMANTIC_ENDPOINT=... npm run verify:experiment -- --live
```

## Adding a data-only preset

A preset is **data**, not code: an identity, a default model, and the
capabilities the provider declares. Adding one must not add a transport, a
client, or a per-vendor branch.

1. Add the entry to `src/presets/index.ts`.
2. Declare capabilities **only where you have observed them**. `capabilityOf()`
   returns `unverified` for anything undeclared — absence of evidence is never
   turned into a failure.
3. If the preset needs a second transport, stop: that is an architecture
   change, not a preset. File an issue first.

Any capability you declare needs a provenance in the docs saying which run
observed it and when. One observation is a declaration with a provenance, not a
certification, and it must be re-observed rather than assumed.

## Docs that are checked

- `docs/TRACEABILITY.md` maps every requirement to a named proof. Its counts are
  recomputed by `test/traceability.test.ts`, which also verifies that every cited
  file and every quoted test name actually exists. Update the table and the
  summary together, or the suite fails.
- `docs/IMPLEMENTATION.md` must keep naming the verified OpenFox baseline;
  `test/skill-api-compat.test.ts` asserts it.

## Rules for claims

- An unmeasured metric is `null`. It is never `0`.
- Say "not measured" rather than implying a good result.
- Never record an endpoint, a credential, criterion text or repository content
  in a committed report. Committed campaign snapshots are number-only.
- A tool that is advisory must not be described in a way that lets a reader
  mistake it for a verdict.

## Before you open a PR

```bash
npm run check
npm run conformance:smoke
npm pack --dry-run
```

If you touched the OpenFox-facing contract, also run the isolated harness
against the **minimum** supported release, not only the newest:

```bash
HARNESS_PKG_DIR=/tmp/of-harness-2.0.157 scripts/setup-harness.sh
HARNESS_PKG_DIR=/tmp/of-harness-2.0.157 npm run harness
```

The setup script refuses to reuse a tree that holds a different version and
prints the version read back from the tree, so the reported version is always
the one that actually ran.
