# Provider smoke snapshot — 2026-10-01

Human-readable companion to the machine-readable campaign reports committed in
`benchmark/snapshots/verify-0.2.1/`. This file adds nothing to the data: every
number below is copied from those two reports, and every conclusion is
re-derived from them offline by `npm run verify:replay`.

## What these runs are

Two live `verify-0.2.1` campaigns over the same seven-case smoke fixture set,
run against two different System One-compatible models through the same plugin
transport and the same policy version.

- `laya-report.json` — model `laya-rl-agent`, 7 cases, 0 transport failures.
- `kev-report.json` — model `kev-latest`, 7 cases, 0 transport failures.

They are **sanitized, number-only snapshots**. Each committed report carries the
observed status, the reasons, and the per-gate numbers (`gateValues`,
`probabilities`, `confidence`, `scores`), plus an explicit `observedFields`
block listing what was dropped: `state`, `evidence`, `criterion`, `endpoint`,
`apiKey`, `headers`. No state, no evidence, no criterion text, no endpoint and
no credential is present in these files. The raw live reports stay local under
`benchmark/results/`, which is git-ignored.

## What they are not

Both reports record `measured: false`. They are **not** a provider quality
measurement and **not** a false-pass rate. `falsePassRate` is not computed here
and is never reported as zero: a rate that was not measured is unknown, and
unknown is what these runs leave it. They prove transport wiring, report shape
and label agreement — nothing more.

## What the campaigns recorded

Every one of the fourteen cases — seven per model — recorded `observed:
"unknown"`.

The reasons differ, and the difference is the whole point of the replay:

- Under `verify-0.2.1` a `confidence` floor produced an `unusable` verdict. A
  single `unusable` verdict short-circuited the decision, so every gate reading
  in the same call was discarded with it. Twelve of the fourteen cases carry
  `answer_unusable` as their first reason.
- The two cases that do not (`laya/positive-under-calibrated-policy`,
  `kev/…` aside) were decided on `answer_undecided` or `off_scope_detected`
  instead, and still landed on `unknown`.

So the recorded outcome is uniformly `unknown` **for two different reasons**,
and the recorded data alone cannot tell a verdict-vocabulary change apart from a
change in provider behaviour.

## How the numbers were read

The snapshot numbers are the numbers the provider actually returned:

- `evidenceSufficiency` came back as a `score` answer, with its full
  distribution over the three rubric levels (`0`, `1`, `2`) and its declared
  `confidence`.
- The three remaining gates came back as `noul` answers, read as a single
  probability.
- `criterionTestable` did not exist yet, so those runs never asked it. No
  value was recorded and none was invented.

## Replay result

`npm run verify:replay` rebuilds the exact answer set the transport would have
normalized from those recorded numbers and evaluates it under two policies:

| Column | Policy | Purpose |
| --- | --- | --- |
| `recorded` | `verify-0.2.1`, live | what the run actually reported |
| `baseline` | frozen `verify-0.2.1` rules | validity check: must reproduce `recorded` exactly |
| `current` | shipped policy, all gates | what the shipped policy decides now |
| `currentOnRecordedGatesOnly` | shipped policy, four recorded gates | isolates the routing change from a gate those runs never asked |

Both campaigns reproduce their recorded statuses under the frozen baseline,
14/14. That is the validity condition: without it the comparison column would
prove nothing.

On the gates the runtime actually answered, the shipped policy routes the cases
that were previously erased:

| Model | `currentOnRecordedGatesOnly`, in case order |
| --- | --- |
| `laya-rl-agent` | `needs-verification`, `off-scope`, `needs-verification`, `off-scope`, `needs-verification`, `unknown`, `needs-verification` |
| `kev-latest` | `insufficient-evidence`, `insufficient-evidence`, `needs-verification`, `insufficient-evidence`, `off-scope`, `off-scope`, `needs-verification` |

Two properties make this a usable result rather than a favourable one:

- **No case reaches `pass-candidate`.** Not under the shipped policy, and not
  under a calibrated variant of it either, which is asserted by
  `test/verify-policy-replay.test.ts`. A replay cannot manufacture a pass.
- **The hesitance disappears from the verdict.** The recorded runs declared
  `evidenceSufficiency` confidence well under the old floor — the hesitant
  answers are read for their value now, classified by that gate's own
  threshold and band, and the value is reported either way.

The `current` column is deliberately kept at `unknown`: it still declares
`criterionTestable`, which these runs never asked, so it reads that gate as
absent instead of substituting an answer. That is why `current` and
`currentOnRecordedGatesOnly` differ, and why the second is the honest one to
compare against.

## Reproducing

```bash
npm run verify:replay
```

No network call, no credential. Output lands in `benchmark/results/verify/replay.json`,
which is git-ignored.
