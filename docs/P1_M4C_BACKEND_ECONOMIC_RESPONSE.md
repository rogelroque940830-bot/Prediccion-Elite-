# P1-M4C — Backend Economic Decision Response

## Objective

Wire the validated P1-M4B economic adapter into the authenticated P1-M3B scientific capture service so the exact interactive MLB execution is persisted with one digest-valid economic layer and returned to the frontend for the decision card.

## Server sequence

1. Parse and validate the original P1-M3A candidate.
2. Attach `analysis.layers.p1M4bEconomicDecision` through P1-M4B.
3. Recalculate and revalidate the complete scientific snapshot.
4. Use the enriched candidate for revision identity and immutable ledger append.
5. Return the complete P1-M4B adapter result in the P1-M3B response.

A failed adapter or failed enriched-candidate validation returns `422 P1_M4B_ADAPTER_REJECTED` before any ledger write.

## Response addition

`MlbP1M3bCaptureResult` adds:

```text
economicDecision: MlbP1M4bAdapterResult
```

The response contains the original selection and signal, raw P1-M4A economics, the source-signal-protected effective decision, price discipline, EV, SHADOW units, reason codes and safety invariants.

## Persistence

The same P1-M4B adapter object is stored in the scientific snapshot layer. The ledger input is built from the enriched candidate; the original model probability, source signal and original stake evidence are not rewritten.

## Idempotency

Semantic identity remains based on the sporting decision, certified quote, evidence and original model output. The deterministic P1-M4B layer does not create a second sample. Identical retries return the existing prediction with the same economic response.

## Safety

This phase does not add a public endpoint, sportsbook integration, automatic wager, real financial exposure, model change, settlement or automatic promotion. It only persists and returns SHADOW decision-support evidence.
