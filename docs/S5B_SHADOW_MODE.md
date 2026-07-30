# S5B — Controlled MLB Shadow Mode

## Purpose

Measure the validated MLB predictor on immutable pregame decisions without placing bets, changing formulas, changing confidence thresholds, changing market authorization, or modifying stake policy.

S5B begins from the S5A staging-validated state:

- integration control-plane commit: `8026a148d215afdf31a8e48dce08413f70cf3797`;
- deployed S5A runtime commit: `93e17cfbf30ba9971e2fea468c07ca399d7a8641`;
- exact Railway smoke: `MLB Ledger Live Smoke` run `30563996055`, success.

## Safety boundary

Shadow mode is analytical only:

- no sportsbook connection;
- no automatic or manual bet placement by this workflow;
- no real financial exposure;
- no production writes;
- no writes to Railway or `/app/data` from the validation workflow;
- no changes to formulas, thresholds, filters, markets, or stake sizing;
- no retroactive edits to captured predictions or settlements;
- no automatic GO decision or production promotion.

## Immutable source and deduplication

The evaluator consumes `mlb-ledger.v1` records. Each analytical decision receives a stable SHA-256 fingerprint based on:

- game identity;
- market, selection, line, odds and book;
- model name, version, commit and probabilities;
- signal, category and recommended stake;
- stable scientific evidence, factors, sources and analytical layers.

Purely technical timestamps and request identifiers are excluded. Repeated polling of the same model decision is therefore reported as a duplicate and cannot inflate sample size, ROI, calibration or confidence.

## Decision classification

Every unique record is classified as:

- `ACCEPTED`: `BET` or `BET_FUERTE`;
- `BLOCKED`: `PASS`;
- `OBSERVED`: `LEAN` or `INFO`.

Categories retain explicit labels when available (`ELITE`, `PREMIUM`, `LEAN`, `PASS`, `INFO`). Blocking and observation reasons are preserved from warnings, filter reasons, guardrails and blocked-reason fields in the saved scientific snapshot.

## Metrics

S5B reports:

- ledger records, unique analytical decisions and excluded duplicates;
- settled and pending decisions;
- wins, losses, pushes and hit rate;
- flat one-unit profit and ROI;
- policy-weighted simulated profit and ROI using the saved recommended stake;
- Brier score and logarithmic loss from saved pregame probability and immutable settlement classification;
- average closing-line value when available;
- average model probability and edge;
- breakdowns by market, category, disposition and probability band;
- field-level data-quality coverage.

The policy-weighted calculation is simulation only. It does not represent money wagered.

## GO / EXTEND / NO-GO template

The evaluator produces a non-automatic review gate:

- `EXTEND`: sample or required data coverage is insufficient;
- `NO_GO`: a mature sample contains multiple severe negative signals;
- `GO_REVIEW`: technical minimums are met, but human review is still mandatory.

Minimum review conditions are declared in the report and versioned with the code. `automaticPromotion` is always `false`.

## Initial dry run

The first S5B workflow uses deterministic isolated fixtures and writes only GitHub Actions artifacts:

- `shadow-evaluation.json`;
- `shadow-rows.jsonl`;
- `evidence.json`;
- `s5b-shadow-run.log`.

The artifact verifies zero financial exposure, no deployed writes, accepted/blocked separation, analytical deduplication, immutable-source declaration and disabled automatic promotion.

## Commands

```bash
npm ci
npm run typecheck:s5b-shadow
npm run test:s5b-shadow
npm run dry-run:s5b-shadow
```

## Promotion rule

Do not enable recurring staging collection until:

1. the S5B evaluator and all S1–S5A regressions pass;
2. the dry-run evidence is reviewed;
3. the collection storage and authentication boundary are explicitly approved;
4. a separate controlled deployment PR is prepared;
5. the exact staging commit passes a read-only smoke test.
