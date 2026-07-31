import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WnbaPredictorShadowService } from "./wnba-s6d-predictor-shadow-service";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wnba-s6d-"));
  const modern = path.join(root, "inputs", "picks.json");
  const legacy = path.join(root, "inputs", "picks-data.json");
  const s6c = path.join(root, "inputs", "wnba-shadow-records.jsonl");
  const output = path.join(root, "output");
  let now = new Date("2026-07-31T14:00:00.000Z");

  writeJson(modern, [{
    id: "historical-modern",
    ts: Date.parse("2026-07-30T18:00:00.000Z"),
    sport: "wnba",
    homeTeam: "New York Liberty",
    awayTeam: "Los Angeles Sparks",
    pickType: "ML",
    pickSide: "New York Liberty",
    confidence: 80,
  }]);
  writeJson(legacy, { wnbaPicks: [{
    id: "historical-legacy",
    date: "2026-07-30",
    team: "New York Liberty",
    opponent: "Los Angeles Sparks",
    market: "ML",
    pick: "New York Liberty",
    confidence: 80,
  }] });
  appendJsonLine(s6c, {
    schemaVersion: "wnba-shadow.v1",
    id: "s6c-final-1",
    fingerprint: "s6c-fingerprint",
    recordedAt: "2026-07-31T13:30:00.000Z",
    recordedAtMs: Date.parse("2026-07-31T13:30:00.000Z"),
    supersedesId: null,
    game: {
      gameId: "401000001",
      gameDate: "2026-07-31",
      commenceTime: "2026-07-31T23:00:00.000Z",
      homeTeam: "New York Liberty",
      awayTeam: "Los Angeles Sparks",
    },
    market: {
      type: "MONEYLINE",
      book: "Hard Rock Bet",
      capturedAt: "2026-07-31T13:30:00.000Z",
      homeOddsAmerican: -150,
      awayOddsAmerican: 130,
      homeRawImpliedProbability: 0.6,
      awayRawImpliedProbability: 0.4348,
      homeDevigProbability: 0.58,
      awayDevigProbability: 0.42,
    },
    baseline: {
      name: "WNBA_MARKET_BASELINE",
      version: "v1",
      homeWinProbability: 0.58,
      awayWinProbability: 0.42,
      edgePp: 0,
    },
    decision: { signal: "OBSERVE", stakeUnits: 0 },
    analysisStage: "FINAL",
    context: { home: {}, away: {}, sources: {}, degradedSources: [] },
    dataQuality: { checks: 10, passed: 10, coveragePct: 100, missing: [] },
    safety: {},
  });

  const service = new WnbaPredictorShadowService({
    enabled: true,
    intervalMs: 60_000,
    initialDelayMs: 10_000,
    root: output,
    modernPicksPath: modern,
    legacyPicksPath: legacy,
    s6cRecordsPath: s6c,
    deploymentCommit: "test-sha",
    environment: "p0-integration",
    now: () => new Date(now),
  });

  return {
    root,
    modern,
    legacy,
    service,
    setNow(value: string) { now = new Date(value); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("S6D establishes a prospective cutover and does not backfill existing predictor outputs", async () => {
  const f = fixture();
  try {
    const audit = await f.service.run("cutover");
    assert.equal(audit.sourceOutputsDiscovered, 2);
    assert.equal(audit.preCutoverIgnored, 2);
    assert.equal(audit.newSourceOutputs, 0);
    assert.equal(audit.recordsCreated, 0);
    assert.equal(f.service.readRecords().length, 0);
    assert.equal(audit.safety.retrospectiveSyntheticPredictions, false);
    assert.equal(audit.safety.realFinancialExposure, 0);
  } finally {
    f.cleanup();
  }
});

test("S6D captures a new persisted output, links S6C and never infers probability from confidence", async () => {
  const f = fixture();
  try {
    await f.service.run("cutover");
    f.setNow("2026-07-31T14:05:00.000Z");
    writeJson(f.modern, [
      {
        id: "historical-modern",
        ts: Date.parse("2026-07-30T18:00:00.000Z"),
        sport: "wnba",
        homeTeam: "New York Liberty",
        awayTeam: "Los Angeles Sparks",
        pickType: "ML",
        pickSide: "New York Liberty",
        confidence: 80,
      },
      {
        id: "new-modern-1",
        ts: Date.parse("2026-07-31T14:04:00.000Z"),
        sport: "wnba",
        homeTeam: "New York Liberty",
        awayTeam: "Los Angeles Sparks",
        pickType: "ML",
        pickSide: "New York Liberty",
        confidence: 82,
        odds: -145,
        accepted: true,
      },
    ]);

    const audit = await f.service.run("new-output");
    assert.equal(audit.newSourceOutputs, 1);
    assert.equal(audit.recordsCreated, 1);
    assert.equal(audit.baselineLinked, 1);
    assert.equal(audit.missingModelProbability, 1);

    const [record] = f.service.readRecords();
    assert.equal(record.predictor.confidence, 82);
    assert.equal(record.predictor.modelProbability, null);
    assert.equal(record.comparison.edgeVsMarketPp, null);
    assert.equal(record.marketBaseline.linked, true);
    assert.equal(record.marketBaseline.analysisStage, "FINAL");
    assert.equal(record.marketBaseline.selectedWinProbability, 0.58);
    assert.ok(record.missingEvidence.includes("modelProbability"));
  } finally {
    f.cleanup();
  }
});

test("S6D appends a superseding revision when explicit persisted evidence changes", async () => {
  const f = fixture();
  try {
    await f.service.run("cutover");
    writeJson(f.modern, [{
      id: "new-modern-2",
      ts: Date.parse("2026-07-31T14:01:00.000Z"),
      sport: "wnba",
      homeTeam: "New York Liberty",
      awayTeam: "Los Angeles Sparks",
      pickType: "ML",
      pickSide: "New York Liberty",
      confidence: 79,
      accepted: true,
    }]);
    await f.service.run("first-output");

    f.setNow("2026-07-31T14:10:00.000Z");
    writeJson(f.modern, [{
      id: "new-modern-2",
      ts: Date.parse("2026-07-31T14:09:00.000Z"),
      sport: "wnba",
      homeTeam: "New York Liberty",
      awayTeam: "Los Angeles Sparks",
      pickType: "ML",
      pickSide: "New York Liberty",
      confidence: 84,
      probability: 72,
      accepted: true,
      filterReasons: ["all-current-filters-passed"],
    }]);

    const audit = await f.service.run("changed-output");
    assert.equal(audit.recordsCreated, 1);
    assert.equal(audit.supersedingRecords, 1);
    assert.equal(audit.explicitModelProbability, 1);

    const records = f.service.readRecords();
    assert.equal(records.length, 2);
    assert.equal(records[1].supersedesId, records[0].id);
    assert.equal(records[1].predictor.modelProbability, 0.72);
    assert.equal(records[1].predictor.modelProbabilitySourceField, "probability");
    assert.equal(records[1].comparison.edgeVsMarketPp, 14);
    assert.equal(f.service.buildReport().terminalDecisions, 1);
    assert.equal(f.service.buildReport().supersededRecords, 1);
  } finally {
    f.cleanup();
  }
});

test("S6D deduplicates equivalent modern and legacy outputs into one terminal chain", async () => {
  const f = fixture();
  try {
    await f.service.run("cutover");
    writeJson(f.modern, [{
      id: "modern-duplicate",
      ts: Date.parse("2026-07-31T14:01:00.000Z"),
      sport: "wnba",
      homeTeam: "New York Liberty",
      awayTeam: "Los Angeles Sparks",
      pickType: "ML",
      pickSide: "New York Liberty",
      confidence: 81,
      accepted: true,
    }]);
    writeJson(f.legacy, { wnbaPicks: [{
      id: "legacy-duplicate",
      ts: Date.parse("2026-07-31T14:01:00.000Z"),
      date: "2026-07-31",
      homeTeam: "New York Liberty",
      awayTeam: "Los Angeles Sparks",
      market: "ML",
      pick: "New York Liberty",
      confidence: 81,
      accepted: true,
    }] });

    const audit = await f.service.run("duplicate-sources");
    assert.equal(audit.newSourceOutputs, 2);
    assert.equal(audit.recordsCreated, 1);
    assert.equal(f.service.readRecords().length, 1);
    assert.equal(f.service.readRecords()[0].source.aliases.length, 2);
  } finally {
    f.cleanup();
  }
});
