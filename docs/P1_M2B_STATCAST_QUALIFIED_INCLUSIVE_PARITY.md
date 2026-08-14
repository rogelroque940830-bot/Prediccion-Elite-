# P1-M2B Savant Qualified / Inclusive Parity

## Result

Temporary research PR #415 compared official Baseball Savant batter pitch-arsenal datasets for 2026 and 2025.

Every Qualified player/pitch-type row was present in the Inclusive source:

- 2026: 895/895 Qualified rows present in Inclusive;
- 2025: 852/852 Qualified rows present in Inclusive;
- aggregate: 1,747/1,747 overlap rows, zero missing.

For every overlapping row, the fields used by the Statcast engine/certifier were identical: team, pitches, PA, xwOBA, wOBA, whiff percentage and run value per 100. Zero value mismatches were observed.

## Engineering implication

This validates a split-source successor provider without numerical reinterpretation:

- Inclusive rows can remain available for individual DIRECT evidence;
- only rows that are also Qualified need to remain eligible for TEAM_PROXY aggregation.

Because overlapping values are identical, applying a Qualified eligibility mask does not change any value that the historical proxy population used. It only prevents Inclusive-only rows from entering TEAM_PROXY aggregation.

No xwOBA tolerance, DIRECT threshold, 9/9 requirement, model formula or probability should change.

## Chain of custody

- Research PR: #415
- Workflow run: `31274473695`
- Sanitized artifact: `9026597324`
- No player identities were persisted in the accepted artifact.
