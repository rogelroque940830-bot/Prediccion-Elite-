# S6J Phase 5A — First Clean MLB Lifecycle Certification

## Objective

Certify the first complete MLB decision lifecycle generated entirely after the S6H Phase 3 market-price correction.

The lifecycle is:

```text
PROVISIONAL
→ FINAL with two confirmed nine-player batting orders
→ official MLB settlement
→ independent re-grade from the official inning feed
→ comparable CourtEdge consensus closing
→ CLV verification
```

This phase observes and certifies existing behavior. It does not change prediction formulas, probabilities, signals, ranking, markets, thresholds, stake policy, settlement rules, sportsbook integration, or Railway configuration.

## Target selection

The worker permanently selects the earliest post-fix S5C chain that:

1. begins after `2026-08-01T00:00:50.911Z`;
2. contains a PROVISIONAL stage;
3. belongs to the authenticated system owner;
4. has not crossed the Phase 3 cutover.

The selected root is persisted in `target.json`, so later FINAL and settlement revisions are evaluated as one stable lifecycle rather than changing targets between runs.

## Certification checks

The certificate verifies:

- linear `supersedesId` lineage with one terminal descendant;
- stable game, market, selection, and line across the chain;
- standard American odds and complete price provenance;
- FINAL captured before first pitch, with two nine-player batting orders;
- official or append-only correction settlement source;
- independent result and outcome grading from the official MLB inning feed;
- stored full-game score equals the official final score;
- comparable S5E closing consensus matches the settlement correction;
- CLV equals closing implied probability minus opening implied probability;
- shadow profit remains `0` units;
- immutable-ledger count remains monotonic.

## States

- `WAITING_FOR_TARGET`: no eligible post-fix PROVISIONAL chain exists.
- `WAITING_FOR_FINAL`: target exists but lineups have not produced a FINAL revision.
- `WAITING_FOR_SETTLEMENT`: FINAL exists and the official result is pending.
- `WAITING_FOR_OFFICIAL_VERIFICATION`: settlement exists but the official inning feed cannot yet be independently graded.
- `WAITING_FOR_CLOSING`: official settlement is correct but comparable closing/CLV correction is pending.
- `CERTIFIED`: the first full clean cycle passed every check.
- `ACTION_REQUIRED`: a structural, settlement, score, closing, CLV, persistence, or safety defect was detected.

## Runtime

The worker runs every five minutes in `p0-integration` after a 150-second startup delay.

Persistent evidence is stored under:

```text
/app/data/mlb-s6j-first-clean-cycle
```

Files:

- `target.json`: permanently selected lifecycle root;
- `latest.json`: latest complete certificate;
- `snapshots/*.json`: material state changes only.

## Endpoints

Sanitized public health:

```text
GET /health/s6j-first-cycle
```

Protected aggregate status:

```text
GET /api/mlb/ledger/v1/s6j-first-cycle/status
```

Protected full certificate:

```text
GET /api/mlb/ledger/v1/s6j-first-cycle/evidence
```

## Safety boundary

- mode: SHADOW;
- real financial exposure: `0`;
- no sportsbook account integration;
- no automatic bet placement;
- no production writes;
- no historical ledger mutation;
- no automatic promotion;
- no formula, threshold, or stake-policy changes.
