# P1-M3A — MLB Scientific Capture Contract

## Objective

P1-M3A defines the exact immutable record that must be produced when the operator presses **Generate Prediction** after the P1-M2 pregame gate authorizes an MLB market.

The economic purpose is not to claim guaranteed profit. It is to create evidence strong enough to determine:

- which markets produce positive or negative simulated ROI;
- whether model probabilities are calibrated;
- whether positive edge survives closing-line comparison;
- whether FINAL evaluations outperform PROVISIONAL evaluations;
- whether PREMIUM/ELITE recommendations outperform PASS, LEAN and INFO controls;
- which filters protect capital and which filters remove profitable opportunities.

Without a complete capture contract, apparent profit can be created by duplicate observations, stale prices, invalid American odds, mismatched lines, retrospective revisions or selective recording.

## Existing infrastructure reused

P1-M3A does **not** create a parallel analytics system.

It targets the existing infrastructure:

- immutable target: `mlb-ledger.v1`;
- scientific payload: `mlb-scientific-snapshot.v1`;
- pregame authorization: `courtedge-p1-m2b-pregame-readiness.v1`;
- readiness policy: `courtedge-p1-m2a-pregame-readiness-contract.v1`;
- evaluation and metrics: S5B `mlb-shadow-evaluation.v1`;
- automated comparison cohort: S5C shadow ingestion;
- later official settlement, closing-line and calibration services.

The new contract schema is:

```text
courtedge-p1-m3a-scientific-capture-contract.v1
```

P1-M3A is contract-only. It does not register a route and does not write to the ledger. P1-M3B will implement authenticated append-only storage against this fixed contract.

## Confirmed gaps

### Interactive execution is not the same as S5C

S5C is valuable because it automatically recomputes the full slate through backend routes. It is not proof of the exact user-triggered evaluation visible in MLB Predictor.

The interactive record must therefore preserve a separate origin:

```text
INTERACTIVE_MLB_PREDICTOR
```

S5C remains an independent prospective comparison cohort.

### P1-M2 authorization must survive capture

A stored prediction is economically valid only when the record proves:

- the exact `gamePk` and selected market;
- P1-M2B returned `READY_FINAL` or `READY_PROVISIONAL`;
- there were no blockers;
- the analysis stage matches the gate;
- the evidence snapshot has a deterministic digest;
- the quote used by the model is exactly equal to the certified quote.

### Price integrity is mandatory

The contract rejects:

- non-standard American odds between `-99` and `+99`;
- stale prices older than five minutes;
- missing book/source identity;
- missing line on Run Line and Total markets;
- market/side incompatibility;
- a stored implied probability that disagrees with the price by more than 0.75 percentage points;
- an edge that disagrees with `modelProbability - marketImpliedProbability` by more than 0.75 percentage points.

### Control decisions are part of the sample

The contract captures:

- `BET_FUERTE` and `BET` as `ACCEPTED`;
- `PASS` as `BLOCKED` control evidence;
- `LEAN` and `INFO` as `OBSERVED` control evidence.

PASS, LEAN and INFO must have zero recommended stake. Recording only accepted recommendations would create selection bias and prevent evaluation of the filters.

## Capture boundary

The scientific event is born only after all of the following occur:

1. An official MLB game is selected by `gamePk`.
2. A supported market is selected.
3. P1-M2B returns FINAL or PROVISIONAL authorization.
4. The form quote exactly matches `MARKET_ODDS.details.quote` from the gate.
5. The existing predictor completes its model calculation.
6. A sanitized `mlb-scientific-snapshot.v1` exists.
7. The capture candidate passes P1-M3A validation.

A P1-M2 `BLOCKED` attempt is not a model evaluation and must not enter the scientific performance sample.

## Required capture envelope

### Origin

- channel: `INTERACTIVE_MLB_PREDICTOR`;
- user action: `GENERATE_PREDICTION`;
- client evaluation ID;
- frontend release or model Git commit.

The server derives ledger ownership from the authenticated session. A client cannot nominate another user ID.

### Official game identity

- `gamePk`;
- official game date;
- start time;
- home and away teams;
- venue when available.

Capture after first pitch is rejected.

### Readiness binding

- P1-M2B runtime schema;
- P1-M2A contract schema;
- gate generation time;
- market;
- FINAL or PROVISIONAL state;
- blockers and warnings;
- required evidence summary;
- evidence digest;
- complete certified quote.

### Market quote

- market;
- structured side (`HOME`, `AWAY`, `OVER`, `UNDER`);
- human selection label;
- line;
- selected and opposite American prices;
- book/source;
- automatic, consensus or manual source mode;
- capture time;
- provider update time when available;
- consensus method when available;
- provenance digest.

### Model and probability

- model name and version;
- Git commit and/or frontend release;
- environment;
- model probability;
- raw market-implied probability;
- no-vig probability when available;
- edge in percentage points.

### Decision

- signal;
- normalized category;
- confidence label and percentage;
- recommended analytical stake;
- rationale;
- exact filter reasons.

Recommended stake is simulation metadata only. Real financial exposure remains zero.

### Scientific snapshot

- `mlb-scientific-snapshot.v1` payload;
- canonical SHA-256 digest;
- maximum 280,000 bytes;
- no unredacted authorization, cookie, token, secret, password, API-key, session or CSRF fields.

### Safety

Every capture requires:

```text
mode = SHADOW_DECISION_SUPPORT
realFinancialExposure = 0
automaticBetPlacement = false
automaticModelChangesAllowed = false
automaticPromotionAllowed = false
```

## Identity and deduplication

P1-M3A produces three identifiers.

### Lifecycle key

The lifecycle key identifies one stable analytical lane:

- `gamePk`;
- market;
- side;
- normalized selection;
- line.

A changed line starts a different lifecycle.

### Semantic fingerprint

The semantic fingerprint identifies the actual sports decision and includes:

- lifecycle identity;
- official teams and start time;
- FINAL/PROVISIONAL state;
- evidence digest and readiness warnings;
- price, source and provenance;
- model version and probabilities;
- signal, category, recommended stake and filter reasons.

Transmission timestamps, client retry IDs and deployment commit are audit metadata, not sporting identity. A deployment by itself cannot inflate the sample.

### Client request ID

```text
p1m3a:<semantic SHA-256>
```

P1-M3B must use this as the idempotency key.

## Append-only revision policy

- No previous lifecycle record → `NEW_CHAIN`.
- Same semantic fingerprint → `IDEMPOTENT_RETRY`; create nothing.
- Same lifecycle with changed price, evidence, stage or model output → `APPEND_SUPERSEDING_REVISION`.
- Different lifecycle → reject the proposed supersession link.
- Older/equal capture time → reject stale revision.
- PROVISIONAL after FINAL → reject stage regression.

No historical prediction is updated or deleted.

## Ledger mapping

The contract adapter maps a valid capture to `mlb-ledger.v1`:

- `source = app`;
- market, price, probability and decision fields remain first-class ledger columns;
- P1-M3A identity, P1-M2 readiness, certified quote and safety envelope are preserved under `analysis.layers.p1M3aCapture`;
- existing factors, sources, injury audit, raw inputs and raw outputs are retained from the scientific snapshot;
- later revisions use `supersedesId`.

This lets the existing S5B/S6 metrics infrastructure calculate ROI, Brier, log loss, CLV and market/category breakdowns without a new database.

## Economic interpretation boundary

P1-M3A improves measurement; it does not prove profitability.

Minimum interpretation rules remain:

- one result is technical evidence only;
- five results test lifecycle repeatability, not profitability;
- twenty results permit preliminary review only;
- fifty clean settled decisions plus independent certification are preferred before formal human conclusions;
- any formula or threshold change must be versioned and tested as a new SHADOW cohort;
- no automatic promotion to real betting.

## Next implementation phases

### P1-M3B — Authenticated append-only capture service

- validate the P1-M3A candidate server-side;
- derive owner from the authenticated session;
- locate the current lifecycle leaf;
- apply idempotency and supersession policy;
- append through the existing owned MLB ledger;
- expose only bounded status/audit responses;
- never place a bet.

### P1-M3C — Predictor emission

- emit once at the exact existing model-completion boundary;
- preserve the result already calculated by the frontend;
- do not recompute the model in the capture layer;
- retain failed deliveries in a bounded authenticated outbox;
- display capture status without blocking the user from reviewing the prediction.

### P1-M3D — Settlement and money-oriented review

Reuse official settlement and closing-line infrastructure to report:

- flat one-unit ROI;
- policy-simulated ROI;
- Brier score and log loss;
- CLV and coverage;
- FINAL versus PROVISIONAL;
- market, category, signal and probability-band performance;
- accepted recommendations versus PASS/LEAN/INFO controls;
- data-quality exclusions and duplicate counts.
