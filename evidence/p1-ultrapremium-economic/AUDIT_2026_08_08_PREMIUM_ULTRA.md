# P1 PREMIUM / ULTRA Economic Forensic Audit — 2026-08-08

## Question

Did the historical MLB `PREMIUM` / `ULTRA` labels already establish a reliable money-making edge, and can the old ~96% claim be used as an operational betting gate?

## Research chain of custody

- Temporary research PR: #371 — **do not merge**.
- Research head: `2d1be81b4c8f0c80f0c189b7126436850839d64b`.
- Deployed backend verified: `a56374d3b9bdd345c5b8c993119e406e2efbfb76`.
- Workflow run: `31239533368`.
- Job: `93058057257`.
- Artifact: `9016549309`, `p1-ultrapremium-economic-forensic-aggregate`.
- Artifact ZIP SHA-256: `85937162c79e3745e3345beab969409e0fb33070beafdd5f5991c1d6ddc20f62`.
- Artifact files independently re-hashed:
  - `result.json`: `97b79efa7959042043e0449b797b6117ec690cec55ef81964663c578c4eab13a`.
  - `cohort-integrity.json`: `3c3600cc6f0525d27d66b34fe826149425fa4ea72f40327c1cc0b21a4fcde949`.
  - `premium-independent.json`: `e104622a80100c3e2e5196ca88b8d2003fe9c458e881d8a5b6f61ca147b0efca`.

The owner-scoped immutable ledger was exported privately inside the GitHub runner. The raw JSONL was deleted before artifact upload. No prediction, settlement, wager or financial exposure was created.

## What the historical 96% meant

The historical TT F5 `STRONG_EARLY` PREMIUM rule reported 95.5% TEST hit rate on only 22 observations and the UI rounded that historical rate to 96%. The associated ranking probability was floored at 0.85; therefore the displayed 96% was not a calibrated 96% event probability.

The historical F5 ML PREMIUM rule was defined among surviving F5 filters as `ERE_diff >= 20 OR ERE_pick >= 65`; each small development TEST bucket was reported as 6/6. Its ranking probability was floored at 0.97, which again was not a calibrated probability estimate.

The later F5 ML `ULTRA` label required at least two boost signals among `IMPLOSION`, `ERA_DECLINE`, `QUALITY_BAD`, `H2H_STRUGGLE`, and `SOS_INFLATED`. The defining commit reported individual boost hit rates but did **not** report a combined 2+ boost ULTRA hit rate. Therefore there is no source-supported historical statement that the combined ULTRA rule itself was a validated 96% system.

The immutable ledger currently contains no prospective TT `STRONG_EARLY` PREMIUM rows, so the old TT 95.5% development result cannot be independently prospectively evaluated from the current ledger.

## ULTRA: pseudo-replication discovered

A naive label scan found 99 prospective app F5 ULTRA captures and appeared to show 67-32 with +18.47 units and +18.65% ROI. That result is **not an independent sample**.

Those 99 captures came from only **12 unique games**. Nine games had multiple ULTRA captures; individual games contributed as many as 13, 14, 17, 19 and 24 repeated captures. Repeated snapshots of the same eventual result had falsely inflated the effective sample size.

After enforcing one independent game:

- earliest ULTRA per game: 12 games, 7-5, ROI **-3.41%**;
- latest ULTRA per game: 12 games, 7-5, ROI **-4.98%**;
- terminal F5 decision per game that still remained ULTRA: 8 games, 3-5, ROI **-38.37%**.

Thus the raw +18.65% ULTRA capture ROI must not be used for economic decision-making. ULTRA is **not economically validated** by the current independent prospective evidence.

## PREMIUM: independent terminal test

The primary economic comparison was pre-registered before examining the terminal PREMIUM result:

- unit: one latest pregame app F5 ML decision per game;
- cohort begins after the historical F9 missing-data guard, `2026-07-11T03:50:43Z`;
- PREMIUM membership is read only from the selected decision surface (`decision`, `selectedLane`, `finalRecommendation`);
- `alternativePicks`, `altLines` and other non-selected text are excluded;
- comparison: selected PREMIUM vs selected non-PREMIUM terminal F5 decisions;
- inference: 5,000 deterministic game-date cluster bootstrap replicates;
- economic support requires at least 50 PREMIUM games, at least 20 PREMIUM dates, lower 95% ROI bound > 0, lower 95% PREMIUM-minus-control ROI bound > 0, positive mean CLV, and proper scoring not worse than control.

Observed terminal cohort:

### PREMIUM

- 20 independent games; 19 settled; 10 dates.
- 14 wins, 5 losses: **73.68%**.
- Wilson 95% win-rate interval: **51.21% to 88.19%**.
- Flat 1-unit profit: **+4.3561u**.
- ROI: **+22.93%**.
- Median entry: **-145**; mean implied probability **60.48%**.
- Mean model probability: **70.02%**.
- Brier: **0.209713**.
- Log loss: **0.610212**.
- Mean CLV: **+0.0957 pp**; positive CLV on **42.11%**.
- July ROI: **-1.64%**; August ROI: **+37.26%**.

### Non-PREMIUM control

- 85 independent games; 78 settled; 12 dates.
- 38 wins, 29 losses among binary outcomes: **56.72%**.
- Flat 1-unit profit: **-1.5331u**.
- ROI: **-1.97%**.
- Brier: **0.247049**.
- Log loss: **0.689771**.
- Mean CLV: **+0.3187 pp**.

### Date-cluster inference

- PREMIUM ROI 95% bootstrap interval: **-4.48% to +55.44%**.
- PREMIUM minus control ROI difference 95% interval: **-5.74 to +58.79 percentage points**.
- PREMIUM minus control hit-rate difference 95% interval: **-1.63 to +37.73 percentage points**.

Point estimates favor PREMIUM strongly and its point Brier/log-loss are better than control. However, the economic uncertainty intervals still include zero, and the sample has only 20 PREMIUM games / 10 dates. The registered 50-game / 20-date minimums are not met.

Decision: **`PREMIUM_ECONOMIC_EDGE_NOT_CERTIFIED`**.

## New prospective candidate: PREMIUM without ULTRA

A descriptive post-hoc split found:

- `PREMIUM && !ULTRA`: 18 games, 17 settled, 13-4, ROI **+28.05%**;
- July ROI **+14.75%**;
- August ROI **+35.30%**;
- Brier **0.198369**;
- log loss **0.586506**.

This looks substantially more stable than ULTRA, but it was observed **after** inspecting the same outcomes. It therefore cannot be promoted from this dataset. It becomes a **new prospective hypothesis** only.

## Scientific / economic decision

1. Do not use the old `96%` display as a calibrated win probability.
2. Do not restore ULTRA as a money gate; current independent prospective evidence does not support it.
3. PREMIUM is a credible economic candidate, not yet a certified edge.
4. Freeze `PREMIUM && !ULTRA` as a new prospective hypothesis using only future games and one terminal game-level decision per game.
5. Do not optimize price bands or thresholds from this small sample; those breakdowns are descriptive only.
6. No automatic threshold, probability, stake, model, promotion or sportsbook behavior is authorized by this evidence.
