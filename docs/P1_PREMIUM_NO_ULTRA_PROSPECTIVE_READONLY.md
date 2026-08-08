# P1 PREMIUM without ULTRA — authenticated read-only tracker

## Objective

Expose the preregistered `FINAL F5_ML + PREMIUM + !ULTRA` prospective economic hypothesis as an authenticated owner-scoped read-only review.

This surface does **not** change the hypothesis, classify new observations differently, place bets, change stakes, or write to the ledger. It only recomputes the frozen prospective report from the user's immutable records.

## Endpoint

`GET /api/mlb/p1/v1/premium-no-ultra-prospective`

Requirements:

- authenticated interactive MLB session;
- owner-scoped ledger records only;
- existing P1-M3D terminal lifecycle review;
- complete M3D row window.

If P1-M3D reports more unique analytical decisions than its returned row window contains, the endpoint fails closed with HTTP 409 and `PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED` rather than analyzing a truncated cohort.

## Frozen scientific contract

The runtime adapter calls the already-merged `courtedge-p1-premium-no-ultra-prospective.v1` contract unchanged.

The underlying hypothesis remains frozen to:

- prospective cutoff `2026-08-08T04:32:33Z`;
- evidence/rule-semantics commit `a2bc70badc97251f2f0333beb1b2b954f841fad0`;
- F5_ML only;
- FINAL only;
- interactive app, pregame only;
- selected frozen `finalRecommendation` semantics;
- `isPremium === true` and selected reason without `ULTRA`;
- one latest classifiable FINAL F5 decision per game;
- historical 13-4 post-hoc cohort excluded.

## Returned progress

The response contains the same report used by the research contract, including:

- state (`COLLECTING_PROSPECTIVE_EVIDENCE`, `CANDIDATE_NOT_CONFIRMED`, or `ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY`);
- candidate/control game counts;
- settled counts and distinct dates;
- ROI, profit, Brier, log loss, calibration and CLV when scoreable;
- bootstrap intervals once registered sample minimums are reached;
- explicit blockers and every no-money safety flag.

## Safety

This is a GET-only observer.

It performs:

- no prediction writes;
- no settlement writes;
- no ledger mutation;
- no sportsbook call;
- no stake changes;
- no automatic bet;
- no model or threshold change;
- no automatic promotion.

Even `ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY` remains research support only. A future operational money gate, if ever justified, requires a separate explicit and auditable stage.
