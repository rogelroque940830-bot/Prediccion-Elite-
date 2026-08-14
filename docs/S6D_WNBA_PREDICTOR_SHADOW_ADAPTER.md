# S6D WNBA Predictor Shadow Adapter

## Purpose

S6D observes the WNBA predictor outputs that the existing application already persists. It does not copy, reconstruct, tune or replace the predictor. The persisted output is the source of truth.

## Sources

S6D reads both current persistence contracts:

- `data/picks.json` (`sport=wnba` records from `/api/picks/v2`);
- `data/picks-data.json` (`wnbaPicks` from the legacy dashboard state).

Equivalent outputs found in both stores are grouped into one analytical chain. Original source identifiers and payloads are retained only in protected detail records.

## Prospective cutover

The first successful S6D cycle establishes a durable cutover watermark and inventories all already-existing source fingerprints. Those records are reported as `preCutoverIgnored` and are not inserted into the scientific sample.

After cutover:

- a new persisted source fingerprint can create a shadow record;
- unchanged polling creates no duplicate;
- materially changed persisted evidence appends a superseding revision;
- no historical or synthetic prediction is created.

## Probability contract

`confidence` is preserved as confidence only. S6D does not infer a model probability from it.

A normalized `modelProbability` is populated only when the persisted source explicitly contains one of:

- `modelProbability`;
- `probability`;
- `winProbability`;
- `predictedProbability`.

Explicit percentages from 0 to 100 are normalized to 0 to 1. Missing probability remains `null` and is included in diagnostics.

## S6C linkage

S6D links a persisted predictor output to a terminal S6C record only when the date and team identity identify exactly one game. Ambiguous, unmatched and insufficient-identity cases remain explicit.

When selection identity is known, S6D can compare the explicit predictor probability with the S6C de-vigged market baseline. No edge is calculated without both values.

## Runtime

Defaults in `p0-integration`:

- enabled unless explicitly disabled;
- one-minute bounded polling after a five-minute startup delay;
- isolated runtime root `data/wnba-predictor-shadow-v1`;
- public sanitized health at `/health/s6d-wnba-predictor-shadow`;
- protected detail under `/api/wnba/predictor-shadow/v1`.

Environment controls:

- `WNBA_S6D_PREDICTOR_SHADOW_ENABLED`;
- `WNBA_S6D_PREDICTOR_SHADOW_INTERVAL_MS`;
- `WNBA_S6D_PREDICTOR_SHADOW_INITIAL_DELAY_MS`;
- `WNBA_S6D_PREDICTOR_SHADOW_ROOT`.

## Protected endpoints

- `GET /api/wnba/predictor-shadow/v1/status`
- `GET /api/wnba/predictor-shadow/v1/latest`
- `GET /api/wnba/predictor-shadow/v1/records`
- `GET /api/wnba/predictor-shadow/v1/report`

## Interpretation limits

S6D observes persisted predictor output, not every transient screen calculation. Until the frontend explicitly persists blocked and unsaved evaluations, coverage metrics apply only to emitted/persisted outputs.

A saved output is not proof of betting edge. Any later WNBA scientific gate must separately define sample size, closing coverage, calibration and decision rules.

## Safety invariants

- stake `0`;
- real financial exposure `0`;
- no sportsbook integration;
- no automatic wager placement;
- no production writes;
- no automatic promotion;
- no predictor formula, filter, market, probability, threshold or stake-policy changes;
- no synthetic retrospective predictions;
- no mutation or reuse of the MLB or S6C ledgers.
