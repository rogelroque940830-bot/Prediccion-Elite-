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

## Exact root cause: invalid median of American prices

`/api/odds/mlb/f5` creates a consensus from FanDuel, BetMGM, and DraftKings. Its generic `median` helper is also used for American prices.

For an even number of observations, that helper calculates:

```text
round((lower_middle + upper_middle) / 2)
```

That operation is valid for run lines and total points, but it is not valid for American odds because the scale is discontinuous around `-100/+100`.

Example with two books:

```text
Book A: -110
Book B: +100
Current consensus: (-110 + 100) / 2 = -5
```

`-5` is not a valid American price. It is a synthetic artifact created by averaging across the sign boundary.

S5C then compounds the problem because its helper named `validAmericanOdds` accepts every finite non-zero number and rounds it. It does not enforce the standard domain of `<= -100` or `>= +100`.

Therefore values such as `-1`, `-4`, `-5`, `-6`, `-8`, `-9`, `-11`, `-12`, and `-15` can pass ingestion, be persisted as American odds, and generate implied probabilities between roughly 0.99% and 13.04%.

## Live-ledger reconstruction

### Pittsburgh F5 at -145

- standard American price: yes;
- implied probability: `145 / (145 + 100) = 59.184%`;
- model: `65.7%`;
- recomputed edge: `6.516 pp`;
- structural classification: `PASS`.

### Baltimore F5 at -120

- standard American price: yes;
- implied probability: `120 / (120 + 100) = 54.545%`;
- model: `77.4%`;
- recomputed edge: `22.855 pp`;
- stored arithmetic is coherent;
- classification: `REVIEW — EDGE_OUTLIER`.

This record does not prove an arithmetic bug. It requires model and source review because the edge is extraordinary.

### Texas–Houston F5 Over 4 at -126

- live ledger line: `4.0`, not `4.4`;
- standard American price: yes;
- implied probability: `126 / (126 + 100) = 55.752%`;
- model: `78.5%`;
- recomputed edge: `22.748 pp`;
- stored arithmetic is coherent;
- classification: `REVIEW — EDGE_OUTLIER`.

### Kansas City–Colorado F5 Under 6 at -4

- live ledger line: `6.0`, not `6.6`;
- standard American price: no;
- forensic formula result: `4 / (4 + 100) = 3.846%`;
- model: `61.1%`;
- recomputed edge: `57.254 pp`;
- the stored implied probability and edge are internally consistent with the invalid `-4` input;
- classification: `REJECT — INVALID_AMERICAN_ODDS, EDGE_OUTLIER`.

This proves the subtraction that calculates edge is not the primary defect. The invalid consensus price was produced upstream, accepted by S5C, and then treated as real American odds.

## Corrected line finding

The live export contains 139 F5-total records. Every line is on a whole-run or half-run increment:

```text
3.5, 4.0, 4.5, 5.0, 5.5, or 6.0
```

There are zero non-standard line increments in the export.

The apparent `4.4` and `6.6` came from a frontend formatting defect. The ledger already returns selections such as `OVER 4` and `UNDER 6`, while S6G appends the separate `line` field again. That can display as `OVER 4 4` and `UNDER 6 6`, visually resembling `4.4` and `6.6`.

## Frontend finding

The S6G focused view ranks a pending record using signal, analysis stage, confidence, time-to-start, and positive edge. It does not currently validate:

- American-odds domain;
- implied-probability arithmetic;
- edge arithmetic;
- source-price freshness;
- extreme-edge outliers.

It also appends `line` even when the selection text already contains the line.

That is why an invalid record can become visible in `Prioridad` and why valid whole-number totals can look duplicated.

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

The authenticated history view exposes `recordedAt`, but it does not expose the original market `capturedAt` field or the individual raw quotes used to create each consensus. Therefore price freshness and the exact two-book inputs cannot be proven from the history export alone.

No service token, password, browser cookie, Railway secret, or full production payload is stored in this branch or workflow.

## Phase 1 exit criteria

Phase 1 is complete when:

1. deterministic tests pass;
2. the read-only report generator produces JSON and Markdown evidence;
3. the consensus-price and S5C validation defects are documented;
4. an authenticated live export is audited without writing to the ledger;
5. every currently visible Priority/Waiting record is classified with explicit reasons.

All five items are satisfied. The PR remains draft because Phase 1 is diagnostic and must not deploy a runtime change.
