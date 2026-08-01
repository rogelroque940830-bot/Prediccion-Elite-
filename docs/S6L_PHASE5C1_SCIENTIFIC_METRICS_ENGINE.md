# S6L Phase 5C-1 — Scientific Metrics Engine

## Objective

Build the read-only statistical infrastructure required to evaluate clean post-fix MLB decisions without changing the predictor.

This phase computes descriptive and calibration metrics only. It does not decide that the model is good or bad, does not recommend a formula change, and cannot promote a candidate model.

## Eligible cohort

A decision enters the core statistical sample only when its terminal lifecycle record:

1. belongs to an S5C lifecycle created entirely after `2026-08-01T00:00:50.911Z`;
2. is the unique analytical representative for its game, market, selection and line;
3. is `FINAL`;
4. has standard American odds (`<= -100` or `>= +100`);
5. has a model probability strictly between 0 and 1;
6. has complete price provenance, capture time and `median_implied_probability` consensus;
7. has an official settlement or an append-only correction linked to an official event;
8. has a supported result: `WIN`, `LOSS`, `PUSH` or `VOID`.

`WIN` and `LOSS` enter binary probability scoring. `PUSH` and `VOID` remain visible in sample accounting but are excluded from Brier Score, log loss and observed win rate.

The first-ten S6K certificates provide the independently certified subset. The engine reports that coverage separately rather than silently treating every settlement as independently re-graded.

## Metrics

The engine calculates:

- Brier Score;
- natural-log loss;
- observed win rate and Wilson 95% interval;
- fixed-decile calibration bins;
- expected calibration error (ECE);
- maximum calibration error (MCE);
- informational flat-one-unit profit and ROI using opening American odds;
- mean and median CLV plus CLV coverage;
- breakdowns by market and signal;
- PROVISIONAL-to-FINAL model-probability and market-implied-probability drift;
- duplicate and exclusion counts;
- immutable-ledger count monotonicity.

The flat-stake ROI is descriptive shadow evidence. It is not actual account profit and does not enable financial exposure.

## Readiness states

- `INSUFFICIENT_SAMPLE`: fewer than 20 binary decisions.
- `COLLECTING`: at least 20 but fewer than 50 binary decisions, or fewer than ten independently certified decisions.
- `READY_FOR_REVIEW`: at least 50 binary decisions and ten independently certified decisions.
- `ACTION_REQUIRED`: the owned immutable-ledger count regressed.

Even in `READY_FOR_REVIEW`, automatic model changes remain disabled. A human scientific review is required before any later model-candidate phase.

## Runtime

The worker runs every five minutes in `p0-integration`, beginning after the S6K worker startup window.

Persistent output:

```text
/app/data/mlb-s6l-scientific-metrics/latest.json
/app/data/mlb-s6l-scientific-metrics/snapshots/*.json
```

Snapshots are written only when material report content changes.

## Endpoints

Sanitized public health:

```text
GET /health/s6l-scientific-metrics
```

Protected aggregate status:

```text
GET /api/mlb/ledger/v1/s6l-scientific-metrics/status
```

Protected complete scientific report:

```text
GET /api/mlb/ledger/v1/s6l-scientific-metrics/report
```

## Safety boundary

- mode: `SHADOW`;
- real financial exposure: `0`;
- no sportsbook account integration;
- no automatic bet placement;
- no production writes;
- no historical ledger mutation;
- no automatic promotion;
- no formula, probability, signal, ranking, market, threshold, settlement-rule or stake-policy changes;
- no Railway configuration changes;
- no frontend changes.
