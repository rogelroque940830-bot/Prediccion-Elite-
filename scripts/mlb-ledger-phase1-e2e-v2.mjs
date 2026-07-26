import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const MLB_API = "https://statsapi.mlb.com/api";
const PORT = 5055;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const root = process.cwd();
const artifacts = path.join(root, "artifacts", "mlb-phase1-e2e");
const tempDir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "mlb-phase1-e2e-"));
const dbPath = path.join(tempDir, "ledger.sqlite");
const token = `e2e-${process.env.GITHUB_RUN_ID || Date.now()}-${crypto.randomBytes(12).toString("hex")}`;
const commit = process.env.GITHUB_SHA || "local";
let child = null;
let serverOutput = "";

await fsp.mkdir(artifacts, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const day = (daysBack) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - daysBack);
  return value.toISOString().slice(0, 10);
};

async function json(url, options = {}, statuses = [200]) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Non-JSON HTTP ${response.status} from ${url}: ${text.slice(0, 250)}`); }
  if (!statuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

async function recentFinalGame() {
  for (let back = 0; back <= 7; back += 1) {
    const date = day(back);
    const schedule = (await json(`${MLB_API}/v1/schedule?sportId=1&date=${date}`)).body;
    const games = (schedule?.dates || []).flatMap((entry) => entry.games || []);
    for (const item of games) {
      const state = item?.status;
      if (!(state?.abstractGameState === "Final" || state?.codedGameState === "F" || state?.detailedState === "Final")) continue;
      const gamePk = Number(item?.gamePk);
      if (!Number.isInteger(gamePk) || gamePk <= 0) continue;
      const feed = (await json(`${MLB_API}/v1.1/game/${gamePk}/feed/live`)).body;
      const feedState = feed?.gameData?.status;
      if (!(feedState?.abstractGameState === "Final" || feedState?.codedGameState === "F" || feedState?.detailedState === "Final")) continue;
      const innings = (feed?.liveData?.linescore?.innings || []).map((inning) => ({
        home: Number(inning?.home?.runs || 0), away: Number(inning?.away?.runs || 0),
      }));
      const game = {
        gamePk,
        gameDate: String(feed?.gameData?.datetime?.officialDate || date).slice(0, 10),
        commenceTime: new Date(feed?.gameData?.datetime?.dateTime || item?.gameDate).toISOString(),
        homeTeam: String(feed?.gameData?.teams?.home?.name || "").trim(),
        awayTeam: String(feed?.gameData?.teams?.away?.name || "").trim(),
        venue: String(feed?.gameData?.venue?.name || "").trim(),
        homeScore: Number(feed?.liveData?.linescore?.teams?.home?.runs ?? innings.reduce((sum, row) => sum + row.home, 0)),
        awayScore: Number(feed?.liveData?.linescore?.teams?.away?.runs ?? innings.reduce((sum, row) => sum + row.away, 0)),
      };
      if (game.homeTeam && game.awayTeam && Number.isFinite(game.homeScore) && Number.isFinite(game.awayScore)) return game;
    }
  }
  throw new Error("No official final MLB game found in the previous seven days");
}

function runtimeEnv() {
  return {
    ...process.env,
    PORT: String(PORT), NODE_ENV: "test", GIT_COMMIT_SHA: commit,
    RAILWAY_ENVIRONMENT_NAME: "github-actions-isolated-e2e",
    MLB_LEDGER_DB_PATH: dbPath, MLB_LEDGER_AUTO_SETTLE: "false",
    COURTEDGE_WRITE_TOKEN: token,
    COURTEDGE_SESSION_SECRET: `e2e-${crypto.randomBytes(24).toString("hex")}`,
    COURTEDGE_ALLOWED_ORIGINS: "", BDL_API_KEY: "unused", ODDS_API_KEY: "unused",
    RATE_LIMIT_READ_MAX: "1000", RATE_LIMIT_WRITE_MAX: "1000",
  };
}

async function start() {
  child = spawn(process.execPath, [path.join(root, "dist", "index.cjs")], {
    cwd: root, env: runtimeEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { serverOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { serverOutput += chunk.toString(); });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const health = await json(`${BASE_URL}/health`);
      if (health.body?.status === "healthy") return health.body;
    } catch {}
    await sleep(500);
  }
  throw new Error("Server did not become healthy");
}

async function stop() {
  if (child?.exitCode == null) child.kill("SIGTERM");
  if (child) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }
  child = null;
  await fsp.writeFile(path.join(artifacts, "server.log"), serverOutput);
}

const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const get = (pathname) => json(`${BASE_URL}${pathname}`);
const post = (pathname, body, headers = auth, statuses = [200, 201]) => json(`${BASE_URL}${pathname}`, {
  method: "POST", headers, body: JSON.stringify(body),
}, statuses);

function immutabilityError(db, sql, pattern) {
  let message = "";
  try { db.prepare(sql).run(); } catch (error) { message = String(error?.message || error); }
  assert.match(message, pattern);
  return message;
}

const evidence = {
  schemaVersion: "mlb-phase1-e2e-evidence.v1",
  startedAt: new Date().toISOString(),
  execution: {
    mode: "isolated-github-actions", branch: process.env.GITHUB_REF_NAME || "local",
    commit, productionLedgerModified: false, railwayModified: false,
  },
  checks: {},
};

try {
  const game = await recentFinalGame();
  const expected = game.homeScore > game.awayScore ? "WIN" : "LOSS";
  const clientRequestId = `phase1-e2e-${game.gamePk}-${process.env.GITHUB_RUN_ID || Date.now()}`;
  const payload = {
    schemaVersion: "mlb-ledger.v1", clientRequestId, source: "backfill",
    model: { name: "CourtEdge MLB Phase 1 E2E", version: "2026.07-phase1-e2e", gitCommit: commit, environment: "github-actions-isolated-e2e" },
    game: { gamePk: game.gamePk, gameDate: game.gameDate, commenceTime: game.commenceTime, homeTeam: game.homeTeam, awayTeam: game.awayTeam, venue: game.venue },
    market: { type: "ML", selection: `${game.homeTeam} ML`, oddsAmerican: -110, book: "Isolated E2E canary", capturedAt: game.commenceTime },
    probabilities: { model: 0.5 },
    decision: { signal: "INFO", confidenceLabel: "E2E_ONLY", confidencePct: 50, stakeUnits: 0, rationale: "Technical backfill canary; not a betting recommendation and never written to Railway." },
    analysis: {
      stage: "FINAL",
      warnings: ["ISOLATED_E2E_BACKFILL", "NOT_A_BETTING_RECOMMENDATION", "PRODUCTION_LEDGER_NOT_MODIFIED"],
      factors: [{ name: "Official venue orientation", direction: "NEUTRAL", confidence: "FULL", source: "MLB Stats API" }],
      sources: [{ name: "MLB Stats API", status: "VERIFIED", fetchedAt: new Date().toISOString(), metadata: { gamePk: game.gamePk } }],
      layers: { pureModel: 0.5, marketCalibration: 0.5, final: 0.5 },
      rawInputs: { technicalCanary: true, officialGame: game }, rawOutput: { expectedSettlement: expected },
    },
  };
  evidence.game = game;

  evidence.checks.firstStartup = { pass: true, health: await start() };
  const initial = (await get("/api/mlb/ledger/v1/status")).body.data;
  assert.deepEqual([initial.predictions, initial.settlementEvents, initial.immutable], [0, 0, true]);
  evidence.checks.emptyLedger = { pass: true, status: initial };

  const unauthorized = await post("/api/mlb/ledger/v1/predictions", payload, { "Content-Type": "application/json" }, [401]);
  assert.equal(unauthorized.body?.success, false);
  evidence.checks.writeAuth = { pass: true, unauthenticatedStatus: 401 };

  const created = await post("/api/mlb/ledger/v1/predictions", payload, auth, [201]);
  assert.equal(created.body?.idempotent, false);
  const id = created.body?.data?.id;
  assert.ok(id);
  const repeated = await post("/api/mlb/ledger/v1/predictions", payload, auth, [200]);
  assert.equal(repeated.body?.idempotent, true);
  assert.equal(repeated.body?.data?.id, id);
  evidence.checks.idempotentPrediction = { pass: true };

  const before = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(id)}`)).body.data;
  assert.equal(before.prediction.payload.analysis.rawInputs.technicalCanary, true);
  assert.equal(before.prediction.game.homeTeam, game.homeTeam);
  assert.equal(before.prediction.game.awayTeam, game.awayTeam);
  evidence.checks.payloadSnapshot = { pass: true };

  await stop();
  evidence.checks.restartPersistence = { pass: true, health: await start() };
  const persisted = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(id)}`)).body.data;
  assert.equal(persisted.prediction.id, id);
  assert.equal(persisted.settlement, null);

  const run = await post("/api/mlb/ledger/v1/settle-pending", {}, auth, [200]);
  assert.deepEqual([run.body.data.checked, run.body.data.settled, run.body.data.errors.length], [1, 1, 0]);
  const record = (await get(`/api/mlb/ledger/v1/predictions/${encodeURIComponent(id)}`)).body.data;
  assert.equal(record.settlement.result, expected);
  assert.deepEqual(record.settlement.finalScore, { home: game.homeScore, away: game.awayScore });
  assert.equal(record.settlement.source, "official");
  assert.equal(record.settlement.profitUnits, 0);
  evidence.checks.officialAutoSettlement = { pass: true, summary: run.body.data };
  evidence.settlement = { eventId: record.settlement.eventId, result: record.settlement.result, expected, finalScore: record.settlement.finalScore, payloadSha256: record.settlement.payloadSha256 };

  const second = await post("/api/mlb/ledger/v1/settle-pending", {}, auth, [200]);
  assert.deepEqual([second.body.data.checked, second.body.data.settled], [0, 0]);
  evidence.checks.idempotentSettlementLoop = { pass: true };

  const finalStatus = (await get("/api/mlb/ledger/v1/status")).body.data;
  assert.deepEqual([finalStatus.predictions, finalStatus.settlementEvents, finalStatus.immutable], [1, 1, true]);
  assert.match(String(finalStatus.journalMode), /wal/i);
  const report = (await get("/api/mlb/ledger/v1/report")).body.data;
  assert.deepEqual([report.overall.predictions, report.overall.settled, report.overall.pending, report.overall.unitsRisked], [1, 1, 0, 0]);
  assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
  evidence.report = { datasetSha256: report.datasetSha256, overall: report.overall, temporalSplit: report.temporalSplit };
  evidence.checks.reproducibleReport = { pass: true };

  const csvResponse = await fetch(`${BASE_URL}/api/mlb/ledger/v1/export?format=csv`);
  const csv = await csvResponse.text();
  assert.equal(csvResponse.status, 200);
  assert.ok(csv.includes(id) && csv.includes(game.homeTeam));
  const jsonlResponse = await fetch(`${BASE_URL}/api/mlb/ledger/v1/export?format=jsonl`);
  const jsonl = await jsonlResponse.text();
  const rows = jsonl.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(jsonlResponse.status, 200);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settlement.result, expected);
  await fsp.writeFile(path.join(artifacts, "mlb-ledger-export.csv"), csv);
  await fsp.writeFile(path.join(artifacts, "mlb-ledger-export.jsonl"), jsonl);
  evidence.checks.exports = { pass: true, csvRows: 1, jsonlRows: 1 };

  await stop();
  const db = new Database(dbPath);
  evidence.checks.sqliteImmutability = {
    pass: true,
    prediction: immutabilityError(db, "UPDATE mlb_prediction_ledger_v1 SET selection='tampered'", /prediction ledger is immutable/i),
    settlement: immutabilityError(db, "DELETE FROM mlb_settlement_events_v1", /settlement ledger is immutable/i),
  };
  db.close();
  await fsp.copyFile(dbPath, path.join(artifacts, "mlb-ledger-phase1-e2e.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${dbPath}${suffix}`)) await fsp.copyFile(`${dbPath}${suffix}`, path.join(artifacts, `mlb-ledger-phase1-e2e.sqlite${suffix}`));
  }

  evidence.prediction = { id, clientRequestId, payloadSha256: created.body.data.payloadSha256 };
  evidence.checks.finalStatus = { pass: true, status: finalStatus };
  evidence.completedAt = new Date().toISOString();
  evidence.result = "PASS";
  await fsp.writeFile(path.join(artifacts, "phase1-e2e-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ result: "PASS", game: `${game.awayTeam} @ ${game.homeTeam}`, gamePk: game.gamePk, officialScore: `${game.awayScore}-${game.homeScore}`, settlement: expected, predictionId: id, datasetSha256: report.datasetSha256, productionLedgerModified: false }, null, 2));
} catch (error) {
  evidence.completedAt = new Date().toISOString();
  evidence.result = "FAIL";
  evidence.error = { name: error?.name || "Error", message: error?.message || String(error), stack: error?.stack || null };
  await fsp.writeFile(path.join(artifacts, "phase1-e2e-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
} finally {
  await stop().catch(() => {});
}
