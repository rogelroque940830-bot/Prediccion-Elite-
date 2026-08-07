import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";

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
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b2b1-starting-pitcher-history";
const baselinePath = arg("--baseline") ?? "evidence/p1-m6a3b1/2025-official-baseline.json";
const concurrency = Number(arg("--concurrency") ?? 4);
const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
const expectedOutcomeDigest = baseline?.integrity?.outcomeDigest;
const expectedGames = Number(baseline?.integrity?.regularSeasonFinalGames);
const expectedStart = baseline?.source?.startDate;
const expectedEnd = baseline?.source?.endDate;

if (
  startDate !== expectedStart
  || endDate !== expectedEnd
  || !/^[a-f0-9]{64}$/i.test(String(expectedOutcomeDigest ?? ""))
  || !Number.isInteger(expectedGames)
  || expectedGames <= 0
) {
  throw new Error("P1_M6A3B2B1_BASELINE_EVIDENCE_CONTRACT_INVALID");
}

await fs.mkdir(outputRoot, { recursive: true });

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
if (official.failures.length > 0) {
  throw new Error(`P1_M6A3B2B1_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
}
const officialDataset = buildMlbHistoricalDataset(official.games);
if (officialDataset.regularSeasonFinalGames !== expectedGames) {
  throw new Error(`P1_M6A3B2B1_OFFICIAL_GAME_COUNT_MISMATCH:${officialDataset.regularSeasonFinalGames}`);
}
if (officialDataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2B1_OFFICIAL_OUTCOME_DIGEST_MISMATCH:${officialDataset.outcomeDigest}`);
}
const officialIntegrity = {
  schemaVersion: "courtedge-p1-m6a3b2b1-official-integrity.v1",
  startDate,
  endDate,
  sourceVersion: official.sourceVersion,
  scheduleGames: official.scheduleGames,
  officialFinalGames: official.officialFinalGames,
  regularSeasonFinalGames: officialDataset.regularSeasonFinalGames,
  frozenOutcomeDigest: expectedOutcomeDigest,
  reproducedOutcomeDigest: officialDataset.outcomeDigest,
  outcomeDigestMatchesFrozenB1: true,
  failures: official.failures,
  actionabilityAllowed: false,
};
const officialArtifact = await writeJson(path.join(outputRoot, "official-integrity.json"), officialIntegrity);

const history = await fetchMlbHistoricalStartingPitcherHistory({ startDate, endDate, concurrency });
const historyArtifact = await writeJson(path.join(outputRoot, "starting-pitcher-history.json"), history);
if (history.failures.length > 0) {
  throw new Error(`P1_M6A3B2B1_BOXSCORE_HISTORY_INCOMPLETE:${history.failures.length}`);
}
if (history.officialGamesReceived !== expectedGames || history.gamesWithBothStarters !== expectedGames) {
  throw new Error(`P1_M6A3B2B1_STARTER_COVERAGE_INCOMPLETE:${history.gamesWithBothStarters}:${expectedGames}`);
}
if (history.starterLines !== expectedGames * 2) {
  throw new Error(`P1_M6A3B2B1_STARTER_LINE_COUNT_MISMATCH:${history.starterLines}`);
}

const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2b1-starting-pitcher-artifact-manifest.v1",
  generatedAt: new Date().toISOString(),
  range: { startDate, endDate },
  frozenB1OutcomeDigest: expectedOutcomeDigest,
  starterHistoryDigest: history.starterHistoryDigest,
  boxscoreProvenanceDigest: history.boxscoreProvenanceDigest,
  officialGames: history.officialGamesReceived,
  gamesWithBothStarters: history.gamesWithBothStarters,
  starterLines: history.starterLines,
  identityMethodCounts: history.identityMethodCounts,
  artifacts: [officialArtifact, historyArtifact],
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2B1_RESEARCH_HISTORY_ONLY",
    "P1_M6A3B2B2_ASOF_PITCHER_MODEL_REQUIRED",
    "NO_AUTOMATIC_PROMOTION"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2B1_STARTING_PITCHER_HISTORY_SUMMARY");
console.log(JSON.stringify({
  outcomeDigestMatchesFrozenB1: officialDataset.outcomeDigest === expectedOutcomeDigest,
  frozenOutcomeDigest: expectedOutcomeDigest,
  starterHistoryDigest: history.starterHistoryDigest,
  boxscoreProvenanceDigest: history.boxscoreProvenanceDigest,
  officialGames: history.officialGamesReceived,
  gamesWithBothStarters: history.gamesWithBothStarters,
  starterLines: history.starterLines,
  failures: history.failures.length,
  identityMethodCounts: history.identityMethodCounts,
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
}, null, 2));
