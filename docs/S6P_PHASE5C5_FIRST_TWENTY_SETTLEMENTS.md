# S6P / Phase 5C-5 — First 20 eligible MLB settlements

## Objective

Certify the deterministic first 20 clean post-fix binary MLB settlements as the minimum sample for a preliminary human review, while explicitly prohibiting model conclusions or automatic changes.

## Prerequisites

- S6M milestone 20 certificate exists and is valid.
- S6O has certified the first five real settlements.
- S6M/S6L metric parity passes with zero critical issues.
- The owned ledger remains immutable and monotonic.

## State machine

`ARMED_AND_WAITING_FOR_20 -> OBSERVING_TWENTY_RESULT_STABILITY -> MINIMUM_SAMPLE_20_CERTIFIED`

Any integrity failure enters `ACTION_REQUIRED`.

## Evidence

S6P verifies the immutable first-20 manifest, FINAL stages, unique analytical identities, standard American prices, settlement identities, binary outcomes, independent metric recomputation, market/signal breakdowns, deterministic calibration buckets, and PROVISIONAL-to-FINAL probability movement. Baseline and evidence files are append-only and must remain stable across separate worker executions.

## Scientific boundary

At 20 results, `preliminaryReviewAvailable=true` only after certification. The sample remains insufficient for model conclusions: `sampleAdequateForModelConclusions=false`, `conclusionsAllowed=false`, `automaticModelChangesAllowed=false`, recommendation `NO_AUTOMATIC_MODEL_CHANGE`.

The preliminary report may identify questions for later investigation, but it cannot authorize parameter, market, signal, threshold, settlement, or stake changes.

## Runtime

Enabled by default only in `p0-integration`, five-minute interval and stability window. Public health: `GET /health/s6p-first-twenty-settlements`. Protected status/evidence routes are under `/api/mlb/ledger/v1/s6p-first-twenty-settlements`.

## Safety

SHADOW mode, zero financial exposure, no sportsbook integration, no automatic betting, no production writes, no historical mutation, no automatic promotion, and no formula/probability/signal/market/threshold/settlement/stake changes.
