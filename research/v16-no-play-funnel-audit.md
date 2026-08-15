# V16 No-Play Funnel Audit

This branch is diagnostic only. It does not change V16 probabilities, features, frozen classifier thresholds, shortlist qualification, the intrinsic discovery cap, intrinsic thesis rules, odds acquisition, market-edge economics, operating-envelope eligibility, Elite labels, stake, or final recommendation behavior.

## Question

When V16 produces no actionable candidate, identify the earliest blocking stage instead of assuming the model lacks conviction or the Elite thresholds are too strict.

A critical architectural distinction is preserved: V16 scores every FINAL cheap-screen-eligible game, while price discovery is authorized by an upstream shortlist/intrinsic route that does not use the V16 win probability. Therefore a game may have a valid V16 sporting probability and still never reach the sportsbook-price boundary.

## Frozen funnel

1. Daily slate.
2. Analysis eligibility and FINAL pregame inputs.
3. V16 price-independent game probability.
4. Certified-signal shortlist evaluation and qualification.
5. Intrinsic evaluation.
6. Selection into the capped intrinsic market-discovery population.
7. Strong intrinsic market thesis and planned market(s).
8. Paid lookup eligibility.
9. Fresh executable price.
10. Market-specific model/price validation.
11. Positive EV.
12. Operating-envelope disposition.
13. Elite evidence candidate and evidence-row capture.

## Diagnostic interpretation

The audit exposes the sporting prediction separately from routing and betting economics. For every FINAL V16-scored game it reports the Full Game and F5 probabilities, then shows whether the game survived each pre-price routing stage before any price is considered.

A no-play can therefore be attributed to one of several distinct causes: missing certified shortlist signal, exclusion by the intrinsic discovery cap, no strong intrinsic thesis, no fresh executable quote, blocked model/market contract, non-positive EV at the available price, or a downstream operating-envelope blocker.

The audit may expose probabilities, counts, routing state, blocker codes and price/EV disposition. It may not loosen a threshold, change a route, create a final wager, calculate stake, or place a bet.
