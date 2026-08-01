# S6O / Phase 5C-4 — First five real MLB settlements

## Objective

Prove that the clean post-fix MLB lifecycle can settle and certify five distinct binary decisions repeatedly, not merely one isolated decision.

S6O is a read-only certification layer. It does not change the predictor, probabilities, markets, signals, thresholds, settlement rules, or stake policy.

## Prerequisites

S6O depends on:

- S6M milestone 5 being certified with an immutable five-decision manifest;
- S6N having certified the first real settlement end to end;
- S6M/S6L metric parity passing with no critical issue;
- the owned ledger remaining monotonic and immutable.

## State machine

```text
ARMED_AND_WAITING_FOR_5
  -> OBSERVING_FIVE_RESULT_STABILITY
  -> FIRST_FIVE_SETTLEMENTS_CERTIFIED

Any integrity failure -> ACTION_REQUIRED
```

## Certification checks

For the immutable first-five sample, S6O verifies:

- exactly five unique analytical cycles and terminal predictions;
- five FINAL terminal records after the clean-cohort cutoff;
- valid standard American prices and complete S6M certificate assertions;
- five WIN/LOSS settlements with stable event, source, time, and result identity;
- current ledger reconstruction matching the immutable milestone 5 manifest;
- independent recomputation of Brier Score, Log Loss, win rate, Wilson interval, flat-stake ROI, and CLV summary;
- S6M/S6L metric parity and zero critical S6M issues;
- append-only baseline and evidence files with valid SHA-256 digests;
- certificate stability across separate worker executions.

A later independent-certification annotation may mature without invalidating an otherwise identical immutable pick and settlement identity.

## Evidence

The service persists under:

```text
/app/data/mlb-s6o-first-five-settlements-certification/
```

Artifacts:

- `latest.json` — current aggregate state;
- `baseline.json` — append-only first observation of a valid milestone 5 certificate;
- `evidence.json` — append-only certification after the stability window;
- `snapshots/*.json` — bounded state-change snapshots.

The evidence contains overall five-decision metrics plus market and signal breakdowns. Every breakdown is explicitly marked as a technical repetition check only; five results are too small for model conclusions.

## Runtime

The worker is enabled by default only in `p0-integration`, runs every five minutes, and waits five minutes between baseline creation and final certification.

Public health:

```text
GET /health/s6o-first-five-settlements
```

Protected evidence routes:

```text
GET /api/mlb/ledger/v1/s6o-first-five-settlements/status
GET /api/mlb/ledger/v1/s6o-first-five-settlements/evidence
```

## Safety boundary

S6O remains:

- SHADOW only;
- zero real financial exposure;
- no sportsbook integration or automatic betting;
- no production or historical ledger mutation;
- no automatic promotion or model change;
- `conclusionsAllowed=false`;
- `automaticModelChangesAllowed=false`;
- recommendation `NO_AUTOMATIC_MODEL_CHANGE`.

The 20- and 50-decision milestones continue to govern later scientific review.
