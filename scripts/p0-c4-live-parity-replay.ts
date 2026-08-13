import fs from "node:fs";
import path from "node:path";
import { buildC4LiveFeatures, C4_FEATURE_NAMES, type C4FeatureName } from "../server/mlb-c4-live-feature-builder";
import { auditValid, emptyReplayState, mapPush, probableKnown, updateReplayStateForGame, type Json } from "./p0-c4-live-parity-state";

function load(file: string): Json { return JSON.parse(fs.readFileSync(file, "utf8")); }
function finiteOrNull(v: unknown): number | null { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`MISSING_ARG:${name}`);
  return process.argv[i + 1];
}

function replaySeason(root: string, season: string, contract: Json) {
  const base = path.join(root, season);
  const dataset = load(path.join(base, "cohort", "dataset.json"));
  const starters = load(path.join(base, "cohort", "starting-pitcher-history.json"));
  const lineupsJson = load(path.join(base, "cohort", "pregame-lineup-history.json"));
  const auditJson = load(path.join(base, "t5-audit", "t5-starter-identity-audit.json"));
  const canonical = load(path.join(base, "game-anatomy-feature-table.json"));
  if (canonical.schemaVersion !== contract.canonicalSource.featureSchema) throw new Error(`C4_CANONICAL_SCHEMA_DRIFT:${season}`);

  const full = dataset.observations.filter((r: Json) => r.horizon === "FULL_GAME");
  const byDate = new Map<string, Json[]>();
  for (const row of full) mapPush(byDate, String(row.officialDate), row);
  const starterMap = new Map<number, Json>(starters.games.map((g: Json) => [Number(g.gamePk), g]));
  const lineupMap = new Map<number, Json>(lineupsJson.snapshots.map((g: Json) => [Number(g.gamePk), g]));
  const auditMap = new Map<number, Json>(auditJson.rows.map((g: Json) => [Number(g.gamePk), g]));
  const canonicalMap = new Map<number, Json>(canonical.rows.map((g: Json) => [Number(g.gamePk), g]));
  const state = emptyReplayState();
  const featureStats = Object.fromEntries(C4_FEATURE_NAMES.map((f) => [f, { checks: 0, numeric: 0, nullMatches: 0, mismatches: 0, maxAbsDiff: 0 }])) as Record<C4FeatureName, any>;
  const mismatches: Json[] = [];
  let rowsCompared = 0;

  for (const officialDate of [...byDate.keys()].sort()) {
    const games = [...(byDate.get(officialDate) ?? [])].sort((a, b) => Number(a.gamePk) - Number(b.gamePk));
    for (const game of games) {
      const gamePk = Number(game.gamePk), h = Number(game.homeTeamId), a = Number(game.awayTeamId);
      const audit = auditMap.get(gamePk), lineup = lineupMap.get(gamePk), expectedRow = canonicalMap.get(gamePk);
      if (!expectedRow) throw new Error(`C4_CANONICAL_ROW_MISSING:${season}:${gamePk}`);
      const probables = probableKnown(audit), valid = auditValid(audit), complete = Boolean(lineup?.complete);
      const hp = probables ? Number(audit?.homeProbablePitcherId) : null;
      const ap = probables ? Number(audit?.awayProbablePitcherId) : null;
      const got = buildC4LiveFeatures({
        officialDate, gamePk, homeTeamId: h, awayTeamId: a,
        homeTeamHistory: state.teamHistory.get(h) ?? [], awayTeamHistory: state.teamHistory.get(a) ?? [],
        leagueStarterHistory: state.leagueStarterHistory,
        homeStarterHistory: hp === null ? [] : (state.pitcherHistory.get(hp) ?? []),
        awayStarterHistory: ap === null ? [] : (state.pitcherHistory.get(ap) ?? []),
        homeStarterId: hp, awayStarterId: ap,
        homePriorLineups: state.priorLineups.get(h) ?? [], awayPriorLineups: state.priorLineups.get(a) ?? [],
        homeBattingOrder: valid && complete ? lineup.homeBattingOrder.map(Number) : null,
        awayBattingOrder: valid && complete ? lineup.awayBattingOrder.map(Number) : null,
      }).featureVector;

      for (const feature of C4_FEATURE_NAMES) {
        const expected = finiteOrNull(expectedRow.features?.[feature]), actual = finiteOrNull(got[feature]), stat = featureStats[feature];
        stat.checks++;
        if (expected === null && actual === null) { stat.nullMatches++; continue; }
        if (expected !== null && actual !== null) {
          stat.numeric++;
          const diff = Math.abs(expected - actual); stat.maxAbsDiff = Math.max(stat.maxAbsDiff, diff);
          if (diff <= Number(contract.parityGate.maximumNumericAbsoluteDifference)) continue;
        }
        stat.mismatches++;
        if (mismatches.length < 50) mismatches.push({ season, officialDate, gamePk, feature, expected, actual });
      }
      rowsCompared++;
    }
    for (const game of games) updateReplayStateForGame(state, game, starterMap.get(Number(game.gamePk)), lineupMap.get(Number(game.gamePk)), auditMap.get(Number(game.gamePk)));
  }
  return { season, rowsCompared, featureStats, mismatches };
}

const root = arg("--root"), contractFile = arg("--contract"), out = arg("--out"), contract = load(contractFile);
if (JSON.stringify(contract.features) !== JSON.stringify([...C4_FEATURE_NAMES])) throw new Error("C4_CONTRACT_FEATURE_SET_DRIFT");
if (contract.formulaLock.starterKbbShrinkagePriorBattersFaced !== 72) throw new Error("C4_CONTRACT_SHRINKAGE_DRIFT");
if (contract.formulaLock.sameDateHistoryAllowed !== false || contract.formulaLock.seasonHistoryReset !== true) throw new Error("C4_CONTRACT_TEMPORAL_DRIFT");
const reports = (contract.parityGate.seasons as string[]).map((season) => replaySeason(root, season, contract));
const rowsCompared = reports.reduce((s, r) => s + r.rowsCompared, 0);
const mismatchCount = reports.reduce((s, r) => s + Object.values(r.featureStats).reduce((x: number, stat: any) => x + stat.mismatches, 0), 0);
const featureTotals = Object.fromEntries(C4_FEATURE_NAMES.map((feature) => [feature, {
  checks: reports.reduce((s, r) => s + r.featureStats[feature].checks, 0),
  numeric: reports.reduce((s, r) => s + r.featureStats[feature].numeric, 0),
  nullMatches: reports.reduce((s, r) => s + r.featureStats[feature].nullMatches, 0),
  mismatches: reports.reduce((s, r) => s + r.featureStats[feature].mismatches, 0),
  maxAbsDiff: Math.max(...reports.map((r) => r.featureStats[feature].maxAbsDiff)),
}]));
const pass = rowsCompared >= Number(contract.parityGate.minimumRowsComparedAcrossAllSeasons) && mismatchCount === 0 && Object.values(featureTotals).every((x: any) => x.mismatches === 0);
const report = { schemaVersion: "courtedge-p0-c4-live-parity-report.v1", classification: pass ? "C4_LIVE_PARITY_GATE_PASS" : "C4_LIVE_PARITY_GATE_FAIL", canonicalSource: contract.canonicalSource, rowsCompared, featureChecks: rowsCompared * 4, mismatchCount, featureTotals, bySeason: reports.map(({ season, rowsCompared, featureStats }) => ({ season, rowsCompared, featureStats })), firstMismatches: reports.flatMap((r) => r.mismatches).slice(0, 50), policy: { fourOfFourRequired: true, sameDateHistoryAllowed: false, seasonHistoryReset: true, priceInputsUsed: false, v16LiveProbabilityUnlocked: pass, betEliteProduced: false, automaticBetPlacement: false } };
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ pass, rowsCompared, mismatchCount, featureTotals }, null, 2));
if (!pass) process.exitCode = 1;
