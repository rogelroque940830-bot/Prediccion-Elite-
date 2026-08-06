# P1-M4C — MLB Economic Decision Card

## Objective

Display the server-produced P1-M4B economic decision immediately after an authenticated scientific capture succeeds. The frontend does not recalculate probability, EV, fair price, minimum acceptable price or stake.

## Authoritative source

The card accepts only a structurally valid `courtedge-p1-m4b-economic-decision-adapter.v1` object returned inside the P1-M3B capture response. Missing economics, weakened SHADOW safety or an incomplete price structure invalidates the response and prevents the card from rendering as successful.

## Visible fields

- certified selection and current price;
- original model signal and effective protected decision;
- FINAL or PROVISIONAL stage;
- actionability: `ACTIONABLE_FINAL`, `WAIT_FOR_FINAL`, `OBSERVE_ONLY` or `BLOCKED`;
- fair price and active minimum acceptable price;
- model, implied and no-vig probabilities;
- raw and no-vig edge;
- EV per unit;
- quarter-Kelly diagnostic and bounded SHADOW units;
- reason codes and invalidation conditions;
- source-signal ceiling status;
- explicit exposure-zero and no-sportsbook language.

## User interpretation

`ACTIONABLE_FINAL` means only that the versioned SHADOW contract passed at the certified price. It does not place a wager or guarantee profit.

`WAIT_FOR_FINAL` keeps the observation visible with zero units until FINAL evidence and a fresh price are certified.

`OBSERVE_ONLY` means the output is useful for measurement but is not an actionable recommendation.

`BLOCKED` indicates a failed integrity or price requirement.

## Separation from existing market cards

The P1-M4C card is the authoritative economic interpretation for the single P1-M2-certified market. Existing per-market model cards remain diagnostic and are not rewritten in this phase.

## Safety

The card cannot send a sportsbook order, change a model, promote a policy, settle a result or create financial exposure. It renders the server response already associated with the scientific receipt.
