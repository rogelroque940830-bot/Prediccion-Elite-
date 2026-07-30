# S5C Daily MLB Shadow Ingestion

## Objective

Automatically create immutable MLB analytical decisions in `p0-integration` so S5B can accumulate a real forward-looking sample without manual saving and without financial exposure.

## Runtime flow

Every 30 minutes, after an initial 60-second delay, the staging-only worker:

1. resolves the current Florida date;
2. reads the official MLB schedule and per-game live feed;
3. requires both team identities and probable pitchers;
4. classifies the snapshot as `PROVISIONAL` or `FINAL` from official batting orders;
5. reads verified F5 consensus prices from the existing `/api/odds/mlb/f5` route;
6. calls the existing `/api/mlb/early-markets` route with the same official game context;
7. records priced F5 ML and F5 total decisions in the immutable, user-owned MLB ledger;
8. stores `BET_FUERTE`, `BET`, `LEAN`, and `PASS` signals with `stakeUnits = 0`;
9. links recalculations with `supersedesId`;
10. leaves decisions without a verified quote as `unpriced` evidence instead of inventing odds.

## Scientific boundaries

- No sportsbook account or wager-placement integration.
- Real financial exposure is always zero.
- No synthetic or default `-110` price is permitted.
- No changes to predictor formulas, filters, markets, probabilities, thresholds, or stake policy.
- The worker only calls the existing predictor route and persists its output.
- `FINAL` requires both official batting orders and a pregame capture timestamp.
- Exact semantic retries are idempotent.

## Evidence and observability

Public sanitized health:

- `GET /health/s5c-ingestion`

Private endpoints protected by the existing authentication/service-token middleware:

- `GET /api/mlb/ledger/v1/s5c-ingestion/status`
- `GET /api/mlb/ledger/v1/s5c-ingestion/latest`

The public response includes only aggregate counts and safety invariants. It does not expose teams, selections, probabilities, odds, ledger rows, or user data.

## Configuration

- `MLB_S5C_AUTO_CAPTURE=true|false`
- `MLB_S5C_INTERVAL_MS` — default 1,800,000 ms; minimum 300,000 ms
- `MLB_S5C_INITIAL_DELAY_MS` — default 60,000 ms; minimum 10,000 ms
- `MLB_S5C_INGESTION_DIR` — optional evidence path

Without an explicit override, the worker is enabled only when `RAILWAY_ENVIRONMENT_NAME=p0-integration`.

## Acceptance criteria

- TypeScript compilation succeeds.
- Unit test confirms PROVISIONAL and FINAL ingestion.
- Exact retries do not append duplicate records.
- FINAL records supersede their matching PROVISIONAL records.
- Every stored decision has verified American odds and `stakeUnits = 0`.
- Unpriced decisions are reported but not inserted into the priced ledger.
- Existing S1-S5B, MLB ledger, build, and S5A E2E gates remain green.
- Post-merge Railway smoke confirms the exact deployed SHA and a completed S5C run.
