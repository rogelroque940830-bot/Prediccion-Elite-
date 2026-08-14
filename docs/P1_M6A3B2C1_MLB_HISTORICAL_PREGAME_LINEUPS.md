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

## Postponed and rescheduled schedule identity

A full-range MLB schedule response can contain more than one historical listing for the **same `gamePk`**. This was observed directly for `gamePk 778443`: MLB retained a rain-postponed April 5 listing and the played April 6 listing under the same game identity.

B2C1 resolves that situation narrowly instead of taking the first or last row arbitrarily:

1. every listing for the duplicated `gamePk` must have identical home and away team IDs;
2. after exact duplicate rows are collapsed, there must be exactly one played-final listing with `codedGameState=F`;
3. every other distinct listing must be explicitly obsolete because it is `codedGameState=D` or has a detailed state of `Postponed`, `Canceled`, `Cancelled`, or `Suspended`;
4. only then is the played-final listing selected, with `scheduleResolution=RESCHEDULED_FINAL_SELECTED`;
5. any team drift, two unrelated distinct finals, or final-plus-active/non-obsolete listing remains `P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT`.

## Suspended and resumed game identity

B2C1 v3 added a second, separate resolution for a game that **actually started, was suspended, and later resumed under the same `gamePk`**. This pattern was observed directly for `gamePk 777861` (Guardians at Twins): the MLB schedule retains the May 19 original start and the May 21 continuation as two Final listings.

The source does not infer this relationship from dates. It requires explicit, bidirectional MLB resume metadata:

1. exactly two distinct schedule candidates remain after exact duplicate collapse;
2. home and away team IDs are identical on both candidates;
3. both candidates preserve the same `officialDate`;
4. the original candidate contains `resumeDate` and `resumeGameDate`, with no `resumedFrom`;
5. the continuation contains `resumedFrom` and `resumedFromDate`, with no `resumeDate`;
6. `original.resumeDate` must equal the continuation's exact scheduled-start timestamp;
7. `continuation.resumedFrom` must equal the original exact scheduled-start timestamp;
8. `continuation.resumedFromDate` must equal the original official date;
9. both current schedule candidates must be played-final records.

Only when all of those conditions hold does B2C1 select the **original first-pitch start** and label it `SUSPENDED_ORIGINAL_START_SELECTED`.

That choice is essential for historical lineup research: the batting order being reconstructed must be the information available before the game's first pitch, not the state before a later continuation. The continuation timestamp cannot rewrite the original pregame information retrospectively.

One-way resume metadata, timestamp mismatch, team drift, more than two distinct candidates, or unrelated multiple Finals remain `P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT`.

A unique schedule listing, including an exact duplicate that collapses to one identical row, is labeled `DIRECT`. The report publishes counts for `DIRECT`, `RESCHEDULED_FINAL_SELECTED`, and `SUSPENDED_ORIGINAL_START_SELECTED`. Schedule resolution chooses the correct historical start; it does **not** supply lineup data and never relaxes the subsequent pregame snapshot checks.

## B2C1 v4: coded-state and historical-timecode integrity

The first clean v3 full-season research run exposed an important provider-state behavior. All 2,430 requested T-5 payloads contained two valid nine-player batting orders, but 2,330 payloads reported the combination `abstractGameState=Live`, `codedGameState=P`, `detailedState=Warmup`. Treating the broad abstract label `Live` as dispositive therefore misclassified valid coded pregame payloads as post-start evidence.

B2C1 v4 gives the more specific coded/detailed state precedence:

- `codedGameState=I`, `F`, or `O` is always non-pregame;
- detailed states such as `In Progress`, `Final`, `Game Over`, or `Completed Early` are non-pregame;
- `codedGameState=S` or `P` is pregame evidence, including `Live / P / Warmup`;
- otherwise explicit detailed states `Scheduled`, `Pre-Game`, `Warmup`, or `Delayed Start` may certify pregame status;
- `abstractGameState=Preview` is only a final fallback, not an override of explicit in-progress/final coded states.

The same v3 run also exposed a separate temporal-integrity problem: a small set of requested snapshots returned a provider `metaData.timeStamp` later than the requested T-5 `timecode`. B2C1 v4 therefore requires the returned provider metadata timecode to be present and lexically at or before the requested timecode. Both fields use the same fixed `YYYYMMDD_HHMMSS` format. Missing or later provider timecodes are retained as `TIMECODE_NOT_AT_OR_BEFORE_CUTOFF` and cannot be marked complete.

This guard deliberately fails closed. It does not infer that a lineup was available merely because the returned batting order looks plausible.

## Fail-closed lineup definition

A B2C1 v4 snapshot is `COMPLETE` only when all of the following hold:

1. the returned `gamePk`, home team ID and away team ID match the resolved scheduled game;
2. the provider `metaData.timeStamp` is present and is not later than the requested T-5 timecode;
3. the coded/detailed historical snapshot state is still pregame under the v4 rule above;
4. the home batting order contains exactly nine valid, unique MLB player IDs;
5. the away batting order contains exactly nine valid, unique MLB player IDs.

Otherwise the snapshot is retained with an explicit state:

- `HOME_INCOMPLETE`
- `AWAY_INCOMPLETE`
- `BOTH_INCOMPLETE`
- `NOT_PREGAME_AT_CUTOFF`
- `TIMECODE_NOT_AT_OR_BEFORE_CUTOFF`
- `IDENTITY_CONFLICT`

Missing evidence is never replaced with a final lineup, a projected lineup, a name-based guess or a previous game's order.

## One request per resolved game at the research cutoff

For each resolved regular-season `gamePk`, B2C1 derives the UTC cutoff from the selected official scheduled start and requests exactly one:

`/api/v1.1/game/{gamePk}/feed/live?timecode=YYYYMMDD_HHMMSS`

The source uses bounded concurrency, bounded transient retries and a request timeout. Persistent failures are recorded and remain missing evidence.

## Sporting identity versus provider provenance

B2C1 deliberately maintains two digests:

- `lineupHistoryDigest` — canonical sporting identity based on game identity, resolved scheduled start, schedule-resolution method, cutoff, batting-order player IDs and availability classification;
- `sourceProvenanceDigest` — archival provenance that also reflects the raw provider payload and metadata timestamp.

A provider metadata correction that remains on the same valid side of the historical cutoff must not redefine the historical batting order if the sporting fields are unchanged. A provider timestamp that crosses the requested cutoff changes availability and therefore changes canonical lineup identity. A real batting-order change, a different resolved start, or a different resolution path must also change the canonical lineup-history digest.

## Relationship to B1 and later research

The full-season B2C1 research run must be compared against the already frozen B1 2025 official cohort so that the lineup cohort cannot silently gain or lose games. Coverage must be reported before any lineup-effect model is built.

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
