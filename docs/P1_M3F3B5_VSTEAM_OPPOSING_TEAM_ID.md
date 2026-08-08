# P1-M3F3B5 — Statcast vs-team opposing-team identity correction

## Root cause

During the P1-M3F3B5 audit of `statcast-matchup`, the historical lineup-vs-team component was found to call MLB Stats `stats=vsTeam` with `opposingTeamId=<team abbreviation>` (for example `DET` or `CHC`).

The MLB Stats API contract defines `opposingTeamId` as the unique numeric opposing **Team ID**. An abbreviation is not that identifier.

This matters because the combined statcast matchup gives the historical-vs-team term 25% of its final run adjustment:

- starter matchup: 50%;
- projected bullpen matchup: 25%;
- lineup historical vs opponent team: 25%.

The correction is therefore a source-identity correctness fix, not a provenance-only edit.

## Correction strategy

The legacy ~1000-line matchup engine is not rewritten in this phase.

A narrow compatibility layer:

1. obtains the normal legacy starter, bullpen and lineup result;
2. extracts the batter identities already used by that result;
3. re-queries each batter's `vsTeam` history using the **numeric MLB opposing team ID**;
4. recomputes only the 25% historical term while preserving the exact existing 50/25/25 weights;
5. replaces the two historical-vs-team sections and final home/away run deltas;
6. preserves the rest of the legacy result unchanged.

If no usable lineup batter identities exist, the corrected historical term keeps the legacy neutral OPS value of `0.720`; it does not invent players or backfill hindsight lineups.

The public GET endpoint is intercepted before the historical `app.get` handler by an `app.use` compatibility middleware. The existing GET registration remains present for route-contract stability, so there is no duplicate GET route registration.

## Explicit non-claims

This fix may change live matchup run deltas because it corrects an invalid source identifier. That does **not** demonstrate improved predictive accuracy.

No historical OOS improvement claim, automatic promotion, threshold change or actionability change is authorized by this PR.

The 50/25/25 formula itself is frozen and tested.

## B5 certification impact

This correctness fix is a prerequisite for P1-M3F3B5A/B5B source-coverage and certification work. A component cannot be certified while one of its material inputs is queried under the wrong entity identity.

## Safety

No sportsbook integration, ledger write, settlement write, stake change, probability formula change or automatic betting behavior is introduced.
