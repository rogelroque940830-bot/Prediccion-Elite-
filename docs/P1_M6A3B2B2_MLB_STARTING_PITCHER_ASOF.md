# P1-M6A3B2B2 — MLB strict as-of starting-pitcher challenger

## Scientific question

B2B2 asks a narrower question than “does pitcher quality matter?”: **does information from a confirmed starting pitcher's earlier MLB starts improve out-of-sample run-distribution prediction beyond the already-tested team-only challenger, while preserving a league NB2 comparator?**

This stage is research-only. It cannot alter live predictions, recommendations, units, sportsbook prices, ledger records, settlements or economic decisions.

## Frozen inputs

A real run must independently reproduce both certified sporting identities before model evaluation:

- P1-M6A3B1 canonical 2025 outcome digest;
- P1-M6A3B2B1 canonical 2025 starter-history digest.

Provider/feed provenance is recorded separately. A sporting digest mismatch fails closed.

## Target-game identity versus target-game statistics

For a validation game, the confirmed/effective starter identity is required so the model knows **which pitcher is scheduled to start**. The target game's pitching line is never allowed to create that pitcher's strength feature.

Every pitcher snapshot uses an exclusive cutoff equal to the first date of the validation block. Only starter lines with `officialDate < cutoffDateExclusive` may enter the snapshot. Consequently:

- the target game's pitching line is excluded;
- every other game in the same validation block is excluded;
- later games are excluded;
- a pitcher's history can update the model only for future validation blocks.

The same rule is enforced in the inner hyperparameter-selection split.

## Starter feature

B2B2A intentionally begins with one auditable pitcher feature rather than a large hand-built score:

**earned runs per batter faced (ER/BF)** from previous starts.

For each as-of snapshot:

1. league starter ER/BF is calculated from all eligible earlier starter lines with positive batters faced;
2. each pitcher's ER/BF is empirically shrunk toward that league rate using a prior measured in batters faced;
3. the pitcher's shrunk rate divided by the league rate becomes a multiplicative `runRiskFactor`;
4. pitchers with no eligible prior history receive the neutral factor `1.0`.

Earned runs are used for the pitcher-specific feature so team defensive/error effects are not deliberately counted a second time on top of the B2A team defense factor.

## Prediction composition

B2B2A preserves the B2A team attack/defense mean as the base mean. The opponent starter's risk factor modifies that mean:

- home scoring mean is modified by the away starter;
- away scoring mean is modified by the home starter.

The risk factor is raised to a learned `pitcherEffectWeight` in `[0,1]`. The candidate grid includes **0**, so the selection procedure can explicitly choose the null hypothesis and collapse to the team-only prediction rather than being forced to use pitcher information.

## Nested selection

For every outer rolling-origin fold, the following parameters are selected only inside the outer training block:

- team shrinkage prior in games;
- pitcher shrinkage prior in batters faced;
- pitcher effect weight.

The default candidate grids are:

- team prior: `5, 10, 20, 40, 80` games;
- pitcher prior: `18, 36, 72, 144, 288` batters faced;
- pitcher effect: `0, 0.25, 0.5, 0.75, 1`.

The inner history block strictly precedes the inner validation block. When candidate NLLs are tied numerically, the tie-break is conservative: lower pitcher effect, then more pitcher shrinkage, then more team shrinkage.

## Three-way comparison

Each held-out game produces three count negative-log-likelihood values under the same NB2 dispersion estimated from outer training outcomes:

1. league NB2 baseline;
2. B2A-style team-only mean;
3. team + starting-pitcher mean.

The primary B2B2A point comparison is **team-only minus team+pitcher NLL**. League-minus-pitcher is reported independently so a pitcher model cannot look favorable only because the team comparator itself is weak.

Per-game paired losses are retained for the next inference stage.

## Horizon-specific learning

`FIRST_INNING`, `FIRST_3`, `FIRST_5`, and `FULL_GAME` are evaluated separately. Each horizon selects its own effect/shrinkage parameters. No fixed assumption is made that starter information should have the same weight in a first-inning market and a full-game market.

## What B2B2A can and cannot establish

A positive point estimate is **not** sufficient for promotion. B2B2A only establishes the leakage-safe challenger and held-out point losses.

P1-M6A3B2B2B must perform paired date-cluster uncertainty inference, preserving within-date dependence and correcting across the four horizons. Until then:

- `actionabilityAllowed=false`;
- `automaticModelSelectionAllowed=false`;
- `automaticPromotionAllowed=false`.

Even if the point estimate improves, the mandatory blocker remains `P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED`.
