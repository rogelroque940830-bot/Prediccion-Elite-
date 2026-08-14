# P1-M6A3B2C2B — 2025 T-5 Lineup Paired Inference Audit

## Decision

**DO NOT PROMOTE.** The B2C2 T-5 lineup feature remains research-only and must not enter the active predictor.

The authoritative 2025 run found no supported incremental improvement over the team-only NB2 challenger. `FIRST_INNING` was **INCONCLUSIVE** with a slightly unfavorable point estimate. `FIRST_3`, `FIRST_5`, and `FULL_GAME` showed **SUPPORTED_REGRESSION** versus team-only after family-wise paired official-date cluster inference.

This conclusion is deliberately narrow. It does **not** mean that confirmed MLB lineups are generally unimportant. It means that this specific B2C2 representation — geometric-mean aggregation of nine shrunk batter residual run factors applied to team-only expected runs — did not improve out-of-sample count likelihood on the frozen 2025 cohort.

## Chain of custody

- Implementation PR: #335, merged before research.
- Merged B2C2 base: `42156d1670e164efc2e029b6c62fdec765c592a7`.
- Research PR: #336, temporary and closed without merge.
- Research head: `459cd97f2894f45b63faca7c0b3f739447c0152f`.
- Valid PR merge ref tested by Actions: `3b1bef1341c2bcc55d7419a1d8ea1fab9e2213c6`.
- Workflow run: `31221724211`.
- Artifact ID: `9010790516`.
- Artifact ZIP SHA-256: `ed5e8f8d3c71a49d950d414c4611058eb282c93e3be6915cf680ba65a7aa86f2`.
- Artifact contained exactly four files and the manifest-recorded hashes matched the downloaded files.

## Frozen sporting identity

The run reproduced all certified upstream identities before modeling:

- 2,430 official regular-season final games.
- 2,430 historical T-5 lineup snapshots fetched.
- 2,423 source-certified complete lineups.
- B1 outcome digest: `c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d` — reproduced exactly.
- B2C1 lineup-history digest: `f19f28dfe283139aac7f1e1a4da0837a93b63265974deb17e4bd315da2f58e85` — reproduced exactly.
- Certified complete-gamePk digest: `19f38a6c2bfd8bc490142b7634b4769e40cf165c15f2150b5a2d92f756075775` — reproduced exactly.
- Source version: `statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4`.
- All rolling-origin folds were leakage-free.

The seven non-certified source games stayed fail-closed and were never imputed: one `NOT_PREGAME_AT_CUTOFF` and six `TIMECODE_NOT_AT_OR_BEFORE_CUTOFF`.

## OOS and inference design

Each horizon used 1,506 paired validation games, 112 official-date clusters and 3,012 count observations. One otherwise-valid OOS game per horizon was excluded because its lineup was not B2C1-certified. The paired bootstrap used 5,000 deterministic official-date cluster replicates and a Bonferroni family-wise confidence level of 98.75% across four horizons.

The primary comparison is `TEAM_ONLY_MINUS_LINEUP`. Positive values favor the lineup challenger; negative values mean the lineup challenger has higher (worse) count NLL than team-only.

The nested selector was allowed to choose lineup effect weight `0`, so the procedure was not forced to use lineup information. Conservative ties favored lower lineup effect and stronger shrinkage.

## Results

| Horizon | Team-only − lineup point NLL | Family-wise 98.75% interval | Evidence | Overall |
|---|---:|---:|---|---|
| FIRST_INNING | -0.00025798 | [-0.00065770, 0.00005789] | INCONCLUSIVE | INCONCLUSIVE |
| FIRST_3 | -0.00060097 | [-0.00127915, -0.00006278] | SUPPORTED_REGRESSION | SUPPORTED_REGRESSION |
| FIRST_5 | -0.00094025 | [-0.00169574, -0.00024158] | SUPPORTED_REGRESSION | SUPPORTED_REGRESSION |
| FULL_GAME | -0.00224493 | [-0.00378403, -0.00094269] | SUPPORTED_REGRESSION | SUPPORTED_REGRESSION |

`FIRST_INNING` did not establish either benefit or regression. For `FIRST_3`, `FIRST_5`, and `FULL_GAME`, the entire family-wise interval is below zero, establishing that the tested lineup representation was worse than team-only under the certified paired procedure.

The league-NB2 comparisons were inconclusive in all four horizons. That does not rescue the feature: the incremental scientific question was whether lineup composition improved the stronger team-only challenger, and it did not.

## Hyperparameter behavior

The training-only nested selector frequently preferred no lineup contribution:

- FIRST_INNING: 7 of 8 folds selected lineup effect `0`.
- FIRST_3: 7 of 8 folds selected `0`.
- FIRST_5: 6 of 8 folds selected `0`.
- FULL_GAME: 5 of 8 folds selected `0`.

This is descriptive support only; the paired family-wise intervals remain the inferential basis.

Per horizon, 1,086 validation games had all batters previously seen in training history and 420 contained at least one unseen batter. Unseen batters were treated neutrally rather than supplied future information.

## Artifact integrity

- `manifest.json`: `013eb0e6c6540e4e60acd6549a7d1ab78963c2ff3c1604e9b6f824c7e2c78fb9` (8,229 bytes)
- `source-integrity.json`: `27261a9d757f8a0359e58b8dd76d8e3b96e932a0fa29a2d8549a8afddd50f5b9` (1,770 bytes)
- `lineup-oos-report.json`: `028a24e7ce30ebbe4bb243b9439d8130995674a6a9155c0bc8d80de19faac21f` (3,327,229 bytes)
- `lineup-paired-inference.json`: `57528e87a9d17707db42b42da534271f59d1093b7ba052fe7995005adc77bb16` (5,933 bytes)

## Safety boundary

The run retained:

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`

No odds, routes, ledger writes, settlements, sportsbook behavior, financial exposure, or economic-decision behavior changed.

## Scientific conclusion and next implication

**B2C2 is rejected as an incremental lineup feature in its current form.** Do not promote or silently incorporate it into production.

The evidence does not justify abandoning pregame lineup information as a research domain. A future lineup-related challenger would need a materially different representation — for example an order-aware or externally projected batter-quality formulation — and must be evaluated as a new hypothesis rather than tuning B2C2 until it wins.
