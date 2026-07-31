# S6H Phase 3 — Backend Market Integrity and Provenance

## Objective

Stop synthetic near-zero American prices at their source, preserve verifiable quote lineage, and prevent S5C from writing an invalid price to the immutable MLB ledger.

This phase does not change model probabilities, recommendation thresholds, signals, stake policy, settlement, Railway configuration, or historical ledger rows.

## Confirmed defect

The legacy F5 endpoint calculated an even-count median by averaging the two middle **American prices** directly.

Example:

```text
-110 and +100
(-110 + 100) / 2 = -5
```

`-5` is not valid American odds. It was later converted to an implied probability near 4.76%, producing a false extreme edge.

## New consensus method

The protected F5 route uses `median_implied_probability`:

1. reject non-standard prices before aggregation;
2. convert each valid American price to implied probability;
3. compute the median in probability space;
4. convert the consensus probability back to standard American odds.

Examples:

| Inputs | Direct price average | Protected consensus |
|---|---:|---:|
| `-110`, `+100` | `-5` invalid | approximately `-105` |
| `-120`, `+105` | `-8` invalid | standard price near `-109` |
| `-105`, `-115` | `-110` | `-110` |

The implementation never averages opposite-signed American prices directly.

## Line integrity

Spread and total prices are no longer combined across different lines.

The route:

1. groups paired sportsbook quotes by the exact posted line;
2. selects the line supported by the greatest number of books;
3. uses distance from the slate median only as a deterministic tie-breaker;
4. calculates the probability-space price consensus using quotes from that selected line only.

This prevents, for example, a price at total `5.0` from being combined with a price at total `5.5`.

## Route precedence

`registerMlbF5OddsProtectionRoutes(app)` is registered before the legacy market-support routes.

The protected handler uses `app.use` for the exact GET path so the existing route-contract inventory remains unchanged. The legacy implementation remains in source for compatibility but is not reached for `/api/odds/mlb/f5` after this phase.

## Response contract

The protected endpoint returns the backward-compatible fields consumed by S5C:

- `f5Ml.home` / `f5Ml.away`;
- `f5Spread.line`, `homeOdds`, `awayOdds`;
- `f5Total.line`, `overOdds`, `underOdds`;
- source and book count fields.

It also adds:

- `schemaVersion = mlb-f5-odds-consensus.v2`;
- `consensusMethod = median_implied_probability`;
- route `capturedAt`;
- provider `last_update` evidence;
- requested and contributing books;
- accepted/rejected raw quote records;
- selected-line quote records;
- event ID and provider identity.

No API keys or secrets are included in the response or ledger.

## S5C fail-closed behavior

S5C now accepts a price only when its rounded absolute value is at least 100 and no greater than 100,000.

Therefore all values between `-99` and `+99`, including zero, are rejected:

```text
-15, -9, -8, -6, -5, -4, -2, -1, 0, +1 ... +99
```

When a directional model decision exists but its quote is invalid, S5C retains an unpriced diagnostic observation and does not create a priced ledger record.

## Ledger provenance

For each new priced S5C record, the immutable payload now stores:

- original route capture time;
- provider last-update time when available;
- consensus method;
- contributing books;
- raw quote provenance;
- selected market and line;
- confirmation that standard American-odds validation passed.

The market's `capturedAt` uses the odds-route capture time. The ingestion run time is used only as an explicit fallback, with a warning in the payload.

The history view exposes a compact safe subset:

- `priceCapturedAt`;
- `providerLastUpdate`;
- `consensusMethod`;
- `priceContributingBooks`;
- `standardAmericanOddsValidated`.

Raw provider quote arrays remain inside the private immutable payload and are not expanded into every history row.

## Historical records

The 34 previously identified invalid records remain unchanged as evidence. Phase 2 continues to label them `NO UTILIZAR` and exclude them from Priority and Waiting.

Phase 3 applies only to newly fetched quotes and newly appended records.

## Validation

Automated tests cover:

- opposite-signed American prices;
- same-signed American prices;
- standard-domain boundaries at `-100` and `+100`;
- rejection of every synthetic near-zero price;
- provider raw-quote preservation;
- line grouping before price consensus;
- S5C provenance persistence;
- ledger-history provenance exposure;
- route registration precedence;
- modular route-contract preservation;
- production backend bundle creation.

## Deployment boundary

Only the backend branch `integration/p0-staging-secure` is targeted. No manual Railway setting change is required.

After deployment, verification must confirm:

1. `/api/odds/mlb/f5` reports schema v2 and probability-space consensus;
2. every non-null returned American price is `<= -100` or `>= +100`;
3. newly generated S5C records expose capture provenance;
4. no new `F5_TOTAL` record enters the ledger with a near-zero price;
5. the frontend, session, volume, workers, settlement, and existing historical records remain operational.
