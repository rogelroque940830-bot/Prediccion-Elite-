# P1-M3F3B2 — Discipline-speed certifiable provenance

## Purpose

P1-M3F3B2 creates a strict certification path for the existing `discipline-speed` calculation without changing its run-adjustment formulas.

The component combines:

- MLB Stats season pitching evidence for each probable starter; and
- Baseball Savant sprint-speed evidence for lineup batters.

## Scientific distinction

A source failure and a legitimate lack of qualified sample are not the same condition.

For pitcher discipline:

- HTTP/transport/JSON failure is a source-integrity failure and blocks certification;
- an HTTP 200 MLB response with a valid stats envelope but no season split is an explicit `NO_SEASON_SAMPLE` result. It may contribute no discipline adjustment, but the source acquisition itself remains certified.

For sprint speed:

- the existing six-hour cache may support certification only while inside its TTL;
- once expired, Savant must refresh successfully;
- an expired snapshot may not be recertified after refresh failure;
- an empty sprint-speed leaderboard is fail-closed.

## Certified snapshot contract

`getDisciplineSpeedCertifiedSnapshot()` emits certification only after both probable-pitcher acquisitions and the sprint-speed source satisfy the rules above.

Certified output includes:

- schema `courtedge-mlb-discipline-speed-evidence.v1`;
- `sourceStatus=CERTIFIED`;
- `generatedAt` equal to the oldest certified observation used by the calculation;
- pitcher sample statuses (`AVAILABLE` or `NO_SEASON_SAMPLE`);
- sprint-speed cache hit and age;
- speed cache maximum age 21,600 seconds;
- `failureDisposition=THROW_FAIL_CLOSED`.

## Backward compatibility and staging

The legacy `getDisciplineSpeedForGame()` surface remains available for existing runtime/UI consumers. P1-M3F3B2 adds a separate strict snapshot path rather than globally changing the existing endpoint in this phase.

P1-M2B is not switched to this certifier yet. The five Advanced Factor certifiers will be integrated together only after all five source contracts pass falsification.

## Safety / non-claims

This phase does not claim live `ADVANCED_FACTORS` is fresh and does not make a model-quality or betting claim.

No model formula, probability, threshold, odds, ledger, settlement, sportsbook, UI, stake/actionability or promotion change is authorized.
