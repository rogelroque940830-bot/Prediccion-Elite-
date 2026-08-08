# P1-M2B Live FINAL Readiness Evidence — 2026-08-08

## Decision

The current P1-M2B gate **did not reach `READY_FINAL` in the live sample**, but it also did not block analysis. All six sampled market evaluations were `READY_PROVISIONAL`.

This is a source-integrity problem, not a reason to weaken the gate.

## Chain of custody

- deployed integration commit: `6c462a91fd4913d8704c488babd1448190cb5a5d`;
- runtime code equivalent to merged M3E.5 commit `9205dfc6567ead4e8b27b84f4440a370ab314a22`;
- temporary research PR: #394;
- workflow run: `31269202027`;
- aggregate artifact id: `9025079328`;
- artifact SHA-256: `fa74dcdfd82c11db4c7235299428db9a7739e11e317b9d21a277790406686472`.

The permanent evidence intentionally omits game IDs, teams, players and pitchers. The research runner performed public read-only requests only and deleted raw identities before artifact upload.

## Sample

The live August 8 slate contained 15 games. At audit time:

- 3 slate games were already `READY_TO_ANALYZE` at the official-lineup layer;
- 12 were still provisional at that layer;
- the three nearest analysis-allowed pregame games were sampled;
- both ML and F5_ML readiness were evaluated for each game;
- 6/6 readiness requests succeeded;
- 6/6 returned `READY_PROVISIONAL`;
- 0/6 returned `READY_FINAL`;
- 0/6 were `BLOCKED`.

Therefore predictor analysis remains available, but the scientific lifecycle cannot yet produce FINAL captures in the sampled conditions.

## What is now working

Several prior source-integrity repairs are confirmed live:

- `GAME_IDENTITY` was FRESH in all six evaluations;
- `PITCHERS` was FRESH in all six;
- `LINEUPS` was FRESH in all six sampled games;
- `MARKET_ODDS` was FRESH in all six;
- ML `BULLPEN` was FRESH in 3/3, with explicit timestamp provenance.

The old structural bullpen blocker is therefore resolved.

## ML blockers

All three sampled ML evaluations were `READY_PROVISIONAL` because:

1. `INJURIES` remained `DEGRADED` in 3/3; and
2. `ADVANCED_FACTORS` remained `DEGRADED` in 3/3.

The advanced-factor aggregate reported **0/5 certified components** in each sampled ML evaluation.

Most importantly, the audit exposed a concrete runtime defect in the advanced endpoint: the endpoint threw a reference error equivalent to **`getGameMeta is not defined`**. This is a code defect and should be fixed directly, not hidden by changing readiness policy.

Additional advanced components were either missing, degraded or lacked acceptable certification/timing on the sampled games, so repairing that single reference error is necessary but may not be sufficient for ML FINAL readiness.

## F5_ML blockers

All three sampled F5_ML evaluations had FRESH identity, pitchers, confirmed lineups and market odds, but remained provisional because:

- `INJURIES` was `DEGRADED` in 3/3;
- `PITCHER_FORM` had 2/2 underlying sources available but was classified `DERIVED_WITHOUT_EXPLICIT_TIMESTAMP` in 3/3;
- `LINEUP_MATCHUP` had its source available but was also `DERIVED_WITHOUT_EXPLICIT_TIMESTAMP` in 3/3.

This is an important distinction: F5 is not failing because those analytical endpoints are absent. They are available but do not yet carry temporal provenance strong enough to certify freshness.

The correct fix is to add truthful source timestamps and failure propagation from the underlying data acquisition, not to stamp request time onto an old or partially cached result.

## Injuries remain a cross-market constraint

`INJURIES_DEGRADED` occurred in all six evaluations, with partial source coverage on both sides of the sampled games.

Because injuries are a FINAL-only field for every market, even perfect ML advanced factors or perfect F5 pitcher-form/matchup provenance would still leave the sampled games provisional while injury coverage remains degraded.

The injury gate should remain strict. The next work must distinguish legitimate real-world coverage gaps from any remaining identity or source-mapping defects.

## Priority order

The evidence supports this implementation order:

1. **Fix the proven advanced endpoint runtime defect** (`getGameMeta` reference error).
2. Re-run advanced-factor certification on current games and identify any remaining component-specific failures.
3. Add truthful explicit temporal provenance to PITCHER_FORM.
4. Add truthful explicit temporal provenance to LINEUP_MATCHUP.
5. Continue injury source identity/coverage hardening independently.
6. Re-run the live M2B audit before claiming FINAL is attainable.

Do not lower `READY_FINAL` requirements to make the current sample pass.

## Relationship to M3E.5

The M3E.5 live owner cohort currently contains only 10 terminal interactive decisions across three dates, all `PROVISIONAL_ONLY`.

This audit explains why future evidence accumulation would continue to remain provisional under current source conditions even when official lineups are fully confirmed. Therefore improving legitimate FINAL source certification is a direct prerequisite to producing the lifecycle diversity M3E.5 ultimately needs.

## Safety

The research created:

- 0 predictions;
- 0 settlements;
- 0 bets;
- 0 financial exposure;
- 0 model changes;
- 0 threshold changes.

No operational or economic gate was changed.
