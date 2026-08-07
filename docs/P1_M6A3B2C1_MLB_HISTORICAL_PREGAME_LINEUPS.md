# P1-M6A3B2C1 — Historical MLB Pregame Lineup Source

## Objective

Build a historical, auditable source for official MLB batting orders as they were available **before** a game, rather than reading the completed-game boxscore and pretending that the final lineup had been known pregame.

B2C1 is a source-certification stage only. It does not estimate a lineup effect, change a probability, choose a market, generate a pick or authorize actionability.

## Why historical `timecode` snapshots

MLB Stats API game feeds support a historical `timecode` parameter. B2C1 requests the game feed at a specific UTC instant and reads `liveData.boxscore.teams.{home,away}.battingOrder` from that historical state.

The source therefore asks: **was a complete official batting order already present at the configured pregame cutoff?** It never asks the final boxscore what the lineup eventually became and backfills that answer into the past.

## Primary cutoff

The default cutoff is **300 seconds before the scheduled start (`T-5`)**.

This is aligned with the existing P1-M2A readiness contract, where official lineups are FINAL-only evidence with a required freshness window of 300 seconds. B2C1 does not redefine the production readiness policy; it creates a historical analogue for research.

The scheduled start comes from the official MLB schedule response and is tied to `gamePk`, home team ID and away team ID. Doubleheaders remain separate by official game identity and scheduled time.

## Fail-closed lineup definition

A B2C1 snapshot is `COMPLETE` only when all of the following hold:

1. the returned `gamePk`, home team ID and away team ID match the scheduled game;
2. the historical snapshot is still pregame, not Live or Final;
3. the home batting order contains exactly nine valid, unique MLB player IDs;
4. the away batting order contains exactly nine valid, unique MLB player IDs.

Otherwise the snapshot is retained with an explicit state:

- `HOME_INCOMPLETE`
- `AWAY_INCOMPLETE`
- `BOTH_INCOMPLETE`
- `NOT_PREGAME_AT_CUTOFF`
- `IDENTITY_CONFLICT`

Missing evidence is never replaced with a final lineup, a projected lineup, a name-based guess or a previous game's order.

## One request per game at the research cutoff

For each scheduled regular-season game, B2C1 derives the UTC cutoff and requests exactly one:

`/api/v1.1/game/{gamePk}/feed/live?timecode=YYYYMMDD_HHMMSS`

The source uses bounded concurrency, bounded transient retries and a request timeout. Persistent failures are recorded and remain missing evidence.

## Sporting identity versus provider provenance

B2C1 deliberately maintains two digests:

- `lineupHistoryDigest` — canonical sporting identity based on game identity, scheduled start, cutoff, batting-order player IDs and availability classification;
- `sourceProvenanceDigest` — archival provenance that also reflects the raw provider payload and metadata timestamp.

A provider metadata correction must not redefine the historical batting order if the sporting fields are unchanged. A real batting-order change must change the canonical lineup-history digest.

## Relationship to B1 and later research

The first full-season B2C1 research run must be compared against the already frozen B1 2025 official cohort so that the lineup cohort cannot silently gain or lose games. Coverage must be reported before any lineup-effect model is built.

Only after source coverage and chain of custody are certified should B2C2 ask whether lineup information adds out-of-sample predictive value. B2C2 must remain free to conclude that the lineup feature is inconclusive or harmful.

## Safety boundary

B2C1 is research-only:

- `actionabilityAllowed=false`
- `automaticModelSelectionAllowed=false`
- `automaticPromotionAllowed=false`
- no ledger writes
- no settlement writes
- no sportsbook integration
- no model-formula changes
- no live route registration

A complete historical lineup snapshot is evidence availability, not a betting recommendation.
