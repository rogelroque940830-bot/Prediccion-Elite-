# P1-M3B — Authenticated MLB Scientific Capture Service

## Objective

P1-M3B implements the server-side append-only service required by the merged P1-M3A contract.

It records the exact interactive MLB evaluation produced after P1-M2 authorizes the selected game and market. The service does not calculate a new prediction and does not replace S5C. It preserves the user-triggered predictor output as a separate scientific cohort that can later be settled and evaluated by the existing S5B/S6 infrastructure.

The service schema is:

```text
courtedge-p1-m3b-scientific-capture-service.v1
```

The endpoint is:

```http
POST /api/mlb/p1/v1/scientific-captures
```

## Economic purpose

A profitable-looking record is not trustworthy unless the system can prove:

- which official game and market were evaluated;
- the exact price and line used by the model;
- the pregame gate state at that moment;
- model, implied and no-vig probabilities;
- the edge arithmetic;
- the signal, category and filter reasons;
- whether the evaluation was FINAL or PROVISIONAL;
- whether the event is a new decision, an idempotent retry or a valid revision;
- who owns the record;
- that no real wager was placed.

P1-M3B enforces those conditions before anything reaches `mlb-ledger.v1`.

It does not promise profit. It creates the evidence needed to measure ROI, Brier score, log loss, closing-line value and filter performance without duplicate or selectively recorded observations.

## Authentication boundary

Interactive capture requires all of the following:

1. an authenticated CourtEdge user session;
2. a valid `X-CourtEdge-CSRF` token through the existing write middleware;
3. role `admin` or `analyst`;
4. the session flag `courtEdgeAuthenticated = true`;
5. ownership derived from the server-side session.

A service write token alone cannot create an interactive capture. The request body cannot contain or select a `userId`; the top-level request schema is strict and rejects extra ownership fields.

Viewer sessions remain read-only.

## Server flow

```text
Authenticated POST
        ↓
Strict P1-M3B request schema
        ↓
P1-M3A economic-integrity validation using server time
        ↓
Stable lifecycle and semantic identity
        ↓
Read only this authenticated user's prior P1 captures
        ↓
Revision decision
        ↓
Append through appendOwnedPrediction
        ↓
Verify immutable ownership binding
        ↓
Return compact capture receipt
```

## Validation

The service revalidates the complete P1-M3A candidate. Important failures include:

- malformed or extra request fields;
- blocked or stale P1-M2 readiness;
- quote different from the certified quote;
- stale or invalid American odds;
- incompatible market and side;
- missing line where required;
- implied-probability mismatch;
- edge arithmetic mismatch;
- capture at or after first pitch;
- invalid signal/category or stake combination;
- modified scientific snapshot digest;
- oversized snapshot;
- unredacted secret, token, cookie, password, session or CSRF data;
- any nonzero real financial exposure or enabled automatic action.

Validation uses the backend clock. Client timestamps do not determine current time.

## Ownership and isolation

The service receives the authenticated user ID from the route middleware and passes it to the existing ownership layer.

`appendOwnedPrediction` scopes the deterministic P1-M3A client request ID by user. Therefore two users may capture the same semantic sports decision while receiving separate prediction IDs and immutable ownership records.

Prior revisions are searched only inside the authenticated user's records. A user's record can never supersede another user's record.

## Idempotency and revisions

The service uses the P1-M3A lifecycle key and semantic fingerprint.

### New lifecycle

No previous owned P1 capture exists for the lifecycle:

```text
NEW_CHAIN → APPENDED
```

### Identical retry

The current semantic fingerprint equals the latest owned capture:

```text
IDEMPOTENT_RETRY → no new ledger row
```

The service also retains SQLite `clientRequestId` idempotency as a second protection against simultaneous identical requests.

### Material revision

The game, market, selection and line remain stable while price, readiness, stage or model output changes:

```text
APPEND_SUPERSEDING_REVISION → new immutable row with supersedesId
```

### Rejected revision

- different lifecycle cannot be linked;
- older or equal client capture time cannot replace a newer revision;
- PROVISIONAL cannot supersede FINAL.

No existing prediction is updated or deleted.

## Concurrency

Requests for the same authenticated user and lifecycle are serialized in the backend process. This prevents two simultaneous interactive requests from creating parallel revisions in the deployed single-service runtime.

The database client-request constraint remains the authoritative idempotency protection for identical semantic requests.

## Ledger mapping

P1-M3B reuses the P1-M3A adapter and writes through the existing ownership API.

The ledger record preserves:

- `mlb-ledger.v1` first-class game, market, odds, probability, signal and stage columns;
- `analysis.layers.p1M3aCapture` with readiness, certified quote, identity and safety;
- `analysis.layers.p1M3bCapture` with endpoint, server receive time, authenticated-session authority and revision decision;
- existing factors, sources, injury audit, raw inputs and raw outputs from the scientific snapshot.

The service does not call `MlbLedgerStore.appendPrediction` directly. It must always use `appendOwnedPrediction`.

## Response

A successful new append returns HTTP `201`.

An identical retry returns HTTP `200`.

The compact receipt contains:

- P1-M3B schema and endpoint;
- `APPENDED` or `IDEMPOTENT`;
- prediction ID and server ledger timestamp;
- lifecycle key and semantic fingerprint;
- validation decision;
- revision decision and `supersedesId`;
- authenticated ownership confirmation;
- zero-exposure safety state.

The endpoint does not echo the full raw scientific snapshot.

## Error classes

- `400 MALFORMED_CAPTURE_CANDIDATE`: request structure or forbidden extra fields;
- `401 INTERACTIVE_SESSION_REQUIRED`: no authenticated interactive session;
- `403`: invalid CSRF or viewer role;
- `409 REJECT_STAGE_REGRESSION` or `REJECT_STALE_REVISION`;
- `422 P1_M3A_CAPTURE_REJECTED`: economic-integrity contract failure;
- `500`: unexpected persistence or ownership verification failure.

No rejected request writes a new ledger row.

## Safety boundary

Every accepted capture retains:

```text
mode = SHADOW_DECISION_SUPPORT
realFinancialExposure = 0
automaticBetPlacement = false
automaticModelChangesAllowed = false
automaticPromotionAllowed = false
```

P1-M3B does not:

- connect to a sportsbook account;
- place a wager;
- change model formulas or probabilities;
- change signals, markets, thresholds or stake policy;
- settle games;
- alter previous ledger records;
- enable automatic model promotion.

## Validation requirements

Before merge:

- focused TypeScript passes;
- deterministic SQLite service tests pass;
- authenticated-session and ownership isolation tests pass;
- idempotency and concurrent retry tests pass;
- PROVISIONAL-to-FINAL and stage-regression tests pass;
- malformed, stale and forged-owner requests fail closed;
- route contract and security regressions pass;
- production backend builds;
- P1-M3A, P1-M2, S5A and S5B regressions remain green;
- diff scope contains no frontend, model or sportsbook changes.

## Next phase

P1-M3C will make the MLB predictor frontend emit the P1-M3A candidate to this endpoint immediately after a successful user-triggered model calculation.

P1-M3C must display capture success, idempotency or rejection clearly. A model result must never be presented as scientifically recorded unless the backend returns a valid P1-M3B receipt.
