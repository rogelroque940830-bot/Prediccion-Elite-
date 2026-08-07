# P1-M6A3B2B2B — 2025 Starting-Pitcher Paired Inference Audit

## Decision

**DO NOT PROMOTE.** The B2B2 starting-pitcher feature remains research/shadow evidence only.

The valid 2025 research run classified `FIRST_INNING`, `FIRST_3`, `FIRST_5`, and `FULL_GAME` as **INCONCLUSIVE** after paired official-date cluster inference. The small favorable point estimates versus the team-only challenger did not clear zero in the family-wise intervals.

This conclusion is deliberately narrow: it does **not** mean that starting pitchers are generally unimportant. It means that this specific B2B2 feature/model did not demonstrate statistically supported incremental out-of-sample improvement on the frozen 2025 cohort under the certified inference procedure.

## Chain of custody

- Research PR: #324, temporary and closed without merge.
- Workflow run: `31209919814`.
- Valid PR merge ref: `d04eada0b19568245604c07b6f2d23484fe75423`.
- The merge ref explicitly merged research head `59a1f5836800977693c5ab9401f1d44996e161c2` into merged B2B2B base `ece82c3a77ec1812a3d13b4d5c46e85a4067cb59`.
- Artifact ID: `9006459288`.
- Artifact ZIP SHA-256: `822d716ef04c374d697aef24668d4120da68b9f2dc190c4aec7802feb5e5fbad`.
- Artifact contained exactly four files: manifest, source integrity, B2B2A OOS report, and B2B2B paired inference.
- Manifest-recorded file hashes matched the downloaded files.

## Frozen sporting identity

The run reproduced both certified sporting identities before inference:

- 2,430 regular-season final games.
- 4,860 starting-pitcher lines.
- B1 outcome digest: `c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d` — reproduced exactly.
- B2B1 starter-history digest: `2ae7b52b671f84fdecbc802b7891a03b66e768178bc6add177be5116c9426efa` — reproduced exactly.
- All rolling-origin folds were leakage-free.

## Inference design

Each horizon used the same 1,507 held-out games, 112 official-date clusters and 3,014 count observations. The paired bootstrap used 5,000 deterministic date-cluster replicates. Both an ordinary 95% interval and a Bonferroni family-wise 98.75% interval across four horizons were computed.

The primary incremental comparison is `TEAM_ONLY_MINUS_PITCHER`. `LEAGUE_NB2_MINUS_PITCHER` is retained as a second comparator so that improvement against a weaker team-only challenger cannot be mistaken for broad predictive superiority.

## Results

| Horizon | Team-only − pitcher point NLL | Family-wise 98.75% interval | Team evidence | League NB2 − pitcher point NLL | Family-wise 98.75% interval | Overall |
|---|---:|---:|---|---:|---:|---|
| First inning | 0.00048228 | [-0.00263139, 0.00358836] | INCONCLUSIVE | -0.00112664 | [-0.00747818, 0.00520396] | INCONCLUSIVE |
| First 3 | 0.00035827 | [-0.00239058, 0.00318498] | INCONCLUSIVE | 0.00278624 | [-0.00345410, 0.00869530] | INCONCLUSIVE |
| First 5 | 0.00146261 | [-0.00354146, 0.00620712] | INCONCLUSIVE | 0.00652583 | [-0.00228611, 0.01482067] | INCONCLUSIVE |
| Full game | 0.00017375 | [-0.00351739, 0.00394526] | INCONCLUSIVE | 0.00409139 | [-0.00350909, 0.01163921] | INCONCLUSIVE |

F5 had the largest favorable point estimate versus team-only, but its ordinary 95% interval also crossed zero. Therefore the failure to establish improvement is not merely an artifact of the four-horizon Bonferroni correction.

## Artifact file integrity

- `manifest.json`: `996d685060453775820f5ed5d52ec314d14d82539dd21c2580050b44541fb9a5`
- `source-integrity.json`: `6a5d58e3d1480b5d74821578697b35f4963a9f02b17ecb0cef500dc107aec185`
- `starting-pitcher-oos-report.json`: `e97645458bc0f280da290e62c078bfa321a4e65f8d412def12b61c6da1e254ac`
- `starting-pitcher-paired-inference.json`: `72650afb3edf8cb398a909fffcfbe1356e1a3d554df7d07efd54ebf38749952a`

## Safety boundary

The run and evidence retain:

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`

No odds, live routes, ledger writes, settlements, financial exposure or economic-decision behavior were changed by this evidence stage.

## Next research implication

B2B2 is not promoted as a mandatory feature. The next covariate should be tested independently with the same discipline. The recommended next block is historical pregame batting-order/lineup reconstruction with explicit as-of availability before any lineup challenger is allowed to compete against the stable baselines.
