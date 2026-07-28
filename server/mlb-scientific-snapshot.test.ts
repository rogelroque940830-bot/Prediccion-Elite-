import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint, findMlbSupersedesId } from "./mlb-scientific-snapshot";

function basePick() {
  return {
    id: "ui-mlb-42",
    ts: Date.parse("2026-07-26T17:30:00.000Z"),
    sport: "mlb" as const,
    homeTeam: "Tampa Bay Rays",
    awayTeam: "Cleveland Guardians",
    pickType: "ML",
    pickSide: "Tampa Bay Rays ML",
    confidence: 61.2,
    edge: 8.8,
    odds: -110,
    date: "2026-07-26",
    modelProb: 61.2,
    impliedProb: 52.38,
    stake: 1,
  };
}

function fullSnapshot() {
  return {
    schemaVersion: "mlb-scientific-snapshot.v1" as const,
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v1",
    },
    game: {
      gamePk: 822950,
      gameDate: "2026-07-26",
      commenceTime: "2026-07-26T17:35:00.000Z",
      homeTeam: "Tampa Bay Rays",
      awayTeam: "Cleveland Guardians",
      venue: "George M. Steinbrenner Field",
    },
    market: {
      type: "ML" as const,
      selection: "Tampa Bay Rays ML",
      oddsAmerican: -110,
      book: "Hard Rock",
      capturedAt: "2026-07-26T17:30:00.000Z",
    },
    probabilities: {
      model: 0.612,
      marketImplied: 0.5238,
      noVig: 0.5,
      edgePp: 8.8,
    },
    decision: {
      signal: "BET" as const,
      confidenceLabel: "A",
      confidencePct: 61.2,
      stakeUnits: 1,
      rationale: "Edge verified after full predictor calculation.",
    },
    analysis: {
      stage: "FINAL" as const,
      warnings: [],
      factors: [
        {
          name: "Statcast pitch-by-pitch",
          direction: "HOME" as const,
          magnitude: 0.42,
          units: "runs",
          confidence: "FULL" as const,
          source: "MLB Stats API",
        },
      ],
      sources: [
        {
          name: "MLB Stats API",
          status: "VERIFIED" as const,
          fetchedAt: "2026-07-26T17:25:00.000Z",
          metadata: { gamePk: 822950 },
        },
      ],
      layers: {
        pureModel: 0.64,
        marketCalibration: 0.5238,
        final: 0.612,
      },
      rawInputs: {
        apiKey: "must-not-survive",
        Authorization: "Bearer must-not-survive",
        pitcher: { era: 3.2, whip: 1.1 },
      },
      rawOutput: {
        selectedMarket: "ML",
      },
    },
  };
}

test("full snapshot becomes the single final ledger payload", () => {
  const prediction = buildMlbLedgerPredictionFromPick({
    ...basePick(),
    scientificSnapshot: fullSnapshot(),
  });

  assert.match(prediction.clientRequestId || "", /^picks-v2:ui-mlb-42:[a-f0-9]{32}$/);
  assert.equal(prediction.analysis.stage, "FINAL");
  assert.equal(prediction.decision.signal, "BET");
  assert.equal(prediction.game.gamePk, 822950);
  assert.equal(prediction.market.selection, "Tampa Bay Rays ML");
  assert.equal((prediction.analysis.rawInputs as any).apiKey, "[REDACTED]");
  assert.equal((prediction.analysis.rawInputs as any).Authorization, "[REDACTED]");
});

test("full snapshot request ids are stable for exact retries and unique for changed payloads", () => {
  const firstSnapshot = fullSnapshot();
  const exactRetry = structuredClone(firstSnapshot);
  const changedSnapshot = structuredClone(firstSnapshot);
  (changedSnapshot.analysis.rawOutput as any).selectedMarket = "ML_RECALCULATED";

  const first = buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: firstSnapshot });
  const retry = buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: exactRetry });
  const changed = buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: changedSnapshot });

  assert.equal(first.clientRequestId, retry.clientRequestId);
  assert.notEqual(first.clientRequestId, changed.clientRequestId);
});

test("orientation mismatch is rejected before the immutable append", () => {
  const snapshot = fullSnapshot();
  snapshot.game.homeTeam = "Cleveland Guardians";
  snapshot.game.awayTeam = "Tampa Bay Rays";

  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /venue orientation/i,
  );
});

test("canonical odds mismatch is rejected", () => {
  const snapshot = fullSnapshot();
  snapshot.market.oddsAmerican = -105;

  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /odds do not match/i,
  );
});

test("legacy MLB picks still map to an explicit provisional mirror", () => {
  const prediction = buildMlbLedgerPredictionFromPick(basePick());
  assert.equal(prediction.analysis.stage, "PROVISIONAL");
  assert.equal(prediction.decision.signal, "INFO");
  assert.equal(prediction.model.version, "picks-v2-mirror-v1");
  assert.equal(prediction.clientRequestId, "picks-v2:ui-mlb-42");
});


test("canonical fingerprint suppresses the same pick across different UI ids", () => {
  const first = basePick();
  const second = { ...basePick(), id: "ui-mlb-99", ts: first.ts + 15_000 };
  assert.equal(canonicalMlbPickFingerprint(first), canonicalMlbPickFingerprint(second));
});

test("FINAL snapshot captured after game start is rejected", () => {
  const snapshot = fullSnapshot();
  snapshot.market.capturedAt = "2026-07-26T17:36:00.000Z";
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /captured after the official game start/i,
  );
});

test("FINAL snapshot requires the official game identity", () => {
  const snapshot = fullSnapshot();
  delete snapshot.game.gamePk;
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /require gamePk/i,
  );
});

test("latest matching immutable prediction is selected as supersedesId", () => {
  const next = buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: fullSnapshot() });
  const record = (id: string, recordedAtMs: number, model: number, clientRequestId = `picks-v2:${id}`) => ({
    prediction: {
      id,
      clientRequestId,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: { gamePk: 822950, gameDate: "2026-07-26", commenceTime: "2026-07-26T17:35:00.000Z", homeTeam: "Tampa Bay Rays", awayTeam: "Cleveland Guardians" },
      market: { type: "ML", selection: "Tampa Bay Rays ML", line: null, oddsAmerican: -110, book: "Hard Rock" },
      probabilities: { model, marketImplied: 0.5238, noVig: 0.5, edgePp: (model - 0.5238) * 100 },
      decision: { signal: "BET", confidenceLabel: "A", confidencePct: model * 100, stakeUnits: 1 },
      analysisStage: "FINAL",
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v1", gitCommit: null, environment: null },
      supersedesId: null,
      source: "app",
      payloadSha256: id.padEnd(64, "0").slice(0, 64),
      payload: {},
    },
    settlement: null,
  });
  const records = [
    record("mlb-pred-old", 1_000, 0.58),
    record("mlb-pred-newer", 2_000, 0.60),
    record("mlb-pred-retry", 3_000, 0.612, next.clientRequestId),
  ];
  assert.equal(findMlbSupersedesId(records as any, next), "mlb-pred-newer");
});

test("provisional snapshot captured after known game start is also rejected", () => {
  const snapshot = fullSnapshot();
  (snapshot.analysis as any).stage = "PROVISIONAL";
  snapshot.market.capturedAt = "2026-07-26T17:36:00.000Z";
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /captured after the official game start/i,
  );
});

