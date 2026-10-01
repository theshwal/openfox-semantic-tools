# Provider calibration and self-test

Semantic runtimes do not necessarily use the same numeric scale for the same
question. The plugin therefore keeps **semantic policy** separate from
**provider calibration**.

## Precedence

Verification resolves numeric policy values in this order:

1. explicit operator overrides (`calibrationOverridesJson`);
2. an explicitly active calibration profile (`calibrationProfileJson`);
3. the shipped conservative `verify-0.3.0` defaults.

Provider presets remain transport/capability metadata. They do not contain
provider-specific verification branches.

## Calibration profile

A profile is JSON with `schemaVersion: 1`. It records provider identity,
provenance/freshness metadata and optional gate overrides.

Example:

```json
{
  "schemaVersion": 1,
  "id": "my-kev-profile",
  "provider": {
    "presetId": "kev",
    "model": "jaredpalmer/kev-4b",
    "runtimeVersion": "2026-10-01"
  },
  "policyVersion": "verify-0.3.0",
  "fixtureSetVersion": "local-v1",
  "testedAt": "2026-10-01T18:00:00Z",
  "status": "user-calibrated",
  "provenance": "operator-labelled-set",
  "active": true,
  "calibrated": false,
  "gateOverrides": {
    "satisfied": {
      "threshold": 0.82,
      "undecided": [0.55, 0.82]
    }
  }
}
```

`active: true` is required before a profile can affect verification. Importing
or generating a profile does not activate it.

`calibrated: true` is a separate, explicit assertion. It can make the existing
`pass-candidate` path reachable, so do not set it merely because a small smoke
test looked good.

## Freshness

The plugin compares a profile with the configured provider identity:

- **matched** — preset/model/version match what the profile records;
- **stale** — a recorded provider/model/version changed;
- **unverified** — identity cannot be checked, for example because the profile
  records a runtime version but the operator did not configure one.

A stale or unverified profile stays visible but is **not applied** by
`semantic_verify_task`. Explicit operator overrides remain explicit and are
still honored.

`runtimeVersion` is optional plugin metadata used only for this freshness check.

## Provider self-test

`semantic_provider_self_test` sends only embedded synthetic examples to the
configured endpoint. It never reads repository/session content and never writes
a profile.

It reports separately:

- provider reachability and exercised protocol primitives;
- declared choice capability/deviations;
- active profile id/status/freshness;
- a three-case semantic smoke test;
- observed per-gate numeric ranges;
- warnings and categories that should remain on fallback;
- a conservative recommendation.

The smoke test is a diagnostic, not a benchmark and not a certification. A
provider/model update can change behavior even when the name stays the same.

## User-labelled calibration set

`semantic_calibration_candidate` accepts labelled cases whose gate values were
observed by the operator. It produces a JSON `CalibrationProfile` candidate with
per-gate min/max/median/count observations.

The candidate is deliberately:

- `status: "user-calibrated"`;
- `active: false`;
- `calibrated: false`;
- observation-only: no thresholds are invented automatically.

This lets an operator export/import the result, review it, and add explicit
`gateOverrides` only when their own evidence justifies doing so.

## Current Jev / Kev / Laya snapshot

The dated 2026-10-01 provider work in
`benchmark/snapshots/provider-smoke-2026-10-01.md` is a baseline observation,
not a leaderboard and not a permanent calibration table.

The current data showed materially different gate ranges between Jev, Kev and
Laya, but it does **not** justify shipping permissive numeric profiles that
silently change policy. For that reason no built-in provider profile is
auto-selected and no current provider snapshot changes the defaults.

Future model/runtime releases should be checked with the self-test or an
operator-owned labelled set rather than requiring maintainers to continuously
re-benchmark every available model.
