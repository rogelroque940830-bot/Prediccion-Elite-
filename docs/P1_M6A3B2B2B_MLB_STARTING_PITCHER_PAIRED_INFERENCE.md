# P1-M6A3B2B2B — Paired date-cluster inference for the starting-pitcher challenger

## Purpose

B2B2B does not change the B2B2A starting-pitcher model, coefficients, folds, hyperparameters, run means or predictions. It quantifies uncertainty in the held-out per-game losses already produced by B2B2A.

The scientific question is evaluated with two separate paired comparisons on the same validation games:

1. `TEAM_ONLY_MINUS_PITCHER`: does adding the starting-pitcher feature improve on the team-only challenger?
2. `LEAGUE_NB2_MINUS_PITCHER`: does the combined model also remain competitive with the league NB2 baseline?

The first comparison is the primary incremental-pitcher question. The league comparison prevents a favorable result relative to a weak team-only comparator from being misread as broad predictive superiority.

## Dependence and resampling unit

Games played on the same official MLB date are not treated as independent bootstrap units. Per-game paired losses are grouped by `officialDate`, preserving all games from a date together. The certified P1-M6A3B2A deterministic date-cluster bootstrap is reused rather than introducing a second resampling method.

For each horizon, 5,000 deterministic paired bootstrap replicates are generated over official-date clusters. The report contains:

- an ordinary 95% paired interval; and
- a Bonferroni family-wise 98.75% interval, corresponding to alpha 0.05 divided across four horizons.

`FIRST_INNING`, `FIRST_3`, `FIRST_5` and `FULL_GAME` are tested separately.

## Point-estimate parity

B2B2B recomputes the mean paired differences directly from B2B2A `pairedRows`. Those values must agree with the aggregate B2B2A `teamMinusPitcherCountNll` and `leagueMinusPitcherCountNll` summaries. Every row must also satisfy its own arithmetic identity. Duplicate validation games fail closed.

This prevents the inference layer from silently analyzing a different loss sample from the point-estimate report.

## Evidence labels

For each comparison, the Bonferroni family-wise interval determines the evidence status:

- `SUPPORTED_IMPROVEMENT` only when the entire interval is above zero;
- `SUPPORTED_REGRESSION` only when the entire interval is below zero;
- `INCONCLUSIVE` when the interval crosses or touches zero;
- `INSUFFICIENT_OOS_SAMPLE` when there are fewer than the required official-date clusters.

Overall horizon status is deliberately conservative. Incremental support requires the **team-only minus pitcher** comparison to show supported improvement and the league comparison not to show supported regression. A supported loss versus team-only is classified as regression. Conflicting comparisons are retained as mixed evidence rather than collapsed into a positive label.

## Upstream integrity

B2B2B accepts only a B2B2A report whose rolling-origin leakage flag is true. The official research executor continues to fail closed unless both frozen sporting identities reproduce before modeling:

- P1-M6A3B1 canonical outcome digest;
- P1-M6A3B2B1 canonical starting-pitcher history digest.

The inference stage never fetches or substitutes new sporting outcomes on its own; it evaluates the same held-out losses produced from those certified inputs.

## Safety boundary

A statistically supported interval is research evidence, not permission to place a wager or promote a model. This stage keeps:

- `actionabilityAllowed=false`;
- `automaticModelSelectionAllowed=false`;
- `automaticPromotionAllowed=false`.

Even `SUPPORTED_INCREMENTAL_IMPROVEMENT` remains blocked by final P1-M6A3B model certification and subsequent market/economic validation. No live route, sportsbook, odds, ledger, settlement or economic-decision path is changed by B2B2B.
