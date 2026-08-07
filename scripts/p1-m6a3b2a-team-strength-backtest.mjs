import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { buildMlbTeamStrengthOosReport } from "../server/mlb-market-team-strength.ts";
import { buildMlbTeamStrengthPairedInferenceReport } from "../server/mlb-market-team-strength-inference.ts";

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
const expectedOutcomeDigest = baselineEvidence?.integrity?.outcomeDigest;
const expectedObservationsByHorizon = baselineEvidence?.sample?.observationsByHorizon;
if (startDate !== expectedStart || endDate !== expectedEnd || !/^[a-f0-9]{64}$/.test(String(expectedOutcomeDigest ?? ""))) {
  throw new Error("P1_M6A3B2A_BASELINE_EVIDENCE_RANGE_OR_OUTCOME_DIGEST_MISMATCH");
}

await fs.mkdir(outputRoot, { recursive: true });
const acquisition = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const acquisitionArtifact = await writeJson(path.join(outputRoot, "acquisition.json"), acquisition);
if (acquisition.failures.length > 0) {
  throw new Error(`P1_M6A3B2A_ACQUISITION_INCOMPLETE:${acquisition.failures.length}`);
}

const dataset = buildMlbHistoricalDataset(acquisition.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
if (dataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_OUTCOME_DIGEST_MISMATCH:${dataset.outcomeDigest}`);
}
for (const [horizon, expectedCount] of Object.entries(expectedObservationsByHorizon ?? {})) {
  if (dataset.observationsByHorizon[horizon] !== expectedCount) {
    throw new Error(`P1_M6A3B2A_FROZEN_BASELINE_SAMPLE_COUNT_MISMATCH:${horizon}:${dataset.observationsByHorizon[horizon]}:${expectedCount}`);
  }
}

const report = buildMlbTeamStrengthOosReport(dataset.observations, { generatedAt });
const inference = buildMlbTeamStrengthPairedInferenceReport(dataset.observations, { generatedAt });
for (const horizon of report.horizons) {
  const paired = inference.horizons.find((entry) => entry.horizon === horizon.horizon);
  if (!paired) throw new Error(`P1_M6A3B2A_PAIRED_INFERENCE_HORIZON_MISSING:${horizon.horizon}`);
  const point = horizon.baselineMinusChallengerCountNll;
  const pairedPoint = paired.pointEstimateBaselineMinusChallengerCountNll;
  if (point != null && pairedPoint != null && Math.abs(point - pairedPoint) > 2e-7) {
    throw new Error(`P1_M6A3B2A_POINT_ESTIMATE_PARITY_FAILURE:${horizon.horizon}:${point}:${pairedPoint}`);
  }
}

const reportArtifact = await writeJson(path.join(outputRoot, "team-strength-oos-report.json"), report);
const inferenceArtifact = await writeJson(path.join(outputRoot, "paired-date-inference.json"), inference);
const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2a-team-strength-artifact-manifest.v2",
  generatedAt,
  sourceVersion: acquisition.sourceVersion,
  range: { startDate, endDate },
  frozenB1OutcomeDigest: expectedOutcomeDigest,
  reproducedOutcomeDigest: dataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
  providerProvenance: {
    sourceProvenanceDigest: dataset.sourceProvenanceDigest,
    legacyDatasetDigest: dataset.datasetDigest,
    allowedToDriftWithoutChangingOutcomeIdentity: true,
  },
  games: {
    scheduled: acquisition.scheduleGames,
    officialFinal: acquisition.officialFinalGames,
    regularSeasonFinal: dataset.regularSeasonFinalGames,
  },
  observationsByHorizon: dataset.observationsByHorizon,
  artifacts: [acquisitionArtifact, datasetArtifact, reportArtifact, inferenceArtifact],
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2A_TEAM_STRENGTH_CHALLENGER_ONLY",
    "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
    "PAIRED_DATE_UNCERTAINTY_REQUIRED_FOR_INTERPRETATION",
    "HUMAN_REVIEW_OF_OUT_OF_SAMPLE_EVIDENCE_REQUIRED"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2A_TEAM_STRENGTH_SCIENTIFIC_SUMMARY");
console.log(JSON.stringify({
  outcomeDigest: dataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
  sourceProvenanceDigest: dataset.sourceProvenanceDigest,
  legacyDatasetDigest: dataset.datasetDigest,
  games: dataset.regularSeasonFinalGames,
  observationsByHorizon: dataset.observationsByHorizon,
  allFoldsLeakageFree: report.allFoldsLeakageFree,
  actionabilityAllowed: report.actionabilityAllowed,
  automaticModelSelectionAllowed: report.automaticModelSelectionAllowed,
  automaticPromotionAllowed: report.automaticPromotionAllowed,
  horizons: report.horizons.map((horizon) => {
    const paired = inference.horizons.find((entry) => entry.horizon === horizon.horizon);
    return {
      horizon: horizon.horizon,
      legacyPointStatus: horizon.status,
      pairedEvidenceStatus: paired?.evidenceStatus ?? null,
      observations: horizon.observations,
      validationGames: horizon.validationGames,
      dateClusters: paired?.dateClusters ?? null,
      baselineNb2CountNegativeLogLikelihood: horizon.baselineNb2CountNegativeLogLikelihood,
      challengerCountNegativeLogLikelihood: horizon.challengerCountNegativeLogLikelihood,
      baselineMinusChallengerCountNll: horizon.baselineMinusChallengerCountNll,
      relativeCountNllReductionPct: horizon.relativeCountNllReductionPct,
      pairedUnadjusted95: paired?.unadjusted95 ?? null,
      pairedBonferroniFamilywise: paired?.bonferroniFamilywise ?? null,
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
    };
  }),
}, null, 2));
