import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildMlbP1M3cCandidate,
  mlbP1M3cCanonicalJson,
  mlbP1M3cSha256,
  resolveMlbP1M3cAutomaticSelection,
} from "./mlb-scientific-capture";
import type { MlbPregameReadinessReport } from "./mlb-pregame-readiness";
import type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";

const NOW = "2026-08-05T20:30:00.000Z";

function report(): MlbPregameReadinessReport {
  return {
    schemaVersion: "courtedge-p1-m2b-pregame-readiness.v1",
    contractSchemaVersion: "courtedge-p1-m2a-pregame-readiness-contract.v1",
    generatedAt: NOW,
    market: "ML",
    game: {
      gamePk: 824806,
      officialDate: "2026-08-05",
      startTime: "2026-08-05T23:05:00.000Z",
      state: "PREGAME",
      detailedState: "Warmup",
      homeTeam: { id: 110, name: "Baltimore Orioles" },
      awayTeam: { id: 108, name: "Los Angeles Angels" },
    },
    gate: {
      schemaVersion: "courtedge-p1-m2a-pregame-readiness-contract.v1",
      status: "READY_FINAL",
      analysisAllowed: true,
      analysisStage: "FINAL",
      blockers: [],
      warnings: [],
      requiredFields: ["GAME_IDENTITY", "PITCHERS", "LINEUPS", "MARKET_ODDS"],
    },
    summary: {
      requiredFields: ["GAME_IDENTITY", "PITCHERS", "LINEUPS", "MARKET_ODDS"],
      fresh: 4,
      stale: 0,
      degraded: 0,
      missing: 0,
      conflict: 0,
      unknown: 0,
    },
    evidence: [
      {
        field: "GAME_IDENTITY",
        required: true,
        state: "FRESH",
        sourceIds: ["mlb-stats"],
        endpoints: ["/api/mlb/p1/v1/slate"],
        authority: "MLB",
        fetchedAt: NOW,
        observedAt: NOW,
        ageSeconds: 0,
        maxAgeSeconds: 300,
        sourceStatus: "OFFICIAL",
        quality: "AUTHORITATIVE",
        details: {},
        errors: [],
      },
      {
        field: "MARKET_ODDS",
        required: true,
        state: "FRESH",
        sourceIds: ["hard-rock"],
        endpoints: ["/api/odds/mlb"],
        authority: "MARKET",
        fetchedAt: NOW,
        observedAt: NOW,
        ageSeconds: 0,
        maxAgeSeconds: 300,
        sourceStatus: "EXPLICIT_PROVIDER_TIME",
        quality: "MARKET_PROVENANCE",
        details: {
          quote: {
            home: -120,
            away: 110,
            book: "Hard Rock",
            capturedAt: NOW,
            providerLastUpdate: NOW,
          },
        },
        errors: [],
      },
    ],
    warnings: [],
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function snapshot(): MlbScientificSnapshot {
  return {
    schemaVersion: "mlb-scientific-snapshot.v1",
    model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2" },
    game: {
      gamePk: 824806,
      gameDate: "2026-08-05",
      commenceTime: "2026-08-05T23:05:00.000Z",
      homeTeam: "Baltimore Orioles",
      awayTeam: "Los Angeles Angels",
    },
    market: {
      type: "ML",
      selection: "Baltimore Orioles ML",
      oddsAmerican: -120,
      book: "Hard Rock",
      capturedAt: NOW,
    },
    probabilities: {
      model: 0.59,
      marketImplied: 120 / 220,
      noVig: 0.56,
      edgePp: 4.45454545,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "A",
      confidencePct: 59,
      stakeUnits: 1,
    },
    analysis: { stage: "FINAL", warnings: [], rawInputs: {}, rawOutput: {} },
  };
}

test("P1-M3C canonical SHA-256 matches the server contract basis", async () => {
  const value = { z: 1.1234567890123456, a: [3, { y: true, x: undefined }] };
  const expected = createHash("sha256").update(mlbP1M3cCanonicalJson(value)).digest("hex");
  assert.equal(await mlbP1M3cSha256(value), expected);
});

test("P1-M3C resolves only the market certified for the execution", () => {
  const base = {
    homeTeam: "Home",
    awayTeam: "Away",
    lines: {
      mlHome: "-120",
      mlAway: "+110",
      runLineHomeOdds: "+135",
      runLineAwayOdds: "-155",
      overOdds: "-105",
      underOdds: "-115",
      f5MlHome: "-130",
      f5MlAway: "+115",
    },
    result: {
      homeProb: 0.59,
      awayProb: 0.41,
      f5HomeProb: 0.62,
      f5AwayProb: 0.38,
      pickedSide: "home" as const,
      recommendedOdds: -120,
      f5PickedSide: "home" as const,
      f5RecommendedOdds: -130,
      ouLine: 8.5,
      runLine: { pickedSide: "away" as const, side: "Visitante +1.5", coversRL: true, coverProb: 0.57 },
      ouResult: { side: "UNDER" as const, hitProb: 0.58 },
    },
  };

  assert.deepEqual(resolveMlbP1M3cAutomaticSelection({ ...base, market: "ML" }), {
    marketLabel: "ML",
    pick: "Home ML",
    oddsAmerican: -120,
    modelProbPct: 59,
  });
  assert.deepEqual(resolveMlbP1M3cAutomaticSelection({ ...base, market: "F5_ML" }), {
    marketLabel: "F5",
    pick: "Home F5",
    oddsAmerican: -130,
    modelProbPct: 62,
  });
  assert.deepEqual(resolveMlbP1M3cAutomaticSelection({ ...base, market: "RUN_LINE" }), {
    marketLabel: "Run Line",
    pick: "Visitante +1.5 (Away)",
    oddsAmerican: -155,
    modelProbPct: 57,
  });
  assert.deepEqual(resolveMlbP1M3cAutomaticSelection({ ...base, market: "TOTAL" }), {
    marketLabel: "O/U",
    pick: "UNDER 8.5",
    oddsAmerican: -115,
    modelProbPct: 58,
  });
  assert.equal(resolveMlbP1M3cAutomaticSelection({ ...base, market: "F5_TOTAL" }), null);
});

test("P1-M3C builds an exact P1-M3A candidate from the certified report", async () => {
  const candidate = await buildMlbP1M3cCandidate({
    report: report(),
    scientificSnapshot: snapshot(),
    evaluation: {
      market: "ML",
      side: "HOME",
      selection: "Baltimore Orioles ML",
      line: null,
      oddsAmerican: -120,
      oppositeOddsAmerican: 110,
      sourceModeHint: "AUTOMATIC",
      modelProbability: 0.59,
      marketImplied: 120 / 220,
      noVig: 0.56,
      edgePp: 4.45454545,
      signal: "BET",
      category: "PREMIUM",
      confidenceLabel: "A",
      confidencePct: 59,
      recommendedStakeUnits: 1,
      rationale: "Certified model edge",
      filterReasons: [],
    },
    capturedAt: NOW,
    clientEvaluationId: "p1m3c:test:824806:ml",
    venue: "Oriole Park",
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v2",
      gitCommit: null,
      environment: "p0-integration",
    },
  });

  assert.equal(candidate.schemaVersion, "courtedge-p1-m3a-scientific-capture-contract.v1");
  assert.equal(candidate.origin.userAction, "GENERATE_PREDICTION");
  assert.equal(candidate.readiness.gateStatus, "READY_FINAL");
  assert.equal(candidate.quote.oddsAmerican, -120);
  assert.equal(candidate.quote.oppositeOddsAmerican, 110);
  assert.equal(candidate.quote.book, "Hard Rock");
  assert.match(candidate.quote.provenanceDigest, /^[a-f0-9]{64}$/);
  assert.match(candidate.readiness.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.match(candidate.scientificSnapshot.payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(candidate.safety.realFinancialExposure, 0);
  assert.equal(candidate.safety.automaticBetPlacement, false);
});

test("P1-M3C fails closed when selected odds differ from the certified quote", async () => {
  await assert.rejects(
    buildMlbP1M3cCandidate({
      report: report(),
      scientificSnapshot: snapshot(),
      evaluation: {
        market: "ML",
        side: "HOME",
        selection: "Baltimore Orioles ML",
        line: null,
        oddsAmerican: -118,
        oppositeOddsAmerican: 110,
        sourceModeHint: "AUTOMATIC",
        modelProbability: 0.59,
        marketImplied: 0.541,
        noVig: 0.56,
        edgePp: 4.9,
        signal: "PASS",
        category: "PASS",
        confidenceLabel: "F",
        confidencePct: 59,
        recommendedStakeUnits: 0,
        rationale: null,
        filterReasons: ["quote mismatch"],
      },
      capturedAt: NOW,
      clientEvaluationId: "p1m3c:test:mismatch",
      venue: null,
      model: { name: "CourtEdge MLB", version: "v2", gitCommit: null, environment: null },
    }),
    /P1_M3C_CERTIFIED_QUOTE_SELECTION_MISMATCH/,
  );
});
