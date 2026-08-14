# P1-M3E.4 MLB Frozen Manifest Evaluation

## Purpose

P1-M3E.4 connects the immutable pregame research window from P1-M3E.3 to the stricter two-holdout operating-envelope evaluator from P1-M3E.2.

The objective is not to create a bet. The objective is to make the research chronology non-negotiable:

1. freeze an outcome-blind pregame window;
2. verify that the exact frozen manifest still matches the current immutable source rows;
3. exclude every decision after the frozen cutoff;
4. wait until every frozen decision has a terminal settlement before opening outcome-driven discovery;
5. preserve the exact frozen 50/25/25 date partitions;
6. select a rule only on Discovery;
7. open Validation with the frozen discovery winner;
8. open Confirmation only if Validation passes;
9. never translate research support directly into an operational recommendation.

## Why all frozen settlements are required before Discovery

If Discovery were recomputed every time another frozen game settled, the discovery winner could change as outcomes trickled in. That would be a form of sequential outcome-driven model selection.

P1-M3E.4 therefore refuses to evaluate the operating envelope while any frozen decision is unresolved. This is deliberately conservative. The frozen pregame cohort can accumulate settlements, but outcomes cannot influence the research rule until the whole frozen window has reached terminal disposition.

## Manifest verification

P1-M3E.4 receives the previously generated P1-M3E.3 report. Before evaluating any outcome, it rebuilds P1-M3E.3 using the same preregistered freeze configuration and current source rows.

The original and recomputed `manifestDigest` must be identical.

A mismatch fails closed because it means that an identity-defining pregame field inside the frozen window changed or an unexpected historical decision entered the frozen period.

Future rows after the frozen cutoff are permitted, but P1-M3E.3 guarantees that they cannot change the manifest digest. P1-M3E.4 excludes them from evaluation.

## Scoreable-date protection

Resolved non-binary decisions such as pushes may be legitimate terminal outcomes but cannot be used for binary Brier/log-loss evaluation.

P1-M3E.4 requires every frozen manifest date to retain at least one binary scoreable decision. If a frozen date disappears from the scoreable set, the module returns `FROZEN_NOT_EVALUABLE` rather than allowing P1-M3E.2 to recalculate temporal boundaries from a smaller date set.

The original partitions therefore remain authoritative.

## States

- `WAITING_FOR_FREEZE` — P1-M3E.3 has not yet frozen a research window.
- `FROZEN_WAITING_FOR_SETTLEMENTS` — manifest verified, but at least one frozen decision remains unresolved.
- `FROZEN_NOT_EVALUABLE` — all decisions resolved, but the frozen cohort cannot satisfy the fixed scoreable/date requirements without changing the protocol.
- `NO_DISCOVERY_RULE` — the frozen Discovery partition contains no preregistered candidate rule meeting the research criteria.
- `VALIDATION_FAILED` — the frozen discovery winner failed the untouched Validation partition. Confirmation remains unopened.
- `CONFIRMATION_FAILED` — the rule passed Validation but failed final untouched Confirmation.
- `STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY` — the same pregame-identifiable rule survived both untouched holdouts.

## Audit snapshot

Once the entire frozen window is resolved, P1-M3E.4 computes a SHA-256 `settlementSnapshotDigest` from the frozen settlement/evaluation fields. This is an audit fingerprint, not a selector input and not a promotion criterion.

## Safety invariants

Even the strongest state keeps all of the following false:

- `economicProfitabilityCertified`
- `operationalRecommendationGateAllowed`
- `bettingRecommendationAllowed`
- `stakeChangesAllowed`
- `automaticBettingAllowed`
- `modelProbabilityChanged`
- `existingEconomicThresholdsChanged`
- `premiumNoUltraProspectiveHypothesisChanged`
- `automaticModelChangesAllowed`
- `automaticPromotionAllowed`

The frozen August 8 PREMIUM-without-ULTRA prospective hypothesis remains a separate economic confirmation track and is not changed by P1-M3E.4.

## Production status

P1-M3E.4 is a pure research module. It creates no route, performs no ledger write, performs no settlement write, calls no sportsbook and changes no production prediction behavior.
