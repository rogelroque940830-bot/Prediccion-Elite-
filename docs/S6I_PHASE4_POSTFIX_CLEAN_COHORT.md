# S6I Phase 4 — Post-fix Clean Cohort Certification

## Objective

Validate the complete MLB shadow lifecycle using only records created after the S6H Phase 3 market-integrity correction became live.

This phase does **not** change prediction formulas, model probabilities, signals, ranking thresholds, stake policy, settlement logic, Railway settings, or historical ledger rows.

## Cohort boundary

The clean cohort begins at:

```text
2026-08-01T00:00:50.911Z
```

This is the first live verification timestamp at which the backend returned:

```text
schemaVersion = mlb-f5-odds-consensus.v2
consensusMethod = median_implied_probability
invalidAmericanPrices = 0
```

Phase 3 deployment commit:

```text
80c3120a35285724ef53b76e2d3a70300aab80ec
```

A terminal decision is excluded from the pure cohort when its supersedes chain begins before the cutoff.

## Clean-row requirements

Every clean decision must satisfy all of the following:

1. S5C immutable ledger record.
2. Terminal record in its PROVISIONAL → FINAL supersedes chain.
3. Entire chain created after the Phase 3 cutoff.
4. American odds are standard: absolute value from 100 through 100,000.
5. Stored implied probability agrees with the American-price formula within 0.05 percentage points.
6. Stored edge agrees with model probability minus implied probability within 0.05 percentage points.
7. Original market capture time is present.
8. Consensus method is `median_implied_probability`.
9. At least one contributing sportsbook is identified.
10. `standardAmericanOddsValidated` is true.
11. Market and selection are structurally compatible.
12. Repeated semantic fingerprints are excluded from performance metrics.

Historical invalid records are not deleted. They remain available as evidence and continue to be excluded by the Phase 2 frontend integrity gate.

## Lifecycle checks

The service evaluates:

- PROVISIONAL snapshots naturally waiting for official batting orders;
- FINAL snapshot coverage after games begin;
- settlement presence;
- overdue settlements more than 12 hours after scheduled start;
- official final-score evidence;
- closing-price and CLV coverage;
- monotonic ledger counts across persisted snapshots;
- immutable-ledger continuity across deployments.

## Operational readiness thresholds

These thresholds control only readiness for human QA review. They do not authorize betting or change predictor behavior.

| Check | Requirement |
|---|---:|
| Minimum settled clean unique decisions | 20 |
| FINAL snapshot coverage | at least 90% |
| Settlement coverage for overdue games | 100% |
| Closing/CLV coverage among settled records | at least 80% |
| Official final-score coverage among settled records | at least 95% |
| New invalid American prices | 0 |
| Clean-row provenance | 100% |
| Persistent ledger count | monotonic |

Possible states:

- `COLLECTING`: operational checks pass, but the settled sample is still below 20.
- `READY_FOR_HUMAN_REVIEW`: all operational checks pass and the minimum settled sample is reached.
- `ACTION_REQUIRED`: a critical integrity defect, missed FINAL, overdue settlement, or persistence regression is detected.

There is no automatic promotion.

## Performance observations

The report calculates informational-only evidence for the clean unique cohort:

- settled decisions;
- observed win rate;
- mean model probability;
- mean CLV;
- Brier score;
- market-level breakdowns.

These observations do not change formulas or certify profitability. Scientific calibration remains a later phase after enough clean settlements accumulate.

## Runtime

The worker runs every 15 minutes in `p0-integration` and writes immutable-style JSON snapshots under:

```text
/app/data/mlb-s6i-postfix-certification
```

Public aggregate health:

```text
GET /health/s6i-postfix-certification
```

Aggregate API status:

```text
GET /api/mlb/ledger/v1/s6i-postfix-certification/status
```

Issue feed:

```text
GET /api/mlb/ledger/v1/s6i-postfix-certification/issues
```

The endpoints intentionally avoid returning raw provider quote arrays or the full private ledger.

## Safety boundary

- Shadow mode only.
- Real financial exposure: 0.
- No sportsbook writes.
- No automatic bet placement.
- No historical mutation.
- No automatic promotion.
- No formula changes.
- No threshold changes to the predictor.
- No stake-policy changes.
