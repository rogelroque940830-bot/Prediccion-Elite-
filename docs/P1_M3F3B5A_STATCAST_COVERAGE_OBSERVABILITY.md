# P1-M3F3B5A — Statcast matchup coverage observability

## Purpose

P1-M3F3B5A is an observability prerequisite for certifying the fifth detailed `ADVANCED_FACTORS` component, `statcast-matchup`.

P1-M3F3B5 corrected the material `opposingTeamId` identity defect first. B5A now asks a narrower question: **which source-coverage properties can be proven from the current identity-safe result, and which provenance dimensions remain invisible?**

This phase does not alter the Statcast matchup engine, run deltas, probability, thresholds or any P1 decision.

## Visible coverage

The current result exposes enough evidence to measure, per offense:

- whether the caller knows the current lineup is confirmed;
- lineup batter count;
- per-batter matchup source counts: `DIRECT`, `TEAM_PROXY`, `LEAGUE_FALLBACK`, unknown;
- direct batter coverage percentage;
- number of starter arsenal pitch types returned;
- whether the engine used fallback pitch types;
- number of bullpen pitchers actually evaluated;
- numeric vs-team identity;
- vs-team requested batters, successful queries, usable rows and failures.

Visible coverage is called complete only when both sides have:

- confirmed current lineups;
- exactly 9 batters;
- 9/9 direct batter matchup sources;
- no team proxy, league fallback or unknown batter source;
- non-empty starter pitch types with no fallback-pitch-type flag;
- at least one evaluated bullpen pitcher;
- 9 requested numeric-ID vs-team histories, 9 successful queries and zero failures.

## Provenance that is still hidden

Even perfect visible coverage is **not sufficient for certification** because the legacy result does not expose four material acquisition facts:

1. which source produced the pitcher's arsenal (current Savant, previous-season Savant, Stats API fallback, or cache);
2. whether the projected bullpen roster and all required bullpen pitcher stats were acquired completely, versus an empty/partial array after hidden failures;
3. whether recent batter-stats acquisition succeeded for every direct matchup row, versus a null momentum fallback;
4. the observation times / ages of the caches used by the calculation.

B5A therefore hard-codes these dimensions as unobservable and returns `BLOCKED_UNOBSERVABLE_PROVENANCE` even when every visible check is perfect.

This is deliberate. A non-null numeric result is not evidence that its source chain was complete or fresh.

## States

- `BLOCKED_UNCONFIRMED_LINEUP`: at least one current lineup is not confirmed.
- `BLOCKED_VISIBLE_COVERAGE_GAP`: current lineups are confirmed but one or more visible coverage requirements fail.
- `BLOCKED_UNOBSERVABLE_PROVENANCE`: all visible coverage requirements pass, but hidden provenance still prevents certification.

There is intentionally **no `CERTIFIED` state in B5A**.

## Next phase

P1-M3F3B5B must instrument or replace the hidden source paths so the four currently unobservable provenance dimensions become falsifiable. Only then may a cold/fresh `statcast-matchup` execution emit `sourceStatus=CERTIFIED`.

B5B must not infer those dimensions from a numeric output and must not lower the direct-coverage requirements registered here merely to obtain a green live sample.

## Safety

- model output changed: false;
- probability changed: false;
- economic threshold changed: false;
- actionability allowed: false;
- automatic promotion allowed: false;
- no ledger, settlement, sportsbook or betting writes.
