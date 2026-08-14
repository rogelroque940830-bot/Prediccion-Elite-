# S6N Phase 5C-3 — First Real Settlement Monitor

## Objective

Arm an automatic, read-only monitor before the first clean MLB binary settlement is available, then certify that the first S6M milestone-1 certificate is real, internally consistent, stable across separate worker runs, and still supported by the immutable owned ledger.

## State machine

- `ARMED_AND_WAITING`: no eligible milestone-1 certificate exists yet.
- `OBSERVING_CERTIFICATE_STABILITY`: milestone 1 is valid and an append-only first-observation baseline has been written; a second stable observation is pending.
- `FIRST_REAL_SETTLEMENT_CERTIFIED`: the same valid certificate survived the stability window and an append-only S6N evidence file was written.
- `ACTION_REQUIRED`: any certificate, manifest, settlement, ledger, persistence, S6M parity, or evidence-integrity check failed.

## Verification surface

S6N independently checks:

1. S6M is not actionable, has no critical issues, and its S6L parity check passed with zero mismatches.
2. The milestone-1 append-only certificate exists exactly when S6M reports it as certified.
3. Certificate and manifest SHA-256 digests match their stored contents.
4. The certificate contains exactly one eligible binary decision.
5. The current deterministic first eligible decision reconstructed from the owned ledger matches the immutable manifest.
6. Independently recomputed one-decision metrics match the certificate metrics.
7. The terminal prediction still exists, is `FINAL`, is post-fix, has standard American odds, and retains the exact settlement event, source, timestamp, and WIN/LOSS result.
8. The certificate digest remains unchanged across separate worker runs and the configured minimum stability window.
9. The owned ledger count remains monotonic.
10. The append-only S6N baseline and final evidence digests remain valid.

## Persistence

The service stores data under:

```text
/app/data/mlb-s6n-first-real-settlement-monitor
```

Files:

- `baseline.json`: append-only first valid observation.
- `evidence.json`: append-only final S6N certification.
- `latest.json`: current aggregate state.
- `snapshots/*.json`: state-change snapshots, pruned to a bounded maximum.

A missing, unreadable, changed, or tampered baseline/evidence file is actionable. Existing evidence is never silently recreated or overwritten.

## Worker defaults

- Initial delay: 270 seconds.
- Interval: 5 minutes.
- Minimum certificate stability: 5 minutes.
- Maximum retained state-change snapshots: 100.

All values can be overridden through the corresponding `MLB_S6N_*` environment variables, but no Railway configuration change is required for the staging integration environment.

## Routes

- `GET /health/s6n-first-real-settlement`
- `GET /api/mlb/ledger/v1/s6n-first-real-settlement/status`
- `GET /api/mlb/ledger/v1/s6n-first-real-settlement/evidence`

The health route exposes only aggregate state. The evidence route returns the persisted S6N baseline/evidence package after it exists.

## Safety boundary

S6N is strictly observational:

- SHADOW mode only.
- Real financial exposure remains 0.
- No sportsbook integration or automatic betting.
- No ledger mutation or deletion.
- No automatic promotion or model change.
- No prediction formula, probability, signal, market, threshold, settlement rule, or stake-policy change.
- Scientific conclusions remain disabled even after the first settlement is certified; the larger 5/20/50 sample milestones still govern later review.
