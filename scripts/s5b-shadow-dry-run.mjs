import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMlbShadowEvaluation } from "../server/mlb-shadow-evaluation.ts";

const outputDir = path.join(process.cwd(), "artifacts", "s5b-shadow-dry-run");
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

function resultFor(index) {
  if (index % 5 === 0) return "PUSH";
  return index % 3 === 0 ? "LOSS" : "WIN";
}

function record(index, overrides = {}) {
  const gameDate = `2026-07-${String(10 + index).padStart(2, "0")}`;
  const signal = overrides.signal ?? (index % 4 === 0 ? "PASS" : index % 4 === 1 ? "INFO" : index % 4 === 2 ? "BET" : "BET_FUERTE");
  const stakeUnits = signal === "BET_FUERTE" ? 2 : signal === "BET" ? 1 : 0;
  const probability = 0.53 + index * 0.012;
  const marketImplied = 0.51 + (index % 3) * 0.01;
  const result = resultFor(index);
  const id = `s5b-dry-${index}`;
  const recordedAt = `${gameDate}T12:00:00.000Z`;
  const oddsAmerican = index % 2 === 0 ? -110 : 105;
  const confidenceLabel = signal === "BET_FUERTE" ? "ELITE" : signal === "BET" ? "PREMIUM" : signal;
  const warnings = signal === "PASS"
    ? [index % 2 === 0 ? "EDGE_BELOW_THRESHOLD" : "LINEUP_NOT_CONFIRMED"]
    : [];

  return {
    prediction: {
      id,
      clientRequestId: `s5b-dry-request-${index}`,
      recordedAt,
      recordedAtMs: Date.parse(recordedAt),
      game: {
        gamePk: 910000 + index,
        gameDate,
        commenceTime: `${gameDate}T23:00:00.000Z`,
        homeTeam: `Shadow Home ${index}`,
        awayTeam: `Shadow Away ${index}`,
      },
      market: {
        type: index % 3 === 0 ? "ML" : index % 3 === 1 ? "F5_TOTAL" : "TEAM_TOTAL",
        selection: index % 3 === 0 ? `Shadow Home ${index}` : index % 3 === 1 ? "OVER 4.5" : "HOME OVER 3.5",
        line: index % 3 === 0 ? null : index % 3 === 1 ? 4.5 : 3.5,
        oddsAmerican,
        book: "S5B Isolated Fixture",
      },
      probabilities: {
        model: probability,
        marketImplied,
        noVig: marketImplied,
        edgePp: (probability - marketImplied) * 100,
      },
      decision: {
        signal,
        confidenceLabel,
        confidencePct: probability * 100,
        stakeUnits,
      },
      analysisStage: "FINAL",
      model: {
        name: "CourtEdge MLB",
        version: "s5b-shadow-dry-run-v1",
        gitCommit: process.env.GITHUB_SHA || "local-dry-run",
        environment: "github-actions-isolated",
      },
      supersedesId: null,
      source: "app",
      payloadSha256: `dry-prediction-sha-${index}`,
      payload: {
        model: {
          name: "CourtEdge MLB",
          version: "s5b-shadow-dry-run-v1",
          gitCommit: process.env.GITHUB_SHA || "local-dry-run",
          environment: "github-actions-isolated",
        },
        game: {
          gamePk: 910000 + index,
          gameDate,
          commenceTime: `${gameDate}T23:00:00.000Z`,
          homeTeam: `Shadow Home ${index}`,
          awayTeam: `Shadow Away ${index}`,
        },
        market: {
          type: index % 3 === 0 ? "ML" : index % 3 === 1 ? "F5_TOTAL" : "TEAM_TOTAL",
          selection: index % 3 === 0 ? `Shadow Home ${index}` : index % 3 === 1 ? "OVER 4.5" : "HOME OVER 3.5",
          line: index % 3 === 0 ? undefined : index % 3 === 1 ? 4.5 : 3.5,
          oddsAmerican,
          book: "S5B Isolated Fixture",
          capturedAt: recordedAt,
        },
        probabilities: { model: probability, marketImplied, edgePp: (probability - marketImplied) * 100 },
        decision: { signal, confidenceLabel, stakeUnits },
        analysis: {
          stage: "FINAL",
          warnings,
          factors: [{ name: "isolated-fixture", direction: "NEUTRAL", magnitude: index }],
          sources: [{ name: "s5b-dry-run", status: "VERIFIED", fetchedAt: recordedAt }],
          layers: { filterReasons: warnings },
          rawOutput: { filterReasons: warnings },
        },
      },
    },
    settlement: {
      eventId: `s5b-dry-settlement-${index}`,
      predictionId: id,
      clientRequestId: `s5b-dry-settlement-request-${index}`,
      recordedAt: `${gameDate}T23:59:00.000Z`,
      recordedAtMs: Date.parse(`${gameDate}T23:59:00.000Z`),
      settledAt: `${gameDate}T23:59:00.000Z`,
      result,
      closingOddsAmerican: index % 2 === 0 ? -105 : 100,
      closingLine: index % 3 === 0 ? null : index % 3 === 1 ? 4.5 : 3.5,
      closingImpliedProbability: index % 2 === 0 ? 0.5122 : 0.5,
      clvPp: 0.35 + index * 0.05,
      outcomeValue: result === "WIN" ? 1 : result === "LOSS" ? 0 : 0.5,
      finalScore: { home: 5 + (index % 4), away: 2 + (index % 3) },
      profitUnits: result === "WIN" ? stakeUnits : result === "LOSS" ? -stakeUnits : 0,
      source: "official",
      correctionOfEventId: null,
      notes: "Synthetic isolated S5B dry-run settlement; no deployed write.",
      payloadSha256: `dry-settlement-sha-${index}`,
      payload: {},
    },
  };
}

const records = Array.from({ length: 12 }, (_, index) => record(index));
const duplicate = structuredClone(records[2]);
duplicate.prediction.id = "s5b-dry-duplicate";
duplicate.prediction.clientRequestId = "s5b-dry-request-duplicate";
duplicate.prediction.recordedAt = "2026-07-12T12:00:15.000Z";
duplicate.prediction.recordedAtMs = Date.parse(duplicate.prediction.recordedAt);
duplicate.prediction.payload.market.capturedAt = duplicate.prediction.recordedAt;
duplicate.prediction.payload.analysis.sources[0].fetchedAt = duplicate.prediction.recordedAt;
records.push(duplicate);

const report = buildMlbShadowEvaluation(records);
const canonicalRows = JSON.stringify(report.rows);
const datasetSha256 = createHash("sha256").update(canonicalRows).digest("hex");
const evidence = {
  schemaVersion: "s5b-shadow-dry-run-evidence.v1",
  generatedAt: new Date().toISOString(),
  gitCommit: process.env.GITHUB_SHA || "local",
  isolation: {
    railwayRequests: 0,
    deployedWrites: 0,
    productionWrites: 0,
    realFinancialExposure: 0,
    sportsbookIntegrations: 0,
  },
  datasetSha256,
  assertions: {
    modeIsShadow: report.mode === "SHADOW",
    noFinancialExposure: report.execution.realFinancialExposure === 0,
    duplicateExcluded: report.deduplication.duplicatesExcluded === 1,
    acceptedAndBlockedSeparated: Boolean(report.breakdowns.byDisposition.ACCEPTED && report.breakdowns.byDisposition.BLOCKED),
    immutableSourceDeclared: report.methodology.immutableSource === "mlb-ledger.v1",
    automaticPromotionDisabled: report.decisionGate.automaticPromotion === false,
  },
  summary: report.summary,
  deduplication: report.deduplication,
  dataQuality: report.dataQuality,
  decisionGate: report.decisionGate,
};

for (const [name, passed] of Object.entries(evidence.assertions)) {
  if (!passed) throw new Error(`S5B dry-run assertion failed: ${name}`);
}

await writeFile(path.join(outputDir, "shadow-evaluation.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(outputDir, "shadow-rows.jsonl"), `${report.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
await writeFile(path.join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

console.log(JSON.stringify({
  status: "PASS",
  schemaVersion: evidence.schemaVersion,
  datasetSha256,
  ledgerRecords: report.deduplication.ledgerRecords,
  uniqueAnalyticalDecisions: report.deduplication.uniqueAnalyticalDecisions,
  duplicatesExcluded: report.deduplication.duplicatesExcluded,
  accepted: report.breakdowns.byDisposition.ACCEPTED?.total ?? 0,
  blocked: report.breakdowns.byDisposition.BLOCKED?.total ?? 0,
  observed: report.breakdowns.byDisposition.OBSERVED?.total ?? 0,
  gate: report.decisionGate.status,
  realFinancialExposure: report.execution.realFinancialExposure,
}, null, 2));
