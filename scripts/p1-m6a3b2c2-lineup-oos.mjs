import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";
import { buildMlbLineupOosReport } from "../server/mlb-market-lineup-asof.ts";
import { buildMlbLineupPairedInferenceReport } from "../server/mlb-market-lineup-inference.ts";

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

function sortedGamePks(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

const startDate = arg("--start") ?? "2025-03-01";
const endDate = arg("--end") ?? "2025-10-01";
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b2c2-lineup-oos";
const baselineEvidencePath = arg("--baseline") ?? "evidence/p1-m6a3b1/2025-official-baseline.json";
const lineupEvidencePath = arg("--lineup-evidence") ?? "evidence/p1-m6a3b2c1/2025-pregame-lineup-coverage.json";
const concurrency = Number(arg("--concurrency") ?? 4);
const generatedAt = new Date().toISOString();

const baselineEvidence = JSON.parse(await fs.readFile(baselineEvidencePath, "utf8"));
const lineupEvidence = JSON.parse(await fs.readFile(lineupEvidencePath, "utf8"));
const expectedOutcomeDigest = baselineEvidence?.integrity?.outcomeDigest;
const expectedStart = baselineEvidence?.source?.startDate;
const expectedEnd = baselineEvidence?.source?.endDate;
const expectedGames = Number(lineupEvidence?.sourceCertification?.scheduleGames);
const expectedSnapshots = Number(lineupEvidence?.sourceCertification?.snapshotsFetched);
const expectedCompleteLineupGames = Number(lineupEvidence?.sourceCertification?.completeLineupGames);
const expectedLineupHistoryDigest = lineupEvidence?.sourceCertification?.lineupHistoryDigest;
const expectedCompleteGamePksDigest = lineupEvidence?.sourceCertification?.completeGamePksDigest;
const expectedSourceVersion = lineupEvidence?.sourceCertification?.sourceVersion;

if (
  startDate !== expectedStart
  || endDate !== expectedEnd
  || !isSha256(expectedOutcomeDigest)
  || !isSha256(expectedLineupHistoryDigest)
  || !isSha256(expectedCompleteGamePksDigest)
  || expectedGames !== 2430
  || expectedSnapshots !== 2430
  || expectedCompleteLineupGames !== 2423
  || expectedSourceVersion !== "statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4"
) {
  throw new Error("P1_M6A3B2C2_FROZEN_EVIDENCE_CONTRACT_INVALID");
}

await fs.mkdir(outputRoot, { recursive: true });

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
if (official.failures.length > 0) {
  throw new Error(`P1_M6A3B2C2_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
}
const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
if (dataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2C2_FROZEN_OUTCOME_DIGEST_MISMATCH:${dataset.outcomeDigest}`);
}
if (dataset.regularSeasonFinalGames !== expectedGames) {
  throw new Error(`P1_M6A3B2C2_FROZEN_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}`);
}

const lineup = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: 300,
  concurrency,
});
if (lineup.sourceVersion !== expectedSourceVersion) {
  throw new Error(`P1_M6A3B2C2_LINEUP_SOURCE_VERSION_MISMATCH:${lineup.sourceVersion}`);
}
if (lineup.failures.length > 0) {
  throw new Error(`P1_M6A3B2C2_LINEUP_ACQUISITION_INCOMPLETE:${lineup.failures.length}`);
}
if (lineup.scheduleGames !== expectedGames || lineup.snapshotsFetched !== expectedSnapshots) {
  throw new Error(`P1_M6A3B2C2_LINEUP_COHORT_COUNT_MISMATCH:${lineup.scheduleGames}:${lineup.snapshotsFetched}`);
}
if (lineup.completeLineupGames !== expectedCompleteLineupGames) {
  throw new Error(`P1_M6A3B2C2_COMPLETE_LINEUP_COUNT_MISMATCH:${lineup.completeLineupGames}`);
}
if (lineup.lineupHistoryDigest !== expectedLineupHistoryDigest) {
  throw new Error(`P1_M6A3B2C2_FROZEN_LINEUP_HISTORY_DIGEST_MISMATCH:${lineup.lineupHistoryDigest}`);
}
const completeGamePks = sortedGamePks(lineup.snapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
const completeGamePksDigest = sha256(JSON.stringify(completeGamePks));
if (completeGamePksDigest !== expectedCompleteGamePksDigest) {
  throw new Error(`P1_M6A3B2C2_COMPLETE_GAMEPK_DIGEST_MISMATCH:${completeGamePksDigest}`);
}

const sourceIntegrity = {
  schemaVersion: "courtedge-p1-m6a3b2c2-source-integrity.v1",
  generatedAt,
  range: { startDate, endDate },
  frozenB1OutcomeDigest: expectedOutcomeDigest,
  reproducedOutcomeDigest: dataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: dataset.outcomeDigest === expectedOutcomeDigest,
  frozenB2C1LineupHistoryDigest: expectedLineupHistoryDigest,
  reproducedLineupHistoryDigest: lineup.lineupHistoryDigest,
  lineupHistoryDigestMatchesFrozenB2C1: lineup.lineupHistoryDigest === expectedLineupHistoryDigest,
  frozenCompleteGamePksDigest: expectedCompleteGamePksDigest,
  reproducedCompleteGamePksDigest: completeGamePksDigest,
  completeGamePksDigestMatchesFrozenB2C1: completeGamePksDigest === expectedCompleteGamePksDigest,
  officialGames: dataset.regularSeasonFinalGames,
  lineupScheduleGames: lineup.scheduleGames,
  lineupSnapshotsFetched: lineup.snapshotsFetched,
  completeLineupGames: lineup.completeLineupGames,
  availabilityCounts: lineup.availabilityCounts,
  scheduleResolutionCounts: lineup.scheduleResolutionCounts,
  lineupSourceVersion: lineup.sourceVersion,
  sourceProvenance: {
    outcomeSourceProvenanceDigest: dataset.sourceProvenanceDigest,
    lineupSourceProvenanceDigest: lineup.sourceProvenanceDigest,
  },
  actionabilityAllowed: false,
};
const sourceIntegrityArtifact = await writeJson(path.join(outputRoot, "source-integrity.json"), sourceIntegrity);

const report = buildMlbLineupOosReport(dataset.observations, lineup.snapshots, { generatedAt });
if (!report.allFoldsLeakageFree) throw new Error("P1_M6A3B2C2_OOS_LEAKAGE_DETECTED");
if (report.actionabilityAllowed || report.automaticModelSelectionAllowed || report.automaticPromotionAllowed) {
  throw new Error("P1_M6A3B2C2_RESEARCH_BOUNDARY_VIOLATION");
}
const reportArtifact = await writeJson(path.join(outputRoot, "lineup-oos-report.json"), report);

const inference = buildMlbLineupPairedInferenceReport(report, { generatedAt });
if (inference.actionabilityAllowed || inference.automaticModelSelectionAllowed || inference.automaticPromotionAllowed) {
  throw new Error("P1_M6A3B2C2B_RESEARCH_BOUNDARY_VIOLATION");
}
const inferenceArtifact = await writeJson(path.join(outputRoot, "lineup-paired-inference.json"), inference);

const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2c2-lineup-oos-artifact-manifest.v1",
  generatedAt,
  sourceIntegrity: {
    frozenB1OutcomeDigest: expectedOutcomeDigest,
    reproducedOutcomeDigest: dataset.outcomeDigest,
    frozenB2C1LineupHistoryDigest: expectedLineupHistoryDigest,
    reproducedLineupHistoryDigest: lineup.lineupHistoryDigest,
    completeGamePksDigest,
  },
  games: expectedGames,
  certifiedLineupGames: expectedCompleteLineupGames,
  artifacts: [sourceIntegrityArtifact, reportArtifact, inferenceArtifact],
  horizons: report.horizons.map((entry) => {
    const paired = inference.horizons.find((candidate) => candidate.horizon === entry.horizon);
    if (!paired) throw new Error(`P1_M6A3B2C2B_INFERENCE_HORIZON_MISSING:${entry.horizon}`);
    return {
      horizon: entry.horizon,
      pointStatus: entry.status,
      overallEvidenceStatus: paired.overallEvidenceStatus,
      validationGames: entry.validationGames,
      validationGamesExcludedForLineup: entry.validationGamesExcludedForLineup,
      dateClusters: paired.dateClusters,
      teamMinusLineupCountNll: entry.teamMinusLineupCountNll,
      leagueMinusLineupCountNll: entry.leagueMinusLineupCountNll,
      relativeLineupReductionVsTeamPct: entry.relativeLineupReductionVsTeamPct,
      teamComparison: paired.teamComparison,
      leagueComparison: paired.leagueComparison,
      selectedLineupEffectWeightByFold: entry.folds.map((fold) => fold.selectedLineupEffectWeight),
      selectedPlayerPriorGamesByFold: entry.folds.map((fold) => fold.selectedPlayerPriorGames),
      allBattersSeenValidationGames: entry.folds.reduce((sum, fold) => sum + fold.bothLineupsAllBattersSeenValidationGames, 0),
      atLeastOneUnseenBatterValidationGames: entry.folds.reduce((sum, fold) => sum + fold.atLeastOneUnseenBatterValidationGames, 0),
    };
  }),
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2C2B_PAIRED_DATE_INFERENCE_RESEARCH_ONLY",
    "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE",
    "NO_AUTOMATIC_PROMOTION"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2C2_LINEUP_OOS_SUMMARY");
console.log(JSON.stringify({
  outcomeDigestMatchesFrozenB1: sourceIntegrity.outcomeDigestMatchesFrozenB1,
  lineupHistoryDigestMatchesFrozenB2C1: sourceIntegrity.lineupHistoryDigestMatchesFrozenB2C1,
  completeGamePksDigestMatchesFrozenB2C1: sourceIntegrity.completeGamePksDigestMatchesFrozenB2C1,
  games: expectedGames,
  certifiedLineupGames: expectedCompleteLineupGames,
  allFoldsLeakageFree: report.allFoldsLeakageFree,
  actionabilityAllowed: report.actionabilityAllowed,
  automaticModelSelectionAllowed: report.automaticModelSelectionAllowed,
  automaticPromotionAllowed: report.automaticPromotionAllowed,
  horizons: manifest.horizons,
}, null, 2));
