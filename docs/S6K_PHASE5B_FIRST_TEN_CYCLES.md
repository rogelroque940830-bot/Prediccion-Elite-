# S6K Phase 5B — First Ten Clean MLB Lifecycle Certification

## Objective

Certify repeatability across the first ten unique MLB decision lifecycles generated entirely after the S6H Phase 3 market-price correction.

Each lifecycle is evaluated through the same strict chain used by Phase 5A:

```text
PROVISIONAL
→ FINAL with confirmed batting orders
→ official MLB settlement
→ independent re-grade from the official inning feed
→ comparable CourtEdge consensus closing
→ CLV verification
```

This phase observes existing behavior. It does not modify prediction formulas, probabilities, signals, ranking, markets, thresholds, stake policy, settlement rules, sportsbook integration, Railway configuration, or historical ledger records.

## Target registry

The worker maintains an append-only registry of up to ten root prediction IDs.

Selection rules:

1. every record in the lifecycle is created after `2026-08-01T00:00:50.911Z`;
2. the lifecycle contains at least one PROVISIONAL stage;
3. the lifecycle belongs to the authenticated system owner;
4. analytical duplicates with the same game, market, selection and line are not selected twice;
5. existing selected roots preserve their order and are never silently replaced.

The registry is persisted in:

```text
/app/data/mlb-s6k-first-ten-cycles/targets.json
```

## Per-cycle classification

- `PASS`: the underlying S6J lifecycle is `CERTIFIED`.
- `REVIEW`: official settlement exists but independent verification, comparable closing or CLV evidence is still incomplete.
- `REJECT`: the lifecycle is `ACTION_REQUIRED` or contains a critical issue.
- `WAITING`: the lifecycle is naturally waiting for FINAL or settlement.

## Batch states

- `COLLECTING`: fewer than ten targets are available, or one or more selected cycles are still WAITING or REVIEW.
- `READY_FOR_ANALYSIS`: all ten selected cycles are PASS and ledger persistence remains monotonic.
- `ACTION_REQUIRED`: at least one selected cycle is REJECT or the owned ledger count regresses.

## Evidence tracked

For every selected lifecycle the report preserves:

- root and terminal prediction IDs;
- game, market, selection and line;
- chain length and PROVISIONAL/FINAL counts;
- settlement result;
- official independent verification;
- comparable closing capture;
- CLV availability;
- critical and warning issue counts;
- complete underlying S6J certificate.

## Runtime

The worker runs every five minutes in `p0-integration` after a three-minute startup delay.

Persistent files:

```text
/app/data/mlb-s6k-first-ten-cycles/targets.json
/app/data/mlb-s6k-first-ten-cycles/latest.json
/app/data/mlb-s6k-first-ten-cycles/snapshots/*.json
```

Snapshots are written only when material report content changes.

## Endpoints

Sanitized public health:

```text
GET /health/s6k-first-ten-cycles
```

Protected aggregate status:

```text
GET /api/mlb/ledger/v1/s6k-first-ten-cycles/status
```

Protected complete evidence:

```text
GET /api/mlb/ledger/v1/s6k-first-ten-cycles/evidence
```

## Safety boundary

- mode: SHADOW;
- real financial exposure: `0`;
- no sportsbook account integration;
- no automatic bet placement;
- no production writes;
- no historical ledger mutation;
- no automatic promotion;
- no formula, threshold, settlement-rule or stake-policy changes.
