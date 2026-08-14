# S6E — Automatic WNBA Evaluation Emission

## Purpose

S6E records each completed WNBA predictor evaluation automatically, even when the user does not press a save-pick button. It is an observational staging capability. It does not alter model logic, create a canonical pick, recommend a real stake, or place a wager.

## Capture boundary

The frontend observes values only after the existing functions have completed:

- `predictWNBA` — exact home/away model inputs and calibrated win probability;
- `predictWNBATotal` — exact estimated total;
- `wnbaPickQuality` — the three existing ML, spread and total market outputs;
- `wnbaGetBestPlay` — completion boundary and existing best-play result.

The capture calls do not modify arguments or return values. They are guarded for browser execution and swallow all capture failures so telemetry cannot affect predictor behavior.

## Durable browser outbox

Each evaluation is assigned one immutable `evaluationId` and written to `courtedge.wnbaEvaluationOutbox.v1` before delivery. The outbox:

- retains up to 100 evaluations;
- removes an item only after the backend acknowledges it;
- stops retrying after an authentication failure;
- resumes after `courtedge:auth-ready` or the browser returns online;
- preserves the same ID across retries so backend ingestion remains idempotent.

## Backend evidence

The authenticated endpoint is:

`POST /api/wnba/predictor-shadow/v1/evaluations`

Scientific evidence is stored under `data/wnba-evaluation-emission-v1`:

- `evaluations.jsonl` — immutable raw envelopes;
- `outputs.jsonl` — three normalized market outputs per evaluation;
- `s6d-source-projection.json` — WNBA-only projection consumed by S6D;
- `verification-evaluations.jsonl` — segregated deployment checks excluded from outputs and projection.

Reusing an `evaluationId` with identical evidence is idempotent. Reusing it with different evidence is rejected with HTTP 409.

## S6D integration

The projection combines:

1. canonical persisted WNBA rows from `data/picks.json`;
2. S6E direct evaluation outputs.

S6D reads this projection as its modern source. Existing S6D cursor, deduplication, supersession, S6C linkage and explicit-probability behavior remain unchanged. Direct S6E rows preserve their model probability explicitly and always carry `stake: 0` and `result: SHADOW`.

## Privacy and security

Detailed status, evaluations and outputs are private. Evaluation writes require an authenticated session with CSRF or the configured service token. Public health contains counts and safety state only; it excludes teams, selections, odds, probabilities, IDs, model inputs and local file paths.

## Safety invariants

- zero predictions created by S6E;
- zero recommended stake in the scientific projection;
- zero real financial exposure;
- no sportsbook integration;
- no automatic bet placement;
- no production writes;
- no automatic promotion;
- no formula, filter, market, probability, threshold or stake-policy changes;
- no retrospective synthetic evaluations;
- verification evidence never enters the scientific projection.
