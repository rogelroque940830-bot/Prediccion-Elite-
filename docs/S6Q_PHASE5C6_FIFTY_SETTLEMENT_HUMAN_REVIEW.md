# S6Q / Phase 5C-6 — Preferred 50-settlement human review gate

## Objective

Certify the deterministic first 50 clean post-fix binary MLB settlements and require at least ten independently certified decisions before enabling a formal human scientific review. S6Q never authorizes automatic model changes.

## Prerequisites

- S6M milestone 50 certificate exists and passes independent reconstruction.
- S6P has certified the minimum sample of 20 settlements.
- At least ten decisions among the first 50 are independently certified by S6K.
- S6M/S6L metric parity passes with zero critical issues.
- The owned ledger remains immutable and monotonic.

## State machine

`ARMED_AND_WAITING_FOR_50 -> WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION -> WAITING_FOR_TEN_CERTIFIED_CYCLES -> OBSERVING_FIFTY_RESULT_STABILITY -> READY_FOR_HUMAN_REVIEW`

Any integrity, persistence, certificate, prerequisite, or evidence failure enters `ACTION_REQUIRED`.

## Evidence

The append-only review package contains the immutable first-50 manifest, independent metrics, Brier Score, log loss, Wilson interval, ECE/MCE, informational flat-one-unit ROI, CLV coverage and distribution, market and signal breakdowns, calibration buckets, PROVISIONAL-to-FINAL movement, and descriptive market/signal concentration.

## Scientific boundary

At `READY_FOR_HUMAN_REVIEW`, human interpretation is allowed, but `automaticModelChangesAllowed=false` and recommendation remains `NO_AUTOMATIC_MODEL_CHANGE`. Any candidate change must be versioned separately and tested in SHADOW.

`conclusionsAllowed=true` refers only to documented human interpretation of the certified evidence. It never grants permission to mutate the active predictor, stake policy, ledger, or settlement rules.

## Operational invariant

S6Q may advance only through persisted append-only evidence. An in-memory calculation, a concurrent write race, or an unavailable prerequisite cannot produce `READY_FOR_HUMAN_REVIEW`.

- Previously observed baseline or evidence files may not disappear or be recreated silently.
- Once a baseline or evidence artifact has been observed, its history flag remains irreversible across later `ACTION_REQUIRED` reports.
- The baseline first-observation timestamp and baseline/evidence digests are anchored to the previously persisted report and cannot be rewritten to bypass the stability window.
- Ledger monotonicity uses the complete owned-record count, independently of the 10,000-record analytical read cap.
- Persisted S6M, S6P, and S6K reports are shape-validated before their issue, parity, milestone, readiness, or evidence fields are traversed.
- Every named S6M certificate check and every named S6Q evidence check must be present and exactly `true`; an empty or partial checks object cannot satisfy an integrity gate.
- Every derived evidence section—market and signal breakdowns, calibration buckets, PROVISIONAL-to-FINAL comparison, and concentration—is reconstructed independently before persisted evidence is accepted.

## Runtime

Enabled by default only in `p0-integration`, with a five-minute interval and stability window. Public health: `GET /health/s6q-fifty-settlement-human-review`. Protected status/evidence routes are under `/api/mlb/ledger/v1/s6q-fifty-settlement-human-review`.

## Safety

SHADOW mode, zero financial exposure, no sportsbook integration, no automatic betting, no production writes, no historical mutation, no automatic promotion, and no formula/probability/signal/market/threshold/settlement/stake changes.
