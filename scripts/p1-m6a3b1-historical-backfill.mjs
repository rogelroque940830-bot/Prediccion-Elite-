import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { buildMlbHistoricalOutOfSampleReport } from "../server/mlb-market-historical-fit.ts";

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

const startDate = arg("--start");
const endDate = arg("--end");
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b1-historical";
const concurrency = Number(arg("--concurrency") ?? 4);

if (!startDate || !endDate) {
  throw new Error("Usage: node --import tsx scripts/p1-m6a3b1-historical-backfill.mjs --start YYYY-MM-DD --end YYYY-MM-DD [--out dir] [--concurrency 1-6]");
}

const generatedAt = new Date().toISOString();
await fs.mkdir(outputRoot, { recursive: true });

const acquisition = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const acquisitionArtifact = await writeJson(path.join(outputRoot, "acquisition.json"), acquisition);

if (acquisition.failures.length > 0) {
  throw new Error(`P1_M6A3B1_ACQUISITION_INCOMPLETE:${acquisition.failures.length}`);
}
if (acquisition.officialFinalGames === 0) {
  throw new Error("P1_M6A3B1_NO_OFFICIAL_FINAL_GAMES");
}

const dataset = buildMlbHistoricalDataset(acquisition.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
const oos = buildMlbHistoricalOutOfSampleReport(dataset.observations, { generatedAt });
const oosArtifact = await writeJson(path.join(outputRoot, "oos-report.json"), oos);

const manifest = {
  schemaVersion: "courtedge-p1-m6a3b1-historical-artifact-manifest.v2",
  generatedAt,
  source: acquisition.sourceVersion,
  range: { startDate, endDate },
  games: {
    scheduled: acquisition.scheduleGames,
    officialFinal: acquisition.officialFinalGames,
    regularSeasonFinal: dataset.regularSeasonFinalGames,
  },
  observationsByHorizon: dataset.observationsByHorizon,
  outcomeDigest: dataset.outcomeDigest,
  sourceProvenanceDigest: dataset.sourceProvenanceDigest,
  legacyDatasetDigest: dataset.datasetDigest,
  digestSemantics: {
    canonicalSampleIdentity: "outcomeDigest",
    providerPayloadAudit: "sourceProvenanceDigest",
    legacyAcquisitionSnapshot: "legacyDatasetDigest",
  },
  artifacts: [acquisitionArtifact, datasetArtifact, oosArtifact],
  researchOnly: true,
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  blockers: [
    "P1_M6A3B1_BASELINE_ONLY",
    "P1_M6A3B2_COVARIATE_MODEL_REQUIRED",
    "HUMAN_REVIEW_OF_OUT_OF_SAMPLE_EVIDENCE_REQUIRED",
  ],
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log(JSON.stringify({
  ok: true,
  outputRoot,
  games: dataset.regularSeasonFinalGames,
  observationsByHorizon: dataset.observationsByHorizon,
  outcomeDigest: dataset.outcomeDigest,
  sourceProvenanceDigest: dataset.sourceProvenanceDigest,
  legacyDatasetDigest: dataset.datasetDigest,
  horizonResearchStatus: oos.horizons.map((entry) => ({
    horizon: entry.horizon,
    status: entry.status,
    preferredFamilyByCountNll: entry.preferredFamilyByCountNll,
    countNllDeltaPoissonMinusNb2: entry.countNllDeltaPoissonMinusNb2,
  })),
  actionabilityAllowed: false,
}, null, 2));
