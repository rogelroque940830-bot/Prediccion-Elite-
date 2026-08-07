# P1-M6A3B2A — 2025 paired OOS evidence

## Scope

This document freezes the final official-history evidence for the P1-M6A3B2A team attack/defense challenger. It is research evidence only and does not authorize betting actionability, automatic model selection, or automatic promotion.

## Chain of custody

- GitHub Actions run: `31199847411`
- Research artifact: `9002447676`
- Artifact ZIP SHA-256: `202bb1749484497e1a8ff0f89199d324edb2abc29c9762602ff344640ba5da51`
- MLB source: `statsapi.mlb.com-v1.1`
- Regular-season range: 2025-03-01 through 2025-10-01
- Frozen/reproduced canonical outcome digest: `c4f0c8b3bf2b7cb8eed5660d836034410b9f125b0491194df9b2162a4c19a64d`
- Official regular-season finals: 2,430 / 2,430
- Observations: 2,430 for each FIRST_INNING, FIRST_3, FIRST_5, FULL_GAME horizon
- OOS validation games: 1,507 per horizon
- Official-date clusters: 112 per horizon
- Bootstrap replicates: 5,000
- Multiple-horizon adjustment: Bonferroni across four horizons; family-wise confidence 98.75%
- Rolling-origin leakage check: PASS

Provider raw-feed provenance drift was observed again, while the canonical baseball outcome digest remained identical. The drift is preserved as audit evidence and does not redefine the statistical sample.

## Results

| Horizon | Point delta: baseline − challenger count NLL | Relative change | 95% paired interval | 98.75% family-wise interval | Evidence |
| --- | ---: | ---: | --- | --- | --- |
| FIRST_INNING | -0.00160892 | -0.164112% | [-0.00509418, 0.00194785] | [-0.00593715, 0.00310841] | INCONCLUSIVE |
| FIRST_3 | +0.00188046 | +0.110957% | [-0.00221930, 0.00580761] | [-0.00321370, 0.00691073] | INCONCLUSIVE |
| FIRST_5 | +0.00466759 | +0.223201% | [-0.00008491, 0.00930200] | [-0.00138753, 0.01054747] | INCONCLUSIVE |
| FULL_GAME | +0.00329231 | +0.132462% | [-0.00134313, 0.00784782] | [-0.00261516, 0.00910429] | INCONCLUSIVE |

Positive point deltas in FIRST_3, FIRST_5 and FULL_GAME are not sufficient evidence of improvement because every paired interval crosses zero. FIRST_INNING has a negative point delta, but its intervals also cross zero, so there is no supported regression either.

FIRST_5 is the closest horizon to a positive result: its ordinary 95% lower bound is `-0.00008491`, still below zero, and the pre-specified family-wise lower bound is `-0.00138753`. It therefore remains inconclusive and cannot be promoted.

## Scientific decision

**P1-M6A3B2A team attack/defense strength alone is not promoted.**

The evidence does not support claiming that team identity/shrunken attack-defense strength improves the NB2 league baseline reliably enough across unseen dates. This is a useful negative/inconclusive result: the system did not convert small favorable point estimates into a false model victory.

The next planned challenger is **P1-M6A3B2B: starting-pitcher incremental information**. B2B must be historical-`asOf`, leakage-safe, nested within training, and tested incrementally against the appropriate research baseline. It remains non-actionable until its own OOS evidence clears the pre-specified inference boundary.

## Safety boundary

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`
- No sportsbook odds, live prediction route, ledger write, settlement, or economic decision was changed by this evidence run.
