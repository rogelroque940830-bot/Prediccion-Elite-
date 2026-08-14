# P1-M6A3B2C1 — 2025 T-5 Pregame Lineup Coverage Audit

## Decision

**SOURCE COVERAGE CERTIFIED FOR RESEARCH.** B2C1 may proceed to **P1-M6A3B2C2** as a research-only incremental lineup challenger.

The authoritative v4 run reproduced the frozen 2025 B1 cohort and obtained 2,430/2,430 historical T-5 snapshots. Of those, 2,423 contained two valid nine-player batting orders while also passing identity, pregame-state and historical-timecode integrity. That is **99.711934% certified T-5 coverage**.

This conclusion is deliberately limited to source availability and chain of custody. It does **not** establish that batting orders improve prediction quality, and it does not authorize model promotion or betting actionability.

## Chain of custody

- Research PR: #333, temporary and intended to close without merge.
- Workflow run: `31219968270`.
- Valid PR merge ref used by the successful run: `3caf57d5cac7b4bdcf7af5e183c8d03bd70e5195`.
- Research head: `e21b3b5ef07601ce397dbc75ecc297e488acaf68`.
- Merged B2C1 v4 base: `00660f488261c7a8cc592f4e204dd612500b2813`.
- Artifact ID: `9010094577`.
- Artifact ZIP SHA-256: `ca09b7f2fc018c25fa8b4317685a04eb5152605f0a3cb07739b38fbab129a916`.
- Artifact contained exactly three files.

## Frozen sporting identity

The run reproduced the frozen B1 sporting cohort before measuring lineup coverage:

- 2,430 regular-season final games.
- Frozen B1 outcome digest: `c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d`.
- Reproduced outcome digest matched exactly.
- Historical lineup `gamePk` set matched frozen B1 exactly.
- Missing `gamePk`: 0.
- Extra `gamePk`: 0.
- Acquisition failures: 0.
- Identity conflicts: 0.

## Schedule resolution

The 2,430 games resolved as:

| Resolution | Games |
|---|---:|
| DIRECT | 2,396 |
| RESCHEDULED_FINAL_SELECTED | 30 |
| SUSPENDED_ORIGINAL_START_SELECTED | 4 |

The suspended/resumed path uses the original first-pitch start, and rescheduled cases remain fail-closed unless the schedule identity is explicit.

## T-5 coverage

The configured research cutoff was exactly 300 seconds before the resolved scheduled start.

| Availability | Games |
|---|---:|
| COMPLETE | 2,423 |
| HOME_INCOMPLETE | 0 |
| AWAY_INCOMPLETE | 0 |
| BOTH_INCOMPLETE | 0 |
| NOT_PREGAME_AT_CUTOFF | 1 |
| TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 6 |
| IDENTITY_CONFLICT | 0 |

Certified complete coverage: **2,423 / 2,430 = 99.711934%**.

Canonical lineup-history digest:

`f19f28dfe283139aac7f1e1a4da0837a93b63265974deb17e4bd315da2f58e85`

Provider-provenance digest:

`d65ed173c68c38fedd468e3015e46843a2b1906b0c6cb59591fd12b0c96410e4`

## Seven fail-closed exclusions

The seven non-COMPLETE snapshots were retained and classified explicitly; none was backfilled from a final boxscore.

| gamePk | Date | Resolution | Availability | Requested T-5 | Provider metadata | State |
|---|---|---|---|---|---|---|
| 778527 | 2025-03-30 | DIRECT | NOT_PREGAME_AT_CUTOFF | 20250330_180500 | 20250330_130841 | I / In Progress |
| 778195 | 2025-04-24 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250424_181000 | 20250424_210946 | P / Pre-Game |
| 778170 | 2025-04-27 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250427_173500 | 20250427_205532 | P / Pre-Game |
| 778046 | 2025-05-06 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250506_193500 | 20250506_225236 | P / Pre-Game |
| 778029 | 2025-05-08 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250508_191000 | 20250508_215613 | P / Pre-Game |
| 777938 | 2025-05-14 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250514_160500 | 20250514_193735 | P / Pre-Game |
| 777458 | 2025-06-19 | RESCHEDULED_FINAL_SELECTED | TIMECODE_NOT_AT_OR_BEFORE_CUTOFF | 20250619_181000 | 20250619_213330 | P / Pre-Game |

All seven still carried two nine-player batting orders, but B2C1 correctly refused to certify them because state/time integrity failed. This prevents apparent coverage from being inflated with evidence that cannot be proven to have existed at or before T-5.

## Artifact file integrity

- `manifest.json`: `f0ae7350aaaba5fd7c5764ffc23fa8aca3b3cc4939829a7ab0f976278677949b`
- `source-integrity.json`: `42090cfd68c402e90775d6e94312265a17801c728248ec806fae45bb9974051f`
- `pregame-lineup-history.json`: `9633cd9d7a653e9cfe2ad6d4331cb1f74280c5ff72a37d304dbafd9f2a8ed74`

Manifest-recorded hashes matched the downloaded files.

## Safety boundary

The run and permanent evidence retain:

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`

No odds, routes, ledger writes, settlements, sportsbook integration, financial exposure or production prediction formula changed in B2C1.

## Next research implication

B2C1 has answered the availability question: strict historical official batting orders are available for essentially the full frozen 2025 cohort while preserving fail-closed temporal integrity.

The next stage is **P1-M6A3B2C2**, which must test whether lineup information adds incremental out-of-sample predictive value. The 2,423 certified games may be used; the seven excluded games must remain missing rather than being imputed from future information. B2C2 must remain free to conclude that the lineup feature is beneficial, inconclusive or harmful.
