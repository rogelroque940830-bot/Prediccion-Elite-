# P1 MLB PREMIUM without ULTRA — prospective economic confirmation

## Purpose

This stage is a prospective falsification test of a **new** economic hypothesis discovered in the 2026-08-08 PREMIUM/ULTRA forensic audit.

The historical audit found that:

- old `ULTRA` was not economically validated once repeated captures were reduced to independent games;
- terminal F5 `PREMIUM` was promising but not statistically/economically certified;
- a post-hoc descriptive subgroup `PREMIUM && !ULTRA` produced 13-4 and +28.05% ROI on 17 settled games, with positive point ROI in both July and August.

Because `PREMIUM && !ULTRA` was identified **after looking at those outcomes**, none of those historical games may be used as confirmation evidence. This file freezes the next hypothesis before any new qualifying outcome enters the test.

## Immutable prospective cutoff

- Cutoff timestamp: `2026-08-08T04:32:33Z`.
- Cutoff evidence commit: `a2bc70badc97251f2f0333beb1b2b954f841fad0`.
- The timestamp is the merge time of permanent forensic evidence PR #372.
- Any prediction recorded at or before the cutoff is excluded from confirmation.

The previous 13-4 / +28.05% result is development/post-hoc evidence only and is never included in the new confirmation sample.

## Candidate definition

A future game belongs to the candidate cohort only when all conditions are true **before the outcome**:

1. market is `F5_ML`;
2. source is the interactive app capture path;
3. analysis stage is `FINAL`;
4. capture is pregame (`recordedAt < commenceTime`);
5. the selected recommendation surface contains `PREMIUM`;
6. the selected recommendation surface does **not** contain `ULTRA`;
7. the decision was recorded strictly after the frozen cutoff.

Only the selected recommendation surface is inspected:

- selected decision label/rationale;
- `selectedLane`;
- selected `finalRecommendation`.

`alternativePicks`, alternate lines and other non-selected text are forbidden from candidate membership.

## Independence unit

The statistical unit is **one game**, not one refresh, capture or revision.

After the existing P1-M3D lifecycle-terminal review, this contract applies a second game-level deduplication. If more than one eligible FINAL F5 record exists for one game, only the latest pregame record is retained. This explicitly prevents the pseudo-replication that made 99 historical ULTRA captures appear to be 99 observations when they were only 12 games.

## Control

The control cohort is every other future eligible independent FINAL F5 ML game-level decision in the same prospective period that does not satisfy `PREMIUM && !ULTRA`.

No price band, team, pitcher, model-probability threshold or edge threshold is selected from the historical subgroup. Those would be new hypotheses and require separate preregistration.

## Minimum evidence

Before an economic support decision is evaluated:

- candidate: at least **50 settled WIN/LOSS games**;
- candidate: at least **20 distinct game dates**;
- control: at least **50 settled WIN/LOSS games**;
- control: at least **20 distinct game dates**.

Until all four conditions are met, state remains `COLLECTING_PROSPECTIVE_EVIDENCE`.

## Economic confirmation criteria

Once minimum sample requirements are met, all criteria below must pass simultaneously:

1. deterministic 5,000-replicate game-date cluster bootstrap candidate ROI 95% lower bound > 0%;
2. candidate-minus-control ROI difference 95% lower bound > 0 percentage points;
3. candidate mean CLV > 0;
4. candidate Brier score <= control Brier score;
5. candidate log loss <= control log loss;
6. absolute candidate calibration gap <= 5 percentage points;
7. candidate calibration gap <= control calibration gap + 1 percentage point.

The 5-point / 1-point calibration discipline mirrors the already-registered P1-M3E operating-envelope confirmation standard.

No single hit-rate threshold can certify the hypothesis.

## States

- `COLLECTING_PROSPECTIVE_EVIDENCE`: sample minimums are not yet met.
- `CANDIDATE_NOT_CONFIRMED`: sample minimums are met but at least one economic/proper-scoring/calibration criterion fails.
- `ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY`: every preregistered criterion passes.

Even the final state is **research support only**. It does not automatically:

- create a bet;
- change a stake;
- restore the old ULTRA gate;
- change model probabilities;
- change price/edge thresholds;
- promote a model;
- authorize sportsbook integration.

Any future real-money activation must be a separate, explicit, auditable decision after this prospective test succeeds.

## Safety / anti-overfitting rules

- outcomes, ROI, CLV, closing price, Brier and log loss cannot affect candidate membership;
- historical 13-4 observations are excluded by timestamp;
- multiple captures of one game cannot increase sample size;
- no price-band optimization is allowed inside this hypothesis;
- no threshold tuning is allowed after the cutoff;
- no automatic model or stake changes are permitted;
- the current Predictor continues operating in its existing SHADOW/economic-review safety envelope while evidence accumulates.
