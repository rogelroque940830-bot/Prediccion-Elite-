import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";
import { buildMlbStartingPitcherOosReport } from "../server/mlb-market-starting-pitcher-asof.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ""));
}

async function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, text, "utf8");
  return { file: path.basename(file), sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

const startDate = arg("--start") ?? "2025-03-01";
const endDate = arg("--end") ?? "2025-10-01";
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b2b2-starting-pitcher-oos";
const baselineEvidencePath = arg("--baseline") ?? "evidence/p1-m6a3b1/2025-official-baseline.json";
const starterEvidencePath = arg("--starter-evidence") ?? "evidence/p1-m6a3b2b1/2025-starting-pitcher-history.json";
const concurrency = Number(arg("--concurrency") ?? 4);
const generatedAt = new Date().toISOString();

const baselineEvidence = JSON.parse(await fs.readFile(baselineEvidencePath, "utf8"));
const starterEvidence = JSON.parse(await fs.readFile(starterEvidencePath, "utf8"));
const expectedOutcomeDigest = baselineEvidence?.integrity?.outcomeDigest;
const expectedStarterHistoryDigest = starterEvidence?.integrity?.starterHistoryDigest;
const expectedStart = baselineEvidence?.source?.startDate;
const expectedEnd = baselineEvidence?.source?.endDate;
const expectedGames = Number(starterEvidence?.cohort?.regularSeasonFinalGames);
const expectedStarterLines = Number(starterEvidence?.cohort?.starterLines);

if (
  startDate !== expectedStart
  || endDate !== expectedEnd
  || !isSha256(expectedOutcomeDigest)
  || !isSha256(expectedStarterHistoryDigest)
  || expectedGames !== 2430
  || expectedStarterLines !== 4860
) {
  throw new Error("P1_M6A3B2B2_FROZEN_EVIDENCE_CONTRACT_INVALID");
}

await fs.mkdir(outputRoot, { recursive: true });

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
if (official.failures.length > 0) {
  throw new Error(`P1_M6A3B2B2_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
}
const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
if (dataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2B2_FROZEN_OUTCOME_DIGEST_MISMATCH:${dataset.outcomeDigest}`);
}
if (dataset.regularSeasonFinalGames !== expectedGames) {
  throw new Error(`P1_M6A3B2B2_FROZEN_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}`);
}

const starterHistory = await fetchMlbHistoricalStartingPitcherHistory({ startDate, endDate, concurrency });
if (starterHistory.failures.length > 0) {
  throw new Error(`P1_M6A3B2B2_STARTER_HISTORY_INCOMPLETE:${starterHistory.failures.length}`);
}
if (starterHistory.gamesWithBothStarters !== expectedGames || starterHistory.starterLines !== expectedStarterLines) {
  throw new Error(`P1_M6A3B2B2_STARTER_COVERAGE_MISMATCH:${starterHistory.gamesWithBothStarters}:${starterHistory.starterLines}`);
}
if (starterHistory.starterHistoryDigest !== expectedStarterHistoryDigest) {
  throw new Error(`P1_M6A3B2B2_FROZEN_STARTER_HISTORY_DIGEST_MISMATCH:${starterHistory.starterHistoryDigest}`);
}

const sourceIntegrity = {
  schemaVersion: "courtedge-p1-m6a3b2b2-source-integrity.v1",
  generatedAt,
  range: { startDate, endDate },
  outcomeDigest: dataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
  starterHistoryDigest: starterHistory.starterHistoryDigest,
  starterHistoryDigestMatchesFrozenB2B1: starterHistory.starterHistoryDigest === expectedStarterHistoryDigest,
  officialGames: dataset.regularSeasonFinalGames,
  gamesWithBothStarters: starterHistory.gamesWithBothStarters,
  starterLines: starterHistory.starterLines,
  identityMethodCounts: starterHistory.identityMethodCounts,
  sourceProvenance: {
    outcomeSourceProvenanceDigest: dataset.sourceProvenanceDigest,
    boxscoreProvenanceDigest: starterHistory.boxscoreProvenanceDigest,
  },
  actionabilityAllowed: false,
};
const sourceIntegrityArtifact = await writeJson(path.join(outputRoot, "source-integrity.json"), sourceIntegrity);

const report = buildMlbStartingPitcherOosReport(dataset.observations, starterHistory.games, { generatedAt });
if (!report.allFoldsLeakageFree) throw new Error("P1_M6A3B2B2_OOS_LEAKAGE_DETECTED");
if (report.actionabilityAllowed || report.automaticModelSelectionAllowed || report.automaticPromotionAllowed) {
  throw new Error("P1_M6A3B2B2_RESEARCH_BOUNDARY_VIOLATION");
}
const reportArtifact = await writeJson(path.join(outputRoot, "starting-pitcher-oos-report.json"), report);

const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2b2-starting-pitcher-oos-artifact-manifest.v1",
  generatedAt,
  sourceIntegrity: {
    frozenB1OutcomeDigest: expectedOutcomeDigest,
    reproducedOutcomeDigest: dataset.outcomeDigest,
    frozenB2B1StarterHistoryDigest: expectedStarterHistoryDigest,
    reproducedStarterHistoryDigest: starterHistory.starterHistoryDigest,
  },
  games: expectedGames,
  starterLines: expectedStarterLines,
  artifacts: [sourceIntegrityArtifact, reportArtifact],
  horizons: report.horizons.map((entry) => ({
    horizon: entry.horizon,
    status: entry.status,
    validationGames: entry.validationGames,
    teamMinusPitcherCountNll: entry.teamMinusPitcherCountNll,
    leagueMinusPitcherCountNll: entry.leagueMinusPitcherCountNll,
    relativePitcherReductionVsTeamPct: entry.relativePitcherReductionVsTeamPct,
    selectedPitcherEffectWeightByFold: entry.folds.map((fold) => fold.selectedPitcherEffectWeight),
    selectedPitcherPriorBattersByFold: entry.folds.map((fold) => fold.selectedPitcherPriorBatters),
    bothPitchersSeenValidationGames: entry.folds.reduce((sum, fold) => sum + fold.bothPitchersSeenValidationGames, 0),
    onePitcherUnseenValidationGames: entry.folds.reduce((sum, fold) => sum + fold.onePitcherUnseenValidationGames, 0),
    bothPitchersUnseenValidationGames: entry.folds.reduce((sum, fold) => sum + fold.bothPitchersUnseenValidationGames, 0),
  })),
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2B2_STARTING_PITCHER_CHALLENGER_ONLY",
    "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED",
    "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2B2_STARTING_PITCHER_OOS_SUMMARY");
console.log(JSON.stringify({
  outcomeDigestMatchesFrozenB1: sourceIntegrity.outcomeDigestMatchesFrozenB1,
  starterHistoryDigestMatchesFrozenB2B1: sourceIntegrity.starterHistoryDigestMatchesFrozenB2B1,
  games: expectedGames,
  starterLines: expectedStarterLines,
  allFoldsLeakageFree: report.allFoldsLeakageFree,
  actionabilityAllowed: report.actionabilityAllowed,
  automaticModelSelectionAllowed: report.automaticModelSelectionAllowed,
  automaticPromotionAllowed: report.automaticPromotionAllowed,
  horizons: manifest.horizons,
}, null, 2));
