# P1-M2B Post Statcast Phase 2 Evidence

## Live result

Temporary research PR #413 measured deployed commit `2d6d8956d75adf38338e90eca8e48318224e9ed3` on four real pregame MLB samples prioritized for confirmed lineups.

All four slate samples reported confirmed lineups. Across eight lineup sides, four reached 9/9 DIRECT batter coverage after Phase 1 source expansion.

The strict Statcast certifier remained fail-closed:

- 0/4 CERTIFIED;
- 4/4 DEGRADED;
- no certifiable `generatedAt` emitted.

One measured game had 9/9 DIRECT on both sides. That game passed visible coverage and reached strict starter reproduction, but failed with `STATCAST_CERT_STARTER_XWOBA_MISMATCH`.

## Readiness result

No sampled game reached 5/5 ADVANCED_FACTORS and no `READY_FINAL` state was observed. Three samples were 4/5 advanced and one was 3/5 because SOS was degraded in that sample. INJURIES remained degraded in all four samples. The readiness gate was BLOCKED in the four measurements at that audit time; this evidence does not attribute the BLOCKED status to a single field without a separate blocker audit.

## Parity diagnosis

Phase 1 deliberately separated Savant populations:

- individual DIRECT batter acquisition uses the inclusive official Savant source;
- TEAM_PROXY aggregation remains on the historical Qualified source.

The Phase 2 successor aligned the strict certifier's batter fetch to the inclusive source, but the unchanged B5B certifier builds both current DIRECT rows and TEAM_PROXY aggregates from the same row collection. Therefore it can still compute a different expected xwOBA from the engine even when the final visible classification is DIRECT, because pitch types lacking direct sample can contribute team-proxy values to the weighted xwOBA.

Before changing code again, the next research step is to verify that overlapping Qualified and Inclusive Savant rows have identical numerical values. If they do, a successor provider can preserve inclusive rows for individual DIRECT evidence while marking only Qualified-eligible rows for team aggregation, reproducing the engine's split-source semantics without changing any B5B certification rule or tolerance.

## Scientific boundary

The xwOBA mismatch is not authorization to widen numerical tolerances. Exact reproduction remains the correct gate until source semantics are identical.

## Chain of custody

- Research PR: #413
- Workflow run: `31274035183`
- Sanitized artifact: `9026532805`
- Exact deployed commit: `2d6d8956d75adf38338e90eca8e48318224e9ed3`
- Accepted artifact passed the identity-free assertion before upload.
