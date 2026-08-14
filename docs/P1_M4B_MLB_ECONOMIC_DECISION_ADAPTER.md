# P1-M4B — MLB Economic Decision Adapter

## Objective

P1-M4B connects a validated P1-M3A interactive scientific capture to the P1-M4A economic decision contract.

It does not recalculate the sporting model. It reads the exact selected-side probability, certified market price, readiness stage and original model decision already preserved by P1-M3A, evaluates the P1-M4A price discipline, and attaches the result to the scientific snapshot as a new immutable analytical layer.

Schemas:

```text
source capture:  courtedge-p1-m3a-scientific-capture-contract.v1
economic policy: courtedge-p1-m4a-economic-decision-contract.v1
adapter layer:   courtedge-p1-m4b-economic-decision-adapter.v1
```

Layer key:

```text
analysis.layers.p1M4bEconomicDecision
```

## Required boundary

The adapter accepts one `MlbP1M3aCaptureCandidate` and an evaluation timestamp.

Before any economic interpretation, it runs the complete P1-M3A validator. A capture with any integrity error is rejected and receives no attached layer.

Examples of upstream rejection include:

- snapshot digest mismatch;
- stale or invalid quote;
- readiness blocker;
- certified quote mismatch;
- invalid selected-side probability;
- edge arithmetic mismatch;
- unsafe stake on a non-actionable source decision;
- nonzero financial exposure or automatic betting flags.

P1-M4B never repairs, guesses or silently normalizes an invalid capture.

## Source evidence preserved

The adapter copies into its source summary:

- P1-M3A capture identity;
- market, side, selection and line;
- selected-side model probability;
- market-implied and no-vig probabilities;
- original source signal and category;
- original source analytical stake;
- market-specific source signal policy.

The original candidate fields are not overwritten:

```text
probabilities.model
probabilities.marketImplied
probabilities.noVig
probabilities.edgePp
decision.signal
decision.category
decision.recommendedStakeUnits
```

The economic result is additive evidence, not a rewrite of the model output.

## Market-specific source policies

P1-M4B versions the current source-policy family so differences remain visible:

| Market | Source policy |
|---|---|
| ML | `ML_F5_EDGE_CONFIDENCE_V2` |
| F5 ML | `ML_F5_EDGE_CONFIDENCE_V2` |
| Run Line | `RUN_LINE_COVER_PROBABILITY_V1` |
| Total | `TOTAL_RUN_DIFFERENTIAL_V1` |
| F5 Total | `F5_TOTAL_RUN_DIFFERENTIAL_V1` |

This adapter does not enable a new route, automatic selection or previously excluded market. The F5 Total mapping only defines how an already-existing valid scientific capture would be interpreted.

Run Line and Total source formulas differ from the main ML/F5 edge-confidence helper. P1-M4B records whether the source signal and P1-M4A economic model signal match, downgrade or upgrade. A difference is evidence; it is not permission to change the original formula.

## Raw economic result versus effective decision

The attached layer contains two distinct outputs.

### `economicDecision`

This is the unmodified P1-M4A result. It exposes:

- model signal under the economic policy;
- operational decision and actionability;
- fair price;
- minimum LEAN and BET prices;
- current implied probability;
- raw and no-vig edge;
- EV per unit;
- Kelly diagnostics;
- bounded SHADOW analytical stake;
- explicit block or PASS reasons.

### `effectiveDecision`

The effective decision applies a one-way safety ceiling from the original model signal.

The economic layer may downgrade a source signal, but it may not make it more aggressive:

```text
source BET  + economic LEAN -> effective LEAN
source LEAN + economic BET  -> effective LEAN
source PASS + economic BET  -> effective PASS
source INFO + economic BET  -> effective PASS control
```

A source `PASS`, `INFO` or `LEAN` can therefore never become an actionable BET solely because the economic calculation appears favorable.

Only this combination can retain a positive effective analytical stake:

```text
source BET/BET_FUERTE
+ P1-M4A FINAL BET
+ ACTIONABLE_FINAL
+ all integrity checks valid
```

Every other effective output has zero units.

## PROVISIONAL behavior

A valid PROVISIONAL capture is retained for prospective measurement. P1-M4A returns:

```text
modelSignal = original economic classification
decision = LEAN
actionability = WAIT_FOR_FINAL
analyticalUnits = 0
```

P1-M4B preserves the original source signal separately and keeps the effective decision at zero stake until a later FINAL revision is generated and captured.

## Quote integrity

The adapter proves separately that:

- the selected quote identity equals the P1-M2 certified quote;
- the line equals the certified line;
- quote age is within the P1-M3A five-minute boundary;
- a valid opposite-side price exists.

A missing bilateral price does not invalidate the scientific source capture under P1-M3A, but P1-M4A returns `BILATERAL_PRICE_REQUIRED` and the effective decision is `BLOCKED` with zero units.

## Attachment and digest behavior

The attachment function:

1. validates the original P1-M3A candidate;
2. builds the P1-M4B adapter result;
3. clones the scientific candidate;
4. adds `analysis.layers.p1M4bEconomicDecision`;
5. recomputes the complete P1-M3A snapshot SHA-256 digest;
6. validates the enriched candidate again;
7. returns the enriched candidate only when every validation passes.

The operation is idempotent when an existing layer has the same P1-M4B schema and source digest.

A pre-existing layer with another schema or source digest returns:

```text
P1_M4B_LAYER_CONFLICT
```

It is rejected rather than overwritten.

## Ledger compatibility

P1-M4B performs no ledger write.

The existing P1-M3A ledger mapper already carries snapshot analysis layers into `mlb-ledger.v1`. Therefore, after a caller explicitly submits the enriched P1-M3A candidate through the existing authenticated capture service, the economic layer survives inside:

```text
analysis.layers.p1M4bEconomicDecision
```

The original ledger decision fields continue to represent the original model output. The attached P1-M4B layer represents the separate economic interpretation and effective safety ceiling.

## Safety invariants

Every adapter result declares:

```text
mode = SHADOW_DECISION_SUPPORT
realFinancialExposure = 0
automaticBetPlacement = false
sportsbookIntegration = false
automaticModelChangesAllowed = false
automaticPromotionAllowed = false
originalModelOutputMutated = false
ledgerWritePerformed = false
```

P1-M4B does not:

- register an endpoint;
- change predictor UI;
- alter model formulas or probabilities;
- alter P1-M2 readiness;
- create a pick;
- place a wager;
- connect to a sportsbook;
- write or settle the ledger;
- increase real financial exposure;
- promote SHADOW policy to real-money use.

## Next phase

### P1-M4C — Actionable decision card

P1-M4C should render the attached adapter layer and clearly distinguish:

- original model signal;
- raw P1-M4A economic signal;
- effective decision after the source-signal ceiling;
- FINAL versus PROVISIONAL actionability;
- current, fair and minimum acceptable prices;
- EV, edge and no-vig edge;
- zero-stake block reasons;
- SHADOW-only analytical units.

The UI must not display an economic upgrade as an actionable BET when the original source model emitted LEAN, PASS or INFO.
