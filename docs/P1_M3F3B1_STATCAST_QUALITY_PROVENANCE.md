# P1-M3F3B1 — Statcast quality certifiable provenance

## Purpose

P1-M3F3A established that every detailed `ADVANCED_FACTORS` component must independently be certified, explicitly timed and fresh before the aggregate can become `FRESH`.

P1-M3F3B1 applies that rule to the existing Statcast quality computation (`xERA`, `xwOBA`, HardHit%, barrel%, batter wOBA/xwOBA). It does not change any numerical formula or model coefficient.

## Existing source behavior

The legacy quality module uses three Baseball Savant CSV inputs:

1. expected-statistics pitcher leaderboard;
2. Statcast pitcher quality leaderboard;
3. expected-statistics batter leaderboard.

The existing runtime caches pitcher and batter maps for six hours. Historically, when a refresh failed after cache expiry, the legacy helper could return its previous cached data for UI continuity. That behavior is useful for display but is not sufficient for a `CERTIFIED` P1 readiness claim.

## Certified snapshot contract

`getStatcastQualityCertifiedSnapshot()` is a strict source path layered on the existing calculations.

A snapshot may report `sourceStatus=CERTIFIED` only when:

- pitcher expected-statistics data is present;
- pitcher Statcast-quality data is present;
- batter expected-statistics data is present;
- each required map is non-empty;
- any cache used is still within the existing six-hour TTL.

If an expired cache requires refresh and any required Savant request fails, certification throws fail-closed. An expired snapshot is never re-labeled as newly certified merely because old data still exists in memory.

The snapshot exposes:

- schema `courtedge-mlb-statcast-quality-evidence.v1`;
- `sourceStatus=CERTIFIED`;
- `generatedAt` equal to the oldest certified cache observation used by the snapshot;
- pitcher/batter cache hit flags and cache ages;
- cache maximum age = 21,600 seconds;
- `failureDisposition=THROW_FAIL_CLOSED`.

## Backward compatibility

The existing `getPitcherQualityMap()` and `getBatterQualityMap()` helpers retain their legacy display/runtime fallback behavior. M3F3B1 introduces a separate strict certification path rather than silently changing every existing consumer.

No P1 readiness route is switched in this phase. Integration of the five certified Advanced Factor components will occur only after each component has its own falsified source contract.

## Non-claims

M3F3B1 does not assert that live `ADVANCED_FACTORS` is now fresh. Four other components still require certification, and M2B continues using the current runtime endpoints until the complete certified set is ready.

No model, probability, threshold, odds, ledger, settlement, sportsbook, UI, actionability or promotion change is authorized.
