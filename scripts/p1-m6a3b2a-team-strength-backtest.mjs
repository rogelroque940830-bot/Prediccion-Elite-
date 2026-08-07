import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { buildMlbTeamStrengthOosReport } from "../server/mlb-market-team-strength.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, text, "utf8");
  return { file: path.basename(file), sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

const startDate = arg("--start") ?? "2025-03-01";
const endDate = arg("--end") ?? "2025-10-01";
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b2a-team-strength";
const baselineEvidencePath = arg("--baseline") ?? "evidence/p1-m6a3b1/2025-official-baseline.json";
const concurrency = Number(arg("--concurrency") ?? 4);
const generatedAt = new Date().toISOString();

const baselineEvidence = JSON.parse(await fs.readFile(baselineEvidencePath, "utf8"));
const expectedStart = baselineEvidence?.source?.startDate;
const expectedEnd = baselineEvidence?.source?.endDate;
const expectedDigest = baselineEvidence?.integrity?.datasetDigest;
if (startDate !== expectedStart || endDate !== expectedEnd || !/^[a-f0-9]{64}$/.test(String(expectedDigest ?? ""))) {
  throw new Error("P1_M6A3B2A_BASELINE_EVIDENCE_RANGE_OR_DIGEST_MISMATCH");
}

await fs.mkdir(outputRoot, { recursive: true });
const acquisition = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const acquisitionArtifact = await writeJson(path.join(outputRoot, "acquisition.json"), acquisition);
if (acquisition.failures.length > 0) {
  throw new Error(`P1_M6A3B2A_ACQUISITION_INCOMPLETE:${acquisition.failures.length}`);
}

const dataset = buildMlbHistoricalDataset(acquisition.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
if (dataset.datasetDigest !== expectedDigest) {
  throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_DATASET_DIGEST_MISMATCH:${dataset.datasetDigest}`);
}

const report = buildMlbTeamStrengthOosReport(dataset.observations, { generatedAt });
const reportArtifact = await writeJson(path.join(outputRoot, "team-strength-oos-report.json"), report);
const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2a-team-strength-artifact-manifest.v1",
  generatedAt,
  sourceVersion: acquisition.sourceVersion,
  range: { startDate, endDate },
  frozenB1DatasetDigest: expectedDigest,
  reproducedDatasetDigest: dataset.datasetDigest,
  datasetDigestMatchesFrozenB1: dataset.datasetDigest === expectedDigest,
  games: {
    scheduled: acquisition.scheduleGames,
    officialFinal: acquisition.officialFinalGames,
    regularSeasonFinal: dataset.regularSeasonFinalGames,
  },
  observationsByHorizon: dataset.observationsByHorizon,
  artifacts: [acquisitionArtifact, datasetArtifact, reportArtifact],
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2A_TEAM_STRENGTH_CHALLENGER_ONLY",
    "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
    "HUMAN_REVIEW_OF_OUT_OF_SAMPLE_EVIDENCE_REQUIRED"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2A_TEAM_STRENGTH_SCIENTIFIC_SUMMARY");
console.log(JSON.stringify({
  datasetDigest: dataset.datasetDigest,
  datasetDigestMatchesFrozenB1: dataset.datasetDigest === expectedDigest,
  games: dataset.regularSeasonFinalGames,
  observationsByHorizon: dataset.observationsByHorizon,
  allFoldsLeakageFree: report.allFoldsLeakageFree,
  actionabilityAllowed: report.actionabilityAllowed,
  automaticModelSelectionAllowed: report.automaticModelSelectionAllowed,
  automaticPromotionAllowed: report.automaticPromotionAllowed,
  horizons: report.horizons.map((horizon) => ({
    horizon: horizon.horizon,
    status: horizon.status,
    observations: horizon.observations,
    validationGames: horizon.validationGames,
    baselineNb2CountNegativeLogLikelihood: horizon.baselineNb2CountNegativeLogLikelihood,
    challengerCountNegativeLogLikelihood: horizon.challengerCountNegativeLogLikelihood,
    baselineMinusChallengerCountNll: horizon.baselineMinusChallengerCountNll,
    relativeCountNllReductionPct: horizon.relativeCountNllReductionPct,
    selectedPriorGamesByFold: horizon.folds.map((fold) => fold.selectedPriorGames),
    baselineHomeMoneyline: horizon.baselineHomeMoneylineCalibration ? {
      n: horizon.baselineHomeMoneylineCalibration.n,
      multiclassBrier: horizon.baselineHomeMoneylineCalibration.multiclassBrier,
      logLoss: horizon.baselineHomeMoneylineCalibration.logLoss,
      macroEce: horizon.baselineHomeMoneylineCalibration.macroEce,
    } : null,
    challengerHomeMoneyline: horizon.challengerHomeMoneylineCalibration ? {
      n: horizon.challengerHomeMoneylineCalibration.n,
      multiclassBrier: horizon.challengerHomeMoneylineCalibration.multiclassBrier,
      logLoss: horizon.challengerHomeMoneylineCalibration.logLoss,
      macroEce: horizon.challengerHomeMoneylineCalibration.macroEce,
    } : null,
    baselineNrfi: horizon.baselineNrfiCalibration ? {
      n: horizon.baselineNrfiCalibration.n,
      multiclassBrier: horizon.baselineNrfiCalibration.multiclassBrier,
      logLoss: horizon.baselineNrfiCalibration.logLoss,
      macroEce: horizon.baselineNrfiCalibration.macroEce,
    } : null,
    challengerNrfi: horizon.challengerNrfiCalibration ? {
      n: horizon.challengerNrfiCalibration.n,
      multiclassBrier: horizon.challengerNrfiCalibration.multiclassBrier,
      logLoss: horizon.challengerNrfiCalibration.logLoss,
      macroEce: horizon.challengerNrfiCalibration.macroEce,
    } : null,
  })),
}, null, 2));
