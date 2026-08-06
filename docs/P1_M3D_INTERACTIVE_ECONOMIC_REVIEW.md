# P1-M3D — Interactive MLB settlement and economic review

## Objective

Create an owner-scoped, read-only economic review for the exact MLB evaluations produced when an authenticated operator presses **Generar Predicción**.

P1-M3D does not create another ledger, settlement engine or statistics system. It reuses:

- `mlb-ledger.v1` as the immutable source;
- P1-M3A/P1-M3B to identify interactive captures and their revision chains;
- P1-M4B to identify the protected effective decision and bounded SHADOW units;
- S5B row arithmetic for flat profit, proper scores and analytical deduplication;
- existing append-only official settlements and comparable closing evidence for result and CLV.

The schema is:

```text
courtedge-p1-m3d-interactive-economic-review.v1
```

The private endpoint is:

```text
GET /api/mlb/p1/v1/economic-review
```

## Cohort boundary

A ledger record enters the source cohort only when:

1. it belongs to the authenticated user;
2. `analysis.layers.p1M3aCapture` has the exact P1-M3A schema;
3. `origin.channel` is `INTERACTIVE_MLB_PREDICTOR`;
4. a non-empty P1-M3A lifecycle key exists.

Automatic S5C captures, manual history and records owned by other users are excluded.

## Revision handling

P1-M3D groups records by the immutable P1-M3A lifecycle key.

- superseded revisions never count as separate decisions;
- exactly one terminal leaf is required;
- a lifecycle with zero or multiple leaves is excluded and produces `ACTION_REQUIRED`;
- PROVISIONAL-to-FINAL chains remain visible as lifecycle coverage but only the terminal leaf enters performance metrics.

After terminal resolution, S5B analytical deduplication is applied. A refresh, retry or deployment cannot inflate the sample.

## Two accounting views

### Flat one-unit simulation

Every settled unique terminal decision is simulated at one unit using the saved pregame American price.

This answers:

> What would have happened if every recorded interactive decision had been treated equally?

### P1-M4 policy simulation

Only a structurally valid P1-M4B layer with:

```text
effectiveDecision.decision = BET
effectiveDecision.actionability = ACTIONABLE_FINAL
0 < effectiveDecision.analyticalUnits <= 1
```

contributes policy exposure and profit.

LEAN, PASS, INFO, PROVISIONAL, BLOCKED, OBSERVE_ONLY and invalid P1-M4B layers contribute zero policy units. This is analytical SHADOW accounting only; no wager is placed.

## Metrics

The report exposes:

- total, settled and pending interactive decisions;
- wins, losses, pushes/voids and hit rate;
- flat exposure, profit and ROI;
- policy exposure, profit and ROI;
- Brier Score and natural-log loss;
- mean model probability and observed win rate;
- Wilson 95% interval;
- mean market-implied probability and edge;
- mean/median CLV and CLV coverage;
- market, source-signal, effective-decision, actionability, stage and probability-band breakdowns;
- accepted BET/BET_FUERTE recommendations versus LEAN/PASS/INFO controls;
- PROVISIONAL-to-FINAL, FINAL-only and PROVISIONAL-only lifecycle counts;
- malformed, branched, duplicate and invalid-economic-layer exclusions.

## Interpretation milestones

- 0 settlements: `WAITING_FOR_FIRST_SETTLEMENT`;
- 1–4: `TECHNICAL_SAMPLE_ONLY`;
- 5–19: `PRELIMINARY_REVIEW_ONLY`;
- 20–49: `COLLECTING_PREFERRED_SAMPLE`;
- 50 or more: `READY_FOR_HUMAN_REVIEW`.

These states do not authorize a model conclusion. `conclusionsAllowed`, automatic model changes and automatic promotion remain false in every state. Human review must remain explicit and any candidate policy change requires a separately versioned SHADOW study.

## Data integrity

Flat metrics may still describe a valid settled interactive capture when its P1-M4B layer is missing or invalid. However, that record is excluded from policy exposure and the report surfaces `ECONOMIC_LAYER_COVERAGE_INCOMPLETE`.

A branched lifecycle is a critical integrity condition and fails closed instead of selecting an arbitrary leaf.

## Safety

P1-M3D is read-only:

- no new prediction or settlement write;
- no correction or historical mutation;
- no sportsbook integration;
- no automatic bet;
- no real financial exposure;
- no model, formula, probability, signal, threshold or stake-policy change;
- no automatic promotion.

The next phase, P1-M3D-B, may render this server-authoritative report in the frontend. It must not recalculate economics in the browser.
