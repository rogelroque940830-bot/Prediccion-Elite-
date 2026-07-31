# S6C WNBA Shadow Baseline

## Purpose

S6C creates an isolated, zero-stake WNBA evidence pipeline in `p0-integration`. It does not replace or modify the existing predictor. Its probability is the de-vigged two-sided moneyline market probability and must be interpreted only as a reproducible market baseline.

## Scientific contract

- one append-only game chain per scheduled WNBA game;
- `PROVISIONAL` snapshots outside the final pregame window;
- `FINAL` snapshots inside the configured pregame window;
- unchanged retries are idempotent;
- materially changed market/context evidence appends a superseding revision;
- official final scores append a settlement event without mutating prior records;
- Brier score and log loss are calculated from the terminal record only;
- no claim of predictive edge is permitted from the market baseline itself.

## Evidence captured

Each record preserves:

- schedule identity and commence time;
- both moneyline prices and source;
- raw implied and de-vigged probabilities;
- team ratings and recent form;
- fatigue, SOS, top-player context and injuries;
- source attribution and degraded-source flags;
- missing-context diagnostics;
- deployment commit, stage and supersession chain.

## Runtime

Defaults in `p0-integration`:

- enabled unless explicitly disabled;
- low-frequency bounded worker;
- runtime root `data/wnba-shadow-v1`;
- sanitized health at `/health/s6c-wnba-shadow`;
- detailed authenticated endpoints under `/api/wnba/shadow/v1`.

Environment controls:

- `WNBA_S6C_SHADOW_ENABLED`
- `WNBA_S6C_SHADOW_INTERVAL_MS`
- `WNBA_S6C_SHADOW_INITIAL_DELAY_MS`
- `WNBA_S6C_FINAL_WINDOW_MINUTES`
- `WNBA_S6C_SETTLEMENT_LOOKBACK_DAYS`
- `WNBA_S6C_SHADOW_ROOT`

## Detailed endpoints

All detailed routes require an authenticated session or the configured service token:

- `GET /api/wnba/shadow/v1/status`
- `GET /api/wnba/shadow/v1/latest`
- `GET /api/wnba/shadow/v1/records`
- `GET /api/wnba/shadow/v1/settlements`
- `GET /api/wnba/shadow/v1/report`

## Safety invariants

S6C must always report:

- signal `OBSERVE`;
- recommended stake `0`;
- real financial exposure `0`;
- no sportsbook integration;
- no automatic wager placement;
- no production writes;
- no automatic promotion;
- no changes to existing predictor formulas, filters, markets, probabilities, thresholds or stake policy;
- no reuse of the MLB ledger.

## Interpretation limits

The first sample is a baseline-quality exercise, not proof that the predictor wins. Promotion or model changes are forbidden until a later, separately authorized phase defines sample-size, closing-line and calibration gates for WNBA.
