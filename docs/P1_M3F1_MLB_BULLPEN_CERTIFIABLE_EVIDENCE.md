# P1-M3F1 — MLB Bullpen Certifiable Evidence

## Purpose

P1-M3F evidence proved that the real prospective interactive ML cohort could not reach `READY_FINAL` under the previous implementation because ML requires `BULLPEN`, while the bullpen endpoint exposed no timestamp recognized by P1-M2B.

P1-M3F1 removes that structural impossibility **without relaxing the P1-M2 readiness gate**.

The goal is narrow:

> A bullpen snapshot may expose an explicit `generatedAt` only when the same bullpen calculation used by the predictor has successfully obtained its critical source inputs. Any critical source failure must fail closed rather than being interpreted as an empty/rested bullpen.

## Previous failure mode

The previous helpers used patterns such as:

- roster fetch failure -> `[]`;
- recent schedule failure -> `[]`;
- boxscore failure -> `[]`;
- season-stat failure -> `null`.

Those fallbacks were acceptable for an advisory display but were unsafe as evidence for a FINAL scientific gate. For example, a failed recent boxscore lookup could leave every reliever with no `daysWorked`, which is indistinguishable from a truly rested bullpen.

Because the response had no explicit temporal provenance, M2B correctly classified it `DEGRADED`. P1-M3F evidence showed `BULLPEN_DEGRADED` in 9/9 real terminal interactive ML decisions.

## P1-M3F1 source contract

`getBullpenStatus` now resolves only after all of the following complete successfully:

1. **Active pitcher roster** from MLB Stats API.
   - Empty or malformed roster rejects.
   - The active-roster cache is bounded to 30 minutes, matching the M2A bullpen freshness window.
2. **Season pitching evidence for every active pitcher inspected by the bullpen calculation.**
   - Current-season stats are used first, with previous-season fallback when current stats are not established.
   - Missing role/starter evidence rejects instead of silently becoming `UNKNOWN`.
   - Season stats remain a slow-moving contextual input and may be cached for up to 24 hours; that cache age is exposed in provenance.
3. **Recent final-game schedule** for the three-day usage lookback.
   - A successful schedule with zero final games is a valid empty history.
   - A failed/malformed schedule rejects.
4. **Every required recent final-game boxscore.**
   - Each final game found in the lookback must have a valid feed/live boxscore for the team.
   - Missing boxscore/team/pitcher data rejects instead of producing an empty usage list.

Only after these requirements succeed does the returned `BullpenStatus` include:

- `sourceStatus: "CERTIFIED"`;
- `generatedAt`;
- `provenance.schemaVersion = "courtedge-mlb-bullpen-evidence.v1"`;
- explicit source coverage counts;
- `failureDisposition: "THROW_FAIL_CLOSED"`.

The existing `/api/mlb/bullpen-status/:gamePk` route requires both home and away calls through `Promise.all`. Therefore a critical failure for either side returns an endpoint failure. P1-M2B then remains provisional/missing rather than treating incomplete bullpen evidence as fresh.

## Meaning of `generatedAt`

`generatedAt` is the completion time of a bullpen availability snapshot whose critical inputs were successfully resolved under the contract above. It is **not** a claim that every slow-moving season statistic was published at that instant.

The provenance distinguishes:

- the 30-minute active-roster freshness bound;
- complete season-stat coverage and its 24-hour cache bound;
- live recent schedule/boxscore verification for the usage window.

This distinction matters because bullpen availability is driven by current roster membership and recent workload, while season stats primarily classify roles and starter/reliever context.

## M2A / M2B behavior

P1-M2A continues to require for full-game ML:

- BULLPEN;
- ADVANCED_FACTORS;

No requirement was removed or weakened.

The source inventory changes only the bullpen timestamp contract from `MISSING_UNIFORM_TIMESTAMP` to `EXPLICIT`, documenting the new fail-closed source behavior.

P1-M2B logic is unchanged:

- a certified recent `generatedAt` can classify BULLPEN as `FRESH`;
- an untimed successful payload remains `DEGRADED`;
- a source failure remains missing/degraded and cannot support FINAL.

A focused integration regression proves both directions. With all other ML requirements fresh, certified timed bullpen evidence can reach `READY_FINAL`; the same bullpen evidence without an explicit timestamp remains `READY_PROVISIONAL` with `BULLPEN_DEGRADED`.

## What this phase does not solve

P1-M3F live evidence also found:

- `ADVANCED_FACTORS_DEGRADED` 9/9;
- `INJURIES_DEGRADED` 9/9;
- `LINEUPS_MISSING` 2/9.

Therefore P1-M3F1 does **not** imply that current live ML predictions will immediately become FINAL. It removes one proven structural blocker only. Advanced-factor and injury provenance remain separate research/fix phases.

## No retrospective mutation

This change does not rewrite any existing PROVISIONAL capture as FINAL. Historical ledger records remain immutable. Only future readiness evaluations may observe the new certified bullpen timestamp when the source contract actually succeeds.

## Safety boundaries

P1-M3F1 does not:

- change model formulas or probabilities;
- change betting thresholds or stake policy;
- change market odds;
- create predictions or settlements;
- create synthetic user actions;
- place bets or integrate a sportsbook;
- authorize automatic model changes or promotion;
- lower P1-M3E sample requirements.

The phase changes only source integrity and temporal certifiability for bullpen readiness evidence.
