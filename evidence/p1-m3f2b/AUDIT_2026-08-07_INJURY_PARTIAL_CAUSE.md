# P1-M3F2B Injury PARTIAL Cause Audit — 2026-08-07

## Decision

The audited live `INJURIES=PARTIAL` state is scientifically justified. It is not caused by stale evidence, transport failure or an incorrect timestamp contract.

One side had complete reconciliation and was `VERIFIED`. The other side remained `PARTIAL` because the external injury feed had both an identity rejection and a material official-MLB coverage gap.

Do **not** relax P1-M2B to treat `PARTIAL` as `FRESH`.

## Chain of custody

- deployed backend: `0e3f39d790a6011f27e3384e74228b62fa9d7a0e`
- temporary research PR: #356
- research head: `fedbe323c860e970d6ddcc1fc4b554b51ae464df`
- workflow run: `31228254871`
- artifact ID: `9012850523`
- artifact ZIP SHA-256: `5d0aebcacf1692140ddfaf952cc907fe48a12bbb328492da2f61f096c3ab28f3`
- result JSON SHA-256: `7227e08e2befb63056974880a6df75f7b60b558c4569ba38577ddffa7d4f96dd`
- audited state: `PREGAME`

## Exact live cause

### Side with full coverage

- status: `VERIFIED`
- official validation: `VERIFIED`
- stale: false
- source errors: 0
- rejected identities: 0
- official-only injured players: 0
- Phase B coverage: `FULL`

### Side with partial coverage

- status: `PARTIAL`
- official validation: `VERIFIED`
- stale: false
- source errors: 0
- rejected identities: **1**
- official-only injured players: **5**
- Phase B coverage: `PARTIAL`

The current aggregate source logic intentionally requires both `rejectedCount===0` and `officialOnly===0` before the team injury status becomes `VERIFIED`. That condition is not satisfied for the partial side.

## Interpretation

The external feed and the official MLB validation source were healthy, but they did not agree on full player coverage. Five players present on MLB's official injured evidence were absent from the external feed, and one external identity could not be safely reconciled.

Treating this state as fresh/complete would erase real uncertainty. The existing conservative readiness behavior is therefore appropriate for this audited case.

A future improvement may investigate:

1. the one rejected identity and whether deterministic identity resolution can safely recover it; and
2. whether official MLB injury evidence can become an authoritative supplemental source for players omitted by the external feed.

Those are source-model changes requiring their own evidence. They must not be implemented by simply reclassifying `PARTIAL` as `VERIFIED`.

## Safety

This audit used public read-only endpoints only. It created zero predictions, settlements, bets or financial exposure and changed no model/readiness logic.

## Priority

The immediate readiness priority remains `ADVANCED_FACTORS`: P1-M3F2 proved all five required endpoints succeed live but expose no M2B-recognized timestamp. That is a structural temporal-provenance defect and should be addressed before attempting a broader injury-source redesign.
