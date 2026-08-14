import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore, type MlbPredictionInput } from "./mlb-ledger-store";
import { MlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import type { MlbS5cShadowIngestionService } from "./mlb-s5c-shadow-ingestion";
import { MlbS5eCoverageService } from "./mlb-s5e-coverage-service";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function prediction(
  id: string,
  options: {
    stage?: "PROVISIONAL" | "FINAL";
    market?: "F5_ML" | "F5_TOTAL";
    selection?: string;
    line?: number;
    odds?: number;
    commenceTime?: string;
    supersedesId?: string;
  } = {},
): MlbPredictionInput {
  const market = options.market ?? "F5_ML";
  const commenceTime = options.commenceTime ?? "2026-07-30T19:00:00.000Z";
  return {
    schemaVersion: "mlb-ledger.v1",
    clientRequestId: id,
    source: "app",
    ...(options.supersedesId ? { supersedesId: options.supersedesId } : {}),
    model: {
      name: "CourtEdge MLB Early Markets",
      version: "s5c-shadow-v1",
      gitCommit: "test-commit",
      environment: "p0-integration",
    },
    game: {
      gamePk: 900001,
      gameDate: "2026-07-30",
      commenceTime,
      homeTeam: "Miami Marlins",
      awayTeam: "Philadelphia Phillies",
      venue: "Test Park",
    },
    market: {
      type: market,
      selection: options.selection ?? (market === "F5_ML" ? "Miami Marlins" : "OVER 4.5"),
      ...(options.line != null ? { line: options.line } : {}),
      oddsAmerican: options.odds ?? -110,
      book: "draftkings, fanduel, betmgm",
      capturedAt: "2026-07-30T17:00:00.000Z",
    },
    probabilities: {
      model: 0.61,
      marketImplied: 0.52381,
      edgePp: 8.619,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "PREMIUM",
      confidencePct: 61,
      stakeUnits: 0,
      rationale: "fixture",
    },
    analysis: {
      stage: options.stage ?? "FINAL",
      warnings: [],
      sources: [{ name: "fixture", status: "VERIFIED", fetchedAt: "2026-07-30T17:00:00.000Z" }],
      layers: { s5c: { lineupCounts: { home: 9, away: 9 } } },
    },
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5e-coverage-"));
  const dbPath = path.join(root, "ledger.sqlite");
  const store = new MlbLedgerStore(dbPath);
  const ownership = new MlbLedgerOwnershipStore(dbPath);
  const ownerUserId = 1;
  const save = (input: MlbPredictionInput) => {
    const result = store.appendPrediction(input);
    ownership.bind(result.data.id, result.data.clientRequestId, ownerUserId, "service");
    return result.data;
  };
  return { root, store, ownership, ownerUserId, save };
}

test("S5E captures same-source F5 consensus and appends an immutable settlement correction", async () => {
  const fixture = setup();
  const saved = fixture.save(prediction("s5e-ml-final"));
  let now = new Date("2026-07-30T18:50:00.000Z");
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/odds/mlb/f5")) {
      return json({
        success: true,
        games: [{
          homeTeam: "Miami Marlins",
          awayTeam: "Philadelphia Phillies",
          commence: "2026-07-30T19:00:00.000Z",
          source: "fanduel, betmgm, draftkings",
          f5Ml: { home: -120, away: 105, n: 3 },
          f5Total: { line: 4.5, overOdds: -108, underOdds: -112, n: 3 },
        }],
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const s5c = { run: async () => ({}) } as unknown as MlbS5cShadowIngestionService;
  const service = new MlbS5eCoverageService(fixture.store, fixture.ownership, s5c, {
    enabled: true,
    ownerUserId: fixture.ownerUserId,
    root: path.join(fixture.root, "s5e"),
    selfBaseUrl: "http://fixture",
    now: () => now,
    fetcher,
  });

  const first = await service.run("test-capture");
  assert.equal(first.closing.observationsCreated, 1);
  assert.equal(service.readObservations(saved.id).length, 1);
  assert.equal(service.readObservations(saved.id)[0].classification, "COMPARABLE");

  fixture.store.appendSettlement(saved.id, {
    clientRequestId: "official-settlement",
    settledAt: "2026-07-30T23:30:00.000Z",
    result: "WIN",
    outcomeValue: 1,
    finalScore: { home: 5, away: 3 },
    source: "official",
    notes: "official fixture",
  });
  now = new Date("2026-07-30T18:55:00.000Z");
  const second = await service.run("test-correction");
  assert.equal(second.closing.correctionsApplied, 1);
  const corrected = fixture.store.getRecord(saved.id)?.settlement;
  assert.equal(corrected?.source, "correction");
  assert.equal(corrected?.closingOddsAmerican, -120);
  assert.ok(corrected?.clvPp != null);
  assert.equal(corrected?.correctionOfEventId != null, true);

  fixture.ownership.close();
  fixture.store.close();
});

test("S5E records a moved F5 total line without creating invalid price CLV", async () => {
  const fixture = setup();
  const saved = fixture.save(prediction("s5e-total-final", {
    market: "F5_TOTAL",
    selection: "OVER 4.5",
    line: 4.5,
  }));
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/odds/mlb/f5")) {
      return json({
        success: true,
        games: [{
          homeTeam: "Miami Marlins",
          awayTeam: "Philadelphia Phillies",
          commence: "2026-07-30T19:00:00.000Z",
          source: "draftkings, fanduel, betmgm",
          f5Ml: { home: -115, away: 100, n: 3 },
          f5Total: { line: 5, overOdds: -105, underOdds: -115, n: 3 },
        }],
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const service = new MlbS5eCoverageService(
    fixture.store,
    fixture.ownership,
    { run: async () => ({}) } as unknown as MlbS5cShadowIngestionService,
    {
      enabled: true,
      ownerUserId: fixture.ownerUserId,
      root: path.join(fixture.root, "s5e"),
      selfBaseUrl: "http://fixture",
      now: () => new Date("2026-07-30T18:50:00.000Z"),
      fetcher,
    },
  );
  const audit = await service.run("test-line-move");
  const observation = service.readObservations(saved.id)[0];
  assert.equal(observation.classification, "LINE_MOVED");
  assert.equal(observation.comparable, false);
  assert.equal(audit.closing.nonComparableCaptured, 1);
  assert.equal(audit.diagnostics.lineMoved, 1);

  fixture.ownership.close();
  fixture.store.close();
});

test("S5E triggers a targeted S5C rerun when both official nine-player lineups appear", async () => {
  const fixture = setup();
  const provisional = fixture.save(prediction("s5e-provisional", {
    stage: "PROVISIONAL",
    commenceTime: "2026-07-30T20:30:00.000Z",
  }));
  let triggers = 0;
  const s5c = {
    run: async () => {
      triggers += 1;
      fixture.save(prediction("s5e-final", {
        stage: "FINAL",
        commenceTime: "2026-07-30T20:30:00.000Z",
        supersedesId: provisional.id,
      }));
      return {};
    },
  } as unknown as MlbS5cShadowIngestionService;
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("statsapi.mlb.com")) {
      return json({
        liveData: {
          boxscore: {
            teams: {
              home: { battingOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
              away: { battingOrder: [11, 12, 13, 14, 15, 16, 17, 18, 19] },
            },
          },
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const service = new MlbS5eCoverageService(fixture.store, fixture.ownership, s5c, {
    enabled: true,
    ownerUserId: fixture.ownerUserId,
    root: path.join(fixture.root, "s5e"),
    selfBaseUrl: "http://fixture",
    now: () => new Date("2026-07-30T19:00:00.000Z"),
    fetcher,
  });
  const audit = await service.run("test-finalization");
  assert.equal(triggers, 1);
  assert.equal(audit.finalization.readyGamesDetected, 1);
  assert.equal(audit.finalization.triggerRuns, 1);
  assert.equal(audit.finalization.finalCaptured, 1);
  assert.equal(audit.finalization.provisionalPendingLineups, 0);

  fixture.ownership.close();
  fixture.store.close();
});
