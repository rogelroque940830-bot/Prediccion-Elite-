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

function validSha(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ""));
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
const expectedSourceVersion = baselineEvidence?.source?.sourceVersion;
const expectedOutcomeDigest = baselineEvidence?.integrity?.outcomeDigest;
const expectedArchivedDatasetDigest = baselineEvidence?.integrity?.datasetDigest;
const expectedSourceProvenanceDigest = baselineEvidence?.integrity?.sourceProvenanceDigestAtFreeze;
const expectedGames = Number(baselineEvidence?.integrity?.regularSeasonFinalGames);
const expectedObservations = baselineEvidence?.sample?.observationsByHorizon ?? {};
if (
  startDate !== expectedStart
  || endDate !== expectedEnd
  || !String(expectedSourceVersion ?? "").trim()
  || !validSha(expectedOutcomeDigest)
  || !validSha(expectedArchivedDatasetDigest)
  || !validSha(expectedSourceProvenanceDigest)
  || !Number.isInteger(expectedGames)
  || expectedGames <= 0
) {
  throw new Error("P1_M6A3B2A_BASELINE_EVIDENCE_CONTRACT_INVALID");
}

await fs.mkdir(outputRoot, { recursive: true });
const acquisition = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const acquisitionArtifact = await writeJson(path.join(outputRoot, "acquisition.json"), acquisition);
if (acquisition.failures.length > 0) {
  throw new Error(`P1_M6A3B2A_ACQUISITION_INCOMPLETE:${acquisition.failures.length}`);
}
if (acquisition.sourceVersion !== expectedSourceVersion) {
  throw new Error(`P1_M6A3B2A_SOURCE_VERSION_MISMATCH:${acquisition.sourceVersion}`);
}

const dataset = buildMlbHistoricalDataset(acquisition.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
if (dataset.regularSeasonFinalGames !== expectedGames) {
  throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}`);
}
for (const [horizon, expected] of Object.entries(expectedObservations)) {
  if (dataset.observationsByHorizon[horizon] !== expected) {
    throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_OBSERVATION_COUNT_MISMATCH:${horizon}:${dataset.observationsByHorizon[horizon]}`);
  }
}
if (dataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_OUTCOME_DIGEST_MISMATCH:${dataset.outcomeDigest}`);
}

const archivalDatasetDigestDrift = dataset.datasetDigest !== expectedArchivedDatasetDigest;
const sourceProvenanceDigestDrift = dataset.sourceProvenanceDigest !== expectedSourceProvenanceDigest;
const report = buildMlbTeamStrengthOosReport(dataset.observations, { generatedAt });
const reportArtifact = await writeJson(path.join(outputRoot, "team-strength-oos-report.json"), report);
const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2a-team-strength-artifact-manifest.v2",
  generatedAt,
  sourceVersion: acquisition.sourceVersion,
  range: { startDate, endDate },
  frozenB1: {
    outcomeDigest: expectedOutcomeDigest,
    archivedDatasetDigest: expectedArchivedDatasetDigest,
    sourceProvenanceDigestAtFreeze: expectedSourceProvenanceDigest,
  },
  reproduced: {
    outcomeDigest: dataset.outcomeDigest,
    archivedDatasetDigest: dataset.datasetDigest,
    sourceProvenanceDigest: dataset.sourceProvenanceDigest,
  },
  integrity: {
    outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
    archivalDatasetDigestDrift,
    sourceProvenanceDigestDrift,
    providerMetadataDriftObserved: archivalDatasetDigestDrift || sourceProvenanceDigestDrift,
  },
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
  outcomeDigest: dataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
  archivedDatasetDigest: dataset.datasetDigest,
  archivalDatasetDigestDrift,
  sourceProvenanceDigest: dataset.sourceProvenanceDigest,
  sourceProvenanceDigestDrift,
  providerMetadataDriftObserved: archivalDatasetDigestDrift || sourceProvenanceDigestDrift,
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
