# P1-M6A3B2B1 — 2025 starting-pitcher history evidence

## Result

The final research-only 2025 run completed successfully against the frozen P1-M6A3B1 regular-season cohort. All 2,430 official games were reproduced and every game had both starting pitchers resolved, for 4,860 starter lines and zero failures.

This closes **source coverage and auditability only**. It does not establish predictive value and does not authorize model promotion or actionability.

## Reproducibility

- GitHub Actions run: `31203202561`
- Artifact ID: `9003841757`
- Artifact ZIP SHA-256: `7bffa93697678b62bcd768de2278bf5f4d92b78af9a05ed8db1452ed345e29d4`
- Frozen B1 outcome digest: `c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d`
- Starter sporting-history digest: `2ae7b52b671f84fdecbc802b7891a03b66e768178bc6add177be5116c9426efa`
- Boxscore provenance digest: `16893b5346b94971c2eb58e4b1345a85ce3dea3de0ce9b10de5c22a918969bd1`

The ZIP contains exactly three files. The artifact hashes recorded by the manifest match the downloaded bytes:

- `official-integrity.json`: `3b4d2d49dadb2042477263dcc4262411f5ee8c466fc87891e1923466292d7e03`
- `starting-pitcher-history.json`: `07413bd341857dce2b3377f2a06d71e567babacd3b8e591fabf0ecb840eee08e`
- `manifest.json`: `3fe011692e18ece3e9059183e069992585e11878bdfb76c55f6a8b8b52a7a669`

## Coverage

| Measure | Result |
| --- | ---: |
| Scheduled games | 2,430 |
| Official finals | 2,430 |
| Regular-season finals | 2,430 |
| Games with both starters | 2,430 |
| Starter lines | 4,860 |
| Failures | 0 |

Identity resolution:

- `GAME_STARTED_FLAG_AND_ORDER`: 4,859
- `GAME_STARTED_FLAG_AFTER_ZERO_APPEARANCE_LISTING`: 1
- `PITCHING_ORDER_FIRST`: 0

## Audited exceptional game

The only exceptional identity case was MLB `gamePk=777342`, Philadelphia at Atlanta on 2025-06-27. MLB retained Mick Abel (`690953`) first in the pitching list even though he recorded zero appearance, while Tanner Banks (`621383`) was the unique `gamesStarted=1` pitcher and actually started after the weather delay.

Merged PR #316 introduced a narrow rule for this class of feed artifact: an explicit starter may supersede preceding pitching-list entries only when every preceding listed pitcher has exactly zero outs, zero batters faced and zero pitches. Any real prior appearance remains a fail-closed conflict.

## Scientific boundary

B2B1 is a **data-source certification**, not a prediction-model certification. The next stage is P1-M6A3B2B2. For every validation game, pitcher features must be constructed exclusively from starts with dates strictly earlier than the target validation block. The target game's pitching line must never predict that game.

B2B2 must report the starting-pitcher challenger's incremental out-of-sample value against both:

1. the B2A team-only challenger; and
2. the B1 league-level NB2 baseline.

No pitcher model may be promoted from B2B1 evidence. `actionabilityAllowed=false`, `automaticModelSelectionAllowed=false`, and `automaticPromotionAllowed=false` remain mandatory.
