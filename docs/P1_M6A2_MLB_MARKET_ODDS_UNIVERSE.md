# P1-M6A2 — Real MLB Market Availability and Quote Normalization

## Objective

P1-M6A2 converts current provider sportsbook evidence into the canonical P1-M6A1 MLB market contract without inventing prices, silently changing lines, or treating a reference consensus as an executable Hard Rock quote.

This phase is read-only. It does not write to the immutable ledger, change model probabilities, calculate an economic BET decision, place wagers, or create financial exposure.

## Provider evidence boundary

The Odds API v4 official market catalog documents the baseball period markets used here. Non-featured period markets are queried one event at a time through the event-odds endpoint. The API permits an explicit `bookmakers` parameter instead of `regions`, which prevents region-wide responses from silently changing the requested book set.

Provider documentation used for this contract:

- https://the-odds-api.com/liveapi/guides/v4/
- https://the-odds-api.com/sports-odds-data/betting-markets.html
- https://the-odds-api.com/liveapi/guides/v4/api-error-codes.html

## Requested provider markets

### Full game

- `h2h` → ML
- `spreads` → Run Line
- `totals` → Total
- `team_totals` → Home/Away Team Total

### First 5 innings

- `h2h_1st_5_innings` → F5 ML, only as the canonical two-way push-on-tie contract
- `spreads_1st_5_innings` → F5 Run Line
- `totals_1st_5_innings` → F5 Total
- `h2h_3_way_1st_5_innings` → alternate-contract evidence only

### First 3 innings

- `h2h_1st_3_innings` → F3 ML, only as the canonical two-way push-on-tie contract
- `spreads_1st_3_innings` → F3 Run Line
- `totals_1st_3_innings` → F3 Total
- `h2h_3_way_1st_3_innings` → alternate-contract evidence only

### First inning

- `h2h_1st_1_innings` → first-inning ML, only as the canonical two-way push-on-tie contract
- `h2h_3_way_1st_1_innings` → alternate-contract evidence only
- `totals_1st_1_innings` → NRFI/YRFI only when the exact paired line is 0.5. Under 0.5 maps to NRFI and Over 0.5 maps to YRFI.

## Markets intentionally not inferred

The provider catalog used for this phase does not document F3 or F5 Team Totals. P1-M6A2 therefore emits `UNAVAILABLE_FROM_PROVIDER` for `F3_TEAM_TOTAL` and `F5_TEAM_TOTAL`. A future exact manual or independently verified sportsbook quote may populate those canonical P1-M6A1 contracts, but this provider path will not fabricate them.

A first-inning total other than exactly 0.5 is not NRFI/YRFI and is classified as `CONTRACT_MISMATCH`.

A three-way period moneyline is not a two-way push-on-tie moneyline and is never converted into one.

## Execution versus reference books

Execution-book priority:

1. `hardrockbet_fl`
2. `hardrockbet`
3. `hardrockbet_az`

Reference-only books:

- `draftkings`
- `fanduel`
- `betmgm`

A reference consensus is analytical price evidence only. It can produce `REFERENCE_ONLY` but can never produce `EXECUTABLE`.

## Exact-line invariant

Run Lines, Totals and Team Totals are paired only when both opposing outcomes have the exact same contract line. Reference consensus groups quotes by exact paired line before calculating median implied-probability consensus. Prices from different lines are never averaged into a synthetic quote.

Examples that must remain different contracts:

- F3 Over 2.5 and F3 Over 3.0
- F5 Home -0.5 and F5 Home -1.0
- Home Team Total Over 4.5 and Over 5.0

## Price and freshness integrity

Only standard American odds accepted by `server/american-odds.ts` enter a normalized pair.

CourtEdge P1-M6A2 freshness policy: maximum quote age 5 minutes. The official additional-market feed may update more frequently, but the 5-minute threshold is a conservative CourtEdge execution policy, not a provider guarantee.

Statuses are separated into:

- execution source: `FRESH`, `STALE`, `UNKNOWN`, `INVALID`, `MISSING`
- reference source: same status vocabulary
- canonical availability: `EXECUTABLE`, `REFERENCE_ONLY`, `STALE_ONLY`, `CONTRACT_MISMATCH`, `INVALID_PRICE_OR_STRUCTURE`, `UNAVAILABLE_FROM_PROVIDER`

## Endpoint

`GET /api/mlb/p1/v1/market-universe-odds?date=YYYY-MM-DD`

The date uses the Florida slate convention. If omitted, the current Florida date is used.

The route:

- fetches the MLB event list;
- filters to the requested Florida date before any event-odds calls;
- caps one request at 20 events;
- fetches at most 3 event-odds responses concurrently;
- caches a successful slate for 60 seconds;
- does not cache a state where every eligible event request failed;
- returns provider failures instead of converting them into a naturally empty slate.

## Scientific invariants

1. No reference price is executable.
2. No stale or unknown-freshness execution quote is executable.
3. No different lines are averaged together.
4. No three-way market is coerced to two-way.
5. No F3/F5 Team Total is invented from a provider key that is not documented.
6. NRFI/YRFI require the exact first-inning 0.5 total contract.
7. Market support is not model support. P1-M6A3 must still build and validate horizon-specific probability engines.
8. This layer remains read-only with zero financial exposure.
