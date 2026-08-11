# P0 Step 12 — Historical Elite Discovery + Prospective Confirmation

## Objective

Step 12 learns which pregame signals and signal combinations have historically added out-of-sample value **without** turning research discoveries into live betting filters.

The research order is fixed:

1. historical discovery;
2. chronological out-of-sample / holdout falsification;
3. prospective confirmation through the Step 11C ledger;
4. only later, independent consideration of BET_ELITE promotion.

Historical results cannot promote BET_ELITE by themselves.

## Frozen evidence already available

The repository already contains a strong 2025 historical research spine that Step 12 should reuse rather than reacquire casually:

- 2,430 official MLB regular-season finals from 2025-03-01 through 2025-10-01;
- 184 unique official game dates;
- 2,430 observations for each of FIRST_INNING, FIRST_3, FIRST_5 and FULL_GAME;
- 1,507 held-out validation games per horizon in the B1 rolling-origin baseline;
- a stable canonical `outcomeDigest` for sporting outcomes;
- official T-5 pregame lineup evidence for 2,423 of 2,430 games (99.711934% complete coverage);
- historical branches/evidence for team-strength, starting-pitcher and lineup OOS research.

These sources are research evidence only. They are not assumed to be equivalent to the current Step 11A candidate population until an explicit compatibility audit proves that equivalence.

## Step 12A — Compatibility audit

Before mining signals, create a machine-readable compatibility matrix for each historical feature/evidence family.

Each candidate field must be classified as one of:

- `PREGAME_COMPATIBLE`: demonstrably available before the historical game at the declared as-of cutoff;
- `OUTCOME_ONLY`: allowed only for settlement/label construction;
- `MARKET_PRICE_MISSING`: sporting evidence is valid but the current price-aware Elite economics cannot be reconstructed;
- `SCHEMA_TRANSLATION_REQUIRED`: semantically usable only after a deterministic adapter is written and tested;
- `LEAKAGE_RISK`: future/postgame information could contaminate the field;
- `INCOMPATIBLE`: must not be used.

No field with `LEAKAGE_RISK` or `INCOMPATIBLE` may enter discovery or holdout scoring.

## Step 12B — Historical feature table

Build one canonical row per historical game/horizon/as-of observation. Keep raw evidence and derived features separate.

Candidate pregame feature families should be added only when already supported by historical as-of evidence, beginning with:

- league/home-away distribution baseline;
- team-strength evidence;
- starting-pitcher evidence;
- official T-5 lineup evidence;
- other context only after its historical as-of provenance is certified.

Outcome columns are labels only and must be joined after feature construction.

If historical sportsbook execution prices cannot be proven comparable to the current Step 9 contract, Step 12 must **not** manufacture EV, no-vig edge, ROI, or an Elite economic label. In that case the first research pass evaluates sporting signal quality only, while price-aware confirmation remains prospective through Step 11C.

## Step 12C — Chronological split discipline

Never randomly shuffle games.

Use chronological discovery and validation. Existing rolling-origin folds may be reused where compatible. Any new Elite signal search must preserve an untouched later holdout period or nested rolling-origin equivalent.

A signal discovered using a period cannot use that same period as its certification evidence.

## Step 12D — Signal discovery

Test simple, interpretable signal atoms first. Examples are feature-family presence, directional agreement, or predeclared bins derived from training data only.

Rules:

- no outcome-informed threshold selection on validation/holdout data;
- no unrestricted combinatorial search;
- maximum rule complexity must be declared before each experiment;
- all attempted hypotheses must be recorded, including failures;
- no automatic best-rule promotion.

The purpose is to discover hypotheses, not to optimize an in-sample leaderboard.

## Step 12E — Quality and volume together

Every candidate rule must report both predictive quality and how much opportunity it removes.

At minimum report:

- sample size and unique dates;
- WIN / LOSS / PUSH where a settlement-compatible market exists;
- proper scoring/calibration metrics appropriate to the target;
- baseline candidate count;
- rule candidate count;
- retention percentage;
- active-date coverage;
- no-pick-date percentage;
- average candidates per active date.

A rule that looks strong because it retains almost nothing is not automatically better.

The current Step 11B volume-aware calibration contract remains the reference for price-aware settled observations. Its 80 decisive observations / 30 decisive dates floor is a **research sufficiency gate**, never a live pick filter.

## Step 12F — OOS falsification

Promote a discovery only to `OOS_SUPPORTED_HYPOTHESIS` when it survives the untouched chronological validation/holdout under the metric family declared before scoring.

Failure, sign reversal, severe calibration deterioration, or unacceptable volume collapse must be reported rather than hidden.

`OOS_SUPPORTED_HYPOTHESIS` still does not mean BET_ELITE.

## Step 12G — Prospective confirmation

Step 11C continues capturing 100% of current `ELITE_EVIDENCE_CANDIDATE` observations with no additional eligibility filter.

OOS-supported historical hypotheses are evaluated prospectively against that immutable population. Historical discovery must not alter which candidates Step 11C captures.

Prospective reporting compares:

- baseline Step 11A candidate population;
- each predeclared historical hypothesis;
- quality metrics;
- retention and no-pick-date metrics.

## Promotion boundary

Step 12 cannot:

- produce BET_ELITE;
- change the live Operating Envelope;
- add a hard EV/probability threshold;
- select stake/Kelly;
- place a wager;
- silently remove candidates from Step 11C;
- use postgame information as a pregame feature.

A future promotion step may consider BET_ELITE only after historical OOS support and independent prospective confirmation are both available.

## First implementation slice

The first Step 12 PR should be deliberately narrow:

1. inventory the frozen 2025 evidence already present in repository history/research branches;
2. create the compatibility matrix;
3. build deterministic adapters for compatible pregame sporting evidence;
4. reproduce the frozen outcome identity;
5. emit a research-only feature-table manifest;
6. do **not** search thresholds or declare a winning Elite rule yet.

This keeps Step 12 falsifiable and prevents the historical dataset from becoming another source of hidden filters.
