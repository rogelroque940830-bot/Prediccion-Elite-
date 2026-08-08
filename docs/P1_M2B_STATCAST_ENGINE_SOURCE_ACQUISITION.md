# P1-M2B Phase 1 — Statcast Engine Source Acquisition

## Evidence basis

Permanent evidence #407 isolated the remaining Statcast Matchup blocker after M2B reached 4/5 advanced certification.

The live engine had confirmed lineups, starter arsenals, bullpen coverage and successful batter-history queries, but not all lineup batters had DIRECT pitch-type evidence. Research #406 then showed that the production Savant query used unsupported snake_case parameter names. With official Baseball Savant parameters, an inclusive batter source expanded the measured dataset from 895 rows / 356 players to 4,979 rows / 622 players.

Crucially, the experiment did not lower the model's internal August requirement: DIRECT still requires at least 30 pitches for a pitch type and coverage of at least 60% of the opposing starter arsenal.

## Phase 1 design

This phase changes **engine acquisition only**. The strict Statcast certifier is intentionally not modified.

### DIRECT batter source

Individual batter evidence now uses the official Savant pitch-arsenal parameter names with inclusive source acquisition:

- `min=1`
- `minPitches=1`
- `pitchType=`
- `type=batter`

Rows below the engine's existing internal `minPitches` threshold remain unusable by `analyzeBatter()`. The broader source therefore supplies candidates; it does not redefine what counts as DIRECT evidence.

### TEAM_PROXY source

TEAM_PROXY aggregation remains on a separate **Qualified** Savant batter source (`minPitches=q`). This preserves the historical team-proxy population instead of silently changing proxy values while increasing individual DIRECT coverage.

### Pitcher source

Pitcher Savant acquisition remains Qualified, but URL construction now uses the official parameter names. This makes the request explicit and reproducible rather than depending on ignored legacy parameters/default UI behavior.

## Shared source constructor

`mlb-statcast-savant-source.ts` centralizes official pitch-arsenal URL construction. Phase 2 can reuse the same constructor when the strict certifier is aligned, preventing future motor↔certifier URL drift.

## Frozen scientific boundaries

This phase does not change:

- the 9/9 DIRECT B5A/B5B certification requirement;
- August `minPitches=30`;
- the 60% opposing-arsenal DIRECT rule;
- TEAM_PROXY minimums;
- xwOBA formulas;
- recent-form weighting;
- vs-pitcher weighting;
- bullpen selection or weighting;
- combined 50% starter / 25% bullpen / 25% historical run-delta weights;
- model probabilities, thresholds, stakes or recommendations;
- the strict Statcast certifier.

Because the certifier remains on its prior acquisition path, this Phase 1 change **must not create Statcast certification by itself**. Post-deploy research must measure engine DIRECT coverage and numerical stability before a separate certifier-alignment successor is considered.

## Fail-closed expectation

Some games still will not have 9/9 DIRECT evidence even with the inclusive source. Those games remain legitimately uncertifiable. The objective is to remove an unnecessary source-side Qualified filter, not to force 5/5 advanced readiness.
