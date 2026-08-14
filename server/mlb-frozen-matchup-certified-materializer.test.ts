import assert from "node:assert/strict";
import test from "node:test";
import {
  MlbFrozenMatchupCertifiedMaterializer,
  type MlbFrozenMatchupCertifiedMaterializerOptions,
} from "./mlb-frozen-matchup-certified-materializer";
import type { MlbFrozenMatchupCanonicalSeed } from "./mlb-frozen-matchup-canonical-seed";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";

function seed(): MlbFrozenMatchupCanonicalSeed {
  return {
    schemaVersion: "courtedge-p0-v17-frozen-matchup-canonical-seed.v1",
    rawSha256: "a7af9d52d5564dbbb3268f575d0555d264e8a601a729613e3bdb6a0a0675d5d4",
    supportedTargetDateGte: "2026-08-11",
    supportedTargetDateLte: "2027-03-25",
    seedThroughDate: "2026-08-10",
    supportRationale: "test fixture",
    sourceCustody: {
      v9_2026_YTD: { workflowRunId: 31666803576, artifactId: 9168238661, artifactDigest: "sha256:2dacb88229524aecc9ebcd7d90b84e0327be360618eafe1b35ecab890e888f48" },
      v12_2025: { workflowRunId: 31669146698, artifactId: 9169102385, artifactDigest: "sha256:eca343e9c88bb4fd3ea1d4b14cc10144a4604e681d25f0140c39de9b47cebaf2" },
      v12_2026_YTD: { workflowRunId: 31669146698, artifactId: 9169078788, artifactDigest: "sha256:3fe195aec739bd9a6558fbc36fbd6a32deb4d6666910ee3be8022add910be8f7" },
    },
    handSplitGames: [{
      gamePk: 10,
      officialDate: "2026-08-10",
      teamHandTotals: [
        { teamId: 1, vsHand: "L", pa: 60, ab: 50, tb: 100 },
        { teamId: 2, vsHand: "R", pa: 60, ab: 50, tb: 50 },
      ],
    }],
    pitchmixGames: [{
      gamePk: 10,
      officialDate: "2026-08-10",
      pitcherTotals: [
        { pitcherId: 101, allPitches: 300, categorizedPitches: 300, FASTBALL: 300, BREAKING: 0, OFFSPEED: 0 },
        { pitcherId: 202, allPitches: 300, categorizedPitches: 300, FASTBALL: 300, BREAKING: 0, OFFSPEED: 0 },
      ],
      teamPitchFamilyTotals: [
        { teamId: 1, pitchFamily: "FASTBALL", swings: 100, contacts: 80, whiffs: 20, terminalPa: 100, tb: 150, hr: 10 },
        { teamId: 2, pitchFamily: "FASTBALL", swings: 100, contacts: 70, whiffs: 30, terminalPa: 100, tb: 120, hr: 8 },
        { teamId: 1, pitchFamily: "BREAKING", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
        { teamId: 2, pitchFamily: "BREAKING", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
        { teamId: 1, pitchFamily: "OFFSPEED", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
        { teamId: 2, pitchFamily: "OFFSPEED", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
      ],
    }],
    policy: {
      priceIndependent: true,
      sameDateOutcomeLeakageAllowed: false,
      seedIsFrozenHistoricalAggregateOnly: true,
      syntheticAggregateGameIdentities: true,
    },
  };
}

function game(gamePk = 999001): MlbP1SlateGame {
  return {
    gamePk,
    startTime: "2026-08-12T23:10:00.000Z",
    officialDate: "2026-08-12",
    venue: "Test Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: 101, name: "Home Starter", hand: "R", confirmed: true },
    awayPitcher: { id: 202, name: "Away Starter", hand: "L", confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: { name: "MLB_STATS_API", fetchedAt: "2026-08-12T20:00:00.000Z", quality: "AUTHORITATIVE" },
  };
}

function incrementalPlayByPlay() {
  return {
    allPlays: [
      {
        about: { halfInning: "top" },
        matchup: { batter: { id: 9001 }, pitcher: { id: 101 }, pitchHand: { code: "R" } },
        result: { eventType: "single" },
        playEvents: [{ isPitch: true, details: { type: { code: "FF" }, code: "X", isInPlay: true, description: "In play, no out" } }],
      },
      {
        about: { halfInning: "bottom" },
        matchup: { batter: { id: 9002 }, pitcher: { id: 202 }, pitchHand: { code: "L" } },
        result: { eventType: "home_run" },
        playEvents: [{ isPitch: true, details: { type: { code: "FF" }, code: "X", isInPlay: true, description: "In play, run(s)" } }],
      },
    ],
  };
}

function fakeFetch(options: { failSchedule?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl: NonNullable<MlbFrozenMatchupCertifiedMaterializerOptions["fetchImpl"]> = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/schedule")) {
      if (options.failSchedule) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({
        dates: [{
          date: "2026-08-11",
          games: [{
            gamePk: 777001,
            officialDate: "2026-08-11",
            status: { abstractGameState: "Final", detailedState: "Final" },
            teams: { home: { team: { id: 1 } }, away: { team: { id: 2 } } },
          }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/game/777001/playByPlay")) {
      return new Response(JSON.stringify(incrementalPlayByPlay()), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("combines frozen V9/V12 custody with only prior-date official incremental play-by-play", async () => {
  const fake = fakeFetch();
  const materializer = new MlbFrozenMatchupCertifiedMaterializer({ fetchImpl: fake.fetchImpl, seed: seed(), timeoutMs: 2_000 });
  const result = await materializer.assessGame(game());

  assert.equal(result.sourceStatus, "CERTIFIED");
  assert.equal(result.provenance.incrementalStartDate, "2026-08-11");
  assert.equal(result.provenance.incrementalEndDate, "2026-08-11");
  assert.equal(result.provenance.incrementalFinalGames, 1);
  assert.equal(result.provenance.sameDateOutcomeLeakageAllowed, false);
  assert.equal(result.provenance.targetOutcomeUsed, false);
  assert.equal(result.provenance.sportsbookPriceUsed, false);
  assert.equal(result.provenance.supportedTargetDateLte, "2027-03-25");
  assert.equal(result.featureAssessment.slg.eligible, true);
  assert.equal(result.featureAssessment.pitchmix.eligible, true);
  assert.ok(result.featureAssessment.slg.homePriorPaRequiredHand > 60);
  assert.equal(fake.calls.filter((url) => url.includes("/v1/schedule")).length, 1);
  assert.equal(fake.calls.filter((url) => url.includes("777001/playByPlay")).length, 1);
});

test("reuses target-date incremental custody across multiple games", async () => {
  const fake = fakeFetch();
  const materializer = new MlbFrozenMatchupCertifiedMaterializer({ fetchImpl: fake.fetchImpl, seed: seed() });
  await materializer.assessGame(game(999001));
  await materializer.assessGame(game(999002));
  assert.equal(fake.calls.filter((url) => url.includes("/v1/schedule")).length, 1);
  assert.equal(fake.calls.filter((url) => url.includes("777001/playByPlay")).length, 1);
});

test("fails closed on official incremental source failure", async () => {
  const fake = fakeFetch({ failSchedule: true });
  const materializer = new MlbFrozenMatchupCertifiedMaterializer({ fetchImpl: fake.fetchImpl, seed: seed() });
  await assert.rejects(() => materializer.assessGame(game()), /MLB_FROZEN_MATCHUP_CERTIFIED_SOURCE_FAILED/);
});

test("rejects targets outside the frozen seed support boundary", async () => {
  const fake = fakeFetch();
  const materializer = new MlbFrozenMatchupCertifiedMaterializer({ fetchImpl: fake.fetchImpl, seed: seed() });
  const before = game();
  before.officialDate = "2026-08-10";
  await assert.rejects(() => materializer.assessGame(before), /TARGET_BEFORE_SUPPORTED_DATE/);
  const after = game();
  after.officialDate = "2027-03-26";
  await assert.rejects(() => materializer.assessGame(after), /TARGET_AFTER_SUPPORTED_DATE/);
  assert.equal(fake.calls.length, 0);
});

test("rejects degraded target identity custody", async () => {
  const fake = fakeFetch();
  const materializer = new MlbFrozenMatchupCertifiedMaterializer({ fetchImpl: fake.fetchImpl, seed: seed() });
  const target = game();
  target.source.quality = "DEGRADED";
  await assert.rejects(() => materializer.assessGame(target), /TARGET_SOURCE_NOT_AUTHORITATIVE/);
  assert.equal(fake.calls.length, 0);
});
