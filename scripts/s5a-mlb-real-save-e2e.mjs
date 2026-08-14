import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const MLB_API = "https://statsapi.mlb.com/api";
const PORT = 5056;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const root = process.cwd();
const artifacts = path.join(root, "artifacts", "s5a-e2e");
const tempDir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "courtedge-s5a-"));
const ledgerPath = path.join(tempDir, "mlb-ledger-v1.sqlite");
const authPath = path.join(tempDir, "courtedge-auth.sqlite");
const picksPath = path.join(tempDir, "picks.json");
const backupDir = path.join(tempDir, "backups");
const token = `s5a-${process.env.GITHUB_RUN_ID || Date.now()}-${crypto.randomBytes(12).toString("hex")}`;
const commit = process.env.GITHUB_SHA || "local";
let child = null;
let serverOutput = "";

await fsp.rm(artifacts, { recursive: true, force: true });
await fsp.mkdir(artifacts, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dateDaysBack = (daysBack) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - daysBack);
  return value.toISOString().slice(0, 10);
};

async function http(pathname, options = {}, expectedStatuses = [200]) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON HTTP ${response.status} from ${pathname}: ${text.slice(0, 500)}`);
    }
  }
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${pathname}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body, headers: response.headers };
}

async function officialFinalGame() {
  for (let daysBack = 0; daysBack <= 10; daysBack += 1) {
    const date = dateDaysBack(daysBack);
    const scheduleResponse = await fetch(
      `${MLB_API}/v1/schedule?sportId=1&date=${date}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    assert.equal(scheduleResponse.ok, true, `MLB schedule HTTP ${scheduleResponse.status}`);
    const schedule = await scheduleResponse.json();
    const games = (schedule?.dates || []).flatMap((entry) => entry.games || []);

    for (const item of games) {
      const status = item?.status;
      const isFinal = status?.abstractGameState === "Final"
        || status?.codedGameState === "F"
        || status?.detailedState === "Final";
      if (!isFinal) continue;

      const gamePk = Number(item?.gamePk);
      if (!Number.isInteger(gamePk) || gamePk <= 0) continue;
      const feedResponse = await fetch(
        `${MLB_API}/v1.1/game/${gamePk}/feed/live`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!feedResponse.ok) continue;
      const feed = await feedResponse.json();
      const feedStatus = feed?.gameData?.status;
      const feedFinal = feedStatus?.abstractGameState === "Final"
        || feedStatus?.codedGameState === "F"
        || feedStatus?.detailedState === "Final";
      if (!feedFinal) continue;

      const innings = (feed?.liveData?.linescore?.innings || []).map((inning) => ({
        home: Number(inning?.home?.runs || 0),
        away: Number(inning?.away?.runs || 0),
      }));
      const commenceTime = new Date(feed?.gameData?.datetime?.dateTime || item?.gameDate).toISOString();
      const game = {
        gamePk,
        gameDate: String(feed?.gameData?.datetime?.officialDate || date).slice(0, 10),
        commenceTime,
        capturedAt: new Date(Date.parse(commenceTime) - 5 * 60_000).toISOString(),
        homeTeam: String(feed?.gameData?.teams?.home?.name || "").trim(),
        awayTeam: String(feed?.gameData?.teams?.away?.name || "").trim(),
        venue: String(feed?.gameData?.venue?.name || "").trim(),
        homeScore: Number(
          feed?.liveData?.linescore?.teams?.home?.runs
          ?? innings.reduce((sum, inning) => sum + inning.home, 0),
        ),
        awayScore: Number(
          feed?.liveData?.linescore?.teams?.away?.runs
          ?? innings.reduce((sum, inning) => sum + inning.away, 0),
        ),
      };
      if (
        game.homeTeam
        && game.awayTeam
        && Number.isFinite(game.homeScore)
        && Number.isFinite(game.awayScore)
        && game.homeScore !== game.awayScore
      ) {
        return game;
      }
    }
  }
  throw new Error("No official final MLB game found in the previous ten days");
}

function runtimeEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    GIT_COMMIT_SHA: commit,
    RAILWAY_ENVIRONMENT_NAME: "github-actions-s5a-isolated",
    MLB_LEDGER_DB_PATH: ledgerPath,
    MLB_LEDGER_AUTO_SETTLE: "false",
    MLB_CLOSING_LINE_CAPTURE: "false",
    COURTEDGE_AUTH_DB_PATH: authPath,
    COURTEDGE_PICKS_FILE: picksPath,
    COURTEDGE_BACKUP_DIR: backupDir,
    COURTEDGE_BACKUP_ENABLED: "true",
    COURTEDGE_ALERTS_ENABLED: "false",
    COURTEDGE_WRITE_TOKEN: token,
    COURTEDGE_SESSION_SECRET: `s5a-session-${crypto.randomBytes(24).toString("hex")}`,
    COURTEDGE_ALLOWED_ORIGINS: "",
    BDL_API_KEY: "isolated-e2e-unused",
    ODDS_API_KEY: "isolated-e2e-unused",
    RATE_LIMIT_READ_MAX: "2000",
    RATE_LIMIT_WRITE_MAX: "2000",
  };
}

async function startServer() {
  child = spawn(process.execPath, [path.join(root, "dist", "index.cjs")], {
    cwd: root,
    env: runtimeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { serverOutput += chunk.toString(); });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`S5A backend exited with code ${child.exitCode}: ${serverOutput.slice(-2_000)}`);
    }
    try {
      const health = await http("/health");
      if (health.body?.status === "healthy") return health.body;
    } catch {}
    await sleep(500);
  }
  throw new Error("S5A backend did not become healthy");
}

async function stopServer() {
  if (!child) return;
  if (child.exitCode == null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(10_000),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  child = null;
}

const authHeaders = {
  "X-CourtEdge-Write-Key": token,
  "Content-Type": "application/json",
};
const privateGet = (pathname, statuses = [200]) => http(pathname, { headers: authHeaders }, statuses);
const post = (pathname, body, headers = authHeaders, statuses = [200, 201]) => http(pathname, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
}, statuses);

function buildCanonicalPick(game) {
  const runIdentity = `${process.env.GITHUB_RUN_ID || Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const id = `s5a-${game.gamePk}-${runIdentity}`.slice(0, 110);
  const selection = `${game.homeTeam} ML`;
  const marketImplied = 110 / 210;
  return {
    id,
    ts: Date.parse(game.capturedAt),
    sport: "mlb",
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    pickType: "ML",
    pickSide: selection,
    confidence: 50,
    edge: 0,
    odds: -110,
    date: game.gameDate,
    modelProb: 50,
    impliedProb: marketImplied * 100,
    stake: 0,
    source: "app",
    notes: "S5A isolated technical validation; not a betting recommendation.",
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1",
      model: {
        name: "CourtEdge MLB",
        version: "s5a-real-save-e2e-v1",
        gitCommit: commit,
        environment: "github-actions-s5a-isolated",
      },
      game: {
        gamePk: game.gamePk,
        gameDate: game.gameDate,
        commenceTime: game.commenceTime,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        venue: game.venue || undefined,
      },
      market: {
        type: "ML",
        selection,
        oddsAmerican: -110,
        book: "S5A isolated canary",
        capturedAt: game.capturedAt,
      },
      probabilities: {
        model: 0.5,
        marketImplied,
        noVig: 0.5,
        edgePp: 0,
      },
      decision: {
        signal: "INFO",
        confidenceLabel: "S5A_E2E_ONLY",
        confidencePct: 50,
        stakeUnits: 0,
        rationale: "Technical end-to-end canary using an official completed MLB game; no wager is authorized.",
      },
      analysis: {
        stage: "FINAL",
        warnings: [
          "ISOLATED_S5A_BACKFILL",
          "NOT_A_BETTING_RECOMMENDATION",
          "PRODUCTION_DATA_NOT_MODIFIED",
        ],
        factors: [{
          name: "Official venue orientation",
          direction: "NEUTRAL",
          confidence: "FULL",
          source: "MLB Stats API",
        }],
        sources: [{
          name: "MLB Stats API",
          status: "VERIFIED",
          fetchedAt: new Date().toISOString(),
          metadata: { gamePk: game.gamePk },
        }],
        layers: { pureModel: 0.5, marketCalibration: marketImplied, final: 0.5 },
        rawInputs: { technicalCanary: true, officialGame: game },
        rawOutput: { selectedMarket: "ML", recommendation: "INFO" },
      },
    },
  };
}

function immutableFailure(db, sql, pattern) {
  let message = "";
  try {
    db.prepare(sql).run();
  } catch (error) {
    message = String(error?.message || error);
  }
  assert.match(message, pattern);
  return message;
}

const evidence = {
  schemaVersion: "courtedge-s5a-e2e-evidence.v1",
  startedAt: new Date().toISOString(),
  execution: {
    mode: "isolated-github-actions",
    branch: process.env.GITHUB_REF_NAME || "local",
    commit,
    productionModified: false,
    railwayModified: false,
    sharedVolumeMounted: false,
  },
  checks: {},
};

try {
  const game = await officialFinalGame();
  const expectedResult = game.homeScore > game.awayScore ? "WIN" : "LOSS";
  const pick = buildCanonicalPick(game);
  evidence.game = game;
  evidence.pick = { id: pick.id, selection: pick.pickSide, expectedResult };

  evidence.checks.firstStartup = { pass: true, health: await startServer() };
  const initialStatus = (await privateGet("/api/mlb/ledger/v1/status")).body.data;
  assert.deepEqual(
    [initialStatus.predictions, initialStatus.settlementEvents, initialStatus.ownership.unownedPredictions],
    [0, 0, 0],
  );
  evidence.checks.emptyIsolatedStores = { pass: true, status: initialStatus };

  const unauthorized = await post(
    "/api/picks/v2",
    pick,
    { "Content-Type": "application/json" },
    [401],
  );
  assert.equal(unauthorized.body?.success, false);
  evidence.checks.writeProtection = { pass: true, unauthenticatedStatus: 401 };

  const created = await post("/api/picks/v2", pick, authHeaders, [201]);
  assert.equal(created.body?.success, true);
  assert.equal(created.body?.ledger?.mode, "FULL_SNAPSHOT");
  assert.equal(created.body?.ledger?.ownerUserId, 1);
  evidence.checks.realSavePath = { pass: true, status: created.status, ledger: created.body.ledger };

  const editableHistory = (await privateGet("/api/picks/v2?sport=mlb")).body;
  assert.equal(editableHistory.data.length, 1);
  assert.equal(editableHistory.data[0].id, pick.id);
  assert.equal("scientificSnapshot" in editableHistory.data[0], false);
  assert.equal(editableHistory.data[0].userId, 1);
  evidence.checks.lightweightEditableHistory = { pass: true, records: 1, userId: editableHistory.userId };

  const ledgerList = (await privateGet("/api/mlb/ledger/v1/predictions")).body;
  assert.equal(ledgerList.data.length, 1);
  const predictionId = ledgerList.data[0].prediction.id;
  assert.equal(ledgerList.data[0].prediction.analysisStage, "FINAL");
  assert.equal(ledgerList.data[0].prediction.payload.analysis.rawInputs.technicalCanary, true);
  assert.equal(ledgerList.data[0].ownership.userId, 1);
  evidence.prediction = {
    id: predictionId,
    payloadSha256: ledgerList.data[0].prediction.payloadSha256,
    ownership: ledgerList.data[0].ownership,
  };
  evidence.checks.immutableSnapshotAndOwnership = { pass: true };

  const retry = await post("/api/picks/v2", pick, authHeaders, [200]);
  assert.equal(retry.body?.success, true);
  const afterRetry = (await privateGet("/api/mlb/ledger/v1/predictions")).body.data;
  assert.equal(afterRetry.length, 1);
  assert.equal(afterRetry[0].prediction.id, predictionId);
  evidence.checks.exactRetryIdempotency = { pass: true, ledgerRecords: 1 };

  const duplicatePick = { ...pick, id: `${pick.id}-duplicate`.slice(0, 118) };
  const duplicate = await post("/api/picks/v2", duplicatePick, authHeaders, [409]);
  assert.match(String(duplicate.body?.error || ""), /already saved/i);
  assert.equal((await privateGet("/api/picks/v2?sport=mlb")).body.data.length, 1);
  assert.equal((await privateGet("/api/mlb/ledger/v1/predictions")).body.data.length, 1);
  evidence.checks.canonicalDuplicateProtection = { pass: true, status: 409 };

  await stopServer();
  evidence.checks.restartPersistence = { pass: true, health: await startServer() };
  const persistedPicks = (await privateGet("/api/picks/v2?sport=mlb")).body.data;
  const persistedLedger = (await privateGet("/api/mlb/ledger/v1/predictions")).body.data;
  assert.equal(persistedPicks.length, 1);
  assert.equal(persistedLedger.length, 1);
  assert.equal(persistedLedger[0].prediction.id, predictionId);
  assert.equal(persistedLedger[0].settlement, null);

  const settlementRun = await post("/api/mlb/ledger/v1/settle-pending", {}, authHeaders, [200]);
  assert.equal(settlementRun.body?.success, true);
  assert.deepEqual(
    [settlementRun.body.data.checked, settlementRun.body.data.settled, settlementRun.body.data.errors.length],
    [1, 1, 0],
  );
  const settledRecord = (await privateGet(
    `/api/mlb/ledger/v1/predictions/${encodeURIComponent(predictionId)}`,
  )).body.data;
  assert.equal(settledRecord.settlement.result, expectedResult);
  assert.deepEqual(settledRecord.settlement.finalScore, {
    home: game.homeScore,
    away: game.awayScore,
  });
  assert.equal(settledRecord.settlement.source, "official");
  assert.equal(settledRecord.settlement.profitUnits, 0);
  evidence.settlement = {
    eventId: settledRecord.settlement.eventId,
    result: settledRecord.settlement.result,
    finalScore: settledRecord.settlement.finalScore,
    payloadSha256: settledRecord.settlement.payloadSha256,
  };
  evidence.checks.officialSettlement = { pass: true, summary: settlementRun.body.data };

  const secondSettlementRun = await post("/api/mlb/ledger/v1/settle-pending", {}, authHeaders, [200]);
  assert.deepEqual(
    [secondSettlementRun.body.data.checked, secondSettlementRun.body.data.settled],
    [0, 0],
  );
  evidence.checks.settlementLoopIdempotency = { pass: true };

  const history = (await privateGet("/api/mlb/ledger/v1/history")).body.data;
  assert.deepEqual([history.summary.total, history.summary.settled, history.summary.pending], [1, 1, 0]);
  assert.equal(history.picks[0].id, predictionId);
  assert.equal(history.picks[0].settlementResult, expectedResult);
  evidence.history = { summary: history.summary, analyticalCalibration: history.analyticalCalibration };
  evidence.checks.userHistory = { pass: true };

  const report = (await privateGet("/api/mlb/ledger/v1/report")).body.data;
  assert.deepEqual([report.overall.predictions, report.overall.settled, report.overall.pending], [1, 1, 0]);
  assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
  evidence.report = { datasetSha256: report.datasetSha256, overall: report.overall };
  evidence.checks.reproducibleReport = { pass: true };

  const exportResponse = await fetch(`${BASE_URL}/api/mlb/ledger/v1/export?format=jsonl`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  const jsonl = await exportResponse.text();
  assert.equal(exportResponse.status, 200);
  const exportRows = jsonl.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(exportRows.length, 1);
  assert.equal(exportRows[0].prediction.id, predictionId);
  assert.equal(exportRows[0].settlement.result, expectedResult);
  await fsp.writeFile(path.join(artifacts, "s5a-ledger-export.jsonl"), jsonl, "utf-8");
  evidence.checks.userScopedExport = { pass: true, rows: 1 };

  const backup = await post("/api/ops/v1/backups", {}, authHeaders, [201]);
  const backupId = backup.body?.data?.backupId;
  assert.ok(backupId);
  const verification = await post(
    `/api/ops/v1/backups/${encodeURIComponent(backupId)}/verify`,
    {},
    authHeaders,
    [200],
  );
  assert.equal(verification.body?.data?.valid, true);
  const restoreDrill = await post(
    `/api/ops/v1/backups/${encodeURIComponent(backupId)}/restore-drill`,
    {},
    authHeaders,
    [200],
  );
  assert.equal(restoreDrill.body?.data?.valid, true);
  assert.equal(restoreDrill.body?.data?.sourceUntouched, true);
  evidence.backup = { backupId, verified: true, restoreDrillId: restoreDrill.body.data.drillId };
  evidence.checks.backupAndRestoreDrill = { pass: true };

  const diagnosticsResponse = await privateGet("/api/ops/v1/diagnostics", [200, 503]);
  const deterministicCodes = new Set([
    "BACKUP_FRESHNESS",
    "RESTORE_DRILL_FRESHNESS",
    "LEDGER_IMMUTABILITY",
    "LEDGER_OWNERSHIP",
    "PICK_OWNERSHIP",
  ]);
  const deterministicChecks = diagnosticsResponse.body.data.checks
    .filter((check) => deterministicCodes.has(check.code));
  assert.equal(deterministicChecks.length, deterministicCodes.size);
  assert.equal(deterministicChecks.every((check) => check.status === "HEALTHY"), true);
  evidence.diagnostics = {
    status: diagnosticsResponse.body.data.status,
    deterministicChecks,
  };
  evidence.checks.operationalInvariants = { pass: true };

  await stopServer();
  const db = new Database(ledgerPath);
  evidence.checks.sqliteImmutability = {
    pass: true,
    prediction: immutableFailure(
      db,
      "UPDATE mlb_prediction_ledger_v1 SET selection = 'tampered'",
      /prediction ledger is immutable/i,
    ),
    settlement: immutableFailure(
      db,
      "DELETE FROM mlb_settlement_events_v1",
      /settlement ledger is immutable/i,
    ),
  };
  db.close();

  const storedPicks = JSON.parse(await fsp.readFile(picksPath, "utf-8"));
  assert.equal(storedPicks.length, 1);
  assert.equal(storedPicks[0].userId, 1);
  assert.equal("scientificSnapshot" in storedPicks[0], false);
  evidence.checks.persistedFileBoundary = { pass: true };

  await fsp.copyFile(ledgerPath, path.join(artifacts, "s5a-ledger.sqlite"));
  await fsp.copyFile(authPath, path.join(artifacts, "s5a-auth.sqlite"));
  await fsp.copyFile(picksPath, path.join(artifacts, "s5a-picks.json"));
  evidence.completedAt = new Date().toISOString();
  evidence.result = "PASS";
  console.log(JSON.stringify({ result: evidence.result, checks: Object.keys(evidence.checks), game, predictionId }, null, 2));
} catch (error) {
  evidence.completedAt = new Date().toISOString();
  evidence.result = "FAIL";
  evidence.failure = {
    name: error?.name || "Error",
    message: String(error?.message || error),
    stack: String(error?.stack || "").slice(0, 8_000),
  };
  throw error;
} finally {
  await stopServer();
  await fsp.writeFile(path.join(artifacts, "server.log"), serverOutput, "utf-8");
  await fsp.writeFile(path.join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
}
