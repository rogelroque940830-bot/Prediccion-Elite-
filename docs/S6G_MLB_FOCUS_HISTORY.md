# S6G — MLB Focus History

## Objective

Reduce the user-facing MLB history overload without deleting or mutating any scientific evidence.

The default MLB history route now presents a compact decision queue instead of the complete ledger stream.

## Default views

- `Prioridad`: at most five pregame decisions with positive edge and an existing actionable or secondary review signal.
- `Esperando`: at most eight pregame decisions that still have analytical interest but are not in the first review queue.
- `Resultados`: the eight most recent settled unique decisions.
- `Auditoría completa`: preserves the existing full ledger, injury calibration, outcome, verdict and closing-line panels.

## Presentation rules

- analytical duplicates are excluded from the focused view;
- repeated revisions of the same game, market, selection and line are collapsed;
- a settled or FINAL revision is preferred over an earlier PROVISIONAL revision;
- PASS, non-positive edge, already-started pending games and study-only records are hidden from the default page;
- the complete immutable ledger remains available at `/mlb-history-audit`;
- no prediction, settlement or audit record is deleted.

## Safety boundary

S6G changes only frontend presentation and ordering. It does not change:

- predictor formulas or probabilities;
- supported markets, filters, vetoes or thresholds;
- S5C, S5E or S5F workers;
- ledger persistence or settlement;
- CLV calculation;
- stake policy;
- sportsbook integration or wager placement.
