#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildMlbFrozenMatchupLiveFeatures,
  type MlbFrozenHandSplitGameAggregate,
  type MlbFrozenPitchmixGameAggregate,
} from "../server/mlb-frozen-matchup-live-feature-builder";

const EVAL = ["2024", "2025", "2026_YTD"] as const;
const ALL_PITCH = ["2023", "2024", "2025", "2026_YTD"] as const;
const TOL = 1e-12;

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`MISSING_ARG:${name}`);
  return process.argv[index + 1];
}

function load(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, value))));
}

function frozenAPlusProb(features: Record<string, unknown>, model: any): number {
  let z = Number(model.intercept);
  for (const spec of model.features) {
    const raw = features[spec.name];
    const x = finite(raw) ? raw : Number(spec.medianImpute);
    z += Number(spec.coef) * ((x - Number(spec.mean)) / Number(spec.scale));
  }
  return sigmoid(z);
}

function frozenV7Prob(features: Record<string, unknown>, model: any): number {
  let z = Number(model.intercept);
  for (let index = 0; index < model.features.length; index += 1) {
    const name = model.features[index];
    const raw = features[name];
    const x = finite(raw) ? raw : Number(model.medianImpute[index]);
    z += Number(model.coef[index]) * ((x - Number(model.mean[index])) / Number(model.scale[index]));
  }
  return sigmoid(z);
}

function isPremiumA(features: Record<string, unknown>, contract: any): boolean {
  return contract.premiumA.all.every((rule: any) =>
    finite(features[rule.feature]) && Number(features[rule.feature]) >= Number(rule.threshold),
  );
}

function isAPlus(features: Record<string, unknown>, contract: any): boolean {
  if (!isPremiumA(features, contract)) return false;
  const spec = contract.aPlusConsensus;
  return frozenAPlusProb(features, spec.models.ML_C4_2022_FROZEN) >= Number(spec.thresholds.c4PHomeGTE)
    && frozenAPlusProb(features, spec.models.ML_FULL13_2022_FROZEN) >= Number(spec.thresholds.full13PHomeGTE);
}

function assertClose(actual: number | null, expected: unknown, label: string): void {
  if (!finite(expected)) {
    if (actual !== null) throw new Error(`${label}:EXPECTED_NULL:ACTUAL=${actual}`);
    return;
  }
  if (actual === null || !Number.isFinite(actual) || Math.abs(actual - expected) > TOL) {
    throw new Error(`${label}:EXPECTED=${expected}:ACTUAL=${actual}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}:EXPECTED=${String(expected)}:ACTUAL=${String(actual)}`);
}

interface FrozenTargetRow {
  season: (typeof EVAL)[number];
  date: string;
  gamePk: number;
  homeTeamId: number;
  awayTeamId: number;
  homeStarterId: number;
  awayStarterId: number;
  premiumA: boolean;
  aPlus: boolean;
  f5Consensus: boolean;
  fgHome: number;
  f5Home: number | null;
}

interface ParityTargetRow extends FrozenTargetRow {
  eligible: boolean;
  contactAdv: number | null;
  whiffAdv: number | null;
  tbpaAdv: number | null;
  hrpaAdv: number | null;
  positiveCount: number;
}

function basicStats(rows: readonly ParityTargetRow[], target: "fgHome" | "f5Home") {
  const decisive = rows.filter((row) => row[target] !== null);
  const wins = decisive.reduce((sum, row) => sum + Number(row[target]), 0);
  const bySeason: Record<string, any> = {};
  for (const season of EVAL) {
    const selected = rows.filter((row) => row.season === season);
    const seasonDecisive = selected.filter((row) => row[target] !== null);
    const seasonWins = seasonDecisive.reduce((sum, row) => sum + Number(row[target]), 0);
    bySeason[season] = {
      selectedRows: selected.length,
      decisiveRows: seasonDecisive.length,
      pushes: selected.length - seasonDecisive.length,
      wins: seasonWins,
      losses: seasonDecisive.length - seasonWins,
    };
  }
  return {
    selectedRows: rows.length,
    decisiveRows: decisive.length,
    pushes: rows.length - decisive.length,
    wins,
    losses: decisive.length - wins,
    bySeason,
  };
}

function assertStats(actual: ReturnType<typeof basicStats>, expected: any, label: string): void {
  for (const key of ["selectedRows", "decisiveRows", "pushes", "wins", "losses"] as const) {
    assertEqual(actual[key], Number(expected[key]), `${label}:${key}`);
  }
  for (const season of EVAL) {
    for (const key of ["selectedRows", "decisiveRows", "pushes", "wins", "losses"] as const) {
      assertEqual(actual.bySeason[season][key], Number(expected.bySeason[season][key]), `${label}:${season}:${key}`);
    }
  }
}

function main(): void {
  const v3Root = arg("--v3-root");
  const v7 = load(arg("--v7-report"));
  const aContract = load(arg("--a-contract"));
  const v9 = load(arg("--v9-report"));
  const v9SplitDir = arg("--v9-split-dir");
  const v12 = load(arg("--v12-report"));
  const v12PitchDir = arg("--v12-pitch-dir");
  const outPath = arg("--out");

  if (v9.schemaVersion !== "courtedge-p0-step12v9-rolling-platoon-performance.v1") throw new Error("V9_REPORT_SCHEMA_INVALID");
  if (v12.schemaVersion !== "courtedge-p0-step12v12-pitchmix-lineup-matchup.v1") throw new Error("V12_REPORT_SCHEMA_INVALID");
  if (aContract.schemaVersion !== "courtedge-p0-step12v6-a-team5-rest-cross-anatomy-contract.v1") throw new Error("A_CONTRACT_SCHEMA_INVALID");

  const handGames: MlbFrozenHandSplitGameAggregate[] = [];
  for (const season of EVAL) {
    const pack = load(join(v9SplitDir, `hand-splits-${season}.json`));
    if (pack.schemaVersion !== "courtedge-p0-step12v9-game-team-hand-aggregates.v1" || pack.season !== season || pack.failures?.length) {
      throw new Error(`V9_HAND_PACK_INVALID:${season}`);
    }
    handGames.push(...pack.games);
  }

  const v9Features = v9.features as any[];
  assertEqual(v9Features.length, 268, "V9_FEATURE_COUNT");
  let v9NumericComparisons = 0;
  for (const row of v9Features) {
    const assessment = buildMlbFrozenMatchupLiveFeatures({
      gamePk: Number(row.gamePk),
      officialDate: row.officialDate,
      homeTeamId: Number(row.homeTeamId),
      awayTeamId: Number(row.awayTeamId),
      homeStarterId: Number(row.homePitcherId),
      awayStarterId: Number(row.awayPitcherId),
      homeStarterHand: row.homeStarterHand,
      awayStarterHand: row.awayStarterHand,
      handSplitGames: handGames,
      pitchmixGames: [],
    });
    assertEqual(assessment.slg.eligible, Boolean(row.primaryEligible), `V9:${row.gamePk}:eligible`);
    assertEqual(assessment.slg.homePriorPaRequiredHand, Number(row.homePriorPaRequiredHand), `V9:${row.gamePk}:homePA`);
    assertEqual(assessment.slg.awayPriorPaRequiredHand, Number(row.awayPriorPaRequiredHand), `V9:${row.gamePk}:awayPA`);
    assertEqual(assessment.slg.minimumPriorPa, Number(row.minimumPriorPa), `V9:${row.gamePk}:minPA`);
    assertClose(assessment.slg.adv, row.slg_adv, `V9:${row.gamePk}:slgAdv`);
    if (finite(row.slg_adv)) v9NumericComparisons += 1;
  }

  const pitchGames: MlbFrozenPitchmixGameAggregate[] = [];
  for (const season of ALL_PITCH) {
    const pack = load(join(v12PitchDir, `pitchmix-${season}.json`));
    if (pack.schemaVersion !== "courtedge-p0-step12v12-game-pitchmix-summary.v1" || pack.season !== season || pack.failures?.length) {
      throw new Error(`V12_PITCH_PACK_INVALID:${season}`);
    }
    pitchGames.push(...pack.games);
  }

  const thresholds = v7.thresholdSelection2023;
  const f5C4 = v7.fitted2022Models.F5_C4;
  const f5Full13 = v7.fitted2022Models.F5_FULL13;
  const targets: FrozenTargetRow[] = [];
  for (const season of EVAL) {
    const table = load(join(v3Root, season, "game-anatomy-feature-table.json"));
    if (table.schemaVersion !== "courtedge-p0-step12v-game-anatomy-feature-table.v1") throw new Error(`V3_TABLE_SCHEMA_INVALID:${season}`);
    for (const row of table.rows) {
      if (!row.t5PregameValid) continue;
      const features = row.features ?? {};
      const homeStarterId = Number(row.t5HomeProbablePitcherId);
      const awayStarterId = Number(row.t5AwayProbablePitcherId);
      if (!Number.isInteger(homeStarterId) || homeStarterId <= 0 || !Number.isInteger(awayStarterId) || awayStarterId <= 0) continue;
      const premiumA = isPremiumA(features, aContract);
      const aPlus = isAPlus(features, aContract);
      const f5Consensus = frozenV7Prob(features, f5C4) >= Number(thresholds.c4)
        && frozenV7Prob(features, f5Full13) >= Number(thresholds.full13);
      const fg = row.outcomes.FULL_GAME;
      const f5 = row.outcomes.FIRST_5;
      targets.push({
        season,
        date: row.officialDate,
        gamePk: Number(row.gamePk),
        homeTeamId: Number(row.homeTeamId),
        awayTeamId: Number(row.awayTeamId),
        homeStarterId,
        awayStarterId,
        premiumA,
        aPlus,
        f5Consensus,
        fgHome: Number(fg.homeRuns > fg.awayRuns),
        f5Home: f5.homeRuns === f5.awayRuns ? null : Number(f5.homeRuns > f5.awayRuns),
      });
    }
  }

  const frozenAPlus = targets.filter((row) => row.aPlus);
  const frozenF5OutsideA = targets.filter((row) => row.f5Consensus && !row.premiumA);
  assertEqual(frozenAPlus.length, Number(v12.populations.A_PLUS_FULL_GAME_HOME.frozenBaseline.selectedRows), "V12:APLUS_FROZEN_COUNT");
  assertEqual(frozenF5OutsideA.length, Number(v12.populations.F5_CONSENSUS_OUTSIDE_A.frozenBaseline.selectedRows), "V12:F5_FROZEN_COUNT");
  assertStats(basicStats(frozenAPlus.map((row) => ({ ...row, eligible: false, contactAdv: null, whiffAdv: null, tbpaAdv: null, hrpaAdv: null, positiveCount: 0 })), "fgHome"), v12.populations.A_PLUS_FULL_GAME_HOME.frozenBaseline, "V12:APLUS_FROZEN_BASELINE");
  assertStats(basicStats(frozenF5OutsideA.map((row) => ({ ...row, eligible: false, contactAdv: null, whiffAdv: null, tbpaAdv: null, hrpaAdv: null, positiveCount: 0 })), "f5Home"), v12.populations.F5_CONSENSUS_OUTSIDE_A.frozenBaseline, "V12:F5_FROZEN_BASELINE");

  let v12NumericComparisons = 0;
  function enrich(row: FrozenTargetRow): ParityTargetRow {
    const assessment = buildMlbFrozenMatchupLiveFeatures({
      gamePk: row.gamePk,
      officialDate: row.date,
      homeTeamId: row.homeTeamId,
      awayTeamId: row.awayTeamId,
      homeStarterId: row.homeStarterId,
      awayStarterId: row.awayStarterId,
      homeStarterHand: "R",
      awayStarterHand: "R",
      handSplitGames: [],
      pitchmixGames: pitchGames,
    });
    for (const value of [assessment.pitchmix.contactAdv, assessment.pitchmix.whiffAdv, assessment.pitchmix.tbpaAdv, assessment.pitchmix.hrpaAdv]) {
      if (value !== null) v12NumericComparisons += 1;
    }
    return {
      ...row,
      eligible: assessment.pitchmix.eligible,
      contactAdv: assessment.pitchmix.contactAdv,
      whiffAdv: assessment.pitchmix.whiffAdv,
      tbpaAdv: assessment.pitchmix.tbpaAdv,
      hrpaAdv: assessment.pitchmix.hrpaAdv,
      positiveCount: assessment.pitchmix.positiveCount,
    };
  }

  const aPlus = frozenAPlus.map(enrich);
  const f5OutsideA = frozenF5OutsideA.map(enrich);
  const eligibleAPlus = aPlus.filter((row) => row.eligible);
  const eligibleF5 = f5OutsideA.filter((row) => row.eligible);
  assertStats(basicStats(eligibleAPlus, "fgHome"), v12.populations.A_PLUS_FULL_GAME_HOME.eligibleBaseline, "V12:APLUS_ELIGIBLE_BASELINE");
  assertStats(basicStats(eligibleF5, "f5Home"), v12.populations.F5_CONSENSUS_OUTSIDE_A.eligibleBaseline, "V12:F5_ELIGIBLE_BASELINE");

  const cohorts: Record<string, (row: ParityTargetRow) => boolean> = {
    CONTACT_POS: (row) => row.eligible && row.contactAdv !== null && row.contactAdv > 0,
    WHIFF_POS: (row) => row.eligible && row.whiffAdv !== null && row.whiffAdv > 0,
    TBPA_POS: (row) => row.eligible && row.tbpaAdv !== null && row.tbpaAdv > 0,
    HRPA_POS: (row) => row.eligible && row.hrpaAdv !== null && row.hrpaAdv > 0,
    AT_LEAST_2_OF_4: (row) => row.eligible && row.positiveCount >= 2,
    AT_LEAST_3_OF_4: (row) => row.eligible && row.positiveCount >= 3,
  };
  for (const [name, predicate] of Object.entries(cohorts)) {
    assertStats(
      basicStats(aPlus.filter(predicate), "fgHome"),
      v12.signCohorts.A_PLUS_FULL_GAME_HOME[name],
      `V12:APLUS:${name}`,
    );
    assertStats(
      basicStats(f5OutsideA.filter(predicate), "f5Home"),
      v12.signCohorts.F5_CONSENSUS_OUTSIDE_A[name],
      `V12:F5:${name}`,
    );
  }

  const report = {
    schemaVersion: "courtedge-p0-v17-frozen-matchup-parity-gate.v1",
    status: "PASS",
    tolerance: TOL,
    v9: {
      frozenRows: v9Features.length,
      numericSlgComparisons: v9NumericComparisons,
      eligibilityMismatches: 0,
      priorPaMismatches: 0,
      numericMismatches: 0,
    },
    v12: {
      aPlusFrozenRows: aPlus.length,
      aPlusEligibleRows: eligibleAPlus.length,
      f5OutsideAFrozenRows: f5OutsideA.length,
      f5OutsideAEligibleRows: eligibleF5.length,
      numericMetricValuesObserved: v12NumericComparisons,
      baselineMismatches: 0,
      signCohortMismatches: 0,
      predeclaredCohortsComparedPerPopulation: Object.keys(cohorts).length,
    },
    policy: {
      thresholdSearchPerformed: false,
      featureSearchPerformed: false,
      outcomeBasedRetuningPerformed: false,
      liveFilterChangeAllowed: false,
      prospective11cStillRequired: true,
    },
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main();
