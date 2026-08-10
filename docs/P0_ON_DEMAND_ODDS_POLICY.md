# P0 On-Demand Odds Policy

## Objective

CourtEdge must not spend The Odds API quota merely because the backend is online. Provider-consuming background work is opt-in only.

## Immediate invariant

`MLB_CLOSING_LINE_CAPTURE` defaults to OFF. The MLB closing-line worker may start only when the environment explicitly contains `MLB_CLOSING_LINE_CAPTURE=true`.

Legacy background polling already follows the same explicit opt-in pattern through `LEGACY_ODDS_BACKGROUND_POLLING=true`.

## Target analysis flow

1. User explicitly requests an analysis run.
2. Load the slate and inexpensive/non-odds evidence first.
3. Apply coarse eligibility/readiness filters and discard the majority of games.
4. Build a bounded shortlist of interesting candidates.
5. Query fresh market prices only for the shortlist and only once per bounded analysis run, reusing the five-minute cache within that run.
6. Apply the frozen operating-envelope/ranking rules.
7. Return the small set of strongest Elite candidates; no background provider refresh continues after the requested run.

## Non-goals

This policy does not change model formulas, probabilities, confidence, thresholds, PREMIUM/ULTRA rules, stakes, ledger settlement, sportsbook writes or automatic betting.
