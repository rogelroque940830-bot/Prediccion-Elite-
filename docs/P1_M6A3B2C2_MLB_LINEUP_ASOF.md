# P1-M6A3B2C2 — MLB T-5 Lineup Incremental Challenger

## Objective

B2C2 asks one narrow question: **does the identity of the nine official batters available at T-5 add incremental out-of-sample run-prediction value beyond the existing team-only NB2 challenger?**

B2C2 is research only. It does not change the production probability formula, choose a market, generate a pick, write a ledger record, authorize a wager or promote a model automatically.

## Certified upstream source

The target lineup source is the certified B2C1 v4 historical source:

`statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4`

B2C1 certified 2,423 of the frozen 2,430 MLB 2025 regular-season finals at T-5. Seven fail-closed exceptions remain missing evidence and are never imputed from a final boxscore or later snapshot.

B2C2 must reproduce before modeling:

- the frozen B1 2025 outcome digest;
- exactly 2,430 official regular-season final games;
- the B2C1 canonical lineup-history digest;
- exactly 2,423 certified complete lineup games;
- the exact digest of the certified `gamePk` set.

Provider-provenance drift is recorded separately. Canonical sporting identity, not incidental provider metadata, is the research cohort contract.

## Challenger definition

The baseline comparator is the existing team-only NB2 attack/defense shrinkage model. The previously studied starting-pitcher challenger is **not** automatically included because its paired evidence was inconclusive.

The B2C2 challenger adds a lineup-composition factor to each team-only expected run mean.

For each historical batter, using only certified lineup games strictly before the relevant cutoff date, B2C2 aggregates:

- games in which the player appeared in the certified starting nine;
- the team runs observed in those games for the requested horizon;
- the team-only expected runs for those games.

A shrunk residual run factor is then estimated:

`(observed team runs + prior runs) / (team-only expected runs + prior runs)`

where the prior is centered at the league run mean. This quantity is a **historical residual association**, not a causal batting-value estimate and not a claim about an individual player's true talent.

## Current-lineup factor

For a target game, the home and away lineup factors are the geometric means of the nine batter residual factors. A batter unseen in the prior history receives the neutral factor `1.0`; future information is never substituted.

The challenger mean is:

`team-only mean × lineup factor ^ lineupEffectWeight`

The lineup-effect grid includes `0`. Therefore nested model selection can explicitly choose **no lineup effect** when lineup composition does not improve inner validation NLL.

B2C2 v1 deliberately tests starting-nine **identity composition**. It does not introduce batting-order-position weights, handedness interactions, projected substitutions, injury inference or final-boxscore information. Those would require separate hypotheses and separate falsification.

## No-lookahead design

Every outer rolling-origin fold requires:

- `trainingMaxDate < validationMinDate`;
- the lineup-player history maximum date to be strictly earlier than validation;
- all hyperparameter selection to occur inside the outer training sample;
- the inner lineup-history maximum date to be strictly earlier than inner validation.

Hyperparameters are selected jointly inside training only:

- team prior games: `5, 10, 20, 40, 80`;
- player prior lineup games: `5, 10, 20, 40, 80`;
- lineup effect weight: `0, 0.25, 0.5, 0.75, 1`.

Ties choose the more conservative configuration: lower lineup effect first, then stronger player shrinkage, then stronger team shrinkage.

## Missing lineup evidence

Only B2C1 snapshots with `availability=COMPLETE`, `complete=true`, correct game/team identity and two unique nine-player batting orders may enter a target comparison.

A validation game without certified lineup evidence is excluded from **both** the team-only and lineup NLL in the paired B2C2 comparison. This preserves paired comparability. The game remains part of the frozen B1 sporting cohort but not the lineup-comparable validation subset.

Historical games without certified lineup evidence likewise do not contribute to batter residual factors. Their outcomes may still contribute to the team-only training model because those outcomes were independently certified by B1.

## Primary metric and paired inference

The primary model metric is mean count negative log-likelihood under the same NB2 marginal run framework used by the prior challengers.

For every certified validation game B2C2 records paired values for:

- league NB2;
- team-only NB2;
- team plus lineup;
- `TEAM_ONLY_MINUS_LINEUP` count NLL;
- `LEAGUE_NB2_MINUS_LINEUP` count NLL.

Point estimates alone are not promotion evidence. B2C2B aggregates paired deltas by official date and applies deterministic paired date-cluster bootstrap inference:

- 5,000 bootstrap replicates;
- minimum 30 official-date clusters;
- ordinary 95% intervals;
- Bonferroni family-wise 98.75% intervals across four horizons.

A positive point estimate means the lineup challenger has lower NLL; it is not sufficient by itself. Supported incremental improvement requires the family-wise `TEAM_ONLY_MINUS_LINEUP` interval to remain above zero and no contradictory supported regression versus league NB2.

## Horizons

The same four frozen research horizons are evaluated independently:

- `FIRST_INNING`
- `FIRST_3`
- `FIRST_5`
- `FULL_GAME`

A result may differ by horizon. B2C2 remains free to conclude improvement, regression, mixed evidence or inconclusive evidence.

## Interpretation boundary

If B2C2 is inconclusive, that does **not** establish that MLB lineups are generally unimportant. It means this specific starting-nine residual-factor formulation did not establish supported incremental value on the frozen 2025 cohort under the certified OOS procedure.

If B2C2 supports improvement, that still does not authorize production promotion. It would establish research evidence for this exact challenger and require a later final-model certification decision.

## Safety boundary

B2C2 and B2C2B retain:

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`

No odds, sportsbook integration, live route registration, settlement logic, ledger writes or real-financial-exposure behavior is modified by this research stage.
