# The `score` contract, verified against official Jev / System One docs

Read-only investigation. No live call was made for this document, and no
threshold was changed. Sources are the official TypeSafe documentation, checked
against the responses already recorded by the live campaign.

## Sources

| Source | Used for |
| --- | --- |
| [docs.typesafe.ai/primitives/score](https://docs.typesafe.ai/primitives/score) | Request/response shape, score semantics, legend, ranges |
| [docs.typesafe.ai/model-jaggedness/jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13) | Vendor warning on score numeric calibration |
| [docs.typesafe.ai/confidence](https://docs.typesafe.ai/confidence) | Meaning of `confidence` |
| [SDK `ScoreOf`](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreOf.md) | Level keys are rubric indices |
| Campaign reports (already recorded) | One real response shape, per-case conformance outcomes |

## 1. What `score` actually is

**It is the expected value of the level number under the returned
distribution — not an index, and not an argmax.**

> `score`: The position on the level number line, from 0 to the top level
> number... It's each level number multiplied by its probability, added up.

    score = Σ (level_i × P_i)

### The formula, proven on the official examples

Every worked example in the official documentation satisfies the identity
exactly, at five decimals:

| Documented `score` | Distribution | E[level] | Match |
| ---: | --- | ---: | --- |
| 1.43 | 0×0.0, 1×0.57, 2×0.43 | 1.4300 | yes |
| 1.86 | 0×0.0, 1×0.14, 2×0.86, 3×0.0, 4×0.0 | 1.8600 | yes |
| 2.52 | 0×0.0, 1×0.0, 2×0.48, 3×0.52 | 2.5200 | yes |
| 1.26 | 0×0.0, 1×0.74, 2×0.26 | 1.2600 | yes |
| 1.11 | 0×0.0, 1×0.89, 2×0.11 | 1.1100 | yes |

### The campaign response, recomputed

The live campaign returned `score: 0.15` with
`probabilities {0: 0.90, 1: 0.06, 2: 0.04}`:

    E[level] = 0×0.90 + 1×0.06 + 2×0.04 = 0.14
    |0.15 − 0.14| = 0.01

The identity holds to the response's own 2-decimal precision. This is why the
current policy rejects it: it demands `score` equal a rubric index, and 0.15 is
not an index. **The policy is not wrong to be strict — it is wrong about what a
score is.**

## 2. Real range — not 0..1

The range is **[0, len(criteria) − 1] in level units**:

- 3 levels → score runs 0 to 2 (documented values 0.0, 1.11, 1.43, 2.0)
- 4 levels → score runs 0 to 3 (documented value 3.0)
- 5 levels → score runs 0 to 4 (documented value 1.86)

The official docs show a score of **3.0** for a 4-level rubric and **1.86** for a
5-level rubric. Any code assuming a raw score is bounded by 1 is wrong. The docs
themselves normalise by dividing by `len(criteria) − 1`, which is only correct
once you know the top level.

**Assumption forbidden:** that a score is already normalised to 0..1. It is not.

## 3. Two distinct quantities, not interchangeable

| Quantity | Definition | Answers |
| --- | --- | --- |
| `score` (E[level]) | expected position, a real number in [0, top] | "where on the spectrum, on average" |
| `argmax(P)` | the single level with the most mass | "which level, if forced to pick one" |

The docs state explicitly: *"Different distributions can produce the same score.
A score of 1.0 can mean all probability is on level 1, or half is on each of
levels 0 and 2."* So the two are genuinely different information, and one must
never silently substitute for the other. In the campaign response,
`E[level] = 0.14` points near level 0 while `argmax = 0` confirms it — but
`{0: 0.34, 1: 0.33, 2: 0.33}` would give the same E[level] ≈ 0.99 with an
argmax that means much less.

## 4. Vendor warning, which constrains any fix

> Please do not use score outputs (e.g., expectations and probability) to
> compute the exact magnitude of a number between two levels of a criterion. You
> can use the expectation to check if it passes a particular threshold, but
> `jev-1.13`'s score levels are weak in numerical calibration. It will not be
> able to help you reconstruct the exact number by interpolating between the
> nearest two levels.

Consequence: a score may be used to **cross a threshold**. It may not be used
to **measure a distance**, to interpolate, or to compute a graded penalty. Any
option below that tries to reconstruct a magnitude from the score is excluded by
the vendor's own documentation.

## 5. Why the offline suite missed this

The smoke stub emitted `score` as an integer rubric index. That shape is
**legacy/idealised** and does not match the documented System One response, so
the whole offline suite validated a shape no real runtime produces. This is the
concrete evidence gap: the offline conformance run proves the transport, not the
contract.

## 6. Normalisation options (none implemented here)

All options live in a versioned policy module. The adapter stays numeric and
provider-neutral; it carries no threshold and no rubric knowledge.

### Option A — Threshold on E[level] in level units (recommended)

Keep E[level] in level units and express gates as level positions.

- Coherence test: `|score − E[level]| ≤ tol`, with `tol` documented for the
  response's rounding (2-decimal responses justify ~0.01).
- Gate `evidenceSufficiency` becomes "E[level] ≥ top − 0.1" instead of
  "score = top".
- **Strength:** matches the documented semantics exactly; no invented
  normalisation; a threshold is precisely the use the vendor sanctions.
- **Cost:** the policy must know the rubric length, which it already does.
- **Does not weaken confidence:** the confidence floor stays independent.

**Implemented (`verify-0.2.1`).** The policy reads the score as E[level] and
gates it exactly as written above: `DIRECT_EVIDENCE_THRESHOLD = top − 0.1`, so
`evidenceSufficiency` is met only when the expectation reached the top level
(0.1 of slack for the two-decimal rounding a real runtime reports). The previous
`top − 0.5` — the midpoint of the top interval — was a **distance**, which this
document forbids: it accepted `0.7` of the mass on the middle rung as "direct
evidence", in the gate that guards the pass. Option B is still rejected for the
same reason.

**Amendment (`verify-0.2.2`) — coherence and commitment are separate.** The
`0.2.1` policy used one `unusable` verdict for two different situations: an
answer that **contradicts itself** (`score ≠ E[level]`, malformed distribution,
out-of-range value) and an answer that is **coherent but uncommitted** (a
`confidence` below the floor, or a distribution with no level above the
decisive-mass floor). Because `unusable` short-circuits the whole decision, a
merely hesitant answer discarded every other gate's reading too. Both live
campaigns recorded 7/7 `unknown` for that reason, and the artifact could not
tell the two situations apart.

`verify-0.2.2` adds the `low-confidence` gate verdict for the second case only.
Its value is still read and still reported; it is simply never decisive. The
coherence checks are untouched and no threshold moved. `low-confidence` routes
as an additional undecided state: a **decisive** unmet gate beside it still
routes to its risk status, and when nothing is decisively unmet the status is
`unknown` with the reason `answer_low_confidence`. It can never reach
`pass-candidate`, under a calibrated policy as much as under the shipped one.

The asymmetry this leaves open — the transport normalizes a `noul` answer
without its `confidence`, so a live `noul` hesitation is invisible to the policy
— is deliberately **not** fixed here. It is a transport-shape change in
`src/providers/system-one.ts` and belongs to a separate batch; see
`docs/LIVE-JEV-FINDINGS.md`.

Everything the vendor warning covers is left in force, and the policy is still
`calibrated: false`: the coherence check (`|score − E[level]| ≤ 0.01` plus a
float slack) and the single-level mass floor (`> 0.5`, so a tie is not decisive)
both stand, the confidence floor is unchanged and independent, and an
expectation that has not committed to the top rung is `undecided` — `unknown`,
never a pass. No value is ever rounded to a level, and no magnitude is ever
reconstructed from a score.

### Option B — Normalise to 0..1 then threshold

`normalized = E[level] / (len(criteria) − 1)`.

- **Strength:** a 0..1 gate reads like the probability gates, so one threshold
  vocabulary across noul and score.
- **Cost:** the top level becomes the only thing that saturates the gate, and a
  rubric of 3 vs 10 levels compresses differently. It also risks implying a
  magnitude the vendor warns against, because a normalised score invites
  interpolation. Only safe if the policy uses it strictly as a threshold and
  never as a distance.

### Option C — Argmax with a mass floor

Decide on `argmax(P)` only when its mass ≥ a floor, else undecided.

- **Strength:** robust to E[level] rounding; a natural fit for "which level"
  routing.
- **Cost:** throws away the spread information; two very different distributions
  collapse to the same verdict. Must keep the mass floor high enough that a tie
  or a near-tie becomes undecided rather than a coin flip.

### Rejected — Rounding E[level] to the nearest level

Rounding to the nearest level is the most tempting fix because the official
entity-alignment cookbook uses it. It is rejected **here** for two reasons: a
rounded level is a fabricated discrete outcome the model did not assert, and
`0.15 → 0` would convert the campaign's "mostly level 0, slightly level 1"
answer into a confident "level 0" with no stated uncertainty. If rounding is
ever adopted, it must be a separate, explicitly measured decision, not a silent
side effect of parsing.

### Not decided here

`tol`, the mass floor, and option A vs B are **policy constants that require
measurement**. This document defines the contract and the safe options; it does
not set them, does not calibrate anything, and does not enable a positive
verdict. `calibrated` stays `false` and the production pass stays disabled.

## 7. Test plan for the change

Stub coverage (all offline, no credential):

| # | Case | Expected |
| --- | --- | --- |
| 1 | `score = E[level]`, 3 levels, continuous (campaign shape) | accepted, position read |
| 2 | `score = E[level]`, 4 levels, value 3.0 at full mass on top | accepted; catches a 0..1 assumption |
| 3 | `score = E[level]` on a 5-level rubric, value 1.86 | accepted; catches a 0..2 assumption |
| 4 | Integer index score (legacy stub shape) | accepted as a special case of E[level] with a degenerate distribution |
| 5 | `score ≠ E[level]` beyond tolerance (contradiction) | unusable, never a pass |
| 6 | Two levels tied at the top mass | `low-confidence`, never an arbitrary pick |
| 7 | Near-tie within the mass floor | `low-confidence` |
| 8 | Fully flat distribution | `low-confidence` |
| 9 | Rounded probabilities whose sum ≠ 1 within tolerance | accepted if within the documented sum tolerance, else unusable |
| 10 | `confidence` below the floor | `low-confidence`, regardless of `score` |
| 11 | `score` outside `[0, len(criteria) − 1]` | unusable |
| 12 | Official examples 1.43 / 1.86 / 2.52 / 1.26 / 1.11 | identity holds at 5 decimals |
| 13 | A hesitant gate beside a decisive unmet gate | the decisive risk status, not a bare `unknown` |

Each case asserts a verdict, never only a number. The provider-neutral
requirement holds: no vendor, model or endpoint appears in the policy module or
its tests, and the adapter keeps no threshold.
