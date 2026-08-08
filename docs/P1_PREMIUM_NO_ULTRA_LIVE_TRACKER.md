# P1 PREMIUM no-ULTRA live tracker

This adapter exposes the preregistered `FINAL + F5_ML + selected PREMIUM + selected !ULTRA` prospective hypothesis as an authenticated, owner-scoped, read-only report.

## Endpoint

`GET /api/mlb/p1/v1/premium-no-ultra-prospective`

The route:
- requires the existing authenticated interactive session;
- reads only prediction IDs owned by the authenticated user;
- resolves those IDs against the immutable MLB ledger;
- rebuilds the existing P1-M3D terminal economic review;
- fails closed if the upstream terminal review appears truncated;
- passes the complete review rows plus their original immutable records into `buildMlbPremiumNoUltraProspective`.

## Frozen scientific semantics

The route does not redefine the hypothesis. The underlying contract remains frozen to the #372 evidence cutoff:
- cutoff `2026-08-08T04:32:33Z`;
- F5 ML only;
- FINAL only;
- interactive app only;
- pregame only;
- selected `finalRecommendation` only;
- candidate is selected `PREMIUM` without selected `ULTRA`;
- one independent latest classifiable FINAL F5 decision per game;
- historical 13-4 development/post-hoc observations excluded from prospective confirmation.

## No-money boundary

The live tracker is observational research infrastructure. It does not authorize a wager even if the report eventually reaches `ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY`.

It performs no ledger writes, settlement writes, sportsbook calls, stake changes, model/probability changes, threshold changes, automatic promotion, or automatic betting.
