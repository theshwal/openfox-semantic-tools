# User guide

Task-oriented documentation for people **using** this plugin. For the protocol,
the provider contract and the evaluation rules, see
[PROVIDERS.md](./PROVIDERS.md) and [EVALUATION.md](./EVALUATION.md).

Two documents, two audiences:

| You want to | Read |
| --- | --- |
| Install it, configure it, call a tool, know what it will NOT do | **this file** |
| Understand the wire protocol, the calibration maths, the evidence | [PROVIDERS.md](./PROVIDERS.md), [EVALUATION.md](./EVALUATION.md), [ARCHITECTURE.md](./ARCHITECTURE.md) |

---

## 1. Install

**Recommended: from a source checkout, by absolute local path.** This is the
only recipe the project verifies end to end.

```bash
git clone --depth 1 --branch <tag-or-branch> \
  https://github.com/theshwal/openfox-semantic-tools.git \
  "$HOME/src/semantic-tools"
cd "$HOME/src/semantic-tools"
npm ci --ignore-scripts
npm run build
```

Then in OpenFox: **Settings → Plugins → install from local path**, and give the
absolute path (it must start with `/`). Enable it.

![The plugin listed in OpenFox Settings → Plugins](./images/plugins-tab.png)

<sub>The card shows the declared capabilities, the contribution counts the host
itself computed (`10 tools · 1 skills · 14 settings · 1 transforms`), and the
author. Captured on OpenFox 2.0.161 against a throwaway instance.</sub>

Why not the packed `.tgz`? `npm pack` ships only `dist/`, `README.md` and
`docs/`, so the installer finds a `build` script with no `tsconfig.json` beside
it and the install fails. Full explanation, and the GitHub-URL caveat, in
[INSTALLATION.md](./INSTALLATION.md).

Verify your install without spending anything:

```bash
npm run verify:local
```

That runs every offline check and then prints exactly which steps remain manual.

## 2. Configure

All settings live in the plugin's own panel. Two rows matter first.

![The plugin settings form](./images/plugin-settings.png)

<sub>Rendered by the host from this plugin's schema. Every field carries its own
explanation, so nothing here has to be looked up elsewhere.</sub>

### `endpoint` — required

The **full POST URL** of a System One-compatible runtime, e.g.
`https://example.com/v1/systemone`. A preset never supplies a host: it gives
you defaults and declared capabilities, never an endpoint. Until this is set,
every tool fails with `Configure a full System One endpoint…` — that is by
design, not a bug.

### `apiKey` — only if your endpoint needs one

Stored as a secret and never returned in clear text or logged. Local runtimes
usually need none.

### `endpointClass` and `egressPolicy` — read this before pointing it at a remote host

`endpointClass` auto-detects local / private / remote. `egressPolicy` then
decides what may be sent where:

| Policy | Effect |
| --- | --- |
| `allow` (default) | Anything may be sent. |
| `block-remote-automatic` | **Explicit** tool calls allowed; automatic calls (code discovery, context reduction) blocked for remote hosts. **Recommended.** |
| `block-remote-all` | Nothing is ever sent to a remote host, even when you ask. |

The default is `allow` because that is what "I installed this plugin" implies.
If you would rather opt in, switch it now — the setting only ever *blocks*.

### `contextReduce` — off, and here is why

Off by default. It asks the provider which earlier conversation messages are no
longer needed, before each LLM call. Its recorded verdict is **DEFER**: no token,
cost, latency or task-quality benefit has been measured. Leave it off unless
you have read [EVALUATION.md](./EVALUATION.md) and accept the risk.

### `confidenceThreshold` — your dial

Defaults to **75**. It is the one number you control that decides how a
discovery result is presented.

Every discovery result carries a **relevance envelope** with four parts,
always present, never omitted:

| Part | What it tells you |
| --- | --- |
| `searched` | How many files were scanned, how many reached the semantic stage, how many directories were pruned. |
| `skippedByReason` | How many files were **not** looked at, counted per reason, each with a short sample of paths. |
| `caveats.scoreMeans` | What the returned number actually is. |
| `caveats.scoreUnverifiedMeans` | What it does **not** guarantee. |

The fixed sentences in `caveats` are emitted **once per report**, not once per
candidate. A 40-file scan would otherwise repeat ~570 characters of boilerplate
40 times in the agent's context. `caveats.version` lets a consumer cache them.

The named `skipped` sample is capped at 10 per reason, and `skippedTotal` always
carries the exact count, so a bounded list never hides a total.

Each candidate then carries `thresholdStatus`: `above`, `below`, or `unknown`.
Three behaviours are enforced by tests rather than by convention:

- **It only labels.** A `below` candidate stays in the list, marked. No
  candidate is ever filtered away from you.
- **It cannot promote.** `unknown` stays `unknown` whatever you set, so a
  missing, unusable, timed-out or failed answer can never become a pass. Set
  the dial to `0` and a broken answer is still not a pass.
- **It is read per call.** Change it and the next tool call uses the new value;
  there is nothing to reload or restart.

At 75 you will see more `below` than you might expect, and that is the point:
it pushes the agent to confirm a candidate rather than trust it. Lower it for a
shorter list. Both `75` and `0.75` are accepted.

Every candidate also carries `thresholdReason`, the same verdict in words:

- `above` → *"confidence 0.80 is at or above the threshold 0.75"*
- `below` → *"confidence 0.50 is below the threshold 0.75; still worth
  confirming by reading it"*
- `unknown` → *"no usable provider confidence was returned, so this is not
  classified against the threshold"*

`unknown` deliberately does not read like a rejection. It means nothing was
judged, which is a different conclusion from "judged and found weak".

Two rules worth keeping in your head while reading any result:

- The number is a **provider confidence** — how concentrated the model
  distribution was over its own answer. It is **not** a measured probability
  that the file is correct, and nothing here has been calibrated against ground
  truth.
- An **empty result does not prove absence**. Files that were skipped, filtered,
  oversized or unreadable were never judged. Read `skipped` before concluding
  the code does not exist.

When the candidate list comes back **completely empty**, there is no envelope to
carry those reasons, so they survive into the refusal itself:

```
No readable file content was assembled. Narrow or correct the candidate paths
before scanning. Not read: src/logo.png (binary), src/vide.ts (empty).
```

So the skip reasons reach you on a miss too. The list is capped at ten names
plus a count, so a refusal never turns into a directory listing.

### `cacheEnabled` — off by default

Reuses an identical previous answer instead of asking again. Only successful
answers are ever reused, never an error. Leave it off unless you have measured
a benefit.

### `activityPanel` — on by default, and harmless to turn off

Adds a **Semantic activity** panel, opened from the Plugins menu (puzzle icon,
top right) and scoped to the session on screen. It shows how many semantic calls
that session made, how long the provider took, how many answers came back
unusable, and how many times the same question was asked twice.

Each line tells you how much it is worth: `[proven]` means the plugin established
it, `[reported status]` means the number was copied from a report, and one
bucket is explicitly marked `heuristic, unproven`. Questions are never kept —
only a digest of each, so a repeat is visible without the wording being stored.

Two things worth knowing before you read anything into it:

- **It reports observed usage, not quality.** It cannot tell you the semantic
  path beat the deterministic one, because nothing in it compares the two. A
  call with no evidence either way is shown as **indeterminate**, never as
  useless. Deciding whether these tools earn their cost is a separate piece of
  work, described in [EVALUATION.md](./EVALUATION.md).
- **Nothing is kept.** Everything is in memory, bounded, and gone with the
  session. Nothing is written to disk and nothing is sent anywhere. Turn the
  setting off and nothing is recorded at all.

A session with no semantic call says so, rather than showing an empty panel.

## 3. Allow the tools you want

Registering a tool does **not** grant access. Add the tools to the agent's
`allowedTools` in Settings → Agents. Without that, the agent cannot call them
and you will see a refusal, not a silent failure.

## 4. Use the tools

### Which tool do I want?

Work down this list and stop at the first line that fits. The same order is in
the README; this is the version with the reasoning.

| If you want to… | Use | Instead of |
| --- | --- | --- |
| find where a **behaviour** lives | `semantic_search` | nothing — this is the entry point |
| judge a **list of files** you already have | `semantic_scan` | `semantic_search`, which would have to find the list first |
| check **one** acceptance criterion | `semantic_verify_task` | `semantic_issue_coverage`, which is broader than you need |
| check **several** criteria over the same change | `semantic_issue_coverage` | calling `verify_task` in a loop |
| explain what the **context transform** did | `semantic_transform_status` | `semantic_hook_status`, which reports the host, not us |
| see what the **host** was observed doing | `semantic_hook_status` | — |

**Worked examples.**

*"Where is token expiry handled?"* — you have no file names, so
`semantic_search`. If it returns a shortlist and you want to narrow it further
against a second behaviour, feed that list to `semantic_scan`.

*"Which of these nine files decide the answer?"* — you already have the list.
`semantic_search` would spend a recall pass rediscovering what you just told
it. **`semantic_scan` beats `semantic_search` whenever you have a list.**

*"Did this PR meet its three acceptance criteria?"* — three criteria over one
diff is exactly `semantic_issue_coverage`. `verify_task` is the narrower call
for a single criterion; using it three times means three reports to reconcile
instead of one.

*"Context was compacted and the answer looks wrong."* — `semantic_hook_status`
tells you the host compacted and when; `semantic_transform_status` tells you
what *our* transform removed. They are separate measurements and the report
never merges them.

**When not to reach for a semantic tool at all.** The first move is usually
free and exact: `rg`, the symbol index, the failing test. Those answer "where
is this named thing" perfectly. A semantic tool earns its cost on questions
about *meaning* — which file actually decides this, where this behaviour lives
across module boundaries — not on questions about text you could have matched.

**The operator instruments** — `semantic_decide`, `semantic_provider_self_test`,
`semantic_calibration_candidate`, `semantic_question_calibration`,
`semantic_reference_agreement`, `semantic_usage_report` — exist to produce the
evidence behind a decision. They are yours to run, not an agent's to reach for
on its own.

### `semantic_decide` — the primitive

One state, several batched questions. Returns typed probabilities.

```json
{
  "state": {"evidence": "public synthetic excerpt"},
  "questions": {
    "satisfied": {"type": "noul", "instructions": "Does the evidence satisfy the criterion?"},
    "region": {"type": "choice", "instructions": "Choose the relevant region", "criteria": ["handler", "database"]},
    "coverage": {"type": "score", "instructions": "Rate evidence completeness", "criteria": ["absent", "complete"]}
  }
}
```

- `noul` → yes/no with a probability.
- `choice` → pick one of your labels.
- `score` → place the state on your ordered rubric. **Criteria must be an
  ordered array**; object maps are rejected for `score`.

Batch every question about the same state into one call: it is a single
round-trip.

### `semantic_verify_task` — one acceptance criterion

Advisory. It returns `unknown` or a follow-up status until a calibration
profile is measured and installed, so **it cannot currently mark anything
satisfied**. That is intentional: an uncalibrated checker must never produce a
positive verdict.

### `semantic_issue_coverage` — several criteria at once

Same contract, wider scope. Reports coverage and follow-ups; never merge-safe.

### `semantic_search` / `semantic_scan` — find candidates

- `semantic_search`: from a natural-language query. With no `candidates`, it
  does a bounded local recall first and then reranks; with explicit
  `candidates`, it skips recall.
- `semantic_scan`: scores an explicit file list you supply. It never guesses
  which files to read.

Both return **ranked candidates**, never verdicts, and both carry the
relevance envelope described under `confidenceThreshold` above. Read the
`relevance.skipped` list before treating an empty result as an answer: a file
that was too large, binary, or inside an unreadable directory was never judged.
Confirm candidates with `read_file` as you normally would.

### `semantic_provider_self_test` — check the wiring

Synthetic, embedded, free. Run it after configuring an endpoint: `reachable:
true` and `deviations: []` means the transport is fine. It says nothing about
decision quality.

A `smoke_mismatch` on `insufficient-evidence` is a known and documented
behaviour on some runtimes: the plugin rejects an internally inconsistent answer
rather than trusting it. That is the safe outcome, not a defect.

### `semantic_transform_status` — see what the transform did

Pure reader. Reports applied turns, segments dropped and, when a turn was left
alone, **why** (`no_candidates`, `low_confidence`, `egress_blocked`,
`provider_unavailable`, `invalid_response`, `total_wipe_refused`, …). Counts and
reasons only: no message content is retained.

If you enable `contextReduce` and nothing seems to happen, this is where you
look. A no-op is always explained.

The same report keeps two reduction sources **apart**: `transform` is what this
plugin removed, and `hostCompactions` is what OpenFox itself removed. The two
are never summed. OpenFox measures its own compaction, and this plugin does not
claim a share of it.

### `semantic_hook_status` — what the host was observed doing

Pure reader. For each host event the plugin subscribes to, it reports how many
times it fired, how many sessions were seen, and **which `data` keys arrived
with which types**.

That census is deliberate. A key's *type* is enough to tell which fields could
carry free text, and a type name cannot carry that text — so the report can be
produced from a real session without writing repository or conversation
content anywhere.

Two fields matter most:

- `measured` — false until that event has fired at all. "Never observed" is not
  "did not occur".
- `complete` — false while any subscribed event is still unmeasured.

The hooks are **read-only**. A `PluginHookHandler` returns void, so there is no
channel through which this plugin could accept, refuse or alter a turn.

Only events the host actually emits are subscribed. On OpenFox 2.0.161, five of
the fifteen declared events never fire; `docs/HOOK-PAYLOADS.md` records the
measurement.

### `semantic_usage_report` — did anything get used?

Answers one question nothing else could: how often each skill was **offered** to
the agent, versus how often each capability was **actually invoked**.

**The two counts do not come from the same place, and the report says so.** A
skill load is something this plugin observes, so skills carry a real
`offered`/`used` pair. A tool becomes reachable through the agent's
`allowedTools`, which the plugin never sees — so a tool row shows
`used` only, and reads *"available, never used"* until it is actually called.
No figure is inferred, and nothing is counted per turn because nothing observes
turns.

That asymmetry is the point. A skill loaded every session and read never is
prompt overhead you are paying for. A tool nobody ever called is a capability
you may not need. Both are visible; neither is guessed.

It writes a file under your OpenFox config directory and returns the report
inline. It contacts no provider, changes no setting, and judges no code. The
ledger holds **names and counts only** — no endpoint, no credential, no file
content, no repository path. Counters are bucketed by day and older buckets are
purged, so it cannot grow without limit.

Counters are held in memory and written when you ask for the report or when the
host exits, rather than on every tool call: writing synchronously per call would
block the agent's event loop on disk for optional bookkeeping.

### Calibration tools — for operators, not for everyday use

You do not need these to use the plugin. They exist so the *evidence* behind a
threshold can be produced by hand, and every one of them is inactive by
construction.

| Tool | What it does | What it will never do |
| --- | --- | --- |
| `semantic_calibration_candidate` | Turns a case set you labelled by hand into an **inactive** candidate profile. | Never activates anything, never loosens a policy. |
| `semantic_question_calibration` | Scores one question of your choice against your labelled cases and reports agreement and error. | Never sets a threshold. |
| `semantic_reference_agreement` | Compares the provider against your reference judgments on a frozen case set. | Never ranks providers, never activates anything. |

The shipped policy is `calibrated: false`, so `semantic_verify_task` cannot emit
a positive verdict until you deliberately install a measured profile. See
[CALIBRATION.md](./CALIBRATION.md).

## 5. What this plugin will never do

These are guarantees, not limitations:

- It never replaces tests, typechecks or linters.
- It never marks a task complete or merge-safe.
- It never branches a workflow on a semantic result: no transition handler is
  registered.
- The hooks it does subscribe to are **read-only**. A `PluginHookHandler`
  returns void, so a plugin has no channel through which it could accept,
  refuse or alter a turn — observing is all they can do.
- It never blocks a turn — a transform cannot veto one.
- It never deletes the current request or anything after the last tool result.
- A provider error, timeout or malformed answer never becomes a positive
  result. It becomes a structured failure.
- API keys are never logged or echoed in errors.
- Redirects are refused; error bodies are never reflected back.

## 6. Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `Configure a full System One endpoint…` | `endpoint` is empty. Nothing else is wrong. |
| `Unsupported backend "…"` | The saved preset id is unknown. Pick one from the selector. |
| The agent refuses to call a tool | It is not in that agent's `allowedTools`. |
| `no provider call was made` (harness) | Correct: the harness never contacts a provider. |
| A `score` question is rejected | `score` criteria must be an ordered **array**; object maps are only valid for `choice`. The message says so. |
| Enabling `contextReduce` changes nothing | Expected. Check `semantic_transform_status` for the reason; `no_candidates` and `low_confidence` are normal. |
| `egress_blocked` | `egressPolicy` forbids sending that content. Your policy, not a failure. |
| A remote endpoint rejects array `choice` criteria | The selected preset declares that deviation; the request is rewritten to the object form automatically. |

## 7. Honest limits

- No provider is endorsed, and no runtime is claimed compatible. `custom` is
  the default preset and stays that way.
- No decision-quality certification exists. Dated observations live in
  [#9](https://github.com/theshwal/openfox-semantic-tools/issues/9).
- No token, cost or latency saving is claimed for any feature here, because none
  has been measured. The context-reduction transform is **DEFER**.
- Provider presets record *declared* capabilities from real conformance runs.
  `unverified` means nobody asked — never "works".

## 8. Keeping this file useful

This guide is about tasks, not architecture. When you add a tool, add a row to
§4 and, if it can fail in a confusing way, a row to §6. When you change what
the plugin refuses to do, update §5 — those are promises, and the tests assert
them.
