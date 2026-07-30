# S5E FINAL and Closing-Line Coverage

## Objective

S5E repairs the data-quality bottlenecks reported by S5D while preserving every analytical and financial safety boundary.

It does not modify predictor formulas, probabilities, filters, supported markets, decision thresholds, or stake policy.

## Confirmed problems

### FINAL capture timing

S5C normally evaluates the slate every 30 minutes. Official batting orders can appear inside that interval, creating a risk that the last scheduled run occurs before confirmation and the next occurs after first pitch.

S5E checks terminal PROVISIONAL records every five minutes when their games are within four hours of starting. When both official batting orders contain nine players, it triggers an immediate S5C rerun. S5C remains the only component that creates the FINAL analytical prediction.

### Consensus opening versus single-book closing

S5C F5 opening prices are medians from FanDuel, BetMGM, and DraftKings. Comparing that median against one arbitrarily selected bookmaker is not a scientifically equivalent closing comparison.

S5E captures the same CourtEdge F5 consensus endpoint inside the final 20 minutes before first pitch and records:

- the opening source-book set;
- the closing source-book set;
- closing price and line;
- whether the source sets are identical;
- whether the total line remained identical;
- the reason a quote is or is not comparable.

A quote is comparable only when:

1. at least two books participated;
2. the opening and closing source-book sets are identical;
3. a valid closing price exists;
4. for F5 totals, the closing line equals the saved ticket line.

No synthetic price is ever created.

## Append-only settlement correction

If a prediction already has an official settlement but no CLV, and S5E has a comparable consensus observation, S5E appends a correction event that:

- references the original settlement through `correctionOfEventId`;
- preserves result, score, outcome and profit;
- adds the comparable consensus closing price and line;
- allows the immutable ledger to calculate CLV;
- never overwrites or deletes the official event.

## Coverage classifications

FINAL coverage is separated into:

- `finalCaptured`;
- `provisionalPendingLineups`;
- `finalMissedAfterStart`.

Closing coverage is separated into:

- comparable evidence;
- captured but non-comparable evidence;
- pending outside the capture window;
- due inside the capture window;
- missed after start.

Non-comparable causes include:

- source-book set changed;
- total line moved;
- no valid price;
- no matching odds event.

Settlement is separated into:

- settled;
- naturally pending;
- overdue.

## Runtime

S5E is enabled by default only when:

`RAILWAY_ENVIRONMENT_NAME=p0-integration`

Defaults:

- interval: 5 minutes;
- initial delay: 120 seconds;
- closing window: final 20 minutes;
- FINAL lineup requirement: nine official batting-order entries per team.

Configuration:

- `MLB_S5E_COVERAGE=true|false`
- `MLB_S5E_INTERVAL_MS`
- `MLB_S5E_INITIAL_DELAY_MS`
- `MLB_S5E_COVERAGE_DIR`

## Endpoints

Sanitized public health:

- `GET /health/s5e-coverage`

Protected endpoints:

- `GET /api/mlb/ledger/v1/s5e-coverage/status`
- `GET /api/mlb/ledger/v1/s5e-coverage/latest`
- `GET /api/mlb/ledger/v1/s5e-coverage/observations`

## Safety invariants

- mode: SHADOW;
- real financial exposure: 0;
- sportsbook account integration: false;
- automatic bet placement: false;
- production writes: false;
- automatic promotion: false;
- synthetic odds: false;
- formulas changed: false;
- thresholds changed: false;
- stake policy changed: false.
