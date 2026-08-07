# P1-M3E Live Owner-Cohort Evidence Audit — 2026-08-07

## Decision

**Scientific state: `INSUFFICIENT_SAMPLE`.**

No P1-M3E operating envelope is supported or rejected yet because the real prospective interactive sample has not reached the preregistered minimum required to begin discovery and chronological confirmation.

No model, probability, economic threshold, actionability or promotion change is authorized by this evidence.

## Chain of custody

- Integration/backend commit evaluated: `86d38b038e552febd291fdbed03343064e41c9ed`
- Environment: `p0-integration`
- Temporary research PR: #344
- Research head: `16414ba618a5d670ae71304a8cee8c3a9efbbeae`
- GitHub Actions workflow run: `31226494658`
- Aggregate artifact ID: `9012287192`
- Aggregate artifact ZIP SHA-256: `05dd274528f15d6b622f0d99166c4d4349d16c56a10a9fef04aee96065ae1c57`
- `result.json` SHA-256: `8cda8b738ce89e295f833db9757a431b42a2969352a503021308e5c53f4bb046`
- Private raw owner export SHA-256: `272bd12b8796721a72904f3e31ff468f855fe61c346a34b11af24a8ca41d288c`
- The raw private JSONL was held only inside the Actions runner, deleted before artifact upload, and is not preserved in this repository or the aggregate artifact.

The permanent JSON evidence file is the inspected aggregate `result.json` from the research artifact.

## Source completeness

The live owner export was obtained through the existing protected ledger export route using a service bearer credential. Without a user session, that route resolves to the configured system owner.

Live integrity checks at execution time:

- owner-scoped exported records: **2501**
- public ledger predictions: **2501**
- public settlement events: **2311**
- ownership owners: **1**
- unowned predictions: **0**
- exported records exactly matched public ledger prediction count: **true**
- ledger immutable: **true**

This establishes that the research runner received the complete live ledger belonging to the single configured owner at that point in time. It does **not** imply that all 2501 records are eligible interactive P1-M3E observations.

## P1-M3D prospective interactive cohort

P1-M3D reduced the 2501 owner records to the exact interactive scientific cohort:

- interactive ledger records: **11**
- lifecycle chains: **9**
- terminal leaves: **9**
- unique analytical decisions: **9**
- analytical duplicates excluded: **0**
- lifecycle branch conflicts: **0**
- malformed interactive records excluded: **0**
- valid economic layers: **9**
- invalid economic layers: **0**
- settled decisions: **2**
- pending decisions: **7**
- CLV-covered decisions: **0**

Lifecycle maturity is the critical finding:

- `PROVISIONAL_ONLY`: **9**
- `FINAL_ONLY`: **0**
- `PROVISIONAL_TO_FINAL`: **0**

The P1-M3D row window was complete: **9 rows for 9 unique analytical decisions**. Therefore P1-M3E was allowed to run; `P1_M3E_SOURCE_WINDOW_TRUNCATED` did not apply.

## P1-M3E result

P1-M3E received:

- input rows: **9**
- scoreable binary settled rows: **2**
- excluded/non-scoreable rows: **7**
- unique scoreable dates: **1**

Registered minimums remain unchanged:

- minimum total scoreable observations: **80**
- minimum total dates: **30**
- discovery fraction: **60% of dates**
- minimum discovery selected / rejected: **20 / 20**
- minimum confirmation selected / rejected: **15 / 15**
- minimum confirmation selected dates: **10**
- minimum confirmation coverage: **10%**
- maximum rule atoms: **2**
- deterministic date-cluster bootstrap replicates: **5000**

Observed state:

- `state`: **`INSUFFICIENT_SAMPLE`**
- selected rule: **none**
- discovery: **not started**
- confirmation: **not started**
- blocker: **`P1_M3E_MINIMUM_TOTAL_OBSERVATIONS_NOT_REACHED`**

## What the two settled rows do and do not mean

The two currently scoreable decisions were both losses. Their descriptive aggregate was flat-stake ROI -100%, Brier 0.357788 and log loss 0.913151. **No sporting or predictive conclusion is allowed from n=2.** The Wilson interval for the observed win rate is correspondingly very wide, and the preregistered P1-M3E methodology correctly refuses to search for an operating envelope at this sample size.

These two outcomes must not be used to alter thresholds, remove markets, change model weights or infer that the predictor is weak. They are only the first two scoreable prospective observations.

## Scientific interpretation

The user's refinement hypothesis remains viable but currently untestable on the prospective interactive cohort. The limiting resource is not another historical covariate; it is **prospective evidence maturity**.

The most important observed bottleneck is that all nine terminal interactive decisions are `PROVISIONAL_ONLY`. Before P1-M3E can learn when the predictor deserves an ELITE label, the system must accumulate genuine pregame decisions across many dates that mature through the intended FINAL evidence state and then settle normally.

This evidence does not authorize automatically converting a PROVISIONAL record into FINAL, generating synthetic user actions, duplicating decisions, lowering the 80/30 preregistered requirements, or backfilling the prospective interactive cohort from hindsight.

## Safety decision

- `modelQualityOperatingEnvelopeSupported`: false
- `economicProfitabilityCertified`: false
- `operationalGateAllowed`: false
- `modelProbabilityChanged`: false
- `existingEconomicThresholdsChanged`: false
- `automaticModelChangesAllowed`: false
- `automaticPromotionAllowed`: false
- predictions created by research: 0
- settlements created by research: 0
- bets placed by research: 0
- real financial exposure: 0

## Next research target

The next phase should audit **why real interactive lifecycles remain PROVISIONAL_ONLY** and design a prospective collection protocol that increases legitimate FINAL decision coverage without fabricating user actions or leaking postgame information. Only after sufficient prospective FINAL/settled evidence exists should P1-M3E attempt to discover the conditions under which the current predictor is truly elite.
