# S6H Phase 1 — Sanitized Live-Ledger Findings

Snapshot generated at `2026-07-31T22:01:38.615Z` from `mlb-ledger-history-view.v1`.

This document stores aggregate diagnostic evidence only. It does not contain browser cookies, credentials, raw provider payloads, or the complete private ledger export.

## Ledger summary

- total records: **336**;
- pending: **252**;
- settled: **84**;
- wins: **20**;
- losses: **29**;
- pushes: **35**;
- voids: **0**;
- reported win rate: **40.8%**;
- total staked units: **5**;
- total profit units: **0.0953**;
- ROI on staked records: **1.9%**.

Of the 84 settled records, 79 have `stakeUnits = 0`. These are shadow observations, so a loss may correctly show `0.00 u`. Only five settled records carry a one-unit stake.

## Structural integrity audit

Ignoring the history API's missing original `capturedAt` field:

- PASS: **225**;
- REVIEW: **77**;
- REJECT: **34**.

Strict evidence classification, which requires the original market capture timestamp:

- PASS: **0**;
- REVIEW: **302**;
- REJECT: **34**.

All 336 records expose `recordedAt`, but none expose the original market `capturedAt` field in the history view. This is an evidence-completeness issue, not proof that prices were stale.

## Arithmetic findings

Across all 336 records:

- implied-probability mismatches above 0.75 pp: **0**;
- edge-arithmetic mismatches above 0.75 pp: **0**;
- maximum absolute implied-probability rounding difference: **0.00496 pp**;
- maximum absolute edge rounding difference: **0.00496 pp**.

The stored implied probabilities and edges are internally consistent with the stored odds. The primary corruption occurs before those calculations, when invalid synthetic American prices are created and accepted.

## Invalid American prices

- invalid American-odds records: **34** of 336 (**10.1%**);
- every invalid record is `F5_TOTAL`;
- affected dates: 25 records on 2026-07-31 and 9 records on 2026-07-30;
- affected matchups: **6**;
- invalid values observed:
  - `-1`: 2;
  - `-2`: 4;
  - `-4`: 8;
  - `-5`: 6;
  - `-6`: 2;
  - `-8`: 1;
  - `-9`: 5;
  - `-11`: 1;
  - `-12`: 1;
  - `-15`: 4.

Affected matchup groups:

| Date | Matchup | F5 line | Invalid snapshots |
|---|---|---:|---:|
| 2026-07-30 | Seattle Mariners at Los Angeles Dodgers | 5.0 | 9 |
| 2026-07-31 | San Francisco Giants at San Diego Padres | 5.0 | 8 |
| 2026-07-31 | Milwaukee Brewers at Los Angeles Angels | 5.0 | 7 |
| 2026-07-31 | Kansas City Royals at Colorado Rockies | 6.0 | 7 |
| 2026-07-31 | Detroit Tigers at Athletics | 6.0 | 2 |
| 2026-07-31 | Boston Red Sox at Los Angeles Dodgers | 5.0 | 1 |

These values match the failure mode produced when the F5 consensus helper averages two opposite-signed American prices directly.

## Edge outliers

- records with recomputed edge greater than 15 pp: **111**;
- of those, 34 are caused by invalid American prices;
- the remaining **77** have standard American prices but still require model/source review.

A large edge with valid arithmetic is not automatically a software error. It is classified as REVIEW until model calibration and source lineage support it.

## Total-line verification

- F5-total records: **139**;
- non-standard whole/half-run increments: **0**;
- observed lines: `3.5`, `4.0`, `4.5`, `5.0`, `5.5`, and `6.0`.

The apparent `4.4` and `6.6` were not ledger values. The frontend displayed the line twice because `selection` already includes it and the card appended `line` again.

## Focus view at snapshot time

### Priority

| Matchup | Market | Price | Edge | Structural audit |
|---|---|---:|---:|---|
| Pittsburgh Pirates at Cincinnati Reds | Pittsburgh F5 ML | -145 | 6.52 pp | PASS |
| Washington Nationals at Atlanta Braves | Washington F5 ML | -125 | 8.44 pp | PASS |
| Philadelphia Phillies at Baltimore Orioles | Baltimore F5 ML | -120 | 22.85 pp | REVIEW — edge outlier |
| Kansas City Royals at Colorado Rockies | Under 6 F5 | -5 | 56.34 pp | REJECT — invalid American price |
| Texas Rangers at Houston Astros | Over 4 F5 | -124 | 23.14 pp | REVIEW — edge outlier |

### Waiting

| Matchup | Market | Price | Edge | Structural audit |
|---|---|---:|---:|---|
| Pittsburgh Pirates at Cincinnati Reds | Over 4 F5 | -127 | 19.15 pp | REVIEW — edge outlier |
| Pittsburgh Pirates at Cincinnati Reds | Over 3.5 F5 | -130 | 26.98 pp | REVIEW — edge outlier |
| St. Louis Cardinals at Toronto Blue Jays | Toronto F5 ML | -200 | 2.73 pp | PASS |
| St. Louis Cardinals at Toronto Blue Jays | Over 3.5 F5 | -152 | 3.88 pp | PASS |
| St. Louis Cardinals at Toronto Blue Jays | Under 4.5 F5 | -146 | 3.85 pp | PASS |
| Chicago White Sox at Tampa Bay Rays | Over 4.5 F5 | -118 | 15.57 pp | REVIEW — edge outlier |
| Miami Marlins at New York Mets | Miami F5 ML | -112 | 9.17 pp | PASS |
| Chicago White Sox at Tampa Bay Rays | Tampa Bay F5 ML | -145 | 8.82 pp | PASS |

All entries also require the history API to expose the original `capturedAt` value before price freshness can be certified.

## Phase 1 conclusion

The live evidence confirms three independent issues:

1. `/api/odds/mlb/f5` can synthesize invalid prices by averaging opposite-signed American odds for an even-sized consensus;
2. S5C does not reject American odds between `-99` and `+99`;
3. S6G does not apply an integrity gate before placing records in Priority and duplicates the total line in presentation.

The ledger remains immutable. Phase 1 made no runtime, deployment, Railway, worker, formula, settlement, or persistent-volume changes.
