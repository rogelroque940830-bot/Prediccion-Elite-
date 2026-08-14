# P1-M3E.2 MLB Operating Envelope Stability

## Purpose

P1-M3E.2 is a research-only successor to P1-M3E. It asks a stricter question than a single discovery/confirmation split:

> Can a bounded, pregame-identifiable rule discovered on early decisions retain superior model quality through **two untouched later chronological holdouts**?

The module does not alter predictions, thresholds, classifications, stakes, or sportsbook behavior. It does not promote any historical subgroup into an operational betting rule.

## Why this exists

P1-M3E already established the correct direction: learn where the existing predictor is unusually reliable instead of forcing more predictions or adding features because of recent outcomes. A single chronological holdout is materially safer than in-sample optimization, but it can still be fragile to one time boundary.

P1-M3E.2 therefore adds a three-way temporal protocol:

1. **Discovery — first 50% of eligible dates.** Candidate rules may compete only here.
2. **Validation — next 25% of eligible dates.** The selected discovery rule is frozen before these outcomes are evaluated.
3. **Confirmation — final 25% of eligible dates.** The same frozen rule must survive again. No reselection is permitted after validation.

The ordering must satisfy `discovery.maxDate < validation.minDate < confirmation.minDate`.

## Frozen candidate language

P1-M3E.2 reuses the bounded P1-M3E candidate library. Rules contain at most two non-redundant atoms and use only fields already available before settlement, including market, FINAL stage, source signal/category, economic-layer validity/actionability, model probability, edge, no-vig edge, data quality, and market-implied probability.

No new matchup variable is invented in this phase. A future feature may enter the operating-envelope search only after its pregame availability, provenance, missingness behavior, and immutable capture contract are separately demonstrated.

### Forbidden selector inputs

Rule membership must not depend on:

- game result;
- settlement timestamp;
- Brier score;
- log loss;
- realized flat or policy profit;
- closing price;
- CLV;
- any field derived from the final outcome.

Those values may be used only **after membership is frozen** to evaluate model quality or to display non-promotional diagnostics.

## Eligibility

A row is scientifically scoreable only when:

- the game date is valid;
- result is `WIN` or `LOSS`;
- model probability is finite and strictly between 0 and 1;
- Brier score is present and non-negative;
- log loss is present and non-negative;
- prediction IDs are unique.

Pushes, void-like/non-binary results, pending decisions, and rows lacking proper scores cannot create support.

## Default sample requirements

The defaults are deliberately stricter than P1-M3E:

- at least **120** scoreable observations;
- at least **36** distinct dates;
- discovery: at least **24 selected** and **24 rejected** observations;
- each holdout: at least **12 selected** and **12 rejected** observations;
- each holdout: selected rule represented on at least **6 dates**;
- selected holdout coverage between **10% and 70%**;
- date-cluster bootstrap: **5,000** replicates.

These are research minimums, not guarantees of economic profitability.

## Discovery selection

Candidate rules compete on discovery dates only. A candidate is eligible for selection only if:

- selected and rejected discovery samples meet their minimums;
- selected mean log loss is lower than rejected mean log loss;
- selected mean Brier score is lower than rejected mean Brier score;
- selected coverage is between 10% and 70%;
- selected calibration gap is at most 0.05;
- selected calibration is not worse than rejected calibration by more than 0.01.

The discovery score rewards proper-score improvement and applies a small complexity penalty to two-atom rules. Ties prefer the simpler rule and then deterministic rule-key order.

## Validation and confirmation

Neither holdout may choose or modify the rule. Each independently requires:

- holdout selected/rejected sample minimums;
- selected-date minimum;
- accepted coverage;
- lower 95% date-cluster bootstrap bound for rejected-minus-selected log loss > 0;
- lower 95% date-cluster bootstrap bound for rejected-minus-selected Brier score > 0;
- selected calibration gap <= 0.05;
- selected calibration no worse than rejected by more than 0.01.

A discovery winner that fails validation is `VALIDATION_FAILED`. A rule that passes validation but fails the final untouched holdout is `CONFIRMATION_FAILED`.

Only a rule passing both holdouts may reach:

`STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY`

## Economic diagnostics are not a promotion criterion

Selected-group flat-stake ROI and mean CLV are reported for the two holdouts because they are scientifically useful diagnostics. In P1-M3E.2 they are explicitly **not** a promotion criterion.

Economic certification remains a separate problem. In particular, the frozen prospective `FINAL F5_ML + PREMIUM + !ULTRA` hypothesis and its August 8, 2026 cutoff are not modified by this work.

The earlier historical 13-4 PREMIUM-without-ULTRA observation remains post-hoc discovery evidence and cannot be reused as prospective confirmation.

## Safety invariants

Even if the strongest P1-M3E.2 state is reached:

- `economicProfitabilityCertified = false`
- `operationalRecommendationGateAllowed = false`
- `bettingRecommendationAllowed = false`
- `stakeChangesAllowed = false`
- `automaticBettingAllowed = false`
- `modelProbabilityChanged = false`
- `existingEconomicThresholdsChanged = false`
- `premiumNoUltraProspectiveHypothesisChanged = false`
- `automaticModelChangesAllowed = false`
- `automaticPromotionAllowed = false`

P1-M3E.2 therefore answers only whether a candidate operating envelope is **stable enough to deserve continued research attention**. It cannot by itself tell production to recommend a wager.

## Scientific interpretation

The intended end state is not “find a rule that wins.” It is to establish a reproducible abstention boundary:

- conditions inside a repeatedly confirmed pregame envelope become candidates for later independent economic certification;
- conditions outside that envelope remain lower-confidence research territory;
- no condition becomes an operational recommendation until a separately frozen prospective protocol demonstrates economic value without degrading calibration or proper scoring.

This separation is deliberate protection against outcome-driven threshold tuning and post-hoc storytelling.
