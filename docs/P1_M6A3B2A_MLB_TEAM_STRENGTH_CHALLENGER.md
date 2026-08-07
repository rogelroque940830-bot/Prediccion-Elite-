# P1-M6A3B2A — MLB Team Attack/Defense Strength Challenger

## Purpose

P1-M6A3B2A is the first baseball-specific covariate challenger above the frozen P1-M6A3B1 2025 baseline. It asks one narrow empirical question:

> Does knowing **which teams are playing**, through historically available attack and defense evidence, improve held-out run-distribution performance beyond the league-wide NB2 baseline?

B2A does not yet include starting pitchers, confirmed lineups, bullpen availability, park, weather, injuries or sportsbook prices. Those are intentionally isolated into later incremental tests so that every source of improvement can be measured rather than assumed.

## Frozen comparison baseline

B2A must compare against the exact B1 Negative Binomial NB2 family that won the 2025 Poisson-vs-NB2 baseline study. The real B2A research runner must reproduce the frozen B1 dataset digest before evaluating the challenger:

`15827a9172824bb0863ab8c3ecd086184ada6a18fa99bbdee526a58f91aa8a4b`

If official-source reconstruction produces a different digest, B2A fails closed. It does not compare models across different samples.

## Canonical identity

Team identity is the official MLB `teamId` already carried by the B1 official-history dataset and by the P1-M1 authoritative daily slate. Team names are not used as model keys.

This keeps historical and live identity compatible without fuzzy name matching.

## Team-strength formulation

For each horizon and training sample, B2A estimates:

- league mean home runs;
- league mean away runs;
- each team's runs scored and runs allowed;
- each team's home and away exposure counts.

A team's raw attack and defensive-weakness ratios are shrunk toward `1.0` using a pseudo-game prior. The pseudo-games contribute league-average run volume, not an arbitrary team rating.

For team `t`:

- expected runs scored at league baseline account for how many training games the team played home vs away;
- expected runs allowed at league baseline use the opponent-side league means;
- attack factor = `(observed runs scored + prior league runs) / (expected league-baseline runs scored + prior league runs)`;
- defense-weakness factor = `(observed runs allowed + prior league runs) / (expected league-baseline runs allowed + prior league runs)`.

The predicted means for a future matchup are multiplicative:

- home mean = league home mean × home attack factor × away defense-weakness factor;
- away mean = league away mean × away attack factor × home defense-weakness factor.

An unseen team receives factor `1.0`; B2A never invents historical performance.

## Why the prior strength is not hand-picked

The default candidate grid is `5, 10, 20, 40, 80` pseudo-games.

For **each outer rolling-origin fold**, the selected prior is chosen using only an inner split contained inside that fold's training dates:

1. the final 14 training dates become an inner validation block;
2. all earlier training dates form the inner history;
3. each prior candidate is scored on inner held-out NB2 count negative log likelihood;
4. the lowest inner validation NLL wins;
5. exact numerical ties prefer the larger prior, which is the more conservative shrinkage choice.

The outer validation block is never used to select the prior.

## Distribution-family control

B2A does **not** change both the feature model and the distribution family simultaneously.

For every outer fold:

- the baseline is B1 NB2 with separate training home/away means;
- the challenger is team-specific means from B2A;
- both use the same NB2 home and away dispersion parameters fitted from that fold's training sample.

Therefore the primary outer comparison isolates the incremental value of team attack/defense information.

The B2A NB2 log-probability implementation is explicitly tested for numerical parity with the A3A NB2 PMF contract.

## Time boundary

Outer folds reuse the B1 expanding rolling-origin schedule. All training dates are strictly earlier than all validation dates.

The team-strength snapshot for an outer fold is frozen using only the outer training block. Outcomes from the outer validation block do not update the snapshot during that fold. This is deliberately conservative and makes the comparison with the frozen B1 fold baseline clean.

Same-day games cannot leak into one another because split membership is by unique official date.

## Metrics

Primary metric:

- held-out team-run count negative log likelihood.

Reported probability diagnostics:

- Home ML multiclass Brier;
- Home ML log loss;
- Home ML macro ECE;
- FIRST_INNING NRFI Brier/log loss/macro ECE.

These market-probability diagnostics use the A3A exact discrete run-distribution engine. They do not use sportsbook prices.

A horizon is labeled `OOS_IMPROVEMENT` only when the accumulated outer validation sample floor is met and challenger count NLL is lower than the same-fold B1 NB2 baseline.

That label is a research statement, not promotion.

## Falsification requirements

The B2A test suite must prove that:

- a synthetic population with real team attack/defense differences can beat the league-only baseline out of sample;
- an unseen team falls back to neutral factors rather than fabricated history;
- nested prior selection uses only inner training evidence;
- NB2 probability math matches A3A;
- insufficient evidence remains non-actionable;
- mixed horizons, malformed team identity and full-game tied final observations fail closed;
- no result can enable automatic model selection or promotion.

## Real 2025 research execution

The explicit research script re-downloads the official 2025 regular season, rebuilds B1, and first verifies the frozen B1 dataset digest. Only then does it execute B2A:

```bash
node --import tsx scripts/p1-m6a3b2a-team-strength-backtest.mjs \
  --start 2025-03-01 \
  --end 2025-10-01 \
  --out artifacts/p1-m6a3b2a-2025-team-strength
```

No normal application startup invokes this script.

## Safety boundary

P1-M6A3B2A has no live route and no automatic acquisition worker. It does not read sportsbook odds, write predictions or settlements, set units, change thresholds or touch the economic decision layer.

`actionabilityAllowed = false`.

`automaticModelSelectionAllowed = false`.

`automaticPromotionAllowed = false`.

Even a clean OOS improvement only justifies proceeding to the next controlled challenger.

## Next phase — P1-M6A3B2B

B2B will add **starting-pitcher information** with historical `asOf` boundaries and must prove incremental held-out value above B2A, not merely above the old league baseline.

Pitcher identity must remain MLB-ID based. Pitcher features must be constructed only from appearances/statistics that would have existed before the target game's start. Season-end pitching lines, later starts and postgame information are prohibited from historical feature construction.

Only after starting-pitcher evidence proves incremental value should lineup, bullpen, park/weather and other feature groups be tested in their own controlled additions.
