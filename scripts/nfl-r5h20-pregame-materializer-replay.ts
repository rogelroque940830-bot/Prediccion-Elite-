#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  NFL_R5H8_RUNTIME_FEATURES,
  NflPregameMaterializer,
  type NflInjuryUpdate,
  type NflOldWeeklyDepthSnapshot,
  type NflReplayGame,
  type NflTimestampedDepthSnapshot,
} from "../server/nfl-pregame-materializer";

const TOLERANCE = 1e-10;

type Fixture = {
  schemaVersion: string;
  sport: "NFL";
  compareSeasons: number[];
  runtimeFeatures: string[];
  marketDataUsedAsFeature: boolean;
  sameGameObservationAppliedBeforePregameSnapshot: boolean;
  semanticDigest: string;
  games: NflReplayGame[];
  oldWeeklyDepth: NflOldWeeklyDepthSnapshot[];
  timestampedDepth: NflTimestampedDepthSnapshot[];
  injuries: NflInjuryUpdate[];
  expectedRows: Array<{
    gameId: string;
    season: number;
    week: number;
    features: Record<string, number | null>;
  }>;
};

function readFixture(filePath: string): Fixture {
  const raw = fs.readFileSync(path.resolve(filePath));
  const bytes = filePath.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
  return JSON.parse(bytes.toString("utf8")) as Fixture;
}

function compareValue(actual: number | null, expected: number | null): { mismatch: boolean; error: number } {
  if (actual === null || expected === null) {
    return { mismatch: actual !== expected, error: actual === expected ? 0 : Number.POSITIVE_INFINITY };
  }
  const error = Math.abs(actual - expected);
  return { mismatch: !Number.isFinite(error) || error > TOLERANCE, error };
}

function main(): void {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("Usage: nfl-r5h20-pregame-materializer-replay.ts <replay.json.gz>");
  const fixture = readFixture(fixturePath);
  if (fixture.schemaVersion !== "courtedge-nfl-r5h20-pregame-materializer-replay.v1") {
    throw new Error(`Unexpected H20 replay schema ${fixture.schemaVersion}`);
  }
  if (fixture.sport !== "NFL") throw new Error("H20 replay sport mismatch");
  if (fixture.marketDataUsedAsFeature !== false || fixture.sameGameObservationAppliedBeforePregameSnapshot !== false) {
    throw new Error("H20 replay violated pregame/market custody boundary");
  }
  if (fixture.semanticDigest.length !== 64) throw new Error("H20 replay semantic digest missing");
  if (fixture.expectedRows.length !== 544) throw new Error(`Expected 544 H20 oracle rows, got ${fixture.expectedRows.length}`);
  if (fixture.runtimeFeatures.length !== NFL_R5H8_RUNTIME_FEATURES.length) throw new Error("H20 runtime feature count mismatch");
  for (const feature of NFL_R5H8_RUNTIME_FEATURES) {
    if (!fixture.runtimeFeatures.includes(feature)) throw new Error(`H20 replay missing runtime feature ${feature}`);
    if (/moneyline|spread|total_line|odds|price|vig|book|over_under/i.test(feature)) {
      throw new Error(`Market feature entered H20 runtime contract: ${feature}`);
    }
  }

  const expected = new Map(fixture.expectedRows.map((row) => [row.gameId, row]));
  const materializer = new NflPregameMaterializer({
    oldWeeklyDepth: fixture.oldWeeklyDepth,
    timestampedDepth: fixture.timestampedDepth,
    injuries: fixture.injuries,
  });

  let comparedGames = 0;
  let comparedValues = 0;
  let mismatches = 0;
  let nullMismatches = 0;
  let maxFiniteError = 0;
  let firstMismatch: Record<string, unknown> | null = null;

  for (const game of fixture.games) {
    const before = materializer.getProcessedCompletedGames();
    const actual = materializer.replayCompletedGame(game);
    if (actual.provenance.sameGameObservationUsed !== false || actual.provenance.targetGamedayUpdatesAllowed !== false) {
      throw new Error(`Pregame custody flag failed for ${game.gameId}`);
    }
    if (actual.processedCompletedGames !== before) {
      throw new Error(`Same-game observation leaked into pregame snapshot for ${game.gameId}`);
    }
    if (materializer.getProcessedCompletedGames() !== before + 1) {
      throw new Error(`Completed-game state did not advance exactly once for ${game.gameId}`);
    }

    const oracle = expected.get(game.gameId);
    if (!oracle) continue;
    comparedGames += 1;
    for (const feature of NFL_R5H8_RUNTIME_FEATURES) {
      comparedValues += 1;
      const a = actual.features[feature];
      const e = oracle.features[feature] ?? null;
      const result = compareValue(a, e);
      if (Number.isFinite(result.error)) maxFiniteError = Math.max(maxFiniteError, result.error);
      if (!result.mismatch) continue;
      mismatches += 1;
      if (a === null || e === null) nullMismatches += 1;
      if (!firstMismatch) {
        firstMismatch = { gameId: game.gameId, season: game.season, week: game.week, feature, actual: a, expected: e, error: result.error };
      }
    }
  }

  const summary = {
    schemaVersion: "courtedge-nfl-r5h20-typescript-materializer-parity.v1",
    sourceReplayDigest: fixture.semanticDigest,
    comparedGames,
    comparedValues,
    runtimeFeatures: NFL_R5H8_RUNTIME_FEATURES.length,
    mismatches,
    nullMismatches,
    maxFiniteError,
    tolerance: TOLERANCE,
    processedCompletedGames: materializer.getProcessedCompletedGames(),
    firstMismatch,
    pass: mismatches === 0 && comparedGames === fixture.expectedRows.length,
  };
  console.log("NFL_R5H20_TYPESCRIPT_MATERIALIZER_PARITY");
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) throw new Error(`NFL R5H20 materializer parity failed: ${JSON.stringify(summary)}`);
  console.log("NFL_R5H20_TYPESCRIPT_MATERIALIZER_PARITY_PASS");
}

main();
