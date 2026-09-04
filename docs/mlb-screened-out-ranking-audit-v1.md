# MLB screened-out ranking audit v1

## Purpose

Make the whole-slate production card identify the exact analysis-eligible game(s) that were evaluated but did not enter the intrinsic ranking population.

## Production truth

The preprice sequence is:

1. Cheap screen evaluates every analysis-eligible pregame game.
2. Shortlist qualification requires at least one non-zero native run signal from a certified component.
3. `qualifiedForShortlist = independentSignalCount > 0`.
4. Intrinsic population is built only from qualified shortlist candidates.
5. Daily Opportunity re-ranks that intrinsic population for whole-slate context.

Therefore, an analysis-eligible game that is absent from `rankedGamePks` failed the existing shortlist qualification rule in that snapshot. This audit does not change that rule or force the game into the ranking.

## UI behavior

When `Slate evaluado > Competidores ranking`, the Daily BEST PICK card now lists each excluded matchup and states the exact qualification boundary:

`AT_LEAST_ONE_NONZERO_NATIVE_RUN_SIGNAL_FROM_CERTIFIED_COMPONENT`

This is observability only.

## Boundaries unchanged

- no model coefficients;
- no thresholds or weights;
- no route hierarchy;
- no odds/EV behavior;
- no provider call expansion;
- no automatic betting;
- no forced pick.
