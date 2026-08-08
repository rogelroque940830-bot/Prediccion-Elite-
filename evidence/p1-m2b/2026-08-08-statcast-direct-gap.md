# P1-M2B Statcast DIRECT-gap evidence — 2026-08-08

## Result

Four real MLB pregame games were measured on deployed integration commit `97b4a9936df0dd735bea991a3018e52e32e974a5` under the unchanged August Statcast rules.

- All 8 lineup sides were confirmed.
- 3/8 sides already had 9/9 DIRECT coverage.
- Five decomposable non-DIRECT batters were not marginal misses: two were short by 2 qualifying pitch types and three were short by 3.
- No non-DIRECT batter was only one pitch type short.
- Adding 2025 evidence while preserving the same >=30-pitch per-type rule upgraded 0/5 batters, produced no additional 9/9 sides, and produced no game with 9/9 DIRECT on both sides.
- One separate side had zero starter arsenal pitch types; that is an arsenal-availability limitation rather than a batter DIRECT-coverage limitation.

## Interpretation

The current evidence does not justify lowering the >=30-pitch sample minimum, the >=60% opposing-arsenal coverage requirement, or the 9/9 DIRECT certification requirement. A prior-season batter fallback is also not supported: it did not close any of the measured gaps.

The correct behavior is therefore selective certification. Statcast should remain DEGRADED when the available evidence does not meet the existing strict eligibility boundary. This is a feature of an elite predictor: it must know when evidence is insufficient rather than manufacture confidence.

The zero-arsenal side is a separate research problem and should not be conflated with batter DIRECT coverage.

## Safety

Research was read-only and identity-free at the accepted artifact boundary. No model formula, threshold, prediction, settlement, bet or persistence behavior changed.
