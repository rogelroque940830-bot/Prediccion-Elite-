import fs from "node:fs";
import path from "node:path";
import {
  MLB_FULL13_FEATURE_NAMES,
  buildMlbFull13LiveFeatures,
  type MlbFull13FeatureName,
} from "../server/mlb-full13-live-feature-builder";
import {
  auditValid,
  emptyReplayState,
  mapPush,
  probableKnown,
  updateReplayStateForGame,
  type Json,
} from "./p0-full13-live-parity-state";

function load(file: string): Json {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`MISSING_ARG:${name}`);
  return process.argv[index + 1];
}

function replaySeason(root: string, season: string, contract: Json) {
  const base = path.join(root, season);
  const dataset = load(path.join(base, "cohort", "dataset.json"));
  const starters = load(path.join(base, "cohort", "starting-pitcher-history.json"));
  const lineupsJson = load(path.join(base, "cohort", "pregame-lineup-history.json"));
  const auditJson = load(path.join(base, "t5-audit", "t5-starter-identity-audit.json"));
  const canonical = load(path.join(base, "game-anatomy-feature-table.json"));
  if (canonical.schemaVersion !== contract.canonicalSource.featureSchema) {
    throw new Error(`FULL13_CANONICAL_SCHEMA_DRIFT:${season}`);
  }

  const full = dataset.observations.filter((row: Json) => row.horizon === "FULL_GAME");
  const byDate = new Map<string, Json[]>();
  for (const row of full) mapPush(byDate, String(row.officialDate), row);
  const starterMap = new Map<number, Json>(starters.games.map((game: Json) => [Number(game.gamePk), game]));
  const lineupMap = new Map<number, Json>(lineupsJson.snapshots.map((game: Json) => [Number(game.gamePk), game]));
  const auditMap = new Map<number, Json>(auditJson.rows.map((game: Json) => [Number(game.gamePk), game]));
  const canonicalMap = new Map<number, Json>(canonical.rows.map((game: Json) => [Number(game.gamePk), game]));
  const state = emptyReplayState();
  const featureStats = Object.fromEntries(MLB_FULL13_FEATURE_NAMES.map((feature) => [feature, {
    checks: 0,
    numeric: 0,
    nullMatches: 0,
    mismatches: 0,
    maxAbsDiff: 0,
  }])) as Record<MlbFull13FeatureName, any>;
  const mismatches: Json[] = [];
  let rowsCompared = 0;

  for (const officialDate of [...byDate.keys()].sort()) {
    const games = [...(byDate.get(officialDate) ?? [])].sort((left, right) => Number(left.gamePk) - Number(right.gamePk));
    for (const game of games) {
      const gamePk = Number(game.gamePk);
      const homeTeamId = Number(game.homeTeamId);
      const awayTeamId = Number(game.awayTeamId);
      const audit = auditMap.get(gamePk);
      const lineup = lineupMap.get(gamePk);
      const expectedRow = canonicalMap.get(gamePk);
      if (!expectedRow) continue;

      const probables = probableKnown(audit);
      const valid = auditValid(audit);
      const complete = Boolean(lineup?.complete);
      const homePitcherId = probables ? Number(audit?.homeProbablePitcherId) : null;
      const awayPitcherId = probables ? Number(audit?.awayProbablePitcherId) : null;

      const got = buildMlbFull13LiveFeatures({
        officialDate,
        gamePk,
        homeTeamId,
        awayTeamId,
        homeTeamHistory: state.teamHistory.get(homeTeamId) ?? [],
        awayTeamHistory: state.teamHistory.get(awayTeamId) ?? [],
        leagueStarterHistory: state.leagueStarterHistory,
        homeStarterHistory: homePitcherId === null ? [] : (state.pitcherHistory.get(homePitcherId) ?? []),
        awayStarterHistory: awayPitcherId === null ? [] : (state.pitcherHistory.get(awayPitcherId) ?? []),
        homeStarterId: homePitcherId,
        awayStarterId: awayPitcherId,
        homePriorLineups: state.priorLineups.get(homeTeamId) ?? [],
        awayPriorLineups: state.priorLineups.get(awayTeamId) ?? [],
        homeBattingOrder: valid && complete ? lineup.homeBattingOrder.map(Number) : null,
        awayBattingOrder: valid && complete ? lineup.awayBattingOrder.map(Number) : null,
      }).featureVector;

      for (const feature of MLB_FULL13_FEATURE_NAMES) {
        const expected = finiteOrNull(expectedRow.features?.[feature]);
        const actual = finiteOrNull(got[feature]);
        const stat = featureStats[feature];
        stat.checks += 1;
        if (expected === null && actual === null) {
          stat.nullMatches += 1;
          continue;
        }
        if (expected !== null && actual !== null) {
          stat.numeric += 1;
          const diff = Math.abs(expected - actual);
          stat.maxAbsDiff = Math.max(stat.maxAbsDiff, diff);
          if (diff <= Number(contract.parityGate.maximumNumericAbsoluteDifference)) continue;
        }
        stat.mismatches += 1;
        if (mismatches.length < 100) {
          mismatches.push({ season, officialDate, gamePk, feature, expected, actual });
        }
      }
      rowsCompared += 1;
    }

    for (const game of games) {
      updateReplayStateForGame(
        state,
        game,
        starterMap.get(Number(game.gamePk)),
        lineupMap.get(Number(game.gamePk)),
        auditMap.get(Number(game.gamePk)),
      );
    }
  }

  return { season, rowsCompared, featureStats, mismatches };
}

const root = arg("--root");
const contractFile = arg("--contract");
const out = arg("--out");
const contract = load(contractFile);
if (JSON.stringify(contract.features) !== JSON.stringify([...MLB_FULL13_FEATURE_NAMES])) {
  throw new Error("FULL13_CONTRACT_FEATURE_SET_DRIFT");
}
if (contract.formulaLock.starterShrinkagePriorBattersFaced !== 72) {
  throw new Error("FULL13_CONTRACT_SHRINKAGE_DRIFT");
}
if (contract.formulaLock.sameDateHistoryAllowed !== false || contract.formulaLock.seasonHistoryReset !== true) {
  throw new Error("FULL13_CONTRACT_TEMPORAL_DRIFT");
}

const reports = (contract.parityGate.seasons as string[]).map((season) => replaySeason(root, season, contract));
const rowsCompared = reports.reduce((sum, report) => sum + report.rowsCompared, 0);
const mismatchCount = reports.reduce(
  (sum, report) => sum + Object.values(report.featureStats).reduce((inner: number, stat: any) => inner + stat.mismatches, 0),
  0,
);
const featureTotals = Object.fromEntries(MLB_FULL13_FEATURE_NAMES.map((feature) => [feature, {
  checks: reports.reduce((sum, report) => sum + report.featureStats[feature].checks, 0),
  numeric: reports.reduce((sum, report) => sum + report.featureStats[feature].numeric, 0),
  nullMatches: reports.reduce((sum, report) => sum + report.featureStats[feature].nullMatches, 0),
  mismatches: reports.reduce((sum, report) => sum + report.featureStats[feature].mismatches, 0),
  maxAbsDiff: Math.max(...reports.map((report) => report.featureStats[feature].maxAbsDiff)),
}]));
const pass = rowsCompared >= Number(contract.parityGate.minimumRowsComparedAcrossAllSeasons)
  && mismatchCount === 0
  && Object.values(featureTotals).every((stat: any) => stat.mismatches === 0);

const report = {
  schemaVersion: "courtedge-p0-full13-live-parity-report.v1",
  classification: pass ? "FULL13_LIVE_PARITY_GATE_PASS" : "FULL13_LIVE_PARITY_GATE_FAIL",
  canonicalSource: contract.canonicalSource,
  rowsCompared,
  featureChecks: rowsCompared * MLB_FULL13_FEATURE_NAMES.length,
  mismatchCount,
  featureTotals,
  bySeason: reports.map(({ season, rowsCompared: seasonRows, featureStats }) => ({
    season,
    rowsCompared: seasonRows,
    featureStats,
  })),
  firstMismatches: reports.flatMap((seasonReport) => seasonReport.mismatches).slice(0, 100),
  policy: {
    thirteenOfThirteenRequired: true,
    sameDateHistoryAllowed: false,
    seasonHistoryReset: true,
    priceInputsUsed: false,
    frozenClassifierLiveInputUnlocked: pass,
    recommendationChanged: false,
    betEliteProduced: false,
    automaticBetPlacement: false,
  },
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ pass, rowsCompared, mismatchCount, featureTotals }, null, 2));
if (!pass) process.exitCode = 1;
