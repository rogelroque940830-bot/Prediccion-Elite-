import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import { MlbLedgerOwnershipStore, ownedRecordsForUser } from "./mlb-ledger-ownership-store";
import { MlbS5cShadowIngestionService } from "./mlb-s5c-shadow-ingestion";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("S5C records priced provisional/final decisions once, preserves price provenance and never creates financial exposure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5c-shadow-"));
  const dbPath = path.join(root, "ledger.sqlite");
  const store = new MlbLedgerStore(dbPath);
  const ownership = new MlbLedgerOwnershipStore(dbPath);
  let now = new Date("2026-07-30T16:00:00.000Z");
  let finalLineups = false;
  let lineupSize = 9;
  const capturedAt = "2026-07-30T15:59:30.000Z";
  const providerLastUpdate = "2026-07-30T15:58:00.000Z";

  const schedule = {
    dates: [{
      date: "2026-07-30",
      games: [{
        gamePk: 900001,
        gameDate: "2026-07-30T23:10:00.000Z",
        status: { abstractGameState: "Preview", detailedState: "Scheduled" },
        venue: { name: "Test Park" },
        weather: { temp: "82 degrees", wind: "8 mph, Out To Center" },
        teams: {
          home: { team: { id: 146, name: "Miami Marlins" }, probablePitcher: { id: 600001, fullName: "Home Pitcher" } },
          away: { team: { id: 143, name: "Philadelphia Phillies" }, probablePitcher: { id: 600002, fullName: "Away Pitcher" } },
        },
      }],
    }],
  };

  const feed = () => ({
    gamePk: 900001,
    gameData: {
      datetime: { dateTime: "2026-07-30T23:10:00.000Z" },
      venue: { name: "Test Park" },
      weather: { temp: "82 degrees", wind: "8 mph, Out To Center" },
      teams: {
        home: { id: 146, name: "Miami Marlins" },
        away: { id: 143, name: "Philadelphia Phillies" },
      },
      probablePitchers: {
        home: { id: 600001, fullName: "Home Pitcher" },
        away: { id: 600002, fullName: "Away Pitcher" },
      },
      players: {
        ID600001: { fullName: "Home Pitcher", pitchHand: { code: "R" } },
        ID600002: { fullName: "Away Pitcher", pitchHand: { code: "L" } },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: finalLineups ? Array.from({ length: lineupSize }, (_, index) => index + 1) : [] },
          away: { battingOrder: finalLineups ? Array.from({ length: lineupSize }, (_, index) => index + 11) : [] },
        },
      },
    },
  });

  const earlyMarkets = {
    success: true,
    data: {
      homeEre: { ereScore: 66, dataStatus: "VERIFIED" },
      awayEre: { ereScore: 48, dataStatus: "VERIFIED" },
      f5Unified: { layers: { finalProb: 62 } },
      uncertainty: { level: "LOW" },
      markets: {
        f5ProbHome: 0.62,
        f5ProbAway: 0.38,
        f5RecommendedSide: "HOME",
        f5TotalSide: "OVER",
        f5OverProb: 0.59,
        f5UnderProb: 0.41,
        inning1: { homeProb: 0.60, awayProb: 0.40, side: "HOME" },
        teamTotalOver15F5: { homeProb: 0.85, awayProb: 0.62, side: "HOME" },
        teamTotalUnder25F5: { homeProb: 0.20, awayProb: 0.71, side: "AWAY" },
        nrfiYrfiRec: "NRFI",
        probNoRun1stInn: 0.60,
        probAnyRun1stInn: 0.40,
        confidence: "MEDIUM",
        warnings: [],
        finalRecommendation: {
          market: "F5_ML",
          side: "HOME",
          action: "BET",
          reason: "PREMIUM F5 ML HOME",
          isPremium: true,
        },
        alternativePicks: [{
          market: "TT_OVER_15_F5",
          side: "HOME",
          prob: 0.85,
          reason: "Premium team total without verified quote",
          isPremium: true,
        }],
      },
    },
  };

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/v1/schedule")) return json(schedule);
    if (url.includes("/api/v1.1/game/900001/feed/live")) return json(feed());
    if (url.includes("/api/odds/mlb/f5")) {
      return json({
        success: true,
        schemaVersion: "mlb-f5-odds-consensus.v2",
        games: [{
          homeTeam: "Miami Marlins",
          awayTeam: "Philadelphia Phillies",
          commence: "2026-07-30T23:10:00.000Z",
          source: "fanduel, draftkings",
          capturedAt,
          providerLastUpdate,
          consensusMethod: "median_implied_probability",
          f5Ml: {
            home: -115,
            away: -105,
            n: 2,
            capturedAt,
            consensusMethod: "median_implied_probability",
          },
          f5Total: {
            line: 4.5,
            overOdds: -110,
            underOdds: -110,
            n: 2,
            capturedAt,
            consensusMethod: "median_implied_probability",
          },
          provenance: {
            provider: "the-odds-api",
            capturedAt,
            providerLastUpdate,
            consensusMethod: "median_implied_probability",
            contributingBooks: ["fanduel", "draftkings"],
            rawQuotes: {
              f5Ml: { home: [{ bookKey: "fanduel", price: -115 }], away: [{ bookKey: "draftkings", price: -105 }] },
              f5Total: [{ bookKey: "fanduel", price: -110, point: 4.5 }],
            },
          },
        }],
      });
    }
    if (url.includes("/api/mlb/pitcher-recent/900001")) {
      return json({ home: { trend: "STABLE", recentEra: 3.4 }, away: { trend: "STRUGGLING", recentEra: 5.1 } });
    }
    if (url.includes("/api/mlb/umpire/900001")) return json({ name: "Test Umpire", callBias: 0.1 });
    if (url.includes("/api/mlb/early-markets")) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.home.opposingPitcherId, 600002);
      assert.equal(body.away.opposingPitcherId, 600001);
      return json(earlyMarkets);
    }
    return json({ error: `Unhandled URL ${url}` }, 404);
  };

  const service = new MlbS5cShadowIngestionService(store, ownership, {
    ownerUserId: 1,
    enabled: true,
    root: path.join(root, "evidence"),
    selfBaseUrl: "http://127.0.0.1:5000",
    deploymentCommit: "test-s5c-commit",
    environment: "p0-integration",
    now: () => now,
    fetcher,
  });

  const provisional = await service.run("test-provisional");
  assert.equal(provisional.recordsCreated, 2);
  assert.equal(provisional.pricedDecisions, 2);
  assert.ok(provisional.unpricedDecisions >= 3);
  assert.equal(provisional.safety.realFinancialExposure, 0);

  const firstRecords = ownedRecordsForUser(store, ownership, 1, { limit: 100 });
  assert.equal(firstRecords.length, 2);
  assert.ok(firstRecords.every((record) => record.prediction.analysisStage === "PROVISIONAL"));
  assert.ok(firstRecords.every((record) => record.prediction.decision.stakeUnits === 0));
  assert.ok(firstRecords.some((record) => record.prediction.decision.signal === "BET_FUERTE"));
  assert.ok(firstRecords.some((record) => record.prediction.decision.signal === "LEAN"));
  assert.ok(firstRecords.every((record) => record.prediction.payload.market.capturedAt === capturedAt));
  assert.ok(firstRecords.every((record) => record.prediction.payload.analysis.rawInputs.priceCapture.providerLastUpdate === providerLastUpdate));
  assert.ok(firstRecords.every((record) => record.prediction.payload.analysis.rawInputs.priceCapture.consensusMethod === "median_implied_probability"));
  assert.ok(firstRecords.every((record) => record.prediction.payload.analysis.rawInputs.marketProvenance.contributingBooks.length === 2));
  assert.ok(firstRecords.every((record) => record.prediction.payload.analysis.layers.marketPriceIntegrity.standardAmericanOddsValidated === true));

  const redeployedService = new MlbS5cShadowIngestionService(store, ownership, {
    ownerUserId: 1,
    enabled: true,
    root: path.join(root, "redeployed-evidence"),
    selfBaseUrl: "http://127.0.0.1:5000",
    deploymentCommit: "different-deployment-commit",
    environment: "p0-integration",
    now: () => now,
    fetcher,
  });
  const redeployed = await redeployedService.run("test-redeploy");
  assert.equal(redeployed.gamesAnalyzed, 1);
  assert.equal(redeployed.pricedDecisions, 2);
  assert.equal(redeployed.recordsCreated, 0);
  assert.equal(ownedRecordsForUser(store, ownership, 1, { limit: 100 }).length, 2);

  const exactRetry = await service.run("test-retry");
  assert.equal(exactRetry.recordsCreated, 0);
  assert.equal(exactRetry.idempotentSkips, 2);
  assert.equal(ownedRecordsForUser(store, ownership, 1, { limit: 100 }).length, 2);

  finalLineups = true;
  lineupSize = 8;
  now = new Date("2026-07-30T16:30:00.000Z");
  const incompleteLineups = await service.run("test-incomplete-lineups");
  assert.equal(incompleteLineups.recordsCreated, 0);
  assert.ok(ownedRecordsForUser(store, ownership, 1, { limit: 100 })
    .every((record) => record.prediction.analysisStage === "PROVISIONAL"));

  lineupSize = 9;
  now = new Date("2026-07-30T16:35:00.000Z");
  const final = await service.run("test-final");
  assert.equal(final.recordsCreated, 2);

  const allRecords = ownedRecordsForUser(store, ownership, 1, { limit: 100 });
  assert.equal(allRecords.length, 4);
  const finalRecords = allRecords.filter((record) => record.prediction.analysisStage === "FINAL");
  assert.equal(finalRecords.length, 2);
  assert.ok(finalRecords.every((record) => Boolean(record.prediction.supersedesId)));
  assert.ok(finalRecords.every((record) => record.prediction.decision.stakeUnits === 0));
  assert.equal(ownership.status().unownedPredictions, 0);

  store.close();
  ownership.close();
  fs.rmSync(root, { recursive: true, force: true });
});
