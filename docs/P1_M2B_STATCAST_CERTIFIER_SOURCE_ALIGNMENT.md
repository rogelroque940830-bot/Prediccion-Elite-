# P1-M2B Phase 2 — Statcast Certifier Source Alignment

## Evidence basis

Phase 1 changed only engine acquisition and was validated live in #410. DIRECT coverage increased from 13 to 49 batter slots across six measured sides, while the unchanged strict certifier remained fail-closed in 3/3 games.

One game had confirmed lineups and 9/9 DIRECT on both sides, allowing the strict certifier to reach exact reproduction. It failed with `STATCAST_CERT_STARTER_XWOBA_MISMATCH`, which is the expected consequence of the engine using the new inclusive batter source while the certifier still reacquired the previous Qualified batter source.

Phase 2 fixes that source mismatch. It does not change any certification rule.

## Successor strategy

The historical B5/B5B certifier and identity-route files remain unchanged.

M2B registers a GET-only successor middleware before the historical Statcast identity middleware. The successor reuses the existing `createStatcastIdentityRouteService()` and therefore still runs:

1. the same identity-safe Statcast engine output;
2. the same strict `certifyStatcastMatchupReadiness()` implementation;
3. the same exact reproduction checks and fail-closed behavior.

The only injected difference is the `fetchImpl` supplied to the strict certifier.

## Source-aligned fetch

The wrapper rewrites only Baseball Savant pitch-arsenal leaderboard requests:

- `type=batter` → shared official **INCLUSIVE** source (`min=1`, `minPitches=1`, `pitchType=`);
- `type=pitcher` → shared official **QUALIFIED** source (`min=1`, `minPitches=q`, `pitchType=`).

All non-Savant traffic passes through unchanged, including MLB game feed, active roster, season stats, recent form, vs-player and vs-team queries.

The shared constructor `mlb-statcast-savant-source.ts` is the same source definition already used by the Phase 1 engine, eliminating motor↔certifier query drift.

## Frozen certification boundaries

This phase does **not** modify:

- the B5A requirement for current confirmed lineups;
- 9/9 DIRECT batter coverage;
- August >=30 pitches per pitch type;
- >=60% opposing starter arsenal coverage;
- current-season pitcher-arsenal reproduction;
- bullpen roster/stat completeness;
- recent-batter completeness;
- starter-row xwOBA and run-delta reproduction tolerances;
- bullpen run-delta reproduction;
- 50/25/25 combined run-delta reproduction;
- any model probability, recommendation threshold, stake or betting behavior.

The source wrapper never mutates the engine result. Certification remains a pure verification layer.

## Expected live behavior

Games without a confirmed current lineup or without 9/9 DIRECT evidence must remain `DEGRADED`.

For games that satisfy visible coverage, Phase 2 allows the strict certifier to reacquire the same batter source used by the engine and proceed to exact reproduction. `CERTIFIED` is acceptable only if every existing B5B check passes unchanged.

Even if Statcast reaches CERTIFIED and ADVANCED_FACTORS reaches 5/5, `READY_FINAL` is not implied while independent evidence such as INJURIES remains degraded.
