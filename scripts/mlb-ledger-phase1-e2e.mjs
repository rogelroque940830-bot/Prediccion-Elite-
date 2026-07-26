import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const MLB_API = "https://statsapi.mlb.com/api";
const PORT = Number(process.env.PHASE1_E2E_PORT || 5055);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const root = process.cwd();
const artifactDir = path.join(root, "artifacts", "mlb-phase1-e2e");
const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
const workDir = await fsp.mkdtemp(path.join(tempRoot, "courtedge-mlb-phase1-e2e-"));
const dbPath = path.join(workDir, "mlb-ledger-phase1-e2e.sqlite");
const serverLogPath = path.join(artifactDir, "server.log");
const writeToken = `phase1-e2e-${process.env.GITHUB_RUN_ID || Date.now()}-${crypto.randomBytes(12).toString("hex")}`;
const gitCommit = process.env.GITHUB_SHA || "local-e2e";
let server = null;
let serverLog = null;

await fsp.mkdir(artifactDir, { recursive: true });

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function previousUtcDate(daysBack) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack);
  return isoDate(date);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

async function fetchJson(url, options = {}, expectedStatuses = [200]) {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`Unexpected HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }
  return { status: response.status, payload, headers: response.headers };
}

async function findRecentFinalGame() {
  for (let daysBack = 0; daysBack <= 7; daysBack += 1) {
    const date = previousUtcDate(daysBack);
    const scheduleUrl = `${MLB_API}/v1/schedule?sportId=1&date=${encodeURIComponent(date)}`;
    const { payload } = await fetchJson(scheduleUrl);
    const games = (payload?.dates || []).flatMap((entry) => entry.games || []);
    const finals = games.filter((game) =>
      game?.status?.abstractGameState === "Final" ||
      game?.status?.codedGameState === "F" ||
      game?.status?.detailedState === "Final"
    );
    for (const candidate of finals) {
      const gamePk = Number(candidate?.gamePk);
      if (!Number.isInteger(gamePk) || gamePk <= 0) continue;
      const feedUrl = `${MLB_API}/v1.1/game/${gamePk}/feed/live`;
      const { payload: feed } = await fetchJson(feedUrl);
      const status = feed?.gameData?.status;
      const final =
        status?.abstractGameState === "Final" ||
        status?.codedGameState === "F" ||
        status?.detailedState === "Final";
      if (!final) continue;
      const innings = (feed?.liveData?.linescore?.innings || []).map((inning) => ({
        num: Number(inning?.num),
        home: Number(inning?.home?.runs || 0),
        away: Number(inning?.away?.runs || 0),
      }));
      const homeScore = Number(
        feed?.liveData?.linescore?.teams?.home?.runs ??
        innings.reduce((sum, inning) => sum + inning.home, 0)
      );
      const awayScore = Number(
        feed?.liveData?.linescore?.teams?.away?.runs ??
        innings.reduce((sum, inning) => sum + inning.away, 0)
      );
      const homeTeam = String(feed?.gameData?.teams?.home?.name || "").trim();
      const awayTeam = String(feed?.gameData?.teams?.away?.name || "").trim();
      const gameDate = String(
        feed?.gameData?.datetime?.officialDate ||
        feed?.gameData?.datetime?.dateTime ||
        date
      ).slice(0, 10);
      const commenceTime = String(feed?.gameData?.datetime?.dateTime || candidate?.gameDate || "");
      if (!homeTeam || !awayTeam || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      return {
        gamePk,
        gameDate,
        commenceTime: commenceTime && !Number.isNaN(Date.parse(commenceTime))
          ? new Date(commenceTime).toISOString()
          : undefined,
        homeTeam,
        awayTeam,
        venue: String(feed?.gameData?.venue?.name || candidate?.venue?.name || "").trim() || undefined,
        homeScore,
        awayScore,
      };
    }
  }
  throw new Error("No final MLB game was found in the previous seven days");
}

function serverEnvironment() {
  return {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    GIT_COMMIT_SHA: gitCommit,
    RAILWAY_ENVIRONMENT_NAME: "github-actions-isolated-e2e",
    MLB_LEDGER_DB_PATH: dbPath,
    MLB_LEDGER_AUTO_SETTLE: "false",
    COURTEDGE_WRITE_TOKEN: writeToken,
    COURTEDGE_SESSION_SECRET: `e2e-session-${crypto.randomBytes(24).toString("hex")}`,
    COURTEDGE_ALLOWED_ORIGINS: "",
    BDL_API_KEY: "e2e-not-used",
    ODDS_API_KEY: "e2e-not-used",
    RATE_LIMIT_READ_MAX: "1000",
    RATE_LIMIT_WRITE_MAX: "1000",
  };
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Server did not exit in time")), timeoutMs)),
  ]);
}

async function stopServer() {
  if (!server) return;
  if (server.exitCode == null) server.kill("SIGTERM");
  try {
    await waitForExit(server);
  } catch {
    if (server.exitCode == null) server.kill("SIGKILL");
    await waitForExit(server).catch(() => {});
  }
  server = null;
  if (serverLog) {
    await new Promise((resolve) => serverLog.end(resolve));
    serverLog = null;
  }
}

async function startServer() {
  serverLog = fs.createWriteStream(serverLogPath, { flags: "a" });
  server = spawn(process.execPath, [path.join(root, "dist", "index.cjs")], {
    cwd: root,
    env: serverEnvironment(),
    stdio: ["ignore", serverLog, serverLog],
  });

  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (server.exitCode != null) {
      throw new Error(`CourtEdge test server exited with code ${server.exitCode}`);
    }
    try {
      const { payload } = await fetchJson(`${BASE_URL}/health`);
      if (payload?.status === "healthy") return payload;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("CourtEdge test server did not become healthy");
}

function authHeaders() {
  return {
    Authorization: `Bearer ${writeToken}`,
    "Content-Type": "application/json",
  };
}

async function get(pathname) {
  return fetchJson(`${BASE_URL}${pathname}`);
}

async function post(pathname, body, authenticated = true, expectedStatuses = [200, 201]) {
  return fetchJson(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: authenticated ? authHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, expectedStatuses);
}

function expectImmutable(db, sql, expectedText) {
  let message = "";
  try {
    db.prepare(sql).run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, new RegExp(expectedText, "i"));
  return message;
}

const evidence = {
  schemaVersion: "mlb-phase1-e2e-evidence.v1",
  startedAt: new Date().toISOString(),
  execution: {
    mode: "isolated-github-actions",
    branch: process.env.GITHUB_REF_NAME || "local",
    commit: gitCommit,
    productionLedgerModified: false,
    railwayModified: false,
  },
  checks: {},
};

try {
  const game = await findRecentFinalGame();
  evidence.game = game;

  const expectedResult = game.homeScore > game.awayScore ? "WIN" : "LOSS";
  const clientRequestId = `phase1-e2e-${game.gamePk}-${process.env.GITHUB_RUN_ID || Date.now()}`;
  const predictionPayload = {
    schemaVersion: "mlb-ledger.v1",
    clientRequestId,
    source: "backfill",
    model: {
      name: "CourtEdge MLB Phase 1 E2E",
      version: "2026.07-phase1-e2e",
      gitCommit,
      environment: "github-actions-isolated-e2e",
    },
    game: {
      gamePk: game.gamePk,
      gameDate: game.gameDate,
      ...(game.commenceTime ? { commenceTime: game.commenceTime } : {}),
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      ...(game.venue ? { venue: game.venue } : {}),
    },
    market: {
      type: "ML",
      selection: `${game.homeTeam} ML`,
      oddsAmerican: -110,
      book: "Isolated E2E canary",
      capturedAt: game.commenceTime || new Date().toISOString(),
    },
    probabilities: {
      model: 0.5,
    },
    decision: {
      signal: "INFO",
      confidenceLabel: "E2E_ONLY",
      confidencePct: 50,
      stakeUnits: 0,
      rationale: "Technical backfill canary using a real official MLB result. It is not a betting recommendation and never touches the Railway ledger.",
    },
    analysis: {
      stage: "FINAL",
      warnings: [
        "ISOLATED_E2E_BACKFILL",
        "NOT_A_BETTING_RECOMMENDATION",
        "PRODUCTION_LEDGER_NOT_MODIFIED",
      ],
      factors: [
        {
          name: "Official venue orientation",
          direction: "NEUTRAL",
          confidence: "FULL",
          source: "MLB Stats API",
          note: "Home and away teams are taken from the official MLB feed.",
        },
      ],
      sources: [
        {
          name: "MLB Stats API",
          status: "VERIFIED",
          fetchedAt: new Date().toISOString(),
          metadata: { gamePk: game.gamePk, purpose: "phase1-isolated-e2e" },
        },
      ],
      layers: {
        pureModel: 0.5,
        marketCalibration: 0.5,
        final: 0.5,
      },
      rawInputs: {
        technicalCanary: true,
        officialGame: game,
      },
      rawOutput: {
        expectedSettlement: expectedResult,
      },
    },
  };

  const healthFirst = await startServer();
  evidence.checks.firstStartup = { pass: true, health: healthFirst };

  const initialStatus = (await get("/api/mlb/ledger/v1/status")).payload.data;
  assert.equal(initialStatus.predictions, 0);
  assert.equal(initialStatus.settlementEvents, 0);
  assert.equal(initialStatus.immutable, true);
  evidence.checks.emptyLedger = { pass: true, status: initialStatus };

  const unauthorized = await post(
    "/api/mlb/ledger/v1/predictions",
    predictionPayload,
    false,
    [401],
  );
  assert.equal(unauthorized.payload?.success, false);
  evidence.checks.writeAuth = { pass: true, unauthenticatedStatus: unauthorized.status };

  const created = await post("/api/mlb/ledger/v1/predictions", predictionPayload, true, [201]);
  assert.equal(created.payload?.success, true);
  assert.equal(created.payload?.idempotent, false);
  const predictionId = created.payload?.data?.id;
  assert.ok(predictionId);
  evidence.prediction = {
    id: predictionId,
    clientRequestId,
    payloadSha256: created.payload?.data?.payloadSha256,
  };

  const repeated = await post("/api/mlb/ledger/v1/predictions", predictionPayload, true, [200]);
  assert.equal(repeated.payload?.idempotent, true);
  assert.equal(repeated.payload?.data?.id, predictionId);
  evidence.checks.idempotentPrediction = { pass: true };

  const savedBeforeRestart = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(predictionId)}`)).payload.data;
  assert.equal(savedBeforeRestart.prediction.game.gamePk, game.gamePk);
  assert.equal(savedBeforeRestart.prediction.game.homeTeam, game.homeTeam);
  assert.equal(savedBeforeRestart.prediction.game.awayTeam, game.awayTeam);
  assert.equal(savedBeforeRestart.prediction.payload.analysis.rawInputs.technicalCanary, true);
  evidence.checks.payloadSnapshot = { pass: true };

  await stopServer();
  const healthSecond = await startServer();
  const persisted = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(predictionId)}`)).payload.data;
  assert.equal(persisted.prediction.id, predictionId);
  assert.equal(persisted.settlement, null);
  evidence.checks.restartPersistence = { pass: true, health: healthSecond };

  const settlementRun = await post("/api/mlb/ledger/v1/settle-pending", {}, true, [200]);
  assert.equal(settlementRun.payload?.success, true);
  assert.equal(settlementRun.payload?.data?.checked, 1);
  assert.equal(settlementRun.payload?.data?.settled, 1);
  assert.deepEqual(settlementRun.payload?.data?.errors, []);

  const settledRecord = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(predictionId)}`)).payload.data;
  assert.equal(settledRecord.settlement.result, expectedResult);
  assert.equal(settledRecord.settlement.finalScore.home, game.homeScore);
  assert.equal(settledRecord.settlement.finalScore.away, game.awayScore);
  assert.equal(settledRecord.settlement.source, "official");
  assert.equal(settledRecord.settlement.profitUnits, 0);
  evidence.settlement = {
    eventId: settledRecord.settlement.eventId,
    result: settledRecord.settlement.result,
    expectedResult,
    finalScore: settledRecord.settlement.finalScore,
    payloadSha256: settledRecord.settlement.payloadSha256,
  };
  evidence.checks.officialAutoSettlement = { pass: true, summary: settlementRun.payload.data };

  const secondSettlementRun = await post("/api/mlb/ledger/v1/settle-pending", {}, true, [200]);
  assert.equal(secondSettlementRun.payload?.data?.checked, 0);
  assert.equal(secondSettlementRun.payload?.data?.settled, 0);
  evidence.checks.idempotentSettlementLoop = { pass: true };

  const finalStatus = (await get("/api/mlb/ledger/v1/status")).payload.data;
  assert.equal(finalStatus.predictions, 1);
  assert.equal(finalStatus.settlementEvents, 1);
  assert.equal(finalStatus.immutable, true);
  assert.match(String(finalStatus.journalMode), /wal/i);

  const report = (await get("/api/mlb/ledger/v1/report")).payload.data;
  assert.equal(report.schemaVersion, "mlb-ledger.v1");
  assert.equal(report.overall.predictions, 1);
  assert.equal(report.overall.settled, 1);
  assert.equal(report.overall.pending, 0);
  assert.equal(report.overall.unitsRisked, 0);
  assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
  evidence.report = {
    datasetSha256: report.datasetSha256,
    overall: report.overall,
    temporalSplit: report.temporalSplit,
  };
  evidence.checks.reproducibleReport = { pass: true };

  const csvResponse = await fetchWithTimeout(`${BASE_URL}/api/mlb/ledger/v1/export?format=csv`);
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.ok(csv.includes("prediction_id"));
  assert.ok(csv.includes(predictionId));
  assert.ok(csv.includes(game.homeTeam));

  const jsonlResponse = await fetchWithTimeout(`${BASE_URL}/api/mlb/ledger/v1/export?format=jsonl`);
  assert.equal(jsonlResponse.status, 200);
  const jsonl = await jsonlResponse.text();
  const jsonlRows = jsonl.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(jsonlRows.length, 1);
  assert.equal(jsonlRows[0].prediction.id, predictionId);
  assert.equal(jsonlRows[0].settlement.result, expectedResult);
  evidence.checks.exports = { pass: true, csvRows: 1, jsonlRows: 1 };

  await fsp.writeFile(path.join(artifactDir, "mlb-ledger-export.csv"), csv);
  await fsp.writeFile(path.join(artifactDir, "mlb-ledger-export.jsonl"), jsonl);

  await stopServer();

  const directDb = new Database(dbPath);
  const predictionImmutableError = expectImmutable(
    directDb,
    "UPDATE mlb_prediction_ledger_v1 SET selection = 'tampered'",
    "prediction ledger is immutable",
  );
  const settlementImmutableError = expectImmutable(
    directDb,
    "DELETE FROM mlb_settlement_events_v1",
    "settlement ledger is immutable",
  );
  directDb.close();
  evidence.checks.sqliteImmutability = {
    pass: true,
    predictionImmutableError,
    settlementImmutableError,
  };

  await fsp.copyFile(dbPath, path.join(artifactDir, "mlb-ledger-phase1-e2e.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) {
      await fsp.copyFile(source, path.join(artifactDir, `mlb-ledger-phase1-e2e.sqlite${suffix}`));
    }
  }

  evidence.checks.finalStatus = { pass: true, status: finalStatus };
  evidence.completedAt = new Date().toISOString();
  evidence.result = "PASS";
  await fsp.writeFile(
    path.join(artifactDir, "phase1-e2e-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );

  console.log(JSON.stringify({
    result: evidence.result,
    game: `${game.awayTeam} @ ${game.homeTeam}`,
    gamePk: game.gamePk,
    officialScore: `${game.awayScore}-${game.homeScore}`,
    settlement: expectedResult,
    predictionId,
    datasetSha256: report.datasetSha256,
    productionLedgerModified: false,
  }, null, 2));
} catch (error) {
  evidence.completedAt = new Date().toISOString();
  evidence.result = "FAIL";
  evidence.error = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
  await fsp.writeFile(
    path.join(artifactDir, "phase1-e2e-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  throw error;
} finally {
  await stopServer().catch(() => {});
}
