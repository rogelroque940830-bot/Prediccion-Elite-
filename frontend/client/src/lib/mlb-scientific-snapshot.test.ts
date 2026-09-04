import assert from "node:assert/strict";
import test from "node:test";
import {
  createMlbScientificSnapshot,
  type MlbScientificSnapshot,
} from "./mlb-scientific-snapshot";

type SnapshotInput = Omit<MlbScientificSnapshot, "schemaVersion">;

type GlobalWithQueryBridge = typeof globalThis & {
  __COURTEDGE_QUERY_CLIENT__?: unknown;
};

function input(marketType: SnapshotInput["market"]["type"] = "F5_ML"): SnapshotInput {
  return {
    model: { name: "CourtEdge MLB", version: "test" },
    game: {
      gamePk: 123,
      gameDate: "2026-09-04",
      homeTeam: "Home Club",
      awayTeam: "Away Club",
    },
    market: {
      type: marketType,
      selection: marketType === "F5_ML" ? "Home Club F5" : "Home Club",
      oddsAmerican: -120,
      capturedAt: "2026-09-04T16:00:00.000Z",
    },
    probabilities: { model: 0.64, marketImplied: 0.545 },
    decision: { signal: "BET", stakeUnits: 1 },
    analysis: { stage: "FINAL" },
  };
}

function installEarlyQueryBridge(): void {
  const query = {
    queryKey: [
      "early-markets",
      10,
      20,
      123,
      4.5,
      -110,
      -110,
      undefined,
      undefined,
      "2026-09-04",
    ],
    state: {
      dataUpdatedAt: Date.parse("2026-09-04T15:58:00.000Z"),
      data: {
        success: true,
        data: {
          homeEre: { teamName: "Home Club", ereScore: 71, category: "STRONG_EARLY" },
          awayEre: { teamName: "Away Club", ereScore: 49, category: "NEUTRAL" },
          markets: {
            f5ProbHome: 0.64,
            f5ProbAway: 0.36,
            f5RecommendedSide: "HOME",
            finalRecommendation: {
              market: "F5_ML",
              side: "HOME",
              action: "BET",
              reason: "test recommendation",
            },
          },
          f5Unified: { f5ProbHome: 0.64, f5ProbAway: 0.36 },
          matchupSignal: { dataConfidence: "FULL" },
          matchupDisabled: false,
          uncertainty: { level: "LOW" },
        },
      },
    },
  };

  (globalThis as GlobalWithQueryBridge).__COURTEDGE_QUERY_CLIENT__ = {
    getQueryCache: () => ({
      findAll: () => [query],
    }),
  };
}

function clearBridge(): void {
  delete (globalThis as GlobalWithQueryBridge).__COURTEDGE_QUERY_CLIENT__;
}

test("F5 scientific snapshot preserves the exact cached Early/ERE response", () => {
  installEarlyQueryBridge();
  try {
    const snapshot = createMlbScientificSnapshot(input("F5_ML"));
    const early = snapshot.analysis.layers?.earlyEngine as any;

    assert.equal(early.schemaVersion, "mlb-early-engine-capture.v1");
    assert.equal(early.identity.gamePk, 123);
    assert.equal(early.identity.gameDate, "2026-09-04");
    assert.equal(early.savedPick.oddsAmerican, -120);
    assert.equal(early.output.homeEre.ereScore, 71);
    assert.equal(early.output.awayEre.ereScore, 49);
    assert.equal(early.output.markets.f5ProbHome, 0.64);
    assert.equal(early.output.f5Unified.f5ProbHome, 0.64);
    assert.equal(early.recommendationRelation.matchesSavedPick, true);
    assert.equal(early.freshness, "FRESH");
  } finally {
    clearBridge();
  }
});

test("full-game snapshots never inherit an Early/ERE cache entry", () => {
  installEarlyQueryBridge();
  try {
    const snapshot = createMlbScientificSnapshot(input("ML"));
    assert.equal(snapshot.analysis.layers?.earlyEngine, undefined);
    assert.equal(
      snapshot.analysis.warnings?.some((warning) => warning.includes("EARLY_ENGINE_CAPTURE_MISSING")),
      false,
    );
  } finally {
    clearBridge();
  }
});

test("early-market snapshots fail visibly when no matching Early/ERE response exists", () => {
  clearBridge();
  const snapshot = createMlbScientificSnapshot(input("F5_ML"));
  assert.equal(snapshot.analysis.layers?.earlyEngine, undefined);
  assert.equal(
    snapshot.analysis.warnings?.some((warning) => warning.includes("EARLY_ENGINE_CAPTURE_MISSING")),
    true,
  );
});
