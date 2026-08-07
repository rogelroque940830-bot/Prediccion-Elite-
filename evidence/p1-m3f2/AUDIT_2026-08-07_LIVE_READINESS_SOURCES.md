# P1-M3F2 Live Readiness Source Audit — 2026-08-07

## Decision

P1-M3F1 is verified live: bullpen evidence is now genuinely certifiable. The remaining ML readiness blockers are independent:

1. `ADVANCED_FACTORS` is structurally untimed despite all five required endpoints succeeding.
2. `INJURIES` is fresh and officially validated but is classified `PARTIAL`; that classification path requires separate diagnosis.

Do not relax P1-M2 readiness rules. Fix the source contracts independently.

## Chain of custody

- deployed backend: `66ce753a12ca5e80f4b9eafe597f2ff24919ce43`
- environment: `p0-integration`
- temporary research PR: #354
- research head: `b62dc11942e69ddfd20264edc8b4bc4baf575c2d`
- workflow run: `31228026998`
- artifact ID: `9012778873`
- artifact ZIP SHA-256: `7c9901723b41db623dd76219aaca38553c5749ca649105689c289c2655fb1bab`
- result JSON SHA-256: `a78d4c56e5c2d2611a830a854ee014fbf23fee43fa9ebab3aff0b184a8e1bec1`
- audited game state: `PREGAME`
- game identity retained only as SHA-256 in the evidence JSON.

## Bullpen live verification

`/api/mlb/bullpen-status/:gamePk` returned HTTP 200 after P1-M3F1.

Both sides exposed:

- `sourceStatus=CERTIFIED`
- `generatedAt`
- provenance schema `courtedge-mlb-bullpen-evidence.v1`
- provenance status `CERTIFIED`
- `failureDisposition=THROW_FAIL_CLOSED`

M2B-recognized timestamp collection found `generatedAt`; `bothSidesCertified=true`.

Therefore the prior structural `BULLPEN_DEGRADED` defect is resolved in the deployed runtime when the source contract succeeds.

## Advanced Factors live result

P1-M2B requires five calls for the ML `ADVANCED_FACTORS` aggregate:

- `/api/mlb/quality/:gamePk`
- `/api/mlb/statcast-matchup/:gamePk`
- `/api/mlb/discipline-speed/:gamePk`
- `/api/mlb/sos/:gamePk`
- `/api/mlb/advanced/:gamePk`

Live result:

- required endpoints: 5
- successful endpoints: 5
- HTTP 200: 5/5
- recognized timestamp count: 0 on every endpoint
- `anyRecognizedTimestamp=false`
- `allSuccessfulButUntimed=true`

This rules out partial HTTP coverage for the audited game. Under current M2B logic, an all-success derived aggregate with no recognized timestamp is intentionally `DEGRADED`. Thus `ADVANCED_FACTORS` currently has a temporal-provenance blocker analogous to the old bullpen defect.

This evidence does **not** prove that adding `generatedAt` blindly to each endpoint is safe. Each endpoint must be audited for silent fallbacks, cache semantics and internal source completeness before it may claim a certifiable timestamp.

## Injury live result

The aggregate injury path returned HTTP 200 and found the audited game. Both sides reported:

- `status=PARTIAL`
- `officialValidationStatus=VERIFIED`
- `stale=false`
- fresh `fetchedAt`
- `sourceErrorCount=0`

The live injury feed is therefore not degraded because of timestamp staleness or an obvious provider transport error. The decisive non-FRESH attribute is the `PARTIAL` feed status.

A separate injury audit must determine why `PARTIAL` is produced when official validation is VERIFIED and source errors are zero. The readiness gate must not be weakened to ignore `PARTIAL` until that classification is understood.

## Safety

This audit used public read-only endpoints only and created:

- predictions: 0
- settlements: 0
- bets: 0
- financial exposure: 0

No model, threshold, readiness rule, source implementation, ledger or actionability setting changed.

## Next phases

- **P1-M3F2A:** audit the five advanced-factor implementations and introduce explicit temporal/source-quality provenance only where defensible.
- **P1-M3F2B:** trace the injury `PARTIAL` classification to its exact validation/coverage condition and fix only if the evidence contract is overly conservative or internally inconsistent.

The objective remains prospective FINAL-state attainability so that P1-M3E can eventually learn when the predictor is genuinely elite.
