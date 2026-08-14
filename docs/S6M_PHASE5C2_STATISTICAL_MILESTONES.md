# S6M Phase 5C-2 — Statistical Milestone Certification

## Objective

Certify the first real scientific samples produced by the clean post-fix MLB cohort at deterministic milestones of 1, 5, 20, and 50 binary outcomes.

The phase validates the statistical engine. It does not judge the predictor, recommend a formula change, or authorize automatic model changes.

## Independent recomputation

S6M independently reconstructs the eligible sample from the immutable ledger instead of trusting the S6L aggregate report.

Eligibility requires:

1. every lifecycle record was created after the S6H Phase 3 integrity cutoff;
2. the analytical lifecycle is unique by game, market, selection, and line;
3. the terminal record is `FINAL`;
4. American odds are in the standard domain;
5. model probability is strictly between 0 and 1;
6. capture time, consensus method, and contributing books are present;
7. an official settlement or valid correction exists;
8. the settlement result is `WIN`, `LOSS`, `PUSH`, or `VOID`.

S6M then independently recomputes:

- Brier Score;
- natural-log loss;
- observed win rate and Wilson 95% interval;
- ECE and MCE using fixed deciles;
- flat-one-unit informational ROI;
- CLV count, coverage, mean, and median;
- all inclusion, duplicate, and exclusion counts.

Any mismatch with S6L produces `ACTION_REQUIRED` and blocks milestone creation.

## Immutable milestones

The milestones are:

| Milestone | Purpose |
|---:|---|
| 1 | Manually certifiable first eligible settlement and all arithmetic |
| 5 | Detect repeated inclusion, settlement, or calculation defects |
| 20 | Certify the minimum descriptive sample and S6L transition to `COLLECTING` |
| 50 | Certify the preferred sample before human scientific review |

Each certificate uses the first N eligible binary decisions ordered by terminal timestamp and prediction ID. It contains:

- exact prediction and settlement identifiers;
- game, market, selection, line, signal, odds, and probability;
- result and binary outcome;
- CLV when available;
- payload digest;
- independently recomputed metrics;
- manifest digest;
- complete certificate digest.

Certificates are append-only and are never overwritten.

## Runtime states

- `WAITING_FOR_MILESTONE_1`
- `MILESTONE_1_CERTIFIED`
- `MILESTONE_5_CERTIFIED`
- `MILESTONE_20_CERTIFIED`
- `MILESTONE_50_CERTIFIED`
- `ACTION_REQUIRED`

Human review is enabled only when:

- milestone 50 is certified;
- at least ten decisions are independently certified through S6K;
- S6L is `READY_FOR_REVIEW`;
- S6L conclusions are allowed.

Even then:

```text
automaticModelChangesAllowed = false
recommendation = NO_AUTOMATIC_MODEL_CHANGE
```

## Persistent evidence

```text
/app/data/mlb-s6m-statistical-milestones/latest.json
/app/data/mlb-s6m-statistical-milestones/certificates/milestone-1.json
/app/data/mlb-s6m-statistical-milestones/certificates/milestone-5.json
/app/data/mlb-s6m-statistical-milestones/certificates/milestone-20.json
/app/data/mlb-s6m-statistical-milestones/certificates/milestone-50.json
/app/data/mlb-s6m-statistical-milestones/snapshots/*.json
```

## Endpoints

Sanitized public health:

```text
GET /health/s6m-statistical-milestones
```

Protected aggregate status:

```text
GET /api/mlb/ledger/v1/s6m-statistical-milestones/status
```

Protected complete report and milestone metadata:

```text
GET /api/mlb/ledger/v1/s6m-statistical-milestones/report
```

## Safety boundary

- mode: `SHADOW`;
- real financial exposure: `0`;
- no sportsbook integration;
- no automatic betting;
- no prediction or settlement formula changes;
- no thresholds or stake-policy changes;
- no historical ledger mutation or deletion;
- no automatic promotion;
- no Railway configuration changes.
