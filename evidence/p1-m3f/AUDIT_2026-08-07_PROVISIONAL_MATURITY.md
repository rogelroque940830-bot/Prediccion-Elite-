# P1-M3F Provisional Maturity Audit — 2026-08-07

## Decision

The real interactive MLB cohort is not failing to mature solely because captures occur early. The current readiness implementation contains a **structural `READY_FINAL` blocker for ML**: the required `BULLPEN` evidence cannot become `FRESH` under the current source contract.

This audit does **not** authorize relaxing the readiness gate. It identifies the source-provenance work required to make a legitimate FINAL state attainable.

## Chain of custody

- Integration/backend commit audited live: `9b632b344d9b0eb7aced57691428f4310ccd92a9`
- Temporary research PR: #347
- Research head: `a087b76f3038777b7497fd6d142d80433b6651f2`
- GitHub Actions workflow run: `31226803616`
- Aggregate artifact ID: `9012394323`
- Aggregate artifact ZIP SHA-256: `5b6e9dd04c694d01429064e2cb90dba8df4a7fae42ab63827d8c3eb40d70b016`
- Aggregate `result.json` SHA-256: `1a95ed8b253844bdd6d36c990beb1af15aff49fe201ebfc6c12077a3b7d12b47`
- Private owner export SHA-256: `272bd12b8796721a72904f3e31ff468f855fe61c346a34b11af24a8ca41d288c`
- The raw private owner export was deleted inside the Actions runner and was never uploaded.

## Real terminal interactive cohort

All nine terminal interactive decisions were:

- market: `ML` — 9/9
- analysis stage: `PROVISIONAL` — 9/9
- readiness gate: `READY_PROVISIONAL` — 9/9
- lifecycle: `PROVISIONAL_ONLY` — 9/9

No terminal lifecycle reached FINAL and none progressed from PROVISIONAL to FINAL.

Source decisions were conservative:

- `PASS`: 6
- `LEAN`: 3
- actionable FINAL bets: 0

## Aggregate maturity blockers

Warnings across the nine terminal decisions:

- `ADVANCED_FACTORS_DEGRADED`: 9/9
- `BULLPEN_DEGRADED`: 9/9
- `INJURIES_DEGRADED`: 9/9
- `LINEUPS_MISSING`: 2/9

The required ML fields were present in every readiness contract evaluation:

- GAME_IDENTITY
- PITCHERS
- LINEUPS
- INJURIES
- MARKET_ODDS
- BULLPEN
- ADVANCED_FACTORS

Across all required fields, the evidence summary totaled:

- FRESH: 34
- DEGRADED: 27
- MISSING: 2
- STALE: 0
- CONFLICT: 0
- UNKNOWN: 0

## Timing is contributory but not sufficient

The nine captures were generated:

- minimum: 148.32 minutes before scheduled first pitch
- median: 176.74 minutes before scheduled first pitch
- maximum: 708.68 minutes before scheduled first pitch
- 5 captures: 60–180 minutes before first pitch
- 4 captures: at least 180 minutes before first pitch

Generating closer to first pitch could improve lineup availability, because `LINEUPS_MISSING` occurred twice. It cannot by itself solve the observed FINAL problem: seven decisions already lacked a lineup warning but still remained PROVISIONAL, and `BULLPEN_DEGRADED`, `ADVANCED_FACTORS_DEGRADED`, and `INJURIES_DEGRADED` occurred in every decision.

## Structural BULLPEN blocker — current code proof

### 1. ML requires BULLPEN

The P1-M2A market requirements include `BULLPEN` and `ADVANCED_FACTORS` for `ML`. Required market fields must be `FRESH` for `READY_FINAL`; any non-FRESH required field produces a provisional warning.

### 2. M2B deliberately refuses to certify untimed derived data

`server/mlb-p1-pregame-readiness-service.ts` collects recognized timestamp keys from derived-source payloads. For a derived field:

- no successful source => `MISSING`;
- partial source success => `DEGRADED`;
- all sources successful but no explicit recognized timestamp => `DEGRADED` with quality `DERIVED_WITHOUT_EXPLICIT_TIMESTAMP`;
- only explicitly timestamped evidence can be classified by freshness and potentially become `FRESH`.

This is intentional fail-closed behavior. `server/mlb-p1-pregame-readiness.test.ts` explicitly tests that successful untimed factor endpoints remain `READY_PROVISIONAL` rather than being silently considered fresh.

### 3. Current bullpen endpoint has no recognized temporal provenance

For ML, M2B loads:

`/api/mlb/bullpen-status/:gamePk`

The current route returns only:

`{ home: homeBullpen, away: awayBullpen }`

`BullpenStatus` contains team identity, reliever usage/availability, closer/setup analysis, run adjustment and signal, but no `observedAt`, `generatedAt`, `fetchedAt`, `capturedAt`, `providerLastUpdate`, `updatedAt`, `lastUpdate`, or `lastUpdated` field recognized by M2B.

Therefore a successful bullpen response always produces `observedAt=null` inside M2B and is deterministically classified as `DEGRADED`.

### 4. Consequence

Because ML requires BULLPEN and required ML evidence must be FRESH for FINAL, **ML cannot reach `READY_FINAL` under the current implementation even when every bullpen calculation succeeds.**

This single blocker is sufficient to explain the absence of FINAL ML decisions. The additional `ADVANCED_FACTORS_DEGRADED` and `INJURIES_DEGRADED` findings still require separate source-level investigation, but they are not necessary to establish this structural impossibility.

## Why adding a request-time timestamp alone would be unsafe

The correct fix is not simply adding `generatedAt: new Date().toISOString()` to the bullpen route.

Current bullpen internals include cached and fallible source components. Some helper failures currently return empty arrays. If the route were stamped with the current request time without propagating internal source quality, a failed usage lookup could be represented as a freshly computed “rested bullpen,” which would be scientifically worse than remaining PROVISIONAL.

A trustworthy fix must therefore establish an explicit bullpen evidence contract that includes both:

1. temporal provenance for the availability snapshot; and
2. fail-closed source-quality/failure propagation for the critical inputs used to infer reliever availability.

Only a certified complete/fresh bullpen snapshot should become `FRESH` in M2B.

## Other blockers

### ADVANCED_FACTORS

M2B requires all five configured advanced-factor endpoints for the ML aggregate. Partial source availability is deliberately `DEGRADED`, and all-success responses without explicit timestamp provenance are also `DEGRADED`. The live cohort showed degradation 9/9. This requires a separate endpoint-by-endpoint provenance audit before certification.

### INJURIES

The injury pathway can theoretically become FRESH: M2B requires both team injury statuses to be `VERIFIED` and a fresh explicit timestamp. The live cohort instead showed `INJURIES_DEGRADED` 9/9. That is not structurally inevitable from M2B alone; it requires diagnosis of the live validation status/coverage path and must not be conflated with the confirmed bullpen contract defect.

## Scientific consequence for P1-M3E

P1-M3E cannot learn when the predictor is elite if the intended prospective cohort never matures into legitimate FINAL decisions. The next refinement target is therefore **evidence certifiability and FINAL-state attainability**, not another model covariate.

No historical PROVISIONAL record should be rewritten as FINAL, no synthetic user action should be created, and the 80-observation / 30-date P1-M3E requirements must remain unchanged.

## Safety decision

This audit changes nothing in production behavior:

- readiness policy changed: false
- FINAL captures created: false
- synthetic user actions created: false
- model changed: false
- thresholds changed: false
- promotion authorized: false
- predictions created by research: 0
- settlements created by research: 0
- bets placed by research: 0
- real financial exposure: 0

## Next phase

Build a narrow, tested bullpen evidence-provenance contract that makes `FRESH` attainable only when critical availability inputs are complete, explicitly timed and within the required freshness window. Then validate that change independently before addressing advanced-factor and injury provenance.
