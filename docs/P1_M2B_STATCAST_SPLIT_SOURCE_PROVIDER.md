# P1-M2B Statcast Split-Source Certifier Semantics

## Evidence basis

Permanent evidence #414 showed that Phase 2 source alignment still failed exact starter xwOBA reproduction in a game with confirmed lineups and 9/9 DIRECT on both sides.

The remaining semantic difference was the population used for TEAM_PROXY fallback inside a final DIRECT batter row:

- engine DIRECT evidence uses the official Inclusive Savant batter source;
- engine TEAM_PROXY aggregation uses the historical Qualified Savant batter source;
- Phase 2 certifier received the Inclusive source for both DIRECT rows and its internal team aggregation.

A final visible `DIRECT` label does not mean every pitch type used direct data. The xwOBA calculation can still use TEAM_PROXY values for pitch types below the direct-sample threshold, so the population used for team aggregation must also match the engine exactly.

## Parity proof

Permanent evidence #416 compared Qualified and Inclusive Savant rows for 2026 and 2025:

- 1,747/1,747 Qualified player/pitch-type rows were present in Inclusive;
- zero numerical mismatches were found in team, pitches, PA, xwOBA, wOBA, whiff percentage or run value per 100.

Therefore Qualified eligibility can be represented as a mask over the Inclusive source without altering any overlapping value.

## Implementation

The existing Phase 2 successor remains the route owner and the historical B5/B5B certifier remains unchanged.

For each Savant batter request made by the strict certifier, the aligned fetch now retrieves two official CSVs in parallel:

1. Inclusive (`minPitches=1`) — supplies all rows available for individual DIRECT evidence.
2. Qualified (`minPitches=q`) — supplies the eligibility set for TEAM_PROXY aggregation.

The returned synthetic CSV starts from the Inclusive rows. `team_name_alt` is preserved only for rows whose exact `(player_id, pitch_type, team_name_alt)` key also exists in the Qualified source. Inclusive-only rows remain fully present, with all numerical fields unchanged, but receive an empty team field.

This works with the unchanged B5B provider because:

- individual DIRECT lookup groups rows by `playerId` and does not require the team field;
- TEAM_PROXY aggregation explicitly skips rows without a team;
- Qualified overlap values are proven identical to Inclusive values.

Pitcher Savant acquisition remains Qualified. Non-Savant traffic is unchanged.

## Fail-closed behavior

If either Inclusive or Qualified batter source fails, the aligned fetch returns the failed response rather than treating Inclusive-only rows as proxy-eligible. The strict certifier therefore remains degraded rather than fabricating a fallback population.

## Performance boundary

The historical certifier itself is not replaced and its existing certification cache remains active. This avoids the upstream cost of injecting a custom provider, which would bypass B5B's cache path.

## Frozen scientific rules

This successor changes no:

- current-lineup confirmation rule;
- 9/9 DIRECT requirement;
- August >=30 pitches threshold;
- >=60% opposing-arsenal coverage requirement;
- xwOBA or run-delta formulas;
- starter, bullpen or combined reproduction tolerances;
- 50/25/25 run-delta weights;
- model probability, recommendation threshold or stake;
- ledger, settlement, sportsbook or automatic promotion behavior.

Post-deploy live research must again demonstrate strict CERTIFIED status; no certification is assumed from the source change itself.
