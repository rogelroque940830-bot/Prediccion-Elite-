import assert from "node:assert/strict";
import test from "node:test";
import { getNflR5H21Artifact, NFL_R5H21_ARTIFACT_DIGEST, NFL_R5H21_FROZEN_2026_THRESHOLD } from "./nfl-r5h21-artifact";
import { NflR5H21LateDownRuntime, scoreNflR5H21LateDownPregame } from "./nfl-r5h21-late-down-runtime";
import { aggregateNflLateDownPbpCsvText } from "./nfl-full-elite-operational-2026";

test("NFL R5H21 embedded artifact preserves certified prospective policy and custody", () => {
  const artifact = getNflR5H21Artifact();
  assert.equal(artifact.semanticDigest, NFL_R5H21_ARTIFACT_DIGEST);
  assert.equal(artifact.targetSeason, 2026);
  assert.equal(artifact.trainedThroughSeason, 2025);
  assert.equal(artifact.productionPolicy, "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING");
  assert.equal(artifact.targetSeasonRankingOrCapUsed, false);
  assert.equal(artifact.thresholdConfig.threshold, NFL_R5H21_FROZEN_2026_THRESHOLD);
  assert.equal(artifact.end2025State.processedCompletedGames, 3663);
  assert.equal(artifact.safety.marketDataUsedAsFeatures, false);
  assert.equal(artifact.safety.target2026OutcomesUsed, false);
});

test("NFL R5H21 state applies the frozen 0.75 season decay before the first 2026 pregame card", () => {
  const artifact = getNflR5H21Artifact();
  const buf = artifact.end2025State.teamState.find((row) => row.team === "BUF");
  const mia = artifact.end2025State.teamState.find((row) => row.team === "MIA");
  assert.ok(buf && mia);
  const runtime = new NflR5H21LateDownRuntime();
  const features = runtime.materializePregame({ season: 2026, homeTeam: "BUF", awayTeam: "MIA" });
  assert.ok(Math.abs((features.home_off_late_down_conversion ?? 0) - (buf.offLateDownConversion ?? 0) * 0.75) < 1e-12);
  assert.ok(Math.abs((features.home_def_late_down_conversion_allowed ?? 0) - (buf.defLateDownConversionAllowed ?? 0) * 0.75) < 1e-12);
  assert.ok(Math.abs((features.away_off_late_down_conversion ?? 0) - (mia.offLateDownConversion ?? 0) * 0.75) < 1e-12);
  assert.equal(runtime.snapshot().currentSeason, 2026);
  assert.equal(runtime.snapshot().processedCompletedGames, 3663);
});

test("NFL R5H21 state updates only after a completed game using the frozen 0.22 EWMA", () => {
  const runtime = new NflR5H21LateDownRuntime();
  const before = runtime.materializePregame({ season: 2026, homeTeam: "BUF", awayTeam: "MIA" });
  runtime.applyCompletedGame(
    { gameId: "2026_01_MIA_BUF", season: 2026, homeTeam: "BUF", awayTeam: "MIA" },
    {
      home: { offLateDownConversion: 0.8, defLateDownConversionAllowed: 0.2 },
      away: { offLateDownConversion: 0.3, defLateDownConversionAllowed: 0.7 },
    },
  );
  const after = runtime.materializePregame({ season: 2026, homeTeam: "BUF", awayTeam: "MIA" });
  assert.ok(Math.abs((after.home_off_late_down_conversion ?? 0) - (0.78 * (before.home_off_late_down_conversion ?? 0) + 0.22 * 0.8)) < 1e-12);
  assert.ok(Math.abs((after.away_def_late_down_conversion_allowed ?? 0) - (0.78 * (before.away_def_late_down_conversion_allowed ?? 0) + 0.22 * 0.7)) < 1e-12);
  assert.equal(runtime.snapshot().processedCompletedGames, 3664);
  assert.equal(runtime.snapshot().lastAppliedGameId, "2026_01_MIA_BUF");
});

test("NFL R5H21 PBP aggregation matches late-down conversion and defensive allowance semantics", () => {
  const header = ["game_id","season_type","posteam","defteam","pass_attempt","rush_attempt","down","first_down","touchdown","no_play","qb_kneel","qb_spike"].join(",");
  const text = [
    header,
    "G1,REG,BUF,MIA,1,0,3,1,0,0,0,0",
    "G1,REG,BUF,MIA,1,0,4,0,0,0,0,0",
    "G1,REG,MIA,BUF,0,1,3,0,1,0,0,0",
    "G1,REG,MIA,BUF,1,0,2,1,0,0,0,0",
  ].join("\n");
  const out = aggregateNflLateDownPbpCsvText(text);
  const game = out.observations.get("G1");
  assert.ok(game);
  assert.equal(game.get("BUF")?.offLateDownConversion, 0.5);
  assert.equal(game.get("MIA")?.defLateDownConversionAllowed, 0.5);
  assert.equal(game.get("MIA")?.offLateDownConversion, 1);
  assert.equal(game.get("BUF")?.defLateDownConversionAllowed, 1);
});

test("NFL R5H21 threshold-only scorer can add only a non-core residual and never ranks the target season", () => {
  const base = {
    gameId: "2026_01_A_B",
    season: 2026,
    week: 1,
    gameday: "2026-09-10",
    features: {
      home_off_late_down_conversion: 0.8,
      home_def_late_down_conversion_allowed: 0.1,
      away_off_late_down_conversion: 0.1,
      away_def_late_down_conversion_allowed: 0.8,
    },
    referenceHomeWinProbability: 0.70,
  } as const;
  const residual = scoreNflR5H21LateDownPregame({ ...base, coreSelected: false });
  assert.equal(residual.thresholdOnlySelected, true);
  assert.ok(residual.supportScore >= NFL_R5H21_FROZEN_2026_THRESHOLD);
  assert.equal(residual.safety.targetSeasonRankingOrCapUsed, false);
  assert.equal(residual.safety.marketDataUsedAsModelFeature, false);
  const protectedCore = scoreNflR5H21LateDownPregame({ ...base, coreSelected: true });
  assert.equal(protectedCore.thresholdOnlySelected, false);
});
