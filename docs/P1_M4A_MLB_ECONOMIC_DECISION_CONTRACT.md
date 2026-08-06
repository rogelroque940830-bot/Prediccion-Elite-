# P1-M4A — MLB Economic Decision and Minimum Acceptable Price Contract

## Objective

P1-M4A defines the versioned economic interpretation applied after an MLB market passes P1-M2 readiness and the predictor produces a selected-side probability.

The contract answers five separate questions:

1. What is the model's break-even or fair price?
2. What is the worst price that still preserves the existing LEAN or BET edge floor?
3. Is the current certified price economically acceptable?
4. Is the observation actionable now, waiting for FINAL confirmation, or a PASS?
5. What bounded SHADOW analytical stake is associated with the decision?

P1-M4A does not claim profitability. It prevents a model preference from being confused with a value bet and creates a deterministic price-discipline layer that can be evaluated later through ROI, CLV and calibration.

The schema is:

```text
courtedge-p1-m4a-economic-decision-contract.v1
```

This phase is contract-only. It does not register an endpoint, write to the ledger, change the frontend, place a wager or alter an existing model probability.

## Existing model behavior preserved

The main MLB Moneyline/F5 signal helper currently uses strict thresholds:

```text
BET  = edge > 8 percentage points AND selected-side probability >= 70%
LEAN = edge > 3 percentage points
PASS = otherwise
```

The previous helper accepted the home-team probability and therefore expressed confidence as `>= 70%` or `<= 30%`. P1-M4A receives the already selected side, so the equivalent unambiguous requirement is:

```text
selectedSideProbability >= 70%
```

P1-M4A versions these thresholds without changing them. Run Line and Total currently have separate sport-model classification rules; P1-M4B must adapt their selected-side probability into this economic contract without silently replacing those underlying formulas.

## Required input

The contract receives:

- supported market;
- `FINAL` or `PROVISIONAL` stage;
- exact P1-M2 gate status;
- blockers and warnings;
- selected-side model probability;
- current certified American price;
- selected-side no-vig probability when bilateral prices exist;
- proof that quote and line equal the certified P1-M2 values;
- quote freshness;
- bilateral price availability.

A missing or failed integrity proof is not an economic disagreement. It is a hard block.

## Price representation

American prices are display values and cannot be ordered safely as ordinary numbers across favorites and underdogs.

Examples:

```text
-110 -> decimal 1.909091
+110 -> decimal 2.100000
```

A higher decimal price is always economically better for the same outcome. Therefore P1-M4A converts all prices to decimal odds before comparing the current price with the minimum acceptable price.

The contract rejects non-standard American values between `-99` and `+99`.

## Fair price

For selected-side model probability `p`:

```text
fairDecimal = 1 / p
```

The fair American price is the equivalent standard display price. It is the zero-EV break-even estimate and is informational; it is not automatically a recommendation.

Example:

```text
p = 0.60
fair decimal = 1.666667
fair American = -150
```

## Market-implied probability and edge

For decimal price `d`:

```text
marketImplied = 1 / d
edgePp = (modelProbability - marketImplied) * 100
```

When a no-vig probability is available:

```text
noVigEdgePp = (modelProbability - noVigProbability) * 100
```

The raw market-implied edge determines parity with the existing signal helper. The no-vig edge is retained as a separate diagnostic and must not silently replace the current threshold basis in P1-M4A.

## Minimum acceptable price

For an edge floor `e` in percentage points:

```text
maximumAcceptableImpliedProbability = p - e / 100
minimumAcceptableDecimal = 1 / maximumAcceptableImpliedProbability
```

Because the existing thresholds are strict (`>`), the returned integer American price must produce implied probability strictly below that boundary.

Examples:

| Model probability | LEAN floor (>3 pp) | BET floor (>8 pp) |
|---:|---:|---:|
| 57% | -117 | +105 |
| 60% | -132 | -108 |

For a 57% model probability:

- `-118` does not preserve more than 3 percentage points of edge;
- `-117` does;
- `+104` does not preserve more than 8 points;
- `+105` does.

The displayed phrase **minimum acceptable price** means the minimum payout quality, not the numerically smallest American integer.

## Expected value

Expected profit per one simulated unit is:

```text
EV per unit = p * decimalOdds - 1
```

Interpretation:

- `+0.08` means an estimated eight cents of profit per one unit staked over a sufficiently large, correctly calibrated sample;
- `0` is break-even before practical frictions;
- a negative value cannot produce BET or LEAN actionability.

EV is a model estimate, not guaranteed money. Calibration error, stale information and market movement can eliminate the apparent value.

## Decision and actionability

P1-M4A separates the model signal from the operational decision.

### FINAL

A `BET` is `ACTIONABLE_FINAL` only when all of these are true:

- gate is `READY_FINAL` and stage is `FINAL`;
- no blockers exist;
- quote and line match P1-M2 certification;
- quote is fresh and bilateral;
- probability and American price are valid;
- edge is strictly greater than eight percentage points;
- selected-side probability is at least 70%;
- EV is positive;
- current price meets the BET minimum.

A FINAL `LEAN` remains `OBSERVE_ONLY` with zero stake. It is evidence of possible value, not permission to increase financial exposure.

A PASS remains `OBSERVE_ONLY` unless an integrity failure makes it `BLOCKED`.

### PROVISIONAL

A PROVISIONAL calculation preserves the raw `modelSignal` for scientific evaluation, but the operational output is:

```text
decision = LEAN
actionability = WAIT_FOR_FINAL
analytical stake = 0
```

This prevents unconfirmed lineups or other pending required evidence from producing an actionable recommendation while still preserving the observation for later comparison.

## Mandatory PASS or block reasons

P1-M4A records explicit reason codes for:

- gate/status-stage mismatch;
- readiness blockers;
- certified quote mismatch;
- certified line mismatch;
- stale quote;
- missing bilateral price;
- invalid model probability;
- invalid American odds;
- non-positive EV;
- edge below the LEAN floor;
- edge above eight points without the confidence floor;
- current price worse than the applicable minimum;
- PROVISIONAL evaluation awaiting FINAL confirmation.

Hard integrity failures return `PASS + BLOCKED`. Economic insufficiency returns `PASS + OBSERVE_ONLY`.

## Kelly and stake boundary

P1-M4A records full Kelly for diagnostics and retains the existing quarter-Kelly fallback as a versioned policy:

```text
quarterKelly = max(0, fullKelly) * 0.25
```

The existing frontend represents the resulting analytical stake in percentage-style units and caps it at one unit. P1-M4A preserves that behavior:

```text
analyticalUnits = min(1, quarterKelly * 100)
```

A nonzero analytical stake is allowed only for `FINAL + BET + ACTIONABLE_FINAL`.

LEAN, PASS, PROVISIONAL and all blocked decisions must have zero stake.

The stake is simulation metadata only. It is not a command to place a wager.

## Safety invariants

Every result includes:

```text
mode = SHADOW_DECISION_SUPPORT
realFinancialExposure = 0
automaticBetPlacement = false
sportsbookIntegration = false
automaticModelChangesAllowed = false
automaticPromotionAllowed = false
```

P1-M4A does not:

- connect to a sportsbook;
- place or recommend an automatic wager;
- change MLB formulas or probabilities;
- modify P1-M2 readiness;
- change current signal thresholds;
- write a prediction or pick;
- settle a record;
- modify historical ledger rows;
- promote a policy to real-money operation.

## Economic interpretation

The purpose is disciplined capital protection and prospective measurement.

A displayed positive EV is not proof of an exploitable edge. Before any human consideration of real-money use, the policy should demonstrate across a clean settled sample:

- positive ROI with uncertainty bounds;
- positive or stable CLV;
- acceptable Brier score and log loss;
- robustness by market and price band;
- FINAL performance superior to or consistent with PROVISIONAL observations;
- no dependence on a few outlier wins;
- stable results after duplicate and data-quality exclusions.

## Next phases

### P1-M4B — Economic decision adapter

- adapt the existing selected market output to P1-M4A;
- preserve original model probability and signal evidence;
- attach the economic decision to the scientific capture;
- version any differences between ML/F5 and Run Line/Total adapters;
- do not change model formulas silently.

### P1-M4C — Actionable decision card

Display in the predictor:

- decision and actionability;
- selection and certified current price;
- fair price;
- minimum acceptable price;
- model, implied and no-vig probabilities;
- edge and EV per unit;
- SHADOW stake;
- reason codes and invalidation conditions.

The card must say clearly when a price moved beyond the acceptable limit and when a PROVISIONAL observation is waiting for FINAL confirmation.
