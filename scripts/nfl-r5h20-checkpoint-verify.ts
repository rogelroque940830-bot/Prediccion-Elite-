#!/usr/bin/env tsx
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { hydrateNflPregameMaterializer, snapshotNflPregameMaterializer } from "../server/nfl-pregame-checkpoint";
import { NflPregameMaterializer, type NflPregameReferenceData, type NflReplayGame } from "../server/nfl-pregame-materializer";
import {
  checkpointSemanticDigest,
  getNflR5H20End2025Checkpoint,
  NFL_R5H20_END_2025_CHECKPOINT_DIGEST,
  NFL_R5H20_SOURCE_REPLAY_DIGEST,
} from "../server/nfl-r5h20-checkpoint";

const EXPECTED_REPLAY_GAMES = 3663;

type ReplayFixture = {
  semanticDigest: string;
  games: NflReplayGame[];
  oldWeeklyDepth: NonNullable<NflPregameReferenceData["oldWeeklyDepth"]>;
  timestampedDepth: NonNullable<NflPregameReferenceData["timestampedDepth"]>;
  injuries: NonNullable<NflPregameReferenceData["injuries"]>;
};

function main(): void {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("Usage: nfl-r5h20-checkpoint-verify.ts <replay.json.gz>");
  const fixture = JSON.parse(gunzipSync(fs.readFileSync(path.resolve(fixturePath))).toString("utf8")) as ReplayFixture;
  assert.equal(fixture.semanticDigest, NFL_R5H20_SOURCE_REPLAY_DIGEST, "R5H20 replay digest drift");
  assert.equal(fixture.games.length, EXPECTED_REPLAY_GAMES, "R5H20 replay game count drift");

  const referenceData: NflPregameReferenceData = {
    oldWeeklyDepth: fixture.oldWeeklyDepth,
    timestampedDepth: fixture.timestampedDepth,
    injuries: fixture.injuries,
  };
  const full = new NflPregameMaterializer(referenceData);
  for (const game of fixture.games) full.replayCompletedGame(game);

  const rebuilt = snapshotNflPregameMaterializer(full, fixture.semanticDigest);
  const embedded = getNflR5H20End2025Checkpoint();
  assert.equal(rebuilt.semanticDigest, NFL_R5H20_END_2025_CHECKPOINT_DIGEST, "rebuilt checkpoint digest drift");
  assert.equal(embedded.semanticDigest, NFL_R5H20_END_2025_CHECKPOINT_DIGEST, "embedded checkpoint digest drift");
  const { semanticDigest: _embeddedDigest, ...embeddedPayload } = embedded;
  assert.equal(checkpointSemanticDigest(embeddedPayload), NFL_R5H20_END_2025_CHECKPOINT_DIGEST, "embedded checkpoint integrity failure");
  assert.deepEqual(rebuilt, embedded, "embedded checkpoint is not the exact certified replay terminal state");

  const restored = hydrateNflPregameMaterializer(embedded, referenceData);
  assert.equal(restored.getProcessedCompletedGames(), EXPECTED_REPLAY_GAMES);
  assert.equal(restored.getLastAppliedGameId(), full.getLastAppliedGameId());

  const synthetic2026 = {
    gameId: "2026_01_BUF_MIA",
    season: 2026,
    week: 1,
    gameday: "2026-09-10",
    homeTeam: "MIA",
    awayTeam: "BUF",
  } as const;
  const fromFullReplay = full.materializePregame(synthetic2026);
  const fromCheckpoint = restored.materializePregame(synthetic2026);
  assert.deepEqual(fromCheckpoint.features, fromFullReplay.features, "checkpoint continuation feature drift");
  assert.deepEqual(fromCheckpoint.provenance, fromFullReplay.provenance, "checkpoint continuation provenance drift");
  assert.equal(fromCheckpoint.processedCompletedGames, EXPECTED_REPLAY_GAMES);

  console.log("NFL_R5H20_END_2025_CHECKPOINT_VERIFY");
  console.log(JSON.stringify({
    sourceReplayDigest: fixture.semanticDigest,
    checkpointDigest: embedded.semanticDigest,
    replayGames: fixture.games.length,
    teamStates: embedded.teamState.length,
    proxyQbStates: embedded.proxyQbState.length,
    r5bQbStates: embedded.r5bQbState.length,
    lastObservedTeams: embedded.lastObservedQb.length,
    continuationFeatureCount: Object.keys(fromCheckpoint.features).length,
    pass: true,
  }, null, 2));
  console.log("NFL_R5H20_END_2025_CHECKPOINT_VERIFY_PASS");
}

main();
