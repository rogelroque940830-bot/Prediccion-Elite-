# P1-M2B Advanced Route Runtime Repair

## Evidence basis

Live P1-M2B readiness research on 2026-08-08 found all three sampled ML evaluations `READY_PROVISIONAL` with `ADVANCED_FACTORS_DEGRADED`. The aggregate advanced-factor evidence exposed a concrete runtime error from `GET /api/mlb/advanced/:gamePk`: `getGameMeta is not defined`.

Inspection traced the defect to S3 backend modularization. The advanced route was extracted from the former monolithic route file into `market-support-routes.ts`, but two dependencies remained local to the MLB core module and were not carried with the extracted route:

- the doubleheader-safe `getGameMeta(gamePk)` helper;
- the dynamic `MLB_SEASON_CURRENT` value used for probable-pitcher season statistics.

The first missing identifier caused the observed live failure before the second one could be reached.

## Repair

This package restores exactly those runtime dependencies inside the extracted market-support module.

`getGameMeta` preserves the established MLB `feed/live` semantics keyed directly by `gamePk`, rather than using schedule metadata that can mix probable pitchers between doubleheader games. The reconstructed object retains venue, weather, probable-pitcher identity and lineup data needed by the advanced route.

`MLB_SEASON_CURRENT` remains dynamic from the current UTC runtime year; no season value is hard-coded.

No advanced-factor formula, park factor, weather adjustment, opener adjustment, probability, recommendation threshold or betting behavior changes.

## Typecheck debt exposed by the repair

The new focused TypeScript gate initially failed on two pre-existing `TS1117` duplicate-object-key errors in `PARK_FACTORS`: numeric keys `32` and `19` each appeared twice in the same object literal.

Those earlier entries were already unreachable at runtime because JavaScript object-literal semantics keep the later property for the same key. The cleanup therefore removes only the two shadowed earlier entries and preserves the exact effective values that existed before this PR:

- key `19` remains `Coors Field` with run factor `115`;
- key `32` remains `American Family Fld` with run factor `100`.

The regression test asserts those effective values explicitly. This is compiler hygiene only; it does not reinterpret venue identities or change any park-factor value that the running application could previously observe.

## Regression protection

The focused runtime test registers the actual market-support route and invokes `/api/mlb/advanced/:gamePk` with deterministic mocked MLB responses. It proves the route reaches all of the formerly broken dependencies:

1. `v1.1/game/{gamePk}/feed/live` metadata;
2. venue roof metadata;
3. both probable-pitcher season-stat requests using the dynamic current season;
4. successful advanced response generation without either missing-identifier error.

The same test also proves the duplicate-key cleanup preserves the effective park-factor values for keys `19` and `32`.

A dedicated TypeScript configuration now includes `market-support-routes.ts`. This closes the prior S3 verification gap where the production bundle could contain an unresolved identifier because the route module was not part of the focused typecheck.

## Safety

This is a source/runtime integrity repair only. It performs no ledger write, settlement write, sportsbook call, stake change, probability change, threshold change, automatic bet, automatic model change or automatic promotion.

After merge and deployment, live P1-M2B readiness must be re-audited. Successful repair of this endpoint alone does not imply all five advanced components are certified or that ML can reach `READY_FINAL`; the evidence already identified additional source-certification constraints that must remain fail-closed.
