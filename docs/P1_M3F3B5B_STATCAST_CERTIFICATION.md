# P1-M3F3B5B — Strict Statcast matchup certification

## Purpose

B5B closes the fifth detailed `ADVANCED_FACTORS` provenance gap without changing the legacy Statcast matchup formula.

The identity-safe numerical result remains the calculation under review. B5B independently reacquires material source evidence, reproduces the material result, and emits `sourceStatus=CERTIFIED` only when the existing result is reproducible from the strict source set.

A certification failure does **not** rewrite the numerical result and does not turn the endpoint into an HTTP failure. The same identity-safe result remains available for UI/diagnostic use with `sourceStatus=DEGRADED`, so M2B cannot count it as a certified advanced component.

## Preconditions inherited from B5A

Certification is attempted only when the real production payload demonstrates complete visible coverage:

- both current batting orders are confirmed with exactly nine players;
- both starter matchup rows contain 9/9 `DIRECT` batter dataQuality;
- no team-proxy, league or unknown starter-row classification is present;
- both starter arsenals are non-empty;
- at least one bullpen pitcher is evaluated on each side;
- numeric-ID vs-team history requested all nine batters, all nine queries succeeded and zero source failures occurred.

B5A itself still has no `CERTIFIED` state.

## Strict source verification

B5B independently checks the material hidden dimensions.

### Current pitcher arsenal

The strict path fetches the current-season Baseball Savant pitcher-arsenal leaderboard directly. Every material pitcher — both starters and every selected bullpen pitcher — must have at least three current-season Savant pitch types.

This intentionally rejects previous-season or Stats API fallback arsenals for `CERTIFIED`. Those fallbacks may remain useful to the legacy UI calculation, but a fallback-only pitcher cannot establish this strict readiness certificate.

For each starter, the returned production arsenal must materially match the current Savant signature (`type`, `usage`, `wOBA against`, `whiff`).

### Batter pitch-type evidence

Current- and previous-season Savant batter pitch-type leaderboards are reacquired. Current-season rows drive direct batter evidence; previous-season rows are used only to reproduce the existing team-proxy merge rule when a bullpen matchup needs it.

The certifier reproduces the existing month-dependent sample thresholds and `DIRECT` / `TEAM_PROXY` / `LEAGUE` classification logic.

### Recent batter form

Each current lineup batter receives a strict MLB Stats `byDateRange` request for the same 15-day window used by the legacy engine. HTTP or parse failure blocks certification. A successful response with no split is a legitimate no-sample state and reproduces the existing `UNKNOWN` behavior.

### Direct batter-vs-pitcher history

For starters, MLB Stats `vsPlayerTotal` evidence is reacquired for every batter because the starter rows are externally visible and must be reproduced exactly.

For bullpen pitchers, B5B first reproduces the rounded team delta without the optional career term. Only when that fails to reproduce the served delta does it acquire `vsPlayerTotal` for that bullpen pitcher and recompute with the optional term. A source failure in a required query blocks certification.

### Bullpen identity and completeness

For each team B5B reacquires the active roster and a season pitching-stat response for every active pitcher. Source failure for any required pitcher-stat request blocks certification.

The same legacy eligibility rules and leverage score are then used:

- starter share must be no more than 30% of games;
- at least five games;
- score = saves × 4 + holds × 2 + innings pitched × 0.5;
- top four become Closer, Setup, Middle, Middle.

The exact selected pitcher IDs and roles must match the served `bullpenMatchup` arrays.

## Reproduction requirement

B5B does not accept source availability by itself. It must reproduce:

1. both starter arsenal signatures;
2. every starter batter's `dataQuality` and final `expectedXwOBA`;
3. both starter `expectedTeamRunsDelta` values;
4. exact bullpen pitcher identities and roles;
5. every served bullpen `expectedRunsDelta`;
6. both final combined run deltas using the already-frozen 50% starter / 25% bullpen / 25% numeric-ID vs-team history formula.

Any mismatch emits `DEGRADED` rather than adjusting the served value.

## Timestamp policy

A successful certificate exposes an explicit `generatedAt` equal to the oldest conservative observation boundary between the request start and the strict source observations. Successful certificates may be reused for at most 300 seconds only when a SHA-256 fingerprint of the material result is unchanged. Cache reuse preserves the original `generatedAt` and reports cache age.

This prevents a new response timestamp from laundering an old result into a fresh state.

## M2B integration

The existing `/api/mlb/statcast-matchup/:gamePk` compatibility middleware adds only metadata:

- `sourceStatus: CERTIFIED | DEGRADED`;
- top-level `generatedAt` only for a certificate;
- a provenance envelope describing verification, sources, blockers and safety invariants.

M2B already requires every detailed Advanced Factors endpoint to report `sourceStatus=CERTIFIED`, uses the oldest certified component timestamp, and degrades if any component is uncertified or untimed. No M2B relaxation is introduced here.

## Explicit non-claims

A successful source certificate does not demonstrate predictive improvement. It does not authorize model promotion, threshold changes or betting action.

## Safety

- legacy Statcast formula changed: false;
- served run delta mutated by certifier: false;
- probability changed: false;
- economic threshold changed: false;
- automatic betting: false;
- actionability allowed by this certificate: false;
- automatic promotion allowed: false;
- ledger / settlement / sportsbook writes: none.
