# P1-M3E.5 Live Owner Cohort Evidence — 2026-08-08

## Decision

The authoritative live state is **`WAITING_FOR_FREEZE`**.

This is not a model failure and it is not permission to relax the preregistered protocol. The real owner-scoped terminal interactive cohort currently contains **10 valid pregame decisions across 3 distinct dates**, while P1-M3E.3 requires **at least 120 decisions across at least 36 dates** before an outcome-blind frozen research window may exist.

No freeze manifest exists yet. P1-M3E.4 therefore correctly returns `WAITING_FOR_FREEZE` with blocker `P1_M3E4_FROZEN_MANIFEST_REQUIRED`.

## Chain of custody

- merged backend commit: `9205dfc6567ead4e8b27b84f4440a370ab314a22`;
- temporary research PR: #392;
- authoritative workflow run: `31268788005`;
- aggregate artifact id: `9024971742`;
- artifact SHA-256: `6c34dcf5f6d4108a923b8d679aaedd13762b7f5079787e27e81fedd940da9fbe`;
- private owner-export SHA-256: `e4d02902513a2563bab7a317987d38f1fdd2e7cfb451742e0a9618d0e6a096a1`;
- the private raw owner export was deleted inside the runner and was never uploaded.

The deployed `/health` endpoint reported the exact expected merged commit. Anonymous access to `GET /api/mlb/p1/v1/operating-envelope-frozen` returned HTTP 401 with `INTERACTIVE_SESSION_REQUIRED`, confirming the owner-scoped route remained protected in production-equivalent integration.

## Source integrity

The private service-token export contained 2,676 records, exactly matching the 2,676 public ledger predictions reported before research execution. The ledger reported 2,607 settlement events, one owner and zero unowned predictions.

The public ledger counts were checked again after the research computation:

- predictions: 2,676 before / 2,676 after;
- settlement events: 2,607 before / 2,607 after.

Therefore the research performed no production mutation.

## Real P1-M3D terminal cohort

P1-M3D reconstructed:

- 12 interactive ledger records;
- 10 lifecycle chains;
- 10 terminal leaves;
- 10 unique analytical decisions;
- zero analytical duplicates;
- zero lifecycle branches excluded;
- zero malformed interactive records;
- 10 valid economic layers and zero invalid layers;
- 9 settled decisions and 1 pending decision;
- zero CLV-covered decisions.

Lifecycle maturity remains the material limitation: all 10 chains are `PROVISIONAL_ONLY`; there are zero `FINAL_ONLY` chains and zero `PROVISIONAL_TO_FINAL` chains.

P1-M3D therefore remains `PRELIMINARY_REVIEW_ONLY` with recommendation `KEEP_COLLECTING_INTERACTIVE_SHADOW_EVIDENCE`. Conclusions, automatic model changes and automatic promotion remain disallowed.

## Descriptive performance is not inferential evidence

The nine currently settled terminal decisions happened to be 4-5, with descriptive flat-stake ROI -27.72%, Brier 0.274189 and log loss 0.750026.

Those numbers are **not a supported model-quality or profitability conclusion**. The cohort is far below the frozen M3E.5 research requirements, spans only three distinct dates, has no FINAL lifecycle maturity and has zero CLV coverage. Changing model probabilities, thresholds, markets or recommendation logic from these nine settlements would be hindsight-driven overreaction.

## P1-M3E.5 result

The source window was complete: all 10 unique analytical decisions were present as terminal review rows and all 10 were eligible for the outcome-blind freeze calculation.

Current progress toward the immutable freeze:

- eligible decisions: **10 / 120**;
- distinct dates: **3 / 36**;
- freeze state: `WAITING_FOR_FREEZE`;
- freeze manifest: none;
- frozen rows: 0;
- evaluation state: `WAITING_FOR_FREEZE`;
- stable model-quality envelope supported: false;
- economic profitability certified: false.

The preregistered 120-decision / 36-date thresholds remain unchanged.

## Safety

Research created:

- 0 predictions;
- 0 settlements;
- 0 bets;
- 0 financial exposure;
- 0 model changes;
- 0 automatic promotions.

## Next scientific bottleneck

The bottleneck is no longer another speculative covariate. It is **prospective evidence acquisition and lifecycle maturity**.

The correct next work is to increase coverage of genuine terminal interactive pregame decisions and date diversity without synthetic user actions, repeated-capture inflation or hindsight leakage, while auditing why the real cohort remains entirely `PROVISIONAL_ONLY`.

Do not lower the freeze requirements to make the current sample pass.
