import assert from "node:assert/strict";
import test from "node:test";
import { MlbTeamTotalShadowSqliteStore } from "./mlb-team-total-shadow-sqlite-store";
import type { MlbTeamTotalShadowCaptureResult, MlbTeamTotalShadowGameResult } from "./mlb-team-total-shadow-capture";

function gameResult(gamePk = 777001): MlbTeamTotalShadowGameResult {
  return {
    gamePk,
    officialDate: "2026-08-14",
    startTime: "2026-08-14T23:10:00.000Z",
    homeTeam: "Home Club",
    awayTeam: "Away Club",
    status: "CAPTURED",
    providerEventId: "event-1",
    providerCallMade: true,
    providerCreditsCharged: 1,
    homeMarketAvailability: "EXECUTABLE",
    awayMarketAvailability: "EXECUTABLE",
    home: null,
    away: null,
    blockers: [],
  };
}

function runResult(runId: string): MlbTeamTotalShadowCaptureResult {
  return {
    schemaVersion: "courtedge-p0-mlb-team-total-shadow-capture.v1",
    runId,
    date: "2026-08-14",
    generatedAt: "2026-08-14T20:00:00.000Z",
    modelVersion: "mlb-team-total-count-model-v20-frozen-20220814",
    status: "COMPLETED",
    games: [gameResult()],
    budget: null,
    summary: { requestedGames: 1, capturedGames: 1, alreadyCapturedGames: 0, executableHomeTeamTotals: 1, executableAwayTeamTotals: 1, evaluatedTeamTotals: 0, descriptivePositiveEvSides: 0, providerCalls: 1, providerCreditsCharged: 1 },
    policy: { explicitInvocationRequired: true, shadowOnly: true, finalPregameInputsOnly: true, oneProviderMarketKeyOnly: true, providerMarketKey: "team_totals", maxGamesPerRun: 5, firstProspectiveCapturePerGameIsCanonical: true, modelIsPriceIndependent: true, historicalTeamTotalPricesUsed: false, positiveEvRowsAreDiagnosticOnly: true, changesProductionLookupAuthorization: false, changesEliteCandidates: false, recommendsBet: false, calculatesStake: false, automaticPolling: false, automaticBetPlacement: false, realFinancialExposure: 0 },
  };
}

test("V22 SQLite run journal is idempotent and rejects plan mutation", () => {
  const store = new MlbTeamTotalShadowSqliteStore({ filename: ":memory:" });
  try {
    const first = store.beginRun({ providerAccountScopeKey: "scope", runId: "run-1", fingerprint: "abc", nowMs: 1_000, expiresAtMs: 99_000 });
    assert.equal(first.status, "ADMITTED");
    const inProgress = store.beginRun({ providerAccountScopeKey: "scope", runId: "run-1", fingerprint: "abc", nowMs: 1_001, expiresAtMs: 99_000 });
    assert.equal(inProgress.status, "IN_PROGRESS");
    const mismatch = store.beginRun({ providerAccountScopeKey: "scope", runId: "run-1", fingerprint: "different", nowMs: 1_002, expiresAtMs: 99_000 });
    assert.equal(mismatch.status, "FINGERPRINT_MISMATCH");
    store.completeRun({ providerAccountScopeKey: "scope", runId: "run-1", fingerprint: "abc", result: runResult("run-1") });
    const replay = store.beginRun({ providerAccountScopeKey: "scope", runId: "run-1", fingerprint: "abc", nowMs: 1_003, expiresAtMs: 99_000 });
    assert.equal(replay.status, "COMPLETED");
    if (replay.status === "COMPLETED") assert.equal(replay.result.runId, "run-1");
  } finally { store.close(); }
});

test("first prospective game capture is immutable across later runs", () => {
  const store = new MlbTeamTotalShadowSqliteStore({ filename: ":memory:" });
  try {
    assert.equal(store.hasCanonicalGameCapture("scope", 777001), false);
    store.saveCanonicalGameCapture({ providerAccountScopeKey: "scope", runId: "run-1", gamePk: 777001, capturedAt: "2026-08-14T20:00:00.000Z", result: gameResult() });
    assert.equal(store.hasCanonicalGameCapture("scope", 777001), true);
    assert.throws(() => store.saveCanonicalGameCapture({ providerAccountScopeKey: "scope", runId: "run-2", gamePk: 777001, capturedAt: "2026-08-14T20:01:00.000Z", result: gameResult() }), /CANONICAL_CAPTURE_ALREADY_EXISTS/);
    const rows = store.listCanonicalCaptures("scope");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].providerEventId, "event-1");
  } finally { store.close(); }
});
