# P1-M3E — Authenticated Read-Only Cohort Adapter

## Purpose

This adapter connects the already-validated P1-M3E operating-envelope methodology to the owner's real interactive MLB predictor cohort.

It does not change the predictor. It exposes a read-only authenticated review at:

`GET /api/mlb/p1/v1/operating-envelope`

The endpoint answers only the registered P1-M3E scientific question: has a pregame-identifiable operating envelope earned model-quality support on later chronological decisions?

## Source chain

The endpoint uses the existing owner-scoped immutable ledger path:

1. authenticated user identity;
2. owned prediction IDs from the ownership store;
3. immutable ledger records;
4. P1-M3D terminal interactive economic review;
5. P1-M3E operating-envelope analysis.

This preserves the same lifecycle deduplication, interactive-only filtering, settlement handling, proper scoring and pregame metadata already audited in P1-M3D.

## Read-only guarantees

The adapter registers only `app.get(...)`.

It does not call or expose:

- prediction append;
- settlement append;
- ledger mutation;
- sportsbook execution;
- automatic betting;
- automatic model changes;
- automatic promotion;
- probability rewrites;
- economic threshold rewrites.

Authentication uses the same interactive capture session boundary as P1-M3D.

## Cohort completeness guard

P1-M3D intentionally limits the rows exposed in its report view. P1-M3E must not silently infer an operating envelope from a truncated view.

Before analysis, the adapter compares:

- P1-M3D `sample.uniqueAnalyticalDecisions`;
- number of P1-M3D review rows available to P1-M3E.

If the analytical decision count is larger than the available row window, the endpoint fails closed with HTTP 409 and:

`P1_M3E_SOURCE_WINDOW_TRUNCATED`

A future change may safely widen the upstream read window, but this adapter will never treat silent truncation as a complete scientific cohort.

## Expected early state

The registered P1-M3E methodology requires by default:

- at least 80 scoreable binary settled observations;
- at least 30 distinct game dates.

Therefore the endpoint may legitimately return `INSUFFICIENT_SAMPLE` for a long period. That is a valid scientific result, not a system failure.

The requirements must not be lowered merely to obtain an `ELITE_MODEL_QUALITY_SUPPORTED` label.

## Interpretation boundary

Possible states are:

- `INSUFFICIENT_SAMPLE`;
- `NO_DISCOVERY_RULE`;
- `CANDIDATE_NOT_CONFIRMED`;
- `ELITE_MODEL_QUALITY_SUPPORTED`.

Even the last state remains research evidence only. It does not activate a production confidence gate or authorize bets. The response continues to preserve:

- `economicProfitabilityCertified=false`;
- `operationalGateAllowed=false`;
- `modelProbabilityChanged=false`;
- `existingEconomicThresholdsChanged=false`;
- `automaticModelChangesAllowed=false`;
- `automaticPromotionAllowed=false`.

## Why this endpoint exists

The operating-envelope hypothesis depends on **real predictor decisions made before real games**, not on a synthetic historical reconstruction of what the current interactive application might have emitted. The authenticated endpoint makes that prospective cohort measurable without contaminating it or changing the decisions being measured.
