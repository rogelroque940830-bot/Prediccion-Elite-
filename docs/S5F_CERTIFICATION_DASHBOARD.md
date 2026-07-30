# S5F-A Certification Dashboard and Scientific Review Package

## Purpose

S5F-A converts the existing S5B-S5E evidence into a protected, read-only certification surface. It does not change predictor calculations, probabilities, filters, supported markets, thresholds, stake policy, or financial behavior.

## Runtime

- enabled by default only when `RAILWAY_ENVIRONMENT_NAME=p0-integration`;
- first collection after 150 seconds;
- refresh every 5 minutes;
- reads the immutable MLB ledger, S5D gate state, and S5E closing evidence;
- writes only S5F-owned JSON snapshots under the S5F data directory;
- creates a new snapshot only when the semantic certification state changes.

Environment variables:

- `MLB_S5F_CERTIFICATION`
- `MLB_S5F_INTERVAL_MS`
- `MLB_S5F_INITIAL_DELAY_MS`
- `MLB_S5F_CERTIFICATION_DIR`

## Terminal-decision dashboard

The dashboard represents each terminal supersedes chain once. Every row contains:

- official game identity and start time;
- market, selection, signal, confidence and model probability;
- complete PROVISIONAL to FINAL lineage;
- lineage integrity diagnostics;
- origin opening quote and terminal analytical opening quote;
- lineup counts captured at each stage;
- latest S5E closing observation and comparability classification;
- official settlement and CLV when available;
- readiness status: `READY`, `PENDING`, or `ACTION_REQUIRED`.

A PROVISIONAL and FINAL revision in one chain therefore remain two immutable ledger records but one independent dashboard decision.

## Scientific review package

S5F invokes the existing S5B evaluator over terminal records. The package includes:

- unchanged S5D gate policy and status;
- aggregate performance summary;
- market, signal, category, stage and filter breakdowns;
- Brier score, log loss, ROI and CLV metrics when available;
- data-quality coverage;
- analytical deduplication results;
- evidence-readiness counts from S5E;
- consistency check against the latest S5D gate status;
- aggregate warnings and human-review state.

While the gate is `EXTEND`, the package is explicitly marked `partial=true`. It never authorizes promotion.

## Quality alerts

Alerts are deterministic and deduplicated by code, prediction and message. Informational pending states remain non-actionable. Actionable conditions include:

- game started without FINAL;
- closing window currently due without evidence;
- closing window missed after start;
- opening and closing source sets changed;
- verified price unavailable;
- settlement overdue more than six hours;
- missing or cyclic supersedes parent;
- S5E matching or service errors.

A moved F5 total line is retained as evidence but remains informational because price-only CLV is intentionally not calculated across different lines.

## Endpoints

Sanitized public health:

- `GET /health/s5f-certification`

Protected endpoints:

- `GET /api/mlb/ledger/v1/s5f-certification/status`
- `GET /api/mlb/ledger/v1/s5f-certification/dashboard`
- `GET /api/mlb/ledger/v1/s5f-certification/review-package`
- `GET /api/mlb/ledger/v1/s5f-certification/alerts`

Alert filters:

- `severity=INFO|WARNING|CRITICAL`
- `actionable=true|false`
- `limit=1..1000`

## Safety invariants

Every collection verifies:

- mode remains `SHADOW`;
- real financial exposure is `0`;
- no sportsbook integration;
- no automatic wager placement;
- no production writes;
- no automatic promotion;
- no formula changes;
- no threshold changes;
- no stake-policy changes.
