# P1-M5A — Real Interactive Cohort Activation

## Objective

P1-M5A converts the P1-M3D owner-scoped economic review into a verifiable activation sequence for the real interactive MLB cohort.

It answers one operational question:

> Has at least one real user-triggered MLB evaluation completed the exact capture → economic decision → immutable settlement → review path without identity or lifecycle defects?

P1-M5A is an activation certificate. It is not a profitability conclusion, a wagering authorization or a model-promotion mechanism.

## Server-authoritative location

The existing private read-only endpoint remains the single source of truth:

```text
GET /api/mlb/p1/v1/economic-review
```

The P1-M3D report adds:

```text
activation.schemaVersion = courtedge-p1-m5a-real-cohort-activation.v1
```

No endpoint, route, ownership lookup or write path is added.

## Activation sequence

The activation state progresses fail-closed:

| State | Meaning | Next action |
|---|---|---|
| `WAITING_FOR_REAL_CAPTURE` | No terminal interactive P1-M3 decision exists for the authenticated owner. | Generate the first real eligible MLB prediction. |
| `CAPTURE_REGISTERED` | A real interactive capture exists, but no valid P1-M4B economic layer exists. | Generate or correct a valid economic capture through the normal predictor flow. |
| `ECONOMIC_DECISION_REGISTERED` | A terminal capture with valid economics exists, but that same decision has no official settlement. | Wait for the immutable official settlement. |
| `END_TO_END_CERTIFIED` | The same terminal decision has official game identity, valid economics and an immutable settlement. | Review the real cohort descriptively in Rendimiento MLB. |
| `BLOCKED_INTEGRITY` | Owner scope, terminal-leaf policy, lifecycle integrity or analytical uniqueness is not proven. | Resolve the integrity defect before certification. |

## Same-decision requirement

Certification cannot be assembled from unrelated records.

The certifying row must itself contain:

- a positive official `gamePk`;
- one non-empty lifecycle key;
- one immutable prediction ID;
- a valid recorded timestamp;
- a valid P1-M4B economic layer;
- one official settlement result;
- one valid settlement timestamp.

A settled invalid capture plus a separate pending valid capture does not certify the path.

## Integrity requirements

Certification requires all of the following:

- authenticated owner-scoped report;
- only terminal supersession leaves evaluated;
- exactly one terminal leaf per lifecycle;
- no malformed interactive capture excluded;
- no lifecycle branch conflict;
- no analytical duplicate excluded.

When an integrity defect exists, the state is `BLOCKED_INTEGRITY` even if an otherwise eligible settled row exists.

## CLV treatment

Closing-line evidence is valuable but not universally available or comparable. Therefore:

- `clvEvidenceObserved` is reported;
- the certificate records whether its row has CLV;
- CLV is not required to activate the technical end-to-end pipeline;
- absence of CLV does not imply good or bad performance.

## Deterministic certificate

When multiple eligible decisions exist, the certificate uses the earliest official settlement, then the earliest capture timestamp, then prediction ID. This makes the activation evidence deterministic across deployments.

The certificate exposes no user ID and contains only the sporting and analytical identity needed for review.

## Economic and safety boundary

P1-M5A explicitly preserves:

- SHADOW-only operation;
- real financial exposure `0`;
- no sportsbook integration;
- no automatic wager;
- no production write;
- no settlement write;
- no historical ledger mutation;
- no synthetic capture creation;
- no automatic model change;
- no automatic promotion;
- no profitability conclusion.

The existing P1-M3D sample milestones remain descriptive. `END_TO_END_CERTIFIED` proves that the technical real-data circuit works; it does not prove that the model has positive expected value.
