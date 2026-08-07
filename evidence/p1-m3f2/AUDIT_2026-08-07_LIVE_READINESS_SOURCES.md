# P1-M3F2 — Live Readiness Source Audit (2026-08-07)

## Decision

Preserve the successful temporary research result from PR #354 without merging its workflow.

The source audit separates the remaining prospective MLB `READY_FINAL` blockers after P1-M3F1 made bullpen evidence temporally certifiable.

## Chain of custody

- research PR: `#354`
- research head: `b62dc11942e69ddfd20264edc8b4bc4baf575c2d`
- workflow run: `31228026998`
- deployed backend: `66ce753a12ca5e80f4b9eafe597f2ff24919ce43`
- artifact id: `9012778873`
- artifact ZIP SHA-256: `7c9901723b41db623dd76219aaca38553c5749ca649105689c289c2655fb1bab`
- result JSON SHA-256: `a78d4c56e5c2d2611a830a854ee014fbf23fee43fa9ebab3aff0b184a8e1bec1`
- live game identity was not preserved; only a SHA-256 hash of gamePk exists in the artifact.

## Bullpen verification after P1-M3F1

The live bullpen endpoint succeeded and both sides were certifiable:

- HTTP 200;
- `sourceStatus = CERTIFIED` on both sides;
- recognized `generatedAt` on both sides;
- provenance schema `courtedge-mlb-bullpen-evidence.v1`;
- provenance status `CERTIFIED`;
- `failureDisposition = THROW_FAIL_CLOSED`;
- `bothSidesCertified = true`.

Therefore the P1-M3F1 source-integrity change is functioning in the deployed environment. The historical `BULLPEN_DEGRADED` structural defect is no longer attributable to a missing temporal contract for future evaluations that successfully obtain certified bullpen evidence.

This does not rewrite prior PROVISIONAL captures.

## Advanced Factors finding

For the one real pregame source audit, all five ML advanced-factor endpoints succeeded:

1. `/api/mlb/quality/:gamePk`
2. `/api/mlb/statcast-matchup/:gamePk`
3. `/api/mlb/discipline-speed/:gamePk`
4. `/api/mlb/sos/:gamePk`
5. `/api/mlb/advanced/:gamePk`

Observed:

- successful endpoints: 5/5;
- HTTP 200: 5/5;
- recognized timestamp count: 0 on every endpoint;
- no top-level certified source/provenance contract;
- aggregate `allSuccessfulButUntimed = true`.

Under the existing P1-M2B derived-evidence rule, a successful derived source without a recognized explicit timestamp is `DEGRADED`. Consequently, `ADVANCED_FACTORS` remains structurally unable to be `FRESH` from these successful untimed payloads.

This should be solved through genuine source provenance/freshness contracts, not by weakening `READY_FINAL` or attaching an unqualified request-time timestamp.

## Injury finding

The injury source presents a different problem and must not be bundled with the Advanced Factors fix.

Both audited sides had:

- aggregate HTTP 200;
- `officialValidationStatus = VERIFIED`;
- `stale = false`;
- a recent `fetchedAt` timestamp;
- `sourceErrorCount = 0`.

However both returned:

- `status = PARTIAL`.

Therefore `INJURIES_DEGRADED` is not explained by absent timestamps, stale evidence, or a transport/source error in this snapshot. The semantic meaning and construction of `PARTIAL` must be diagnosed separately before deciding whether the source contract or readiness adapter should change.

A `PARTIAL` injury status must not be upgraded to FRESH merely because its timestamp is recent.

## Scientific interpretation

The correct sequence after this evidence is:

1. treat bullpen temporal certifiability as verified live for future evaluations;
2. repair Advanced Factors only if each constituent source can expose qualified, fail-closed temporal provenance;
3. separately audit why injury evidence is `PARTIAL` despite verified, non-stale, error-free source status;
4. only after source integrity is fixed should new genuine interactive evaluations be allowed to mature naturally from PROVISIONAL to FINAL;
5. do not mutate historical captures, synthesize user actions, or lower P1-M3E's registered 80-observation / 30-date requirements.

## Safety boundary

This evidence changes no:

- model formula or probability;
- readiness threshold or required field;
- odds source or market price;
- ledger or settlement;
- sportsbook behavior;
- stake/actionability rule;
- UI behavior;
- automatic model change or promotion.

The research used public read-only endpoints only and created zero predictions, settlements, bets, or financial exposure.
