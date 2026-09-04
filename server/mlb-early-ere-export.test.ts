import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import {
  MLB_CSV_BASE_HEADERS,
  MLB_CSV_EARLY_ERE_HEADERS,
  recordsToMlbCsv,
} from "./mlb-ledger-csv-export";

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function earlyLayer() {
  return {
    schemaVersion: "mlb-early-engine-capture.v1",
    source: "/api/mlb/early-markets",
    observedAt: "2026-09-04T16:55:00.000Z",
    freshness: "FRESH",
    ageMsAtSavedPick: 4200,
    savedPick: {
      marketType: "F5_ML",
      side: "HOME",
    },
    recommendationRelation: {
      matchesSavedPick: true,
    },
    output: {
      homeEre: {
        ereScore: 74.3,
        category: "ELITE",
        dataStatus: "VERIFIED",
      },
      awayEre: {
        ereScore: 51.7,
        category: "SOLID",
        dataStatus: "PARTIAL",
      },
      f5Unified: {
        f5ProbHome: 0.682,
        f5ProbAway: 0.318,
        pickSide: "HOME",
        confidence: "HIGH",
      },
      markets: {
        f5ProbHome: 0.675,
        f5ProbAway: 0.325,
        f5RecommendedSide: "HOME",
        f5TotalRunsEstimated: 4.37,
        confidence: "PREMIUM",
        dataIncomplete: false,
        warnings: ["Wind 10 mph", "Starter note, confirmed"],
        finalRecommendation: {
          market: "F5_ML",
          side: "HOME",
          action: "BET",
          reason: "ERE edge, price verified",
          isPremium: true,
        },
      },
    },
  };
}

function record(
  id: string,
  marketType: "F5_ML" | "F5_TOTAL" | "ML",
  options: { early?: boolean; supersedesId?: string | null; selection?: string; line?: number | null } = {},
): LedgerRecord {
  const payload: any = {
    market: {
      capturedAt: "2026-09-04T16:56:00.000Z",
    },
    analysis: {
      layers: {},
    },
  };
  if (options.early) payload.analysis.layers.earlyEngine = earlyLayer();

  return {
    prediction: {
      id,
      clientRequestId: `picks-v2:${id}:digest`,
      recordedAt: "2026-09-04T16:56:04.200Z",
      recordedAtMs: Date.parse("2026-09-04T16:56:04.200Z"),
      game: {
        gamePk: 900001,
        gameDate: "2026-09-04",
        commenceTime: "2026-09-04T17:10:00.000Z",
        homeTeam: "Home Club",
        awayTeam: "Away Club",
      },
      market: {
        type: marketType,
        selection: options.selection ?? "Home Club F5 ML",
        line: options.line ?? null,
        oddsAmerican: -120,
        book: "Hard Rock",
      },
      probabilities: {
        model: 0.682,
        marketImplied: 0.5455,
        noVig: 0.53,
        edgePp: 13.65,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "PREMIUM",
        confidencePct: 68.2,
        stakeUnits: 1,
      },
      analysisStage: "FINAL",
      model: {
        name: "CourtEdge MLB",
        version: "predictor-full-snapshot-v2",
        gitCommit: "abc123",
        environment: "production",
      },
      supersedesId: options.supersedesId ?? null,
      source: "app",
      payloadSha256: "a".repeat(64),
      payload,
    },
    settlement: marketType === "ML" ? null : {
      eventId: `settle-${id}`,
      predictionId: id,
      clientRequestId: `settle:${id}`,
      recordedAt: "2026-09-05T03:00:00.000Z",
      recordedAtMs: Date.parse("2026-09-05T03:00:00.000Z"),
      settledAt: "2026-09-05T03:00:00.000Z",
      result: "WIN",
      closingOddsAmerican: -130,
      closingLine: options.line ?? null,
      closingImpliedProbability: 0.5652,
      clvPp: 2.4,
      outcomeValue: 1,
      finalScore: { home: 5, away: 3 },
      profitUnits: 0.8333,
      source: "official",
      correctionOfEventId: null,
      notes: "Official settlement",
      payloadSha256: "b".repeat(64),
      payload: {},
    },
  } as unknown as LedgerRecord;
}

test("CSV appends compact immutable Early/ERE audit fields without changing legacy column order", () => {
  const csv = recordsToMlbCsv([
    record("f5-ml-new", "F5_ML", { early: true, supersedesId: "f5-ml-old" }),
    record("f5-total", "F5_TOTAL", {
      early: true,
      selection: "Over 4.5 F5",
      line: 4.5,
    }),
    record("legacy-ml", "ML"),
  ]);

  const lines = csv.split("\n");
  assert.equal(lines.length, 4);

  const headers = parseCsvLine(lines[0]);
  assert.deepEqual(headers.slice(0, MLB_CSV_BASE_HEADERS.length), [...MLB_CSV_BASE_HEADERS]);
  assert.deepEqual(headers.slice(MLB_CSV_BASE_HEADERS.length), [...MLB_CSV_EARLY_ERE_HEADERS]);

  const ml = parseCsvLine(lines[1]);
  const total = parseCsvLine(lines[2]);
  const legacy = parseCsvLine(lines[3]);
  const value = (row: string[], name: string) => row[headers.indexOf(name)];

  assert.equal(value(ml, "market"), "F5_ML");
  assert.equal(value(ml, "supersedes_id"), "f5-ml-old");
  assert.equal(value(ml, "market_captured_at"), "2026-09-04T16:56:00.000Z");
  assert.equal(value(ml, "early_observed_at"), "2026-09-04T16:55:00.000Z");
  assert.equal(value(ml, "early_freshness"), "FRESH");
  assert.equal(value(ml, "home_ere_score"), "74.3");
  assert.equal(value(ml, "home_ere_category"), "ELITE");
  assert.equal(value(ml, "home_ere_data_status"), "VERIFIED");
  assert.equal(value(ml, "away_ere_score"), "51.7");
  assert.equal(value(ml, "away_ere_category"), "SOLID");
  assert.equal(value(ml, "away_ere_data_status"), "PARTIAL");
  assert.equal(value(ml, "f5_prob_home_pct"), "68.2");
  assert.equal(value(ml, "f5_prob_away_pct"), "31.8");
  assert.equal(value(ml, "f5_pick_side"), "HOME");
  assert.equal(value(ml, "f5_confidence"), "HIGH");
  assert.equal(value(ml, "f5_total_runs_estimated"), "4.37");
  assert.equal(value(ml, "early_confidence"), "PREMIUM");
  assert.equal(value(ml, "early_data_incomplete"), "false");
  assert.equal(value(ml, "early_warnings"), "Wind 10 mph | Starter note, confirmed");
  assert.equal(value(ml, "early_final_recommendation_reason"), "ERE edge, price verified");
  assert.equal(value(ml, "result"), "WIN");
  assert.equal(value(ml, "clv_pp"), "2.4");
  assert.equal(value(ml, "profit_units"), "0.8333");

  assert.equal(value(total, "market"), "F5_TOTAL");
  assert.equal(value(total, "line"), "4.5");
  assert.equal(value(total, "f5_total_runs_estimated"), "4.37");
  assert.equal(value(total, "home_ere_score"), "74.3");

  assert.equal(value(legacy, "market"), "ML");
  assert.equal(value(legacy, "early_schema_version"), "");
  assert.equal(value(legacy, "home_ere_score"), "");
  assert.equal(value(legacy, "f5_prob_home_pct"), "");
  assert.equal(value(legacy, "result"), "");
});
