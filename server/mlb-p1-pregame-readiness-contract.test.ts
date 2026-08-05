import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M2A_AUDIT_FINDINGS,
  MLB_P1_M2A_FINAL_ONLY_FIELDS,
  MLB_P1_M2A_HARD_BLOCKING_FIELDS,
  MLB_P1_M2A_MARKET_REQUIREMENTS,
  MLB_P1_M2A_SOURCE_INVENTORY,
  classifyMlbP1M2aFreshness,
  decideMlbP1M2aPregameGate,
  type MlbP1M2aEvidenceState,
  type MlbP1M2aField,
} from "./mlb-p1-pregame-readiness-contract";

function freshEvidence(fields: readonly MlbP1M2aField[]): Partial<Record<MlbP1M2aField, MlbP1M2aEvidenceState>> {
  return Object.fromEntries(fields.map((field) => [field, "FRESH"])) as Partial<Record<MlbP1M2aField, MlbP1M2aEvidenceState>>;
}

test("source inventory uses unique IDs and covers every readiness field", () => {
  const ids = MLB_P1_M2A_SOURCE_INVENTORY.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length);

  const covered = new Set(MLB_P1_M2A_SOURCE_INVENTORY.map((source) => source.field));
  const expected: MlbP1M2aField[] = [
    "GAME_IDENTITY", "PITCHERS", "LINEUPS", "INJURIES", "MARKET_ODDS", "BULLPEN",
    "PITCHER_FORM", "LINEUP_MATCHUP", "ENVIRONMENT", "UMPIRE", "ADVANCED_FACTORS",
  ];
  assert.deepEqual([...covered].sort(), expected.sort());
});

test("audit records the contract, cache, timestamp and visible-degradation gaps", () => {
  const codes = new Set(MLB_P1_M2A_AUDIT_FINDINGS.map((finding) => finding.code));
  assert.equal(codes.has("NO_SINGLE_PREGAME_READINESS_CONTRACT"), true);
  assert.equal(codes.has("AGGREGATE_CACHE_EXCEEDS_DESIRED_FRESHNESS"), true);
  assert.equal(codes.has("FACTOR_ENDPOINTS_LACK_UNIFORM_TIMESTAMPS"), true);
  assert.equal(codes.has("SILENT_FACTOR_DEGRADATION"), true);
});

test("freshness is deterministic and fails unknown timestamps closed", () => {
  const now = new Date("2026-08-05T14:00:00.000Z");
  assert.equal(classifyMlbP1M2aFreshness({ observedAt: "2026-08-05T13:56:00.000Z", now, maxAgeSeconds: 300 }), "FRESH");
  assert.equal(classifyMlbP1M2aFreshness({ observedAt: "2026-08-05T13:54:59.000Z", now, maxAgeSeconds: 300 }), "STALE");
  assert.equal(classifyMlbP1M2aFreshness({ observedAt: null, now, maxAgeSeconds: 300 }), "UNKNOWN");
  assert.equal(classifyMlbP1M2aFreshness({ observedAt: "invalid", now, maxAgeSeconds: 300 }), "UNKNOWN");
  assert.equal(classifyMlbP1M2aFreshness({ observedAt: "2026-08-05T14:02:00.000Z", now, maxAgeSeconds: 300 }), "UNKNOWN");
});

test("missing or stale hard evidence blocks prediction generation", () => {
  const evidence = freshEvidence([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS.F5_ML,
  ]);
  evidence.MARKET_ODDS = "STALE";
  const decision = decideMlbP1M2aPregameGate({ market: "F5_ML", gameState: "PREGAME", evidence });
  assert.equal(decision.status, "BLOCKED");
  assert.equal(decision.analysisAllowed, false);
  assert.deepEqual(decision.blockers, ["MARKET_ODDS_STALE"]);
});

test("started and closed games are blocked even when all evidence is fresh", () => {
  const evidence = freshEvidence([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS.ML,
  ]);
  for (const gameState of ["IN_PROGRESS", "FINAL", "CLOSED"] as const) {
    const decision = decideMlbP1M2aPregameGate({ market: "ML", gameState, evidence });
    assert.equal(decision.status, "BLOCKED");
    assert.equal(decision.blockers[0], `GAME_STATE_${gameState}`);
  }
});

test("missing lineups or injuries permits only provisional analysis", () => {
  const evidence = freshEvidence([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS.F5_ML,
  ]);
  evidence.LINEUPS = "MISSING";
  evidence.INJURIES = "DEGRADED";
  const decision = decideMlbP1M2aPregameGate({ market: "F5_ML", gameState: "SCHEDULED", evidence });
  assert.equal(decision.status, "READY_PROVISIONAL");
  assert.equal(decision.analysisAllowed, true);
  assert.deepEqual(decision.warnings, ["LINEUPS_MISSING", "INJURIES_DEGRADED"]);
});

test("market-specific sufficiency distinguishes F5 from full-game markets", () => {
  const f5Evidence = freshEvidence([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS.F5_ML,
  ]);
  const f5 = decideMlbP1M2aPregameGate({ market: "F5_ML", gameState: "PREGAME", evidence: f5Evidence });
  assert.equal(f5.status, "READY_FINAL");
  assert.equal(f5.requiredFields.includes("BULLPEN"), false);

  const fullGame = decideMlbP1M2aPregameGate({ market: "ML", gameState: "PREGAME", evidence: f5Evidence });
  assert.equal(fullGame.status, "READY_PROVISIONAL");
  assert.equal(fullGame.warnings.includes("BULLPEN_MISSING"), true);
});

test("FINAL is available only when all core and selected-market evidence is fresh", () => {
  const evidence = freshEvidence([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS.TOTAL,
  ]);
  const decision = decideMlbP1M2aPregameGate({ market: "TOTAL", gameState: "PREGAME", evidence });
  assert.equal(decision.status, "READY_FINAL");
  assert.equal(decision.analysisAllowed, true);
  assert.deepEqual(decision.blockers, []);
  assert.deepEqual(decision.warnings, []);
});
