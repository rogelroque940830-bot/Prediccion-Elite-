# P1-M6A1 — Canonical MLB Market Contract and Settlement

## Purpose

P1-M6A1 establishes the immutable market taxonomy and official-settlement foundation required before CourtEdge can compare a complete MLB market universe scientifically.

This phase does **not** invent sportsbook markets, does **not** create odds, does **not** change model probabilities, and does **not** enable automatic wagering. It only makes the backend capable of representing and grading the expanded market set without collapsing distinct horizons into one market.

## Canonical periods and families

- Full game: ML, Run Line, Total, Team Total.
- First 5 innings: ML, Run Line, Total, Team Total.
- First 3 innings: ML, Run Line, Total, Team Total.
- First inning: ML, NRFI, YRFI.
- Existing legacy F5 team-total identifiers remain supported for backward compatibility.

## Settlement contract

F3 and F5 moneylines are currently canonicalized only as **two-way, push-on-tie** markets. A sportsbook quote that is three-way (home/draw/away) is a different mathematical contract and must fail closed during odds normalization until separately supported.

Run Lines are graded from the selected team's score plus the captured line over the exact period. Totals and Team Totals are graded against the exact captured line over the exact period. NRFI/YRFI remain binary first-inning run events.

## Scientific invariants

1. Full-game, F5, F3 and first-inning outcomes are distinct random variables and cannot share a settlement horizon.
2. Period markets require all innings in that period to be present in the official MLB feed before grading.
3. No market becomes actionable merely because its type is supported. Odds freshness, no-vig price, model validity, P1-M4 economic actionability and integrity gates remain separate requirements.
4. OTHER is explicitly non-production-eligible.
5. Three-way moneylines must never be coerced into two-way push-on-tie types.

## Added canonical types

- F3_ML
- F5_RUN_LINE
- F3_RUN_LINE
- F3_TOTAL
- F5_TEAM_TOTAL
- F3_TEAM_TOTAL

The existing types ML, F5_ML, RUN_LINE, TOTAL, F5_TOTAL, TEAM_TOTAL, INNING_1_ML, NRFI and YRFI remain backward compatible.

## Next phase

P1-M6A2 will normalize real sportsbook market availability and prices into this contract. Unsupported or ambiguous quote contracts remain unavailable rather than inferred.
