# P1-M3E — Operating Envelope UI

## Objective

Expose the already-validated P1-M3E operating-envelope result inside the authenticated MLB economic-review surface so the user can learn **when the existing predictor is demonstrably stronger** without changing the underlying probabilities.

The frontend consumes only:

`GET /api/mlb/p1/v1/operating-envelope`

through the existing `fetchJson` client, which always sends browser credentials with `credentials: "include"`.

## Scientific states

The UI renders the backend state exactly:

- `INSUFFICIENT_SAMPLE` — not enough scoreable observations and/or unique dates;
- `NO_DISCOVERY_RULE` — no preregistered pregame rule cleared the discovery quality gates;
- `CANDIDATE_NOT_CONFIRMED` — a discovery candidate did not survive later chronological confirmation;
- `ELITE_MODEL_QUALITY_SUPPORTED` — a frozen pregame rule survived chronological confirmation with supported proper-score improvement and accepted calibration/sample/coverage gates.

The UI never derives or upgrades the state locally.

## What the panel shows

- scoreable observations versus the registered minimum;
- unique game dates versus the registered minimum;
- chronological discovery and confirmation sizes;
- the exact one- or two-atom pregame rule selected by the backend;
- selected versus rejected confirmation log loss and Brier score;
- observed probability/calibration context;
- confirmation coverage;
- deterministic date-cluster bootstrap intervals for log-loss and Brier improvement;
- calibration/sample/coverage confirmation gates;
- backend blockers.

## Interpretation boundary

`ELITE_MODEL_QUALITY_SUPPORTED` means only that the model-quality operating envelope received prospective chronological support under the P1-M3E methodology.

It does **not** mean:

- guaranteed wins;
- profitability certification;
- automatic betting;
- stake changes;
- probability changes;
- threshold changes;
- automatic model promotion.

The frontend parser rejects any response where one of these backend safety flags becomes true:

- `economicProfitabilityCertified`;
- `operationalGateAllowed`;
- `modelProbabilityChanged`;
- `existingEconomicThresholdsChanged`;
- `automaticModelChangesAllowed`;
- `automaticPromotionAllowed`.

It also rejects a report where `temporalSplit.leakageFree !== true` or cohort/split accounting is inconsistent.

## Authentication and privacy

The UI does not contain credentials and does not implement a second authentication path. It reuses the existing CourtEdge browser session. The backend remains owner-scoped and returns HTTP 401 without an interactive authenticated session.

No owner metrics are made public to enable this panel.

## Failure behavior

If the read-only backend reports `P1_M3E_SOURCE_WINDOW_TRUNCATED`, the frontend displays the backend error and does not render an elite label. The correct response to that state is to repair the upstream complete-row read window, not to lower sample requirements or analyze a truncated cohort.

## Write boundary

This frontend feature performs GET-only reads. It does not create predictions, settlements, ledger events, sportsbook requests, bets or financial exposure.
