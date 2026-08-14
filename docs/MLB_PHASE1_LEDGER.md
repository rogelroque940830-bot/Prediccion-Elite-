# MLB Phase 1 — Scientific Prediction Ledger

## Objective

Create a reproducible, append-only record of every MLB prediction before the game starts, followed by append-only settlement events after the result is official. The ledger is intentionally separate from the editable user history in `data/picks.json`.

The database is stored at:

```text
data/mlb-ledger-v1.sqlite
```

Railway must keep `/app/data` mounted to the persistent volume. The path can be overridden with `MLB_LEDGER_DB_PATH` for tests or controlled migrations.

## Integrity guarantees

1. Prediction rows cannot be updated or deleted. SQLite triggers reject both operations.
2. Settlement events cannot be updated or deleted.
3. Corrections are new events that reference the previous event.
4. Recalculated predictions are new rows that use `supersedesId`.
5. `clientRequestId` makes network retries idempotent.
6. Every original payload is canonicalized and stored with SHA-256.
7. Reports include a SHA-256 fingerprint of the exact prediction and settlement set used.
8. Writes require the same authenticated session plus CSRF token, or the configured service token, as canonical picks.

## Endpoints

### Status

```http
GET /api/mlb/ledger/v1/status
```

Returns schema version, prediction count, settlement-event count, latest write time, journal mode and immutable status.

### Append prediction

```http
POST /api/mlb/ledger/v1/predictions
```

Probability values use the `0-1` scale. Confidence percentage uses the `0-100` scale.

Example:

```json
{
  "schemaVersion": "mlb-ledger.v1",
  "clientRequestId": "mlb-777001-f5-home-20260726T200000Z",
  "source": "app",
  "model": {
    "name": "CourtEdge MLB",
    "version": "2026.07-phase1"
  },
  "game": {
    "gamePk": 777001,
    "gameDate": "2026-07-26",
    "commenceTime": "2026-07-26T23:10:00.000Z",
    "homeTeam": "Home Club",
    "awayTeam": "Away Club",
    "venue": "Example Park"
  },
  "market": {
    "type": "F5_ML",
    "selection": "Home Club F5 ML",
    "oddsAmerican": -120,
    "book": "Hard Rock",
    "capturedAt": "2026-07-26T20:00:00.000Z"
  },
  "probabilities": {
    "model": 0.61,
    "noVig": 0.545
  },
  "decision": {
    "signal": "BET",
    "confidenceLabel": "LOW",
    "confidencePct": 61,
    "stakeUnits": 1,
    "rationale": "ERE difference survived all F5 filters"
  },
  "analysis": {
    "stage": "FINAL",
    "warnings": [],
    "factors": [
      {
        "name": "ERE difference",
        "direction": "FOR",
        "magnitude": 12,
        "units": "points",
        "confidence": "FULL",
        "source": "ERE"
      }
    ],
    "sources": [
      {
        "name": "MLB Stats API",
        "status": "VERIFIED",
        "fetchedAt": "2026-07-26T19:59:00.000Z",
        "sample": 30
      }
    ],
    "layers": {
      "pureModel": 0.61,
      "marketCalibration": 0.59,
      "final": 0.61
    },
    "rawInputs": {},
    "rawOutput": {}
  }
}
```

If `marketImplied` is omitted, the server derives it from American odds. If `edgePp` is omitted, the server calculates model probability minus `noVig`, or model probability minus market-implied probability when `noVig` is unavailable.

### List predictions with latest settlement

```http
GET /api/mlb/ledger/v1/predictions
```

Optional query parameters:

- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`
- `market=F5_ML`
- `confidence=LOW`
- `signal=BET`
- `stage=FINAL`
- `settled=true|false`
- `limit=1000`

### Read one prediction

```http
GET /api/mlb/ledger/v1/predictions/:id
```

### Append settlement

```http
POST /api/mlb/ledger/v1/predictions/:id/settlements
```

Example:

```json
{
  "clientRequestId": "settle-mlb-777001-f5-home-v1",
  "settledAt": "2026-07-27T02:00:00.000Z",
  "result": "WIN",
  "closingOddsAmerican": -140,
  "finalScore": {
    "home": 4,
    "away": 2
  },
  "source": "official"
}
```

Supported results:

- `WIN`
- `LOSS`
- `PUSH`
- `VOID`
- `HALF_WIN`
- `HALF_LOSS`

Profit is calculated from the recorded stake and opening odds. `profitUnitsOverride` exists only for settlement cases that cannot be represented by the standard result types. Closing-line value is stored in probability points:

```text
closing implied probability − captured implied probability
```

A positive number means the market moved toward the recorded selection.

### Reproducible report

```http
GET /api/mlb/ledger/v1/report
```

The report returns:

- prediction, settled and pending counts;
- weighted hit rate;
- units risked, profit and ROI;
- average model probability, edge and CLV;
- Brier score and log loss;
- grouping by market, confidence, signal, analysis stage and month;
- calibration buckets;
- chronological train/validation/test summaries;
- dataset SHA-256.

Default temporal partition:

```text
70% train / 15% validation / 15% test
```

Custom partition:

```http
GET /api/mlb/ledger/v1/report?trainPct=60&validationPct=20
```

The split is chronological. It does not shuffle records.

### Export

```http
GET /api/mlb/ledger/v1/export?format=jsonl
GET /api/mlb/ledger/v1/export?format=csv
```

The export accepts the same date, market, confidence, signal and stage filters as the report.

## Correction policy

Never repair historical science by overwriting a row.

### Recalculated prediction

Create a new prediction and set:

```json
{
  "supersedesId": "mlb-pred-original-id"
}
```

### Settlement correction

Create a new settlement event and set:

```json
{
  "source": "correction",
  "correctionOfEventId": "mlb-settle-original-event-id"
}
```

Reports use the latest settlement event for the prediction while retaining every prior event for auditability.

## Validation commands

```bash
npm run typecheck
npm run test:mlb-ledger
npm run build:backend
```

The unit suite verifies:

- idempotent prediction writes;
- immutable prediction rows;
- idempotent settlement writes;
- append-only settlement corrections;
- server-side profit and CLV calculation;
- stable dataset fingerprints;
- chronological report partitions;
- confidence grouping.

## Phase 1 boundary

This phase creates the scientific storage and reporting foundation. It does not yet change MLB model formulas, HIGH/MEDIUM/LOW behavior, Early filters, signal authorization or stake policy. Those changes must be evaluated from the ledger rather than introduced before the evidence exists.
