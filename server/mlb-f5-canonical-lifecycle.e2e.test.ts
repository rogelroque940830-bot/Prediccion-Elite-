import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

interface RunningApp {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startApp(registerPicksV2Routes: (app: express.Express) => void): Promise<RunningApp> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerPicksV2Routes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function postJson(baseUrl: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/picks/v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

function earlyLayer(homeEre = 71.4, awayEre = 48.9) {
  return {
    schemaVersion: "mlb-early-engine-capture.v1",
    source: "react-query:/api/mlb/early-markets",
    observedAt: "2026-09-04T19:44:00.000Z",
    freshness: "FRESH",
    output: {
      homeEre: { teamName: "Detroit Tigers", ereScore: homeEre, category: "STRONG_EARLY", dataStatus: "VERIFIED" },
      awayEre: { teamName: "Baltimore Orioles", ereScore: awayEre, category: "NEUTRAL", dataStatus: "VERIFIED" },
      markets: { confidence: "HIGH", dataIncomplete: false },
    },
  };
}

function canonicalPick(input: {
  id: string;
  pickType: "F5" | "F5 O/U";
  pickSide: string;
  marketType: "F5_ML" | "F5_TOTAL";
  odds: number;
  modelProb: number;
  marketImplied: number;
  edgePp: number;
  line?: number;
  gamePk?: number;
  capturedAt?: string;
  commenceTime?: string;
}) {
  const gamePk = input.gamePk ?? 991001;
  const capturedAt = input.capturedAt ?? "2026-09-04T19:45:00.000Z";
  const commenceTime = input.commenceTime ?? "2026-09-04T20:00:00.000Z";
  return {
    id: input.id,
    ts: Date.parse(capturedAt),
    sport: "mlb" as const,
    homeTeam: "Detroit Tigers",
    awayTeam: "Baltimore Orioles",
    pickType: input.pickType,
    pickSide: input.pickSide,
    confidence: input.modelProb * 100,
    edge: input.edgePp,
    odds: input.odds,
    line: input.line == null ? undefined : String(input.line),
    source: "app" as const,
    date: "2026-09-04",
    modelProb: input.modelProb * 100,
    impliedProb: input.marketImplied * 100,
    stake: 1,
    result: "P",
    profit: 0,
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1" as const,
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2", environment: "test" },
      game: {
        gamePk,
        gameDate: "2026-09-04",
        commenceTime,
        homeTeam: "Detroit Tigers",
        awayTeam: "Baltimore Orioles",
      },
      market: {
        type: input.marketType,
        selection: input.pickSide,
        ...(input.line == null ? {} : { line: input.line }),
        oddsAmerican: input.odds,
        book: "Hard Rock",
        capturedAt,
      },
      probabilities: {
        model: input.modelProb,
        marketImplied: input.marketImplied,
        edgePp: input.edgePp,
      },
      decision: {
        signal: "BET" as const,
        confidenceLabel: "PREMIUM",
        confidencePct: input.modelProb * 100,
        stakeUnits: 1,
        rationale: "canonical F5 lifecycle test",
      },
      analysis: {
        stage: "FINAL" as const,
        layers: { earlyEngine: earlyLayer() },
      },
    },
  };
}

test("F5_ML and F5_TOTAL complete canonical save -> ledger -> supersedes -> grading -> ROI/CLV lifecycle", async () => {
  const originalCwd = process.cwd();
  const previousDbPath = process.env.MLB_LEDGER_DB_PATH;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-f5-e2e-"));
  process.chdir(directory);
  process.env.MLB_LEDGER_DB_PATH = path.join(directory, "mlb-ledger.sqlite");

  let running: RunningApp | null = null;
  try {
    const [{ registerPicksV2Routes }, { getMlbLedgerStore }, { gradeMlbPrediction }, { buildMlbLedgerHistoryView }] = await Promise.all([
      import("./picks-v2"),
      import("./mlb-ledger"),
      import("./mlb-settlement-worker"),
      import("./mlb-ledger-history-view"),
    ]);
    running = await startApp(registerPicksV2Routes);
    const store = getMlbLedgerStore();

    const mlV1 = canonicalPick({
      id: "f5-ml-v1",
      pickType: "F5",
      pickSide: "Detroit Tigers F5",
      marketType: "F5_ML",
      odds: -118,
      modelProb: 0.64,
      marketImplied: 0.5413,
      edgePp: 9.87,
    });
    const first = await postJson(running.baseUrl, mlV1);
    assert.equal(first.status, 201);
    assert.equal(first.body.success, true);
    assert.equal(first.body.ledger.mode, "FULL_SNAPSHOT");

    let records = store.listRecords({ from: "2026-09-04", to: "2026-09-04", limit: 100 });
    let mlRecords = records.filter((record) => record.prediction.market.type === "F5_ML");
    assert.equal(mlRecords.length, 1);
    const firstMlPredictionId = mlRecords[0].prediction.id;
    assert.equal(mlRecords[0].prediction.analysisStage, "FINAL");
    assert.equal(mlRecords[0].prediction.payload.analysis.layers.earlyEngine.schemaVersion, "mlb-early-engine-capture.v1");

    const exactRetry = await postJson(running.baseUrl, mlV1);
    assert.equal(exactRetry.status, 200);
    records = store.listRecords({ from: "2026-09-04", to: "2026-09-04", limit: 100 });
    assert.equal(records.filter((record) => record.prediction.market.type === "F5_ML").length, 1, "exact retry must be idempotent");

    const canonicalDuplicate = await postJson(running.baseUrl, { ...mlV1, id: "f5-ml-duplicate-id" });
    assert.equal(canonicalDuplicate.status, 409);
    assert.equal(canonicalDuplicate.body.existingPickId, "f5-ml-v1");

    const mlV2 = canonicalPick({
      id: "f5-ml-v2",
      pickType: "F5",
      pickSide: "Detroit Tigers F5",
      marketType: "F5_ML",
      odds: -125,
      modelProb: 0.66,
      marketImplied: 0.5556,
      edgePp: 10.44,
      capturedAt: "2026-09-04T19:50:00.000Z",
    });
    const revised = await postJson(running.baseUrl, mlV2);
    assert.equal(revised.status, 201);
    records = store.listRecords({ from: "2026-09-04", to: "2026-09-04", limit: 100 });
    mlRecords = records.filter((record) => record.prediction.market.type === "F5_ML");
    assert.equal(mlRecords.length, 2);
    const revisedRecord = mlRecords.find((record) => record.prediction.market.oddsAmerican === -125);
    assert.ok(revisedRecord);
    assert.equal(revisedRecord.prediction.supersedesId, firstMlPredictionId);

    const totalPick = canonicalPick({
      id: "f5-total-v1",
      pickType: "F5 O/U",
      pickSide: "OVER F5 4.5",
      marketType: "F5_TOTAL",
      odds: -110,
      modelProb: 0.61,
      marketImplied: 0.5238,
      edgePp: 8.62,
      line: 4.5,
    });
    const totalSaved = await postJson(running.baseUrl, totalPick);
    assert.equal(totalSaved.status, 201);
    records = store.listRecords({ from: "2026-09-04", to: "2026-09-04", limit: 100 });
    const totalRecord = records.find((record) => record.prediction.market.type === "F5_TOTAL");
    assert.ok(totalRecord);
    assert.equal(totalRecord.prediction.market.line, 4.5);
    assert.equal(totalRecord.prediction.payload.analysis.layers.earlyEngine.schemaVersion, "mlb-early-engine-capture.v1");

    const atFirstPitch = canonicalPick({
      id: "f5-at-first-pitch",
      pickType: "F5",
      pickSide: "Baltimore Orioles F5",
      marketType: "F5_ML",
      odds: 105,
      modelProb: 0.52,
      marketImplied: 0.4878,
      edgePp: 3.22,
      gamePk: 991002,
      capturedAt: "2026-09-04T20:00:00.000Z",
      commenceTime: "2026-09-04T20:00:00.000Z",
    });
    const rejectedAtStart = await postJson(running.baseUrl, atFirstPitch);
    assert.equal(rejectedAtStart.status, 409);
    assert.match(String(rejectedAtStart.body.error), /at or after the official game start/i);

    const officialGame = {
      gamePk: 991001,
      gameDate: "2026-09-04",
      final: true,
      homeTeam: "Detroit Tigers",
      awayTeam: "Baltimore Orioles",
      homeScore: 5,
      awayScore: 3,
      innings: [
        { num: 1, home: 1, away: 0 },
        { num: 2, home: 0, away: 0 },
        { num: 3, home: 0, away: 1 },
        { num: 4, home: 2, away: 0 },
        { num: 5, home: 0, away: 0 },
        { num: 6, home: 0, away: 1 },
        { num: 7, home: 1, away: 0 },
        { num: 8, home: 0, away: 1 },
        { num: 9, home: 1, away: 0 },
      ],
    };

    const firstMlRecord = mlRecords.find((record) => record.prediction.id === firstMlPredictionId)!;
    const mlGrade = gradeMlbPrediction(firstMlRecord.prediction, officialGame);
    assert.equal(mlGrade?.result, "WIN");
    assert.equal(mlGrade?.outcomeValue, 2);
    const totalGrade = gradeMlbPrediction(totalRecord.prediction, officialGame);
    assert.equal(totalGrade?.result, "LOSS");
    assert.equal(totalGrade?.outcomeValue, 4);

    store.appendSettlement(firstMlPredictionId, {
      clientRequestId: `test-settle:${firstMlPredictionId}`,
      result: mlGrade!.result,
      closingOddsAmerican: -125,
      outcomeValue: mlGrade!.outcomeValue,
      finalScore: { home: 5, away: 3 },
      source: "official",
    });
    store.appendSettlement(totalRecord.prediction.id, {
      clientRequestId: `test-settle:${totalRecord.prediction.id}`,
      result: totalGrade!.result,
      closingOddsAmerican: -115,
      closingLine: 4.5,
      outcomeValue: totalGrade!.outcomeValue,
      finalScore: { home: 5, away: 3 },
      source: "official",
    });

    records = store.listRecords({ from: "2026-09-04", to: "2026-09-04", limit: 100 });
    const settledMl = records.find((record) => record.prediction.id === firstMlPredictionId)!;
    const settledTotal = records.find((record) => record.prediction.id === totalRecord.prediction.id)!;
    assert.equal(settledMl.settlement?.result, "WIN");
    assert.equal(settledTotal.settlement?.result, "LOSS");
    assert.ok((settledMl.settlement?.profitUnits ?? 0) > 0.84 && (settledMl.settlement?.profitUnits ?? 0) < 0.85);
    assert.equal(settledTotal.settlement?.profitUnits, -1);
    assert.ok(typeof settledMl.settlement?.clvPp === "number");
    assert.ok(typeof settledTotal.settlement?.clvPp === "number");

    const history = buildMlbLedgerHistoryView(records);
    assert.equal(history.summary.settled, 2);
    assert.equal(history.summary.pending, 1);
    assert.equal(history.summary.totalStakedUnits, 2);
    assert.equal(history.summary.totalProfitUnits, -0.1525);
    assert.equal(history.summary.roiPct, -7.6);
    assert.ok(history.picks.find((pick) => pick.id === totalRecord.prediction.id)?.earlyEngine);
    assert.equal(history.picks.find((pick) => pick.id === revisedRecord.prediction.id)?.supersedesId, firstMlPredictionId);

    store.close();
  } finally {
    if (running) await running.close();
    process.chdir(originalCwd);
    if (previousDbPath == null) delete process.env.MLB_LEDGER_DB_PATH;
    else process.env.MLB_LEDGER_DB_PATH = previousDbPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
