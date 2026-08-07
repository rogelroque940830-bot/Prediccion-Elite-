# P1-M3E — MLB Predictor Operating Envelope

## Purpose

P1-M3E tests a different question from the P1-M6A3B2 covariate challengers.

It does **not** ask whether another baseball feature can be added to the probability model. It asks whether the predictor that already exists has a pregame-identifiable operating envelope in which its probabilistic forecasts are consistently better than outside that envelope.

The practical objective is selective prediction: learn when the model deserves high trust, when it is ordinary, and when it should abstain. P1-M3E does not change any probability, signal threshold, stake rule, sportsbook path, ledger write, settlement behavior or production recommendation.

## Registered hypothesis

**H1 — operating-envelope hypothesis**

A rule using only information known before the game identifies a subset of predictions with persistently lower log loss and Brier score, while retaining acceptable calibration, on chronologically later decisions.

**H0 — no persistent envelope**

Any apparently strong subset found in earlier decisions fails to preserve its proper-score advantage on later chronological confirmation data.

The project must accept H0 when confirmation is not decisive. A discovery result alone is never enough.

## Why this follows B2C2

P1-M6A3B2C2 rejected one specific lineup representation. FIRST_3, FIRST_5 and FULL_GAME showed supported regression versus team-only NB2, and FIRST_INNING was inconclusive. Repeatedly changing the same representation until it becomes positive would create data-mining risk.

P1-M3E instead studies the already-generated predictor decisions and asks whether **conditions of use** explain when forecasts are strongest. This is a model-selection boundary, not a new covariate.

## Source cohort

The intended source is the immutable, owner-scoped P1-M3 interactive predictor cohort already summarized by P1-M3D.

P1-M3D preserves, among other fields:

- market;
- FINAL/PROVISIONAL stage;
- source signal and category;
- effective economic decision and actionability;
- model probability;
- market-implied probability;
- no-vig probability when available;
- edge;
- data-quality coverage and missing fields;
- official settlement;
- Brier score and log loss;
- flat one-unit result;
- CLV when available.

Only settled binary WIN/LOSS observations with valid Brier and log loss are scoreable in P1-M3E. Pushes, voids, pending records and unscored records do not enter proper-score inference.

## Selector information boundary

A rule may use only pregame information. The fixed atom library contains:

- selected market;
- FINAL stage;
- source BET or BET_FUERTE label;
- source PREMIUM or ELITE category;
- ACTIONABLE_FINAL status;
- valid economic layer;
- fixed model-probability thresholds: 0.55, 0.60, 0.65, 0.70, 0.75;
- fixed edge thresholds: 3, 5, 8, 10, 12 percentage points;
- fixed no-vig edge thresholds: 0, 2, 4, 6, 8 percentage points;
- fixed data-quality thresholds: 80%, 90%, 95%, 100%;
- no missing data-quality fields;
- broad market favorite/underdog context through market-implied probability >= 0.55 or <= 0.45.

A candidate rule contains **one or two atoms only**. Two atoms from the same family are not combined, preventing redundant threshold chains such as `p >= .55 AND p >= .70`.

The threshold library is fixed before outcome evaluation. Thresholds are not learned from winners, losses, ROI or CLV.

### Forbidden selector inputs

The following fields may be used to evaluate a frozen rule but can never decide rule membership:

- result;
- settlement time;
- Brier score;
- log loss;
- profit or ROI;
- CLV;
- closing price.

A falsification test mutates settlement, scores, profit and CLV while holding pregame fields constant and requires rule membership to remain unchanged.

## Chronological discovery and confirmation

Scoreable observations are grouped by `gameDate` and sorted chronologically.

Default split:

- first 60% of unique dates: discovery;
- last 40% of unique dates: untouched confirmation.

The discovery maximum date must be strictly earlier than the confirmation minimum date. No confirmation outcome participates in candidate selection.

Default minimum total evidence before any search:

- 80 scoreable observations;
- 30 unique game dates.

If those minimums are not reached, the state is `INSUFFICIENT_SAMPLE` and there is no selected rule.

## Discovery rule selection

Every pre-registered one- and two-atom rule is evaluated on discovery only.

A rule is eligible for discovery only if:

- at least 20 selected observations;
- at least 20 rejected observations;
- selected coverage is between 15% and 70%;
- selected mean log loss is lower than rejected mean log loss;
- selected mean Brier score is lower than rejected mean Brier score;
- selected calibration gap is not more than 0.02 worse than rejected calibration.

The deterministic discovery objective rewards lower log loss and Brier and penalizes a second rule condition. ROI and CLV do not participate in rule selection.

Ties favor:

1. fewer conditions;
2. larger selected sample;
3. deterministic lexical rule identity.

If no fixed rule passes those requirements, the state is `NO_DISCOVERY_RULE`.

## Confirmation inference

The single discovery winner is frozen and applied unchanged to the later confirmation period.

Default confirmation requirements:

- at least 15 selected observations;
- at least 15 rejected observations;
- selected observations span at least 10 game dates;
- selected coverage is at least 10%;
- selected absolute calibration gap is <= 0.05 and no more than 0.01 worse than rejected calibration.

Uncertainty is estimated with deterministic **official-date cluster bootstrap**. All predictions from the same game date are resampled together so within-day dependence is not treated as independent information.

Default bootstrap:

- 5,000 replicates;
- 95% interval for `rejected mean score - selected mean score`;
- separate intervals for log loss and Brier.

`ELITE_MODEL_QUALITY_SUPPORTED` requires both log-loss and Brier point improvements to be positive **and both lower confidence bounds to be above zero**, in addition to the sample, coverage and calibration requirements.

If any requirement fails, the state is `CANDIDATE_NOT_CONFIRMED`.

## Meaning of “ELITE” in P1-M3E

`ELITE_MODEL_QUALITY_SUPPORTED` means only that a pregame rule survived the registered chronological proper-scoring test.

It does **not** mean:

- guaranteed winner;
- guaranteed profitable bet;
- automatic bet;
- production gate activation;
- permission to change the model;
- permission to change existing edge/probability thresholds;
- permission to increase stake;
- automatic promotion.

Even a supported result keeps:

- `economicProfitabilityCertified=false`;
- `operationalGateAllowed=false`;
- `modelProbabilityChanged=false`;
- `existingEconomicThresholdsChanged=false`;
- `automaticModelChangesAllowed=false`;
- `automaticPromotionAllowed=false`.

A later phase would be required to turn a supported operating envelope into a visible or operational label.

## Proper scoring versus betting economics

P1-M3E deliberately separates two questions.

**Model quality** is evaluated primarily with log loss, Brier score and calibration. These are proper probabilistic scoring criteria and are the scientific basis of the operating-envelope hypothesis.

**Betting economics** — flat ROI, policy ROI and CLV — may be reported descriptively, but they do not select the rule and do not certify model quality. Profitability requires its own prospective economic evidence because a well-calibrated probability can still be offered at a bad price.

## Research boundary

P1-M3E is initially an analytical contract only. It does not register a runtime endpoint and does not modify the predictor UI. The next step after this contract passes typecheck, falsification and regressions is a separate read-only cohort execution against real P1-M3D evidence.

That separation prevents methodology code and empirical conclusions from being introduced in the same unreviewed change.
