# O3.1 — MLB Evidence Repair Console

## Route

`#/operations/evidence-repair`

## Purpose

The private O3.1 console exposes the append-only evidence repair backend without creating inspections or changes on page load. It is used only for authoritative MLB incidents in `DATA_QUALITY_REVIEW`.

## Three-step flow

1. **Inspect evidence**
   - Select one eligible MLB incident.
   - Explicitly call the inspection route.
   - Display official MLB identity, final status and score.
   - Show every affected prediction and exact defective field.

2. **Create a sealed repair plan**
   - Complete only fields that require manual evidence, such as American odds, market type or selection.
   - Record source name, evidence reference, capture time and note.
   - Send the inspection digest, manual patches and evidence source.
   - Display READY/BLOCKED state, digests, repaired fields and expiration.

3. **Append superseding predictions**
   - Require administrator role, exact confirmation phrase, operator reason, idempotency key and acknowledgment.
   - Append new predictions with `supersedesId`.
   - Preserve original predictions unchanged.
   - Display the execution result and append-only digest-chain audit.

## Fail-closed behavior

- No inspection, plan or execution occurs on load, refresh or selection.
- Only MLB `DATA_QUALITY_REVIEW` with `AUTHORITATIVE` evidence is listed.
- Missing manual evidence keeps plan creation disabled.
- Expired or BLOCKED plans cannot execute.
- Invalid safety contracts keep actions disabled.
- Errors are displayed without fabricating state.

## Safety

- `SHADOW_EVIDENCE_REPAIR`
- exposure 0
- no automatic repair
- no historical overwrite
- no settlement execution
- no betting
- no model, probability, signal or stake changes
- no automatic promotion
