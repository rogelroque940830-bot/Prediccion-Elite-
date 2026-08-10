# P1-M3D-B — Interactive MLB economic review UI

## Objective

Render the server-authoritative P1-M3D report for the authenticated user's exact interactive MLB evaluations.

The page is available at:

```text
/mlb-economic-review
```

The data source is the private endpoint:

```text
GET /api/mlb/p1/v1/economic-review
```

## Authority boundary

The browser does not recompute:

- profit;
- ROI;
- Brier Score;
- Log Loss;
- CLV;
- effective P1-M4 policy exposure;
- lifecycle leaves;
- duplicate exclusion;
- sample readiness.

It displays the values already calculated by the P1-M3D backend from the immutable, owner-scoped ledger.

The client validates the exact schema, endpoint and safety envelope before rendering any metric. A response that enables conclusions, model changes, promotion, sportsbook integration, writes, automatic betting or nonzero financial exposure is rejected fail-closed.

## Visible sections

The page exposes:

1. the current evidence milestone;
2. interactive and unique-decision sample counts;
3. settled, pending and CLV-covered counts;
4. one-unit flat simulation;
5. effective P1-M4 SHADOW policy simulation;
6. Brier Score, Log Loss, model probability, observed win rate, market probability, edge and CLV;
7. actionable recommendations versus BET/BET_FUERTE and LEAN/PASS/INFO controls;
8. server-provided breakdowns by market, signal, effective decision, actionability, stage and probability band;
9. integrity issues and exclusions;
10. terminal interactive evaluation rows.

## Evidence milestones

The UI preserves the backend interpretation:

- zero settlements: waiting for the first settlement;
- one to four: technical sample only;
- five to nineteen: preliminary review only;
- twenty to forty-nine: collecting the preferred sample;
- fifty or more: ready for explicit human review;
- critical cohort integrity defect: action required.

No state permits automatic conclusions, model changes or promotion.

## Privacy

The navigation item appears only inside the authenticated private navigation set. The endpoint derives ownership from the session and does not accept a client-supplied user ID.

## Safety

P1-M3D-B is read-only:

- no prediction write;
- no pick save;
- no settlement write or correction;
- no historical mutation;
- no sportsbook integration;
- no automatic wager;
- no real financial exposure;
- no browser-side economic recalculation;
- no model change;
- no automatic promotion.
