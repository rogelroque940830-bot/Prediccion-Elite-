# P1-M5A — Real Interactive Cohort Activation UI

## Objective

P1-M5A adds a visible, server-authoritative activation certificate to the private **Rendimiento MLB** page.

The card answers whether at least one real user-triggered MLB decision completed the same end-to-end lifecycle:

```text
Generar Predicción → P1-M3 capture → P1-M4 economics → immutable settlement → P1-M3D review
```

It does not prove profitability and does not authorize money, model changes or promotion.

## Source of truth

The browser reads the existing authenticated endpoint:

```text
GET /api/mlb/p1/v1/economic-review
```

The activation wrapper and the existing economic page share the same React Query key, so they consume the same cached server response. The browser does not recompute activation state, ROI, CLV, Brier, Log Loss, EV or settlement results.

## Visible states

- **Esperando primera predicción real**
- **Captura real registrada**
- **Decisión económica registrada**
- **Cohorte real certificada de extremo a extremo**
- **Certificación bloqueada por integridad**

The card displays the exact next action returned by the backend.

## Checklist

The card shows backend-certified checks for:

- authenticated owner scope;
- interactive capture from Generar Predicción;
- terminal lifecycle decision;
- valid P1-M4B economic layer;
- official settlement;
- same-decision end-to-end evidence;
- lifecycle integrity;
- analytical identity protection;
- FINAL capture availability;
- CLV availability.

FINAL and CLV are informative. CLV does not block technical activation.

## Fail-closed validation

The frontend rejects the activation block when it contains:

- a foreign schema or release;
- invalid state/next-action combinations;
- a certificate attached to an uncertified state;
- a certified state without same-decision evidence;
- count drift against the P1-M3D sample;
- profitability conclusions;
- model changes or automatic promotion;
- sportsbook integration or automatic betting;
- production or settlement writes;
- historical ledger mutation;
- synthetic capture creation;
- nonzero real financial exposure.

When rejected, the economic review remains visible but the UI does not claim that the real cohort is activated.

## Safety

P1-M5A UI is read-only. It creates no prediction, pick, settlement, correction, ledger event or wager. It preserves SHADOW operation and real financial exposure `0`.
