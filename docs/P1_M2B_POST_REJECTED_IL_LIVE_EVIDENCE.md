# P1-M2B Post-Rejected-Identity IL Reconciliation — Live Evidence

## Scope

Permanent sanitized evidence for the production injury-identity reconciliation merged in PR #456 and deployed as commit `78ac15e52cec34b0229b3a2b94dc958720e4e1c1`.

This evidence is derived from temporary research PR #457, authoritative workflow run `31417880262`, job `93551164708`. The research PR was closed without merge.

## Chain of custody

- `/health`: HTTP 200.
- Historical `/api/mlb/all?date=2026-08-09`: HTTP 200.
- Current `/api/mlb/all?date=2026-08-10`: HTTP 200.
- Deployed commit matched the expected merge SHA exactly.
- Sanitized artifact ID: `9074137079`.
- Artifact SHA-256: `52e584f64df8e296c13b7643fa3f50ceedd4f42fd94f05c07e84fb475d180257`.

## Historical full-slate result — 2026-08-09

The fixed 15-game / 30-side cohort produced:

- 29 VERIFIED injury sides;
- 1 PARTIAL injury side;
- 27 raw rejected external identities across 17 sides;
- 26 rejected identities safely reconciled across 16 sides;
- exactly 1 rejected identity remained unresolved on 1 side;
- 90 MLB-official evidence-only supplements;
- zero reconciliation invariant violations.

The one unresolved identity is consistent with the transaction-only authority case measured before production repair. Transaction-only evidence remains intentionally insufficient to close coverage.

## Current live result — 2026-08-10

The current 10-game / 20-side slate produced:

- 19 VERIFIED injury sides;
- 1 PARTIAL injury side;
- 17 raw rejected identities across 11 sides;
- 16 safely reconciled identities across 10 sides;
- exactly 1 unresolved identity on 1 side;
- 64 MLB-official evidence-only supplements;
- zero reconciliation invariant violations.

Raw `rejectedCount` is preserved as audit evidence. Reconciliation metadata is reported separately. No fuzzy matching, transaction-only rescue, active/non-IL rescue, count relaxation or partial-side promotion is used.

## Readiness effect

Three current games were evaluated for both ML and F5_ML: six readiness evaluations total.

- all six requests returned HTTP 200;
- `INJURIES` was `FRESH` in all six evaluations;
- all six readiness gates were `BLOCKED`;
- the hard blocker in all six was `MARKET_ODDS_MISSING`;
- ML retained `ADVANCED_FACTORS = DEGRADED` in the sample;
- F5_ML retained `PITCHER_FORM = DEGRADED` and `LINEUP_MATCHUP = DEGRADED`.

Therefore the live evidence supports the narrow conclusion that the injury-source blocker was removed from the sampled readiness evaluations. It does **not** support `READY_FINAL`: market odds were missing in all six sampled evaluations.

## Safety boundary

The audit performed zero writes and made no model, formula, probability, recommendation, threshold, stake, Phase B, ledger, settlement or sportsbook changes. Raw payloads remained runner-private; no player, team or game identities and no provider credential were persisted in the permanent evidence.
