# P1-M2B Post Phase 1 Statcast Engine Source Evidence

## Live result

Temporary research PR #409 measured deployed commit `76f11bea340812a5209d3c37e497daa17b4bf55e` after Phase 1 source acquisition was merged.

Across three real pregame games / six lineup sides:

- aggregate DIRECT batter coverage increased from the prior measured 13 slots to **49**;
- TEAM_PROXY slots fell to 5;
- **3/6 sides reached 9/9 DIRECT**;
- 5/6 sides used confirmed lineups.

The strict certifier remained correctly fail-closed:

- 0/3 CERTIFIED;
- 3/3 DEGRADED;
- no certifiable `generatedAt` was emitted.

One measured game had confirmed lineups and 9/9 DIRECT on both sides. That allowed the unchanged strict certifier to pass visible coverage and reach exact reproduction. It then failed with `STATCAST_CERT_STARTER_XWOBA_MISMATCH`.

## Interpretation

This is the expected Phase 1 separation result. The engine now consumes the broader official Savant batter source while the certifier deliberately still reacquires its prior Qualified source. Increased DIRECT coverage therefore does not automatically create certification.

The observed reproduction mismatch is evidence that Phase 2 should align the strict certifier's source acquisition with the same shared official Savant source constructor. The following certification requirements must remain unchanged:

- confirmed current lineup;
- 9/9 DIRECT batter coverage;
- exact source reproduction;
- exact starter xwOBA / run-delta reproduction tolerances;
- bullpen and combined-delta reproduction;
- fail-closed behavior on missing or conflicting evidence.

No threshold or reproduction tolerance should be relaxed to remove the mismatch.

## Chain of custody

- Research PR: #409
- Workflow run: `31273299436`
- Sanitized artifact: `9026264408`
- Deployed commit: `76f11bea340812a5209d3c37e497daa17b4bf55e`
- Accepted artifact passed the identity-free assertion.
