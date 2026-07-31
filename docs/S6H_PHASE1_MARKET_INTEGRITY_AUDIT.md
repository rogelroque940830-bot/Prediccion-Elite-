# S6H Phase 1 — MLB Market Integrity Audit

## Scope

This phase is diagnostic and read-only. It does not modify Railway, the shared persistent volume, ledger rows, settlements, predictor formulas, probabilities, thresholds, markets, workers, stake policy, or sportsbook behavior.

The audit addresses the suspicious records observed in the live `MLB · En foco` view on 2026-07-31.

## Confirmed source path

S5C performs this sequence:

1. reads `/api/odds/mlb/f5`;
2. reads `odds.f5Ml.home/away`, `odds.f5Total.line`, `overOdds`, and `underOdds`;
3. sends those same line/price values to `/api/mlb/early-markets`;
4. persists the selected lane in the immutable ledger;
5. derives `marketImplied` from `oddsAmerican`;
6. derives `edgePp` from model probability minus that implied probability.

The S5C helper named `validAmericanOdds` currently accepts every finite non-zero number and rounds it. It does not enforce the standard American-odds domain of `<= -100` or `>= +100`.

Therefore a source value such as `-4` passes S5C validation, is persisted as `oddsAmerican = -4`, produces an implied probability of approximately `3.846%`, and produces an apparently enormous edge when subtracted from the model probability.

## Deterministic reconstruction of visible anomalies

### Pittsburgh F5 at -145

- standard American price: yes;
- implied probability: `145 / (145 + 100) = 59.184%`;
- model: `65.7%`;
- recomputed edge: `6.516 pp`;
- initial audit classification: `PASS` when source/book and capture time are present.

### Baltimore F5 at -120

- standard American price: yes;
- implied probability: `120 / (120 + 100) = 54.545%`;
- model: `77.4%`;
- recomputed edge: `22.855 pp`;
- stored arithmetic is coherent;
- classification: `REVIEW — EDGE_OUTLIER`.

This record does not prove an arithmetic bug. It requires source/model review because the edge is extraordinary.

### Texas–Houston F5 Over 4.4 at -126

- standard American price: yes;
- implied probability: `126 / (126 + 100) = 55.752%`;
- model: `78.5%`;
- recomputed edge: `22.748 pp`;
- stored arithmetic is coherent;
- `4.4` is not on a whole/half-run increment;
- classification: `REVIEW — EDGE_OUTLIER, NON_STANDARD_LINE_INCREMENT`.

The current source path copies `odds.f5Total.line` verbatim. Phase 1 cannot yet determine whether `4.4` came from the odds provider, a consensus transformation, or a projection accidentally exposed as a ticket line.

### Kansas City–Colorado F5 Under 6.6 at -4

- standard American price: no;
- forensic formula result: `4 / (4 + 100) = 3.846%`;
- model: `61.1%`;
- recomputed edge: `57.254 pp`;
- the stored implied probability and edge are internally consistent with the invalid `-4` input;
- `6.6` is not on a whole/half-run increment;
- classification: `REJECT — INVALID_AMERICAN_ODDS, NON_STANDARD_LINE_INCREMENT`.

This proves the main defect is not the subtraction that calculates edge. The defect is that an invalid source price was allowed into the ledger and then treated as valid American odds.

## Frontend finding

The S6G focused view ranks a pending record using signal, analysis stage, confidence, time-to-start, and positive edge. It does not currently validate:

- American-odds domain;
- implied-probability arithmetic;
- edge arithmetic;
- market/selection compatibility;
- total-line increment;
- source/book presence;
- capture timestamp;
- extreme-edge outliers.

That is why an invalid record can become visible in `Prioridad`.

## Audit classifications

The isolated audit utility produces:

- `PASS`: no deterministic integrity issue detected;
- `REVIEW`: unusual but not proven corrupt;
- `REJECT`: mathematically invalid or market-incompatible.

Issue codes include:

- `INVALID_AMERICAN_ODDS`;
- `IMPLIED_PROBABILITY_MISMATCH`;
- `EDGE_ARITHMETIC_MISMATCH`;
- `EDGE_OUTLIER`;
- `MARKET_SELECTION_MISMATCH`;
- `MISSING_TOTAL_LINE`;
- `NON_STANDARD_LINE_INCREMENT`;
- `MISSING_BOOK`;
- `MISSING_PRICE_CAPTURE_TIME`.

## Running the read-only audit

Export an authenticated ledger history response to a local JSON file, then run:

```bash
node scripts/s6h-audit-mlb-market-integrity.mjs \
  --input path/to/ledger-history.json \
  --json artifacts/s6h-phase1-market-integrity.json \
  --markdown artifacts/s6h-phase1-market-integrity.md
```

Accepted payload forms:

- JSON array;
- `{ "picks": [...] }`;
- `{ "records": [...] }`;
- `{ "data": { "picks": [...] } }`;
- `{ "data": { "records": [...] } }`.

## Evidence boundary

The repository audit establishes the transformation defect and reconstructs the visible examples. It cannot identify the exact live record IDs, original provider rows, source-set members, or raw capture payloads without an authenticated ledger export.

No service token, password, browser cookie, Railway secret, or production data is stored in this branch or workflow.

## Phase 1 exit criteria

Phase 1 is complete when:

1. the deterministic fixture tests pass;
2. the read-only report generator produces JSON and Markdown evidence;
3. the source path and invalid-odds acceptance defect are documented;
4. a live authenticated export is audited without writing to the ledger;
5. every live Priority/Waiting record is classified as PASS, REVIEW, or REJECT with explicit reasons.

Items 1–3 are satisfied by this branch. Items 4–5 require the authenticated export and are intentionally not simulated.
