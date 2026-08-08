# P1-M3E.5 MLB Live Frozen Operating Envelope

## Purpose

P1-M3E.5 connects the already-merged frozen research protocol to the owner's real interactive MLB predictor cohort.

It does not create a new predictor rule. It composes existing scientific stages in this order:

1. read only owner-scoped immutable ledger records;
2. rebuild the existing P1-M3D terminal interactive economic review;
3. fail closed if the complete terminal decision window is not present;
4. run P1-M3E.3 on those terminal pregame rows to freeze the earliest outcome-blind window reaching the preregistered minimums;
5. pass that exact frozen manifest and the same rows into P1-M3E.4;
6. while any frozen decision remains unresolved, report `FROZEN_WAITING_FOR_SETTLEMENTS`;
7. after all frozen decisions resolve, preserve the exact Discovery / Validation / Confirmation partitions;
8. select only on Discovery, validate the frozen rule on Validation, and open Confirmation only after Validation passes.

## Endpoint

Authenticated interactive-session GET only:

`GET /api/mlb/p1/v1/operating-envelope-frozen`

The route uses the same owner ledger and P1-M3D terminal-review chain as the existing operating-envelope review. It performs no writes.

## Source completeness

P1-M3E.5 receives both the number of unique analytical decisions reported by P1-M3D and the actual terminal rows supplied to the frozen protocol.

If the upstream review reports more unique analytical decisions than rows available to P1-M3E.5, it throws `P1_M3E5_SOURCE_WINDOW_TRUNCATED` and returns HTTP 409. A truncated source window cannot produce a freeze or an ELITE research conclusion.

## Freeze behavior

The preregistered P1-M3E.3 minimums remain unchanged:

- at least 120 valid terminal pregame decisions;
- at least 36 distinct decision dates.

The freeze boundary is chosen without result, settlement, Brier score, log loss, ROI, closing odds or CLV. Pending rows count toward the freeze because their outcomes are deliberately irrelevant to boundary selection.

Once the earliest qualifying window freezes, future decisions may increase the live ledger but cannot move:

- cutoff date;
- decision identity digest;
- Discovery date digest;
- Validation date digest;
- Confirmation date digest;
- manifest digest.

## Evaluation behavior

P1-M3E.4 remains authoritative for outcome evaluation.

No outcome-driven Discovery is opened until every frozen decision reaches terminal disposition. Once all frozen rows resolve, P1-M3E.4 verifies the manifest again, excludes all future rows and refuses to recalculate partitions from a smaller date set.

Possible live states are:

- `WAITING_FOR_FREEZE`
- `FROZEN_WAITING_FOR_SETTLEMENTS`
- `FROZEN_NOT_EVALUABLE`
- `NO_DISCOVERY_RULE`
- `VALIDATION_FAILED`
- `CONFIRMATION_FAILED`
- `STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY`

## Interpretation

Even the strongest state means only that the same pregame-identifiable model-quality envelope survived two untouched later holdouts.

P1-M3E.5 always keeps these false:

- economic profitability certification;
- operational recommendation gate;
- betting recommendation authorization;
- stake changes;
- automatic betting;
- model probability changes;
- existing economic-threshold changes;
- changes to the separate PREMIUM-without-ULTRA prospective hypothesis;
- automatic model changes;
- automatic promotion.

The PREMIUM-without-ULTRA prospective economic track remains independent.

## Safety and production boundary

P1-M3E.5 is an authenticated read-only research monitor. It adds no POST/PUT/PATCH/DELETE route, writes no prediction or settlement record, calls no sportsbook and changes no prediction formula or recommendation threshold.
