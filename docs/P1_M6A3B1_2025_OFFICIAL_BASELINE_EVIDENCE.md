# P1-M6A3B1 — 2025 Official MLB Baseline Evidence

## Status

This document freezes the first real-season empirical evidence produced by P1-M6A3B1. It is **research evidence only**. It does not activate a model, create a wager, change economic thresholds or certify sportsbook edge.

The machine-readable companion record is `evidence/p1-m6a3b1/2025-official-baseline.json`.

## Acquisition integrity

The temporary research runner queried MLB Stats API for regular-season games across 2025-03-01 through 2025-10-01 and completed successfully.

- GitHub Actions run: `31194164106`
- Research head: `95e06a386fc1e0c6c0c00e6fdda95af9bb14b151`
- Node: `24.18.0`
- Official schedule games: **2,430**
- Official finals acquired: **2,430**
- Acquisition failures: **0**
- Dataset exclusions: **0**
- FIRST_INNING observations: **2,430**
- FIRST_3 observations: **2,430**
- FIRST_5 observations: **2,430**
- FULL_GAME observations: **2,430**
- Unique game dates: **184**
- Rolling-origin leakage audit: **PASS**

Dataset SHA-256:

`15827a9172824bb0863ab8c3ecd086184ada6a18fa99bbdee526a58f91aa8a4b`

Research ZIP SHA-256:

`3133365b4def2363a4b8b32e0640a7589ef796255a43f8aa9a2941b446baaddc`

The downloaded ZIP and the three evidence files were independently re-hashed after the GitHub run. Their hashes matched both GitHub's artifact digest and the B1 manifest.

## Held-out design

The B1 comparison uses expanding rolling-origin folds. Training dates are strictly earlier than validation dates. Each horizon accumulated **1,507 held-out games / 3,014 held-out team-run observations** under the default B1 schedule.

The candidates are intentionally primitive:

- Poisson league-wide home/away marginal run baseline;
- Negative Binomial NB2 league-wide home/away marginal run baseline.

They do **not** include team strength, starting pitchers, lineups, bullpen availability, park, weather or sportsbook odds.

## Primary count-model result

Lower held-out negative log likelihood is better.

| Horizon | Poisson NLL | NB2 NLL | Poisson - NB2 | Relative reduction |
| --- | ---: | ---: | ---: | ---: |
| FIRST_INNING | 1.10684719 | **0.98037661** | +0.12647058 | **11.4262%** |
| FIRST_3 | 1.89171702 | **1.69475806** | +0.19695896 | **10.4117%** |
| FIRST_5 | 2.29664937 | **2.09120590** | +0.20544347 | **8.9454%** |
| FULL_GAME | 2.72598383 | **2.48547609** | +0.24050774 | **8.8228%** |

**Result:** NB2 is the preferred research baseline by held-out count NLL in all four horizons tested.

This is a distribution-family conclusion, not a production-model conclusion.

## Probability calibration diagnostics

The same simple baseline also generated home-moneyline probability vectors. NB2 improved calibration error (macro ECE) in every reported horizon, although Brier/log-loss improvements for ML were modest because neither candidate knows which teams or pitchers are playing.

| Horizon | Metric | Poisson | NB2 |
| --- | --- | ---: | ---: |
| FIRST_INNING Home ML | Brier | 0.61918299 | **0.61329562** |
| FIRST_INNING Home ML | Log loss | 1.03078913 | **1.02308593** |
| FIRST_INNING Home ML | Macro ECE | 0.04374817 | **0.01185336** |
| FIRST_3 Home ML | Brier | 0.65471400 | **0.65359921** |
| FIRST_3 Home ML | Log loss | 1.07985250 | **1.07838247** |
| FIRST_3 Home ML | Macro ECE | 0.01548560 | **0.00649536** |
| FIRST_5 Home ML | Brier | 0.61962654 | **0.61798363** |
| FIRST_5 Home ML | Log loss | 1.01951765 | **1.01586338** |
| FIRST_5 Home ML | Macro ECE | 0.02013519 | **0.00711330** |
| FULL_GAME Home ML | Brier | 0.49830293 | **0.49776410** |
| FULL_GAME Home ML | Log loss | 0.69144960 | **0.69091000** |
| FULL_GAME Home ML | Macro ECE | 0.01361966 | **0.00764131** |

For FIRST_INNING NRFI, where the baseline directly tests the zero-run event, the distinction was larger:

| Metric | Poisson | NB2 |
| --- | ---: | ---: |
| Brier | 0.53922242 | **0.50014288** |
| Log loss | 0.73419711 | **0.69329006** |
| Macro ECE | 0.09328361 | **0.00858621** |

The NB2 NRFI calibration result is strong evidence that Poisson's equidispersion assumption is inadequate for this simple league-level first-inning baseline. It is **not** evidence that a league-level NRFI wager has positive EV.

## What this evidence supports

P1-M6A3B1 supports keeping Negative Binomial NB2 as the distribution-family benchmark entering B2. It also confirms that the official historical acquisition and rolling-origin evaluation pipeline can process a complete 2,430-game MLB regular season without outcome leakage.

## What this evidence does not support

No team-specific prediction is certified by B1. B1 has no information about the teams' actual offensive/defensive strength, starting pitchers, confirmed lineups, bullpen condition, park, weather, injuries or current market price. It therefore cannot determine whether any side, total, run line, F3/F5 market or NRFI/YRFI price is a bet.

`actionabilityAllowed` remains `false` and `automaticModelSelectionAllowed` remains `false`.

## Required next phase

P1-M6A3B2 must add pregame covariates with explicit historical `asOf` boundaries and compare every feature family against this frozen B1 baseline under the same rolling-origin design. A feature group is useful only if it improves held-out evidence; intuitive baseball relevance alone is not sufficient.
