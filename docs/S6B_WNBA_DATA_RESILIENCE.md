# S6B WNBA Data Resilience

## Purpose

S6A identified the WNBA chain as blocked even though market prices, aggregate context, injuries, and fatigue were available. The required schedule route timed out, while SOS and player support routes also failed against the WNBA Stats hosts.

S6B repairs those three reads without changing prediction logic or creating shadow decisions.

## Route precedence

`registerWnbaS6bRoutes` is registered before the legacy WNBA/NHL route module. The public contracts remain unchanged:

- `GET /api/wnba/games`
- `GET /api/wnba/sos`
- `GET /api/wnba/players`

The legacy implementations remain registered for source compatibility but are not reached after an S6B response is sent.

## Schedule chain

1. Query both official WNBA/NBA Stats hosts in parallel with an eight-second bound.
2. Normalize `scoreboardV3` into the existing game contract.
3. When both hosts fail, query the ESPN read-only WNBA scoreboard feed.
4. When the direct source is valid but empty, compare the secondary feed and use it only if it contains scheduled games.
5. Attribute the response as either:
   - `wnba-stats-scoreboardV3`; or
   - `espn-readonly-fallback`.

The route now also has a working Florida-date default when `date` is omitted.

## SOS chain

1. Query season advanced stats, recent advanced stats, and the WNBA team game log through the bounded dual-host client.
2. Preserve the existing 40% season / 60% recent opponent blend.
3. If the direct calculation fails, use the configured read-only fallback:
   - `WNBA_READONLY_SOS_FALLBACK_URL`; or
   - the existing production read-only endpoint by default.
4. Reject empty, malformed, or recursive fallback responses.
5. Mark fallback output as `production-readonly-fallback`.

## Player chain

1. Query WNBA player per-game statistics through the bounded dual-host client.
2. Preserve the existing eligibility rule of at least five games and five minutes per game.
3. Preserve the existing team-keyed roster contract and minutes-based ordering.
4. If the direct source fails, use `WNBA_READONLY_PLAYERS_FALLBACK_URL` or the existing production read-only endpoint.
5. Reject empty, malformed, or recursive fallback responses.

## S6A interpretation

S6A recognizes any source containing `fallback` as degraded. A valid fallback therefore cannot be silently classified as healthy. On an active priced slate:

- valid schedule/context/odds plus fallback support produces `DEGRADED`;
- a required source failure still produces `BLOCKED`;
- no scheduled games remains `NO_GAMES`.

## Safety invariants

S6B is read-only and does not:

- create predictions;
- place bets;
- connect to a sportsbook;
- write to production stores;
- change formulas, filters, markets, probabilities, thresholds, or stake policy;
- promote any sport automatically.

## Validation

Focused tests cover:

- direct WNBA scoreboard success;
- ESPN schedule normalization after dual-host failure;
- default-date route behavior;
- direct SOS and player contract preservation;
- attributed SOS and player fallbacks;
- invalid fallback rejection;
- recursive fallback rejection.

The final Railway certification must verify the exact merge SHA, a post-deploy S6A audit, protected readiness details, zero predictions, zero exposure, and a WNBA state other than `BLOCKED` when a priced slate is available.
