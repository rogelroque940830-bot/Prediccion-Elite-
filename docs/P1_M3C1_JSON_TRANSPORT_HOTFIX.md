# P1-M3C.1 — Exact JSON transport and digest hotfix

## Incident

The first authenticated live P1-M3C execution generated a predictor result but the P1-M3B service rejected the scientific capture with `P1_M3A_CAPTURE_REJECTED`.

The browser originally calculated `scientificSnapshot.payloadDigest` from the in-memory JavaScript object. That object can contain optional properties whose value is `undefined`. JSON transport omits those object properties and converts undefined array entries to `null`. The server therefore recomputed SHA-256 from a payload that was semantically different from the client-side digest input.

Minimal fixture tests did not expose the defect because they contained no optional undefined values.

## Correction

Before hashing or posting, P1-M3C.1 now creates one JSON-transport-normalized snapshot:

- undefined object properties are omitted;
- undefined array entries become `null`;
- non-finite numbers become `null`;
- sensitive fields are redacted before capture;
- the 280,000-byte P1-M3A limit is checked before POST;
- the normalized object is used both as `scientificSnapshot.payload` and as the SHA-256 input.

This guarantees that the server validates the exact payload received over the wire.

## Error visibility

When P1-M3B returns `details.errors`, the frontend error message now includes those contract codes rather than discarding them behind the generic economic-integrity message.

## Safety

The hotfix does not change:

- MLB formulas or probabilities;
- selected market or odds;
- edge, signal, category, thresholds or stake policy;
- P1-M2 readiness rules;
- ledger append-only semantics;
- settlement;
- SHADOW mode;
- real financial exposure 0;
- automatic betting/model changes/promotion disabled.
