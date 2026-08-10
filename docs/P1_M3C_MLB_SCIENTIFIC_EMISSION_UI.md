# P1-M3C — MLB Scientific Emission UI

## Objective

Connect the exact user-triggered MLB predictor execution to the authenticated P1-M3B append-only capture service.

P1-M3C records the prospective scientific observation produced by **Generar Predicción**. It does not create a canonical pick, place a wager, modify the predictor model, or imply profitability.

## Execution boundary

The emission begins only after all of the following are true:

1. an official `gamePk` is selected;
2. P1-M2B returns `READY_FINAL` or `READY_PROVISIONAL`;
3. P1-M2C confirms the model line and bilateral prices equal the certified market quote;
4. the existing MLB predictor finishes the full calculation;
5. the output for the same certified market can be resolved to one side, one line and one exact price.

The frontend then builds the P1-M3A candidate and posts it to:

```text
POST /api/mlb/p1/v1/scientific-captures
```

## Separation from saved picks

Automatic scientific emission and manual pick saving are different actions.

- **Generar Predicción** emits one SHADOW scientific evaluation.
- **Guardar pick** remains a separate manual operator action.
- P1-M3C never dispatches `ADD_MLB_PICK` in the automatic emission path.
- A PASS, LEAN or INFO evaluation is still emitted so filter performance can be measured.

This separation prevents selection bias and avoids treating every analysis as a betting decision.

## Exact market mapping

Only the P1-M2-certified market is emitted:

| Certified market | Emitted observation |
|---|---|
| `ML` | recommended home or away Moneyline side |
| `F5_ML` | recommended home or away F5 Moneyline side |
| `RUN_LINE` | model-selected team and side-specific line |
| `TOTAL` | model-selected Over or Under |
| `F5_TOTAL` | withheld until exact F5 Over and Under prices exist |

The selected and opposite prices must match the certified quote. Run Line requires the same absolute line, and Total requires the exact same line.

## Candidate construction

The client constructs the merged P1-M3A schema with:

- official game identity and start time from the full P1-M2B report;
- exact readiness status, evidence summary, warnings and evidence digest;
- selected quote, opposite quote, book, source mode, timestamps and provenance digest;
- model probability, market-implied probability, no-vig probability and edge;
- signal, category, confidence, zero-or-bounded recommended SHADOW stake and filter reasons;
- the existing complete `mlb-scientific-snapshot.v1` payload and SHA-256 digest;
- frontend release and unique client evaluation ID;
- mandatory SHADOW safety envelope.

Canonical JSON and SHA-256 follow the P1-M3A server contract. Deployment timestamps and commit metadata remain audit evidence but do not manufacture a new sporting identity.

## Visible states

The results section displays one P1-M3C receipt card:

- `CAPTURING`: request in progress;
- `REGISTRADA`: P1-M3B returned `APPENDED`;
- `IDEMPOTENTE`: the identical semantic evaluation already exists;
- `RECHAZADA`: the candidate or response failed closed.

A rejected capture does not hide the predictor output, but it explicitly states that the execution does not count toward ROI, CLV or calibration.

## Authentication and failure behavior

P1-M3C uses the existing `apiRequest` client, which sends:

- authenticated browser session cookies;
- the current CourtEdge CSRF token;
- same-origin or configured backend routing.

On `401` or `403`, the global authentication-required event remains active. Network, schema, quote and contract failures are visible and never converted into a successful receipt.

## Economic purpose

The emitted observations create prospective evidence for:

- ROI by market and decision class;
- CLV;
- Brier score and log loss;
- FINAL versus PROVISIONAL performance;
- profitability and protection value of PASS/LEAN filters;
- duplicate-free sample size;
- evidence-quality effects.

These metrics can help identify whether a repeatable advantage exists. They do not guarantee profit.

## Safety invariants

P1-M3C preserves:

- `SHADOW_DECISION_SUPPORT`;
- real financial exposure `0`;
- automatic bet placement `false`;
- sportsbook integration absent;
- automatic model changes `false`;
- automatic promotion `false`;
- no formula, probability, market, threshold or stake-policy changes;
- no settlement changes;
- no retrospective capture;
- no automatic canonical pick creation.
