# P1-M6A3B2B1 — MLB starting-pitcher historical source

## Purpose

B2B1 creates a research-only historical source for the actual MLB starting pitcher on each side of an official regular-season game and the starter's game pitching line. It does **not** create a predictive pitcher rating and does not change any live prediction, market, ledger, settlement, sportsbook, or economic path.

The source exists so B2B2 can later estimate a pitcher's pregame strength using **only starts dated before the target game**. A starter's statistics from the target game may update his history only for future dates; they are never legal inputs for predicting that same game.

## Official identity contract

For each side, the parser reads the official MLB boxscore pitching order. The first pitcher in that order is the starter candidate. When the game-level `gamesStarted=1` flag is available, it must identify the same pitcher; disagreement fails closed. If the explicit game-started flag is absent, the source may use the first official pitching-order entry but records the weaker identity method separately.

This explicitly supports openers: an opener is still the official starting pitcher for the game's starter identity even if he records few outs.

## Baseball-stat contract

`inningsPitched` uses baseball notation, not a decimal. Therefore `5.2` means 17 outs and `7.1` means 22 outs. Values with a third fractional out such as `5.3` are invalid and fail closed.

The stored game line includes outs recorded, batters faced when supplied, runs, earned runs, hits, walks, strikeouts, home runs, hit-by-pitch when supplied, pitch count and strikes when supplied. The canonical starter-history digest is based on stable sporting identity/stat fields, while the raw boxscore payload digest is preserved separately as provenance.

## Cohort integrity

The real 2025 backfill must first reproduce the frozen P1-M6A3B1 canonical outcome digest and official-game count. The starter cohort is then required to contain both official starters for every game in that same sample. Any official-history acquisition failure, boxscore failure, identity conflict, malformed innings notation, team mismatch, missing required pitching stats, or incomplete two-starter coverage fails the research run.

## Future B2B2 as-of rule

B2B2 will use this history with a strict chronological boundary:

- validation-game starter identity is the confirmed/actual starter identity relevant at first pitch;
- pitcher quality features are computed only from starts whose `officialDate` is strictly earlier than the validation block;
- no target-game or future-game pitching line can enter a training snapshot;
- hyperparameter selection occurs only inside the outer training block;
- team-only and league NB2 comparators remain visible so pitcher information must prove incremental OOS value rather than hide a weak baseline.

## Safety

B2B1 is `RESEARCH_HISTORY_ONLY`. It sets `actionabilityAllowed=false`, `automaticModelSelectionAllowed=false`, and `automaticPromotionAllowed=false`. A successful data backfill proves only that the historical starter source is complete and auditable; it does not prove predictive value.
