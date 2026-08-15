import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalBatterHistoryFromOfficialGames } from "../server/mlb-market-batter-history.ts";

const MANIFEST_SCHEMA = "courtedge-p0-step12v41-batter-historical-custody-manifest.v1";
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, text, "utf8");
  return { file: path.basename(file), sha256: sha256(text), bytes: Buffer.byteLength(text) };
}
function sortedPks(values) { return [...new Set(values.map(Number).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b); }

const seasonRoot = arg("--season-root");
const outputRoot = arg("--out");
const seasonLabel = arg("--label");
const concurrency = Number(arg("--concurrency") ?? 4);
if (!seasonRoot || !outputRoot || !seasonLabel) throw new Error("V41_REQUIRED_ARGUMENT_MISSING");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("V41_INVALID_CONCURRENCY");

const cohortRoot = path.join(seasonRoot, "cohort");
const official = await readJson(path.join(cohortRoot, "official-acquisition.json"));
const lineup = await readJson(path.join(cohortRoot, "pregame-lineup-history.json"));
if (!Array.isArray(official.games) || official.failures?.length) throw new Error("V41_PARENT_OFFICIAL_COHORT_INVALID");
if (!Array.isArray(lineup.snapshots) || lineup.snapshotsFetched !== official.officialFinalGames) throw new Error("V41_PARENT_LINEUP_COHORT_INVALID");

const officialPks = sortedPks(official.games.map((game) => game.gamePk));
if (officialPks.length !== official.officialFinalGames) throw new Error("V41_PARENT_OFFICIAL_GAME_PK_MISMATCH");

await fs.mkdir(outputRoot, { recursive: true });
const history = await fetchMlbHistoricalBatterHistoryFromOfficialGames({ games: official.games, concurrency });
if (history.fetchFailures.length !== 0) throw new Error(`V41_BATTER_HISTORY_INCOMPLETE:${history.fetchFailures.length}`);
if (history.teamAggregateReconciliationFailures !== 0) throw new Error("V41_TEAM_RECONCILIATION_FAILED");
if (history.gamesWithBatterLines !== official.officialFinalGames) throw new Error("V41_GAME_COUNT_MISMATCH");

const historyPks = sortedPks(history.games.map((game) => game.gamePk));
if (JSON.stringify(historyPks) !== JSON.stringify(officialPks)) throw new Error("V41_GAME_IDENTITY_MISMATCH");

const historyByPk = new Map(history.games.map((game) => [game.gamePk, game]));
let completePregameLineupGames = 0;
let completePregameLineupSlots = 0;
let slotsFoundInOfficialBatterLines = 0;
let slotsWithPositivePlateAppearances = 0;
const missingPregameSlots = [];
for (const snapshot of lineup.snapshots) {
  if (!snapshot.complete) continue;
  completePregameLineupGames += 1;
  const game = historyByPk.get(Number(snapshot.gamePk));
  if (!game) throw new Error(`V41_COMPLETE_LINEUP_GAME_MISSING:${snapshot.gamePk}`);
  for (const [side, ids] of [["home", snapshot.homeBattingOrder], ["away", snapshot.awayBattingOrder]]) {
    if (!Array.isArray(ids) || ids.length !== 9) throw new Error(`V41_COMPLETE_LINEUP_SHAPE_INVALID:${snapshot.gamePk}:${side}`);
    const lines = side === "home" ? game.homeBatters : game.awayBatters;
    const byId = new Map(lines.map((line) => [line.batterId, line]));
    for (const rawId of ids) {
      const batterId = Number(rawId);
      completePregameLineupSlots += 1;
      const line = byId.get(batterId);
      if (line) {
        slotsFoundInOfficialBatterLines += 1;
        if (line.plateAppearances > 0) slotsWithPositivePlateAppearances += 1;
      } else {
        missingPregameSlots.push({ gamePk: Number(snapshot.gamePk), officialDate: snapshot.officialDate, side, batterId });
      }
    }
  }
}
if (completePregameLineupSlots !== completePregameLineupGames * 18) throw new Error("V41_COMPLETE_LINEUP_SLOT_COUNT_INVALID");

const allLines = history.games.flatMap((game) => [...game.awayBatters, ...game.homeBatters]);
const uniqueBatters = new Set(allLines.map((line) => line.batterId));
const historyArtifact = await writeJson(path.join(outputRoot, "batter-history.json"), history);
const manifest = {
  schemaVersion: MANIFEST_SCHEMA,
  generatedAt: new Date().toISOString(),
  seasonLabel,
  parent: {
    sourceVersion: official.sourceVersion,
    startDate: official.startDate,
    endDate: official.endDate,
    officialFinalGames: official.officialFinalGames,
    officialGamePksDigest: sha256(JSON.stringify(officialPks)),
    lineupSchemaVersion: lineup.schemaVersion,
    completePregameLineupGames: lineup.completeLineupGames,
  },
  custody: {
    source: history.source,
    gamesWithBatterLines: history.gamesWithBatterLines,
    batterLines: history.batterLines,
    uniqueBatters: uniqueBatters.size,
    positivePlateAppearanceLines: allLines.filter((line) => line.plateAppearances > 0).length,
    zeroPlateAppearanceLines: allLines.filter((line) => line.plateAppearances === 0).length,
    fetchFailures: history.fetchFailures.length,
    teamAggregateReconciliationFailures: history.teamAggregateReconciliationFailures,
    batterHistoryDigest: history.batterHistoryDigest,
    boxscoreProvenanceDigest: history.boxscoreProvenanceDigest,
  },
  pregameCrosslinkDiagnostics: {
    completePregameLineupGames,
    completePregameLineupSlots,
    slotsFoundInOfficialBatterLines,
    slotMatchRate: completePregameLineupSlots ? slotsFoundInOfficialBatterLines / completePregameLineupSlots : null,
    slotsWithPositivePlateAppearances,
    positivePlateAppearanceRate: completePregameLineupSlots ? slotsWithPositivePlateAppearances / completePregameLineupSlots : null,
    missingPregameSlotCount: missingPregameSlots.length,
    missingPregameSlots,
    gateApplied: false,
    reasonNoGate: "T-minus-5 pregame lineup participation may legitimately change after a late scratch; preserve as later market-eligibility evidence rather than mutate outcome custody.",
  },
  targetCustody: {
    direct: ["hits", "totalBases", "rbi", "runs", "doubles", "triples", "baseOnBalls", "strikeOuts", "stolenBases"],
    deterministicDerived: {
      singlesDerived: "hits-doubles-triples-homeRuns",
      hitsRunsRbisDerived: "hits+runs+rbi",
    },
  },
  artifacts: [historyArtifact],
  policy: {
    researchOnly: true,
    modelTrainingUsed: false,
    featureSearchUsed: false,
    thresholdSearchUsed: false,
    historicalPropPricesUsed: false,
    positiveEvClaimAllowed: false,
    productionMarketRegistryChanged: false,
    liveLookupAuthorizationChanged: false,
    stakeChanged: false,
    betEliteAllowed: false,
    automaticBetPlacementAllowed: false,
    realFinancialExposure: 0,
  },
};
await writeJson(path.join(outputRoot, "batter-history-manifest.json"), manifest);
console.log(JSON.stringify({
  ok: true,
  seasonLabel,
  officialFinalGames: official.officialFinalGames,
  batterLines: history.batterLines,
  uniqueBatters: uniqueBatters.size,
  pregameSlotMatchRate: manifest.pregameCrosslinkDiagnostics.slotMatchRate,
  historyDigest: history.batterHistoryDigest,
  researchOnly: true,
}, null, 2));
