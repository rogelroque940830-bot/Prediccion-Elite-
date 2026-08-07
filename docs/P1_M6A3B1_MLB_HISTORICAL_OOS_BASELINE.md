# P1-M6A3B1 — MLB Historical Dataset and Time-Aware OOS Baseline

## Purpose

P1-M6A3B1 is the first empirical validation layer above the P1-M6A3A probability-distribution contract. It does **not** claim that the current baseline is a production forecasting model. Its purpose is to build a reproducible official-outcome dataset and falsify simple run-distribution families out of sample before introducing higher-dimensional covariates.

## Source of truth

Historical outcomes come from MLB Stats API official game feeds (`statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`). The acquisition path first obtains regular-season game identifiers from the MLB schedule endpoint and then reads each official final feed.

The research dataset does not derive historical outcomes from the betting ledger. The existing ledger is selection-biased toward markets that the predictor happened to evaluate. Using it as the primary run-scoring training sample would bias F1/F3/F5/full-game fitting toward previously selected markets.

Each official game stores a SHA-256 digest of its source payload and a source-version identifier. Dataset rows retain that provenance.

## Outcome identity versus provider-payload provenance

A provider feed is not itself the scientific identity of an observed baseball result. MLB can revise non-outcome metadata in an old `feed/live` payload after a game while leaving the official teams, date, final score and inning-by-inning run results unchanged.

B1 therefore exposes three distinct digests:

- `outcomeDigest`: the **canonical sample identity**. It hashes only immutable analysis-relevant outcome fields: `gamePk`, official date, season, horizon, home/away MLB team IDs and the observed home/away runs for that horizon.
- `sourceProvenanceDigest`: a separate fingerprint of `sourceVersion` and raw `sourceDigest`, used to detect provider-payload drift without pretending that metadata drift changed the baseball result.
- `datasetDigest`: the original/legacy acquisition-snapshot digest retained for backward audit compatibility. It includes `sourceDigest`, so it can legitimately change when MLB changes non-outcome feed metadata. It must **not** be used to decide whether two reconstructed research samples contain the same outcomes.

A canonical outcome correction changes `outcomeDigest`. A raw-provider metadata revision with identical outcomes changes provenance fingerprints but leaves `outcomeDigest` unchanged.

This separation is a safety boundary: future model comparisons must freeze and compare `outcomeDigest`, while still retaining the provider-provenance fingerprints for audit.

## Inclusion and exclusion rules

Only MLB regular-season (`gameType = R`) official finals are eligible.

For FIRST_INNING, FIRST_3 and FIRST_5, every required half-inning must exist with an explicit official run value. A missing home or away half-inning is **not** converted to zero. This matters for shortened/called games and prevents an unplayed half-inning from becoming fabricated model evidence.

FULL_GAME uses the official final team scores and therefore can remain eligible when an early-inning market horizon is incomplete.

Postseason, non-final and malformed games are excluded with explicit counters.

## Four independent horizons

The dataset materializes separate rows for:

- FIRST_INNING;
- FIRST_3;
- FIRST_5;
- FULL_GAME.

A score from one horizon is never reused as the outcome of another horizon.

## Baseline candidate families

B1 compares two deliberately simple marginal run-count candidates:

1. Poisson;
2. Negative Binomial NB2.

For each horizon, home and away means are estimated separately from the training window. NB2 dispersion `k` is fitted by maximizing the training likelihood through a bounded one-dimensional search. The baseline intentionally excludes team, pitcher, lineup, park, weather and bullpen covariates. Those belong to P1-M6A3B2 and must prove incremental out-of-sample value rather than being assumed useful.

This separation makes B1 a distribution-family benchmark, not the final baseball model.

## Time-aware validation

Validation uses expanding rolling-origin folds over **unique official game dates**.

For every fold:

- all training dates precede all validation dates;
- a date can never appear in both sets;
- the model is refit using only the training window;
- validation games are scored without refitting on their outcomes.

The default research configuration is:

- 60 unique training dates before the first validation fold;
- 14 validation dates per fold;
- 14-date step between fold origins;
- at least 300 accumulated validation games before a horizon can reach `READY_FOR_RESEARCH_REVIEW`.

These are research sample-floor defaults, not betting thresholds and not an actionability policy.

## Metrics

Each candidate records:

- held-out mean count negative log likelihood across home and away team-run observations;
- per-fold fitted means and NB2 dispersion;
- home-moneyline WIN/PUSH/LOSS calibration using the A3A calibration engine;
- NRFI calibration for FIRST_INNING;
- training and validation date boundaries for leakage audit.

`preferredFamilyByCountNll` is only a research ranking when the OOS sample floor is met. It does not promote a model and cannot change a live prediction.

## Reproducible acquisition artifact

The backfill script is run explicitly, never from normal application startup:

```bash
node --import tsx scripts/p1-m6a3b1-historical-backfill.mjs \
  --start 2025-03-27 \
  --end 2025-09-28 \
  --out artifacts/p1-m6a3b1-2025
```

One acquisition is bounded to at most 370 calendar days and at most six concurrent feed requests. Any feed request failure causes the backfill to fail closed rather than silently train on an incomplete download.

The output directory contains:

- `acquisition.json`;
- `dataset.json`;
- `oos-report.json`;
- `manifest.json` with SHA-256 artifact digests and the three dataset-identity/provenance digests.

The artifacts are research evidence; they are not ledger records.

## Safety boundary

P1-M6A3B1 has no live route and performs no automatic background acquisition. It does not read sportsbook prices, place bets, write predictions, mutate settlements, change model thresholds, select stakes or change the economic decision layer.

Every dataset and OOS report remains research-only with `actionabilityAllowed: false`. Automatic model selection is explicitly disabled.

## What B1 can and cannot conclude

B1 can answer whether a simple Poisson or NB2 league/home-away baseline better describes held-out run counts for each horizon and whether the resulting primitive probabilities are visibly miscalibrated.

B1 cannot conclude that either family is sufficient for betting. A baseline can win the family comparison while remaining badly calibrated or economically useless.

## Next phase — P1-M6A3B2

B2 must add baseball-specific pregame covariates using only information that would have been available before each historical game. At minimum, candidate feature groups should include team offense/defense strength and starting-pitcher evidence, then separately test lineups, bullpen availability, park, weather and other context.

Every feature group must be evaluated by incremental time-aware OOS performance. Feature construction must carry an `asOf` boundary so that season-end statistics, future starts, postgame lineup information or later injury knowledge cannot leak backward into a historical prediction.

Only after B2 and subsequent independent calibration evidence can any model family be considered for live shadow inference. Production actionability remains blocked.
