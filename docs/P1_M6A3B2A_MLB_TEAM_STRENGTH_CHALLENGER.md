# P1-M6A3B2A — MLB Team Attack/Defense Strength Challenger

## Purpose

P1-M6A3B2A is the first baseball-specific covariate challenger above the frozen P1-M6A3B1 2025 baseline. It asks one narrow empirical question:

> Does knowing **which teams are playing**, through historically available attack and defense evidence, improve held-out run-distribution performance beyond the league-wide NB2 baseline?

B2A does not yet include starting pitchers, confirmed lineups, bullpen availability, park, weather, injuries or sportsbook prices. Those are intentionally isolated into later incremental tests so that every source of improvement can be measured rather than assumed.

## Frozen comparison baseline

B2A must compare against the exact B1 Negative Binomial NB2 family that won the 2025 Poisson-vs-NB2 baseline study, on the exact same **canonical outcome sample**.

The frozen B1 `outcomeDigest` is:

`c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d`

The research runner re-downloads official MLB history and must reproduce this `outcomeDigest` before evaluating the challenger. It also checks the frozen observation count for every horizon.

Raw MLB payload provenance is audited separately through `sourceProvenanceDigest` and the legacy acquisition-snapshot `datasetDigest`. Those provider fingerprints are allowed to change when MLB revises non-outcome metadata; they cannot substitute for outcome identity.

This distinction was forced by an observed real-world provider-drift event: two independent 2025 acquisitions had 0 differences across 2,430 final scores and inning-by-inning results, while raw feed digests changed for 1,048 games. The B1 evidence record preserves that audit.

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

## Point metric and paired uncertainty

The primary point metric remains held-out team-run count negative log likelihood. Positive `baseline - challenger` means the challenger has lower NLL.

A positive point estimate alone is **not** sufficient evidence of improvement. MLB games from the same calendar date share league environment and other common context, so treating every team-run observation as independent would understate uncertainty.

B2A therefore performs a second, mandatory paired inference layer:

1. for each held-out game, baseline and challenger are evaluated on the same observation;
2. their count-NLL difference is aggregated by `officialDate`;
3. complete dates are the bootstrap clusters;
4. dates are sampled with replacement using a deterministic seed derived from the exact horizon evidence;
5. the default run uses 5,000 bootstrap replicates;
6. an ordinary paired 95% percentile interval is reported;
7. a Bonferroni family-wise interval is also reported across the four simultaneously tested horizons. With family alpha `0.05`, each horizon uses alpha `0.0125`, producing a **98.75%** two-sided interval.

The adjusted interval controls the research evidence label:

- `SUPPORTED_IMPROVEMENT` only if the 98.75% lower bound is strictly above zero;
- `SUPPORTED_REGRESSION` only if the 98.75% upper bound is strictly below zero;
- `INCONCLUSIVE` if the adjusted interval contains zero;
- `INSUFFICIENT_OOS_SAMPLE` before inference when validation-game or date-cluster floors are not met.

The original B2A point-status field is retained only for backward audit continuity and is printed as `legacyPointStatus` by the research runner. Scientific interpretation must use `pairedEvidenceStatus`.

## Probability diagnostics

Reported probability diagnostics remain:

- Home ML multiclass Brier;
- Home ML log loss;
- Home ML macro ECE;
- FIRST_INNING NRFI Brier/log loss/macro ECE.

These market-probability diagnostics use the A3A exact discrete run-distribution engine. They do not use sportsbook prices.

They are secondary diagnostics. B2A does not infer sportsbook edge from them.

## Falsification requirements

The B2A test suite must prove that:

- a synthetic population with strong team attack/defense differences can clear the **family-wise paired interval**, not merely produce a positive point estimate;
- homogeneous team evidence can never become `SUPPORTED_IMPROVEMENT`; if estimating team factors adds stable noise it may correctly become `SUPPORTED_REGRESSION`, otherwise it remains `INCONCLUSIVE`;
- the paired bootstrap is deterministic for identical evidence;
- the Bonferroni interval is never narrower than the unadjusted 95% interval;
- an unseen team falls back to neutral factors rather than fabricated history;
- nested prior selection uses only inner training evidence;
- NB2 probability math matches A3A;
- insufficient evidence remains non-actionable;
- mixed horizons, malformed team identity and full-game tied final observations fail closed;
- no result can enable automatic model selection or promotion.

## Real 2025 research execution

The explicit research script re-downloads the official 2025 regular season, rebuilds B1, and first verifies the frozen B1 `outcomeDigest`. Only then does it execute B2A and the paired date-cluster inference:

```bash
node --import tsx scripts/p1-m6a3b2a-team-strength-backtest.mjs \
  --start 2025-03-01 \
  --end 2025-10-01 \
  --out artifacts/p1-m6a3b2a-2025-team-strength
```

The output preserves both provider-provenance fingerprints and the stable outcome identity. A provenance-only drift does not invalidate an outcome-identical sample; a changed `outcomeDigest` does.

No normal application startup invokes this script.

## Safety boundary

P1-M6A3B2A has no live route and no automatic acquisition worker. It does not read sportsbook odds, write predictions or settlements, set units, change thresholds or touch the economic decision layer.

`actionabilityAllowed = false`.

`automaticModelSelectionAllowed = false`.

`automaticPromotionAllowed = false`.

Even `SUPPORTED_IMPROVEMENT` only justifies proceeding to the next controlled challenger.

## Next phase — P1-M6A3B2B

B2B will add **starting-pitcher information** with historical `asOf` boundaries and must prove incremental held-out value above the strongest justified B2A comparator, not merely above the old league baseline.

Pitcher identity must remain MLB-ID based. Pitcher features must be constructed only from appearances/statistics that would have existed before the target game's start. Season-end pitching lines, later starts and postgame information are prohibited from historical feature construction.

Only after starting-pitcher evidence proves incremental value should lineup, bullpen, park/weather and other feature groups be tested in their own controlled additions.
