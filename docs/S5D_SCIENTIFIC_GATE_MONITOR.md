# S5D Scientific Gate Monitor

## Objective

Persist and observe the existing S5B scientific gate while the S5C forward-looking sample grows. S5D does not change the gate policy or any predictor rule. It converts the existing `EXTEND`, `GO_REVIEW`, and `NO_GO` result into an auditable operational state.

## Runtime flow

The staging-only monitor starts after a 90-second delay and evaluates the immutable MLB ledger every 30 minutes.

1. Read the immutable ledger.
2. Keep only terminal records from every `supersedesId` chain.
3. Run the existing `buildMlbShadowEvaluation` implementation.
4. Read the gate policy returned by that evaluator; do not duplicate or override thresholds.
5. Calculate progress toward settled-count and coverage requirements.
6. Write `latest.json` on every successful run.
7. Create a snapshot only when the scientific state changes.
8. Append a transition only when the gate changes status.
9. Create a human-review package when the gate becomes `GO_REVIEW` or `NO_GO`.

## Current gate policy

The monitor consumes the policy already embedded in the S5B evaluator:

- minimum 30 settled unique decisions;
- minimum 80% market-implied probability coverage;
- minimum 70% closing-line coverage;
- minimum 90% FINAL snapshot coverage;
- severe negative evidence can produce `NO_GO` only after the sample is mature.

S5D does not redefine these values.

## Decision states

### EXTEND

At least one maturity or coverage minimum is not satisfied. Collection continues automatically.

### GO_REVIEW

The technical minimums are satisfied and no severe negative gate is present. This status creates a review package, but it does not approve or promote a market.

### NO_GO

A mature sample presents severe negative performance or calibration evidence according to the existing policy. This status creates a human-review package and preserves the evidence.

## Persistence

Default staging root:

`/app/data/mlb-s5d-gate-monitor`

Files:

- `latest.json` — latest monitor envelope;
- `snapshots/*.json` — material scientific changes;
- `transitions.jsonl` — append-only gate transitions;
- `review-packages/*.json` — aggregate human-review packages for `GO_REVIEW` and `NO_GO`.

Snapshots and review packages are retained for 180 days with a default maximum of 1,000 files per category.

## Observability

Sanitized public health:

- `GET /health/s5d-gate`

Protected endpoints:

- `GET /api/mlb/ledger/v1/s5d-gate/status`
- `GET /api/mlb/ledger/v1/s5d-gate/latest`
- `GET /api/mlb/ledger/v1/s5d-gate/transitions?limit=100`

The public endpoint contains only aggregate progress, gate status, transition counts, and safety invariants. It does not expose teams, selections, odds, probabilities, or individual ledger rows.

## Configuration

- `MLB_S5D_GATE_ENABLED=true|false`
- `MLB_S5D_GATE_INTERVAL_MS` — default 1,800,000 ms; minimum 300,000 ms
- `MLB_S5D_GATE_INITIAL_DELAY_MS` — default 90,000 ms; minimum 10,000 ms
- `MLB_S5D_GATE_RETENTION_DAYS` — default 180
- `MLB_S5D_GATE_MAX_SNAPSHOTS` — default 1,000
- `MLB_S5D_GATE_DIR` — optional persistence path

Without an explicit override, S5D is enabled only in `p0-integration`.

## Safety invariants

- mode remains `SHADOW`;
- real financial exposure remains zero;
- no sportsbook account integration;
- no automatic wager placement;
- no production writes;
- no automatic market promotion;
- no formula changes;
- no threshold changes;
- no stake-policy changes.

## Acceptance criteria

- `EXTEND` progress is persisted correctly;
- unchanged evaluations do not create duplicate snapshots or transitions;
- `GO_REVIEW` creates a human-review package without promotion authorization;
- `NO_GO` creates a separate human-review package;
- the transition history is append-only;
- existing S1-S5C regression gates remain green;
- Railway serves the exact merge SHA and completes the first S5D evaluation.
