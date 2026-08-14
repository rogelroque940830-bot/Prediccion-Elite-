# S6F — MLB Review Priority

## Objective

Reduce user-facing MLB slate overload without reducing scientific coverage.

## Boundary

The backend continues to inspect the complete official MLB slate through S5C. S6F changes only the presentation and review order in the MLB predictor.

## Pregame queue

Before a model evaluation exists, games are classified only from evidence already returned by `/api/mlb/all`:

- `Prioridad`: game is still pregame, both teams are identified and both probable pitchers are identified.
- `Pendientes`: game is still pregame but one or both probable pitchers are missing.
- `Todos`: complete returned slate, with started/closed entries visible but disabled for new pregame selection.

`Prioridad` does not mean positive expected value or a betting recommendation. It means the game is ready to be analyzed.

## Post-evaluation decision

After the existing predictor completes its calculation, S6F reads the existing per-market Pick Quality results without changing them:

- `Prioridad alta para revisión`: at least one existing `BET` or `BET_FUERTE` result has positive edge and no recorded veto.
- `Revisión secundaria`: at least one existing `LEAN` has positive edge and no stronger qualifying result exists.
- `Descartar por ahora`: the markets are `PASS`, non-positive, or vetoed.

## Safety

S6F does not change:

- model formulas or probabilities;
- filters or veto rules;
- supported markets or thresholds;
- stake policy;
- S5C/S5E/S5F workers;
- ledger records or settlement;
- sportsbook integration or wager placement.

The scientific worker still discovers every official game, applies its existing eligibility checks, and records shadow decisions with stake and exposure equal to zero.
