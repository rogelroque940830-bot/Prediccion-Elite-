# P1 PREMIUM without ULTRA — prospective tracker UI

## Purpose

Show the authenticated read-only prospective economic hypothesis directly inside the existing MLB economic-review page, beside `Condiciones Élite MLB`.

The card is an observer only. It does not change the Predictor and does not turn research support into a real-money instruction.

## Source

The browser performs authenticated GET-only reads from:

`/api/mlb/p1/v1/premium-no-ultra-prospective`

The frontend parser requires the frozen backend schema and rejects:

- cutoff or rule-semantics drift;
- candidate-definition drift;
- broken independent-game accounting;
- inconsistent criteria/support state;
- `operationalMoneyGateAllowed=true`;
- stake changes;
- automatic betting;
- automatic model changes;
- automatic promotion;
- restoration of old ULTRA as a money gate.

## What the user sees

`Edge Prospectivo F5 · PREMIUM sin ULTRA` shows:

- current state: collecting / not confirmed / research-supported;
- settled candidate progress toward 50;
- candidate-date progress toward 20;
- control settled/date progress;
- candidate and control W-L, hit rate, flat-1u ROI and units;
- CLV, Brier, log loss and calibration when available;
- preregistered 95% bootstrap ROI intervals once inference is eligible;
- blockers returned by the backend;
- an explicit warning that even research support leaves the money gate off.

The historical 13-4 / +28.05% post-hoc sample is never displayed as confirmation progress. The new counter begins after the frozen 2026-08-08 cutoff.

## Safety

The UI performs no POST/PUT/PATCH/DELETE request, no ledger or settlement write, no sportsbook action, no stake change and no automatic model/promotion action.

The card never labels the hypothesis as profitable merely because current hit rate or point ROI is positive. Only the backend's preregistered state can show `Edge respaldado · investigación`, and even that state remains explicitly non-operational.
