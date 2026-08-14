# O3.1 — MLB Evidence Inspection and Append-Only Repair

## Objective

O3.1 resolves MLB `DATA_QUALITY_REVIEW` incidents without mutating the immutable prediction ledger. It inspects the exact invalid fields, compares game identity and final evidence with MLB Stats API, seals an explicit repair plan and appends a new prediction linked through `supersedesId`.

## Workflow

1. Select one authoritative MLB incident in `DATA_QUALITY_REVIEW`.
2. Create an immutable inspection snapshot.
3. Review each active prediction and its field-level issues.
4. Use MLB Stats API for game identity, date, teams, final state and score.
5. Supply manual evidence only for fields MLB cannot provide, such as sportsbook odds or market metadata.
6. Create a sealed repair plan.
7. Execute as administrator with the exact confirmation phrase.
8. Append and verify superseding predictions.
9. O1, O2 and O3 operate only on current supersession leaves; historical records remain intact.

## Routes

- `GET /api/ops/v1/evidence-repair/status`
- `GET /api/ops/v1/evidence-repair/audit`
- `GET /api/ops/v1/evidence-repair/inspections/:inspectionId`
- `GET /api/ops/v1/evidence-repair/plans/:planId`
- `POST /api/ops/v1/evidence-repair/inspect`
- `POST /api/ops/v1/evidence-repair/plan`
- `POST /api/ops/v1/evidence-repair/execute`

## Fail-closed boundaries

- MLB only.
- `DATA_QUALITY_REVIEW` only.
- One game and at most 50 active records.
- Official final evidence required.
- Non-FINAL predictions cannot be converted by O3.1.
- Invalid odds and market metadata require explicit manual evidence.
- Inspection and plan TTL: 10 minutes.
- Execution requires administrator role, exact digest, reason, idempotency key and `APPEND_SUPERSEDING_MLB_EVIDENCE`.
- No settlement is executed in O3.1.

## Safety

- `SHADOW_EVIDENCE_REPAIR`
- financial exposure `0`
- no automatic repair
- no automatic settlement retry
- no historical UPDATE or DELETE
- no probability, signal, market-selection, threshold, stake or model changes beyond explicitly repaired evidence fields
- no automatic betting or promotion

## Supersession semantics

The original prediction remains immutable. A repair appends a new prediction with `supersedesId` pointing to the original. Operational views use only leaf records in the supersession chain, while audit and historical exports retain every version.
