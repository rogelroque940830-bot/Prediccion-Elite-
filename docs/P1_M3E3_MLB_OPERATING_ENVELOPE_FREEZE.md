# P1-M3E.3 MLB Operating Envelope Freeze

## Purpose

P1-M3E.3 protects Operating Envelope 2.0 from a subtle form of temporal contamination: a rolling 50/25/25 split can move old validation dates into discovery as new games are appended.

This package therefore does **not** evaluate whether a rule wins, has positive ROI, or has better Brier/log loss. Its only job is to freeze the earliest real pregame decision window that reaches preregistered size, before any outcome-based operating-envelope evaluation is allowed.

## Upstream contract

The input is the terminal interactive P1-M3D decision-row surface. Those rows originate from P1-M3A scientific captures, whose capture contract rejects games that have already started.

P1-M3E.3 assumes that upstream validation remains intact and then applies an additional outcome-blind freeze rule. A row may participate in the freeze boundary only when it has:

- a non-empty prediction ID;
- a non-empty lifecycle key;
- a valid game date;
- a valid recorded timestamp;
- a finite model probability strictly between 0 and 1.

Duplicate prediction IDs fail closed.

## Forbidden freeze inputs

The freeze boundary and manifest identity do not use:

- result;
- settlement timestamp;
- Brier score;
- log loss;
- realized flat or policy profit;
- closing odds;
- CLV;
- hit rate or observed win rate;
- any later economic performance.

Pending decisions therefore count toward the freeze threshold when their pregame identity is valid. Their later results cannot move the frozen cutoff.

## Default freeze rule

Defaults are preregistered at:

- 120 valid pregame terminal decisions;
- 36 distinct decision dates.

Dates are processed chronologically. The cutoff is the **earliest date** at which both minimums have been reached. Every eligible decision through that date belongs to the frozen research window. Eligible decisions on later dates are excluded from that frozen window.

This construction has an important invariant: appending future decisions cannot move the cutoff backward or forward, cannot move the three temporal partitions, and cannot change the manifest digest.

## Frozen temporal partitions

Once the earliest threshold-reaching window exists, its observed decision dates are partitioned once:

1. discovery: first 50% of frozen dates;
2. validation: next 25%;
3. confirmation: remaining 25%.

The ordering must satisfy:

`discovery.maxDate < validation.minDate < confirmation.minDate`

P1-M3E.3 records SHA-256 digests for the exact frozen decision identities, each date partition, and the complete manifest.

## Why this precedes live M3E.2 evaluation

P1-M3E.2 is a fixed-dataset stability test. It must not be connected directly to a rolling production cohort whose split boundaries can change on every new date.

The required sequence is therefore:

1. P1-M3E.3 freezes an outcome-blind pregame cohort and its three date partitions.
2. A later read-only evaluator must bind itself to that manifest.
3. Discovery may inspect outcomes only inside the frozen discovery partition.
4. Validation may open only after the discovery rule is fixed.
5. Confirmation may open only after validation passes.
6. Later games remain outside this historical stability package and are reserved for subsequent prospective economic certification.

## Relationship to PREMIUM without ULTRA

This work does not change the frozen prospective `FINAL F5_ML + PREMIUM + !ULTRA` hypothesis or its August 8, 2026 cutoff. The historical 13-4 observation remains post-hoc and is not used to set this freeze boundary.

## Safety

P1-M3E.3 has no route and performs no write. It does not alter model probabilities, economic thresholds, recommendations, stakes, sportsbook behavior, or any production record.

Even after a research window is frozen:

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

A freeze is only a chain-of-custody guarantee for later research. It is not evidence that any betting condition is elite.