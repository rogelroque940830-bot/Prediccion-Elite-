#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  V66_BULLPEN_FEATURE_NAMES,
  V66_QUALITY_FEATURE_NAMES,
  buildHorizonExposureFeatures,
  buildQualityHorizonInteractions,
  buildV66BullpenFeatures,
  type BullpenProfile,
} from "../server/mlb-full-modular-mechanistic-feature-builder";

type Row = Record<string, unknown>;

const EXPECTED_ROWS = 11407;
const EXPECTED_BY_SEASON: Record<string, number> = {
  "2022": 2398,
  "2023": 2399,
  "2024": 2406,
  "2025": 2423,
  "2026_YTD": 1781,
};
const TOLERANCE = 1e-12;
const FORBIDDEN = ["outcome", "homeruns", "awayruns", "final_", "winner", "homewin", "target", "settlement", "result"];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0 || i + 1 >= args.length) throw new Error(`MISSING_ARG:${name}`);
    return args[i + 1];
  };
  return { custody: get("--custody"), out: get("--out") };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(row: Row, name: string): number | null {
  const value = row[name];
  return finite(value) ? value : null;
}

function requiredNumber(row: Row, name: string): number {
  const value = row[name];
  if (!finite(value)) throw new Error(`REQUIRED_NUMERIC_FIELD_MISSING:${name}`);
  return value;
}

function compareValue(args: {
  row: Row;
  expected: unknown;
  actual: unknown;
  field: string;
  identity: string;
  state: ParityState;
}) {
  const e = finite(args.expected) ? args.expected : null;
  const a = finite(args.actual) ? args.actual : null;
  args.state.comparisons += 1;
  args.state.comparisonsByField[args.field] = (args.state.comparisonsByField[args.field] ?? 0) + 1;
  if (e === null || a === null) {
    if (e !== a) {
      args.state.missingnessMismatches += 1;
      args.state.mismatchesByField[args.field] = (args.state.mismatchesByField[args.field] ?? 0) + 1;
      if (args.state.examples.length < 20) {
        args.state.examples.push({ identity: args.identity, field: args.field, expected: e, actual: a, kind: "MISSINGNESS" });
      }
    }
    return;
  }
  const diff = Math.abs(e - a);
  args.state.maximumAbsoluteDifference = Math.max(args.state.maximumAbsoluteDifference, diff);
  if (diff > TOLERANCE) {
    args.state.numericMismatches += 1;
    args.state.mismatchesByField[args.field] = (args.state.mismatchesByField[args.field] ?? 0) + 1;
    if (args.state.examples.length < 20) {
      args.state.examples.push({ identity: args.identity, field: args.field, expected: e, actual: a, diff, kind: "NUMERIC" });
    }
  }
}

interface ParityState {
  comparisons: number;
  comparisonsByField: Record<string, number>;
  mismatchesByField: Record<string, number>;
  numericMismatches: number;
  missingnessMismatches: number;
  maximumAbsoluteDifference: number;
  examples: Array<Record<string, unknown>>;
}

function main() {
  const { custody, out } = parseArgs();
  const text = gunzipSync(readFileSync(custody)).toString("utf8");
  const rows: Row[] = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (rows.length !== EXPECTED_ROWS) throw new Error(`V66_ROW_COUNT_DRIFT:${rows.length}`);

  const seasonCounts: Record<string, number> = {};
  const identities = new Set<string>();
  const state: ParityState = {
    comparisons: 0,
    comparisonsByField: {},
    mismatchesByField: {},
    numericMismatches: 0,
    missingnessMismatches: 0,
    maximumAbsoluteDifference: 0,
    examples: [],
  };

  const derivedFields = new Set<string>();
  for (const row of rows) {
    const season = String(row.season ?? "");
    const officialDate = String(row.officialDate ?? "");
    const gamePk = Number(row.gamePk);
    if (!season || !/^\d{4}-\d{2}-\d{2}$/.test(officialDate) || !Number.isInteger(gamePk) || gamePk <= 0) {
      throw new Error(`V66_IDENTITY_INVALID:${season}:${officialDate}:${String(row.gamePk)}`);
    }
    const identity = `${season}|${officialDate}|${gamePk}`;
    if (identities.has(identity)) throw new Error(`V66_IDENTITY_DUPLICATE:${identity}`);
    identities.add(identity);
    seasonCounts[season] = (seasonCounts[season] ?? 0) + 1;

    for (const key of Object.keys(row)) {
      const low = key.toLowerCase();
      if (FORBIDDEN.some((token) => low.includes(token))) throw new Error(`V66_FORBIDDEN_OUTCOME_FIELD:${key}`);
    }

    const exposure = buildHorizonExposureFeatures(
      nullableNumber(row, "home_expected_starter_outs"),
      nullableNumber(row, "away_expected_starter_outs"),
    );
    for (const [field, actual] of Object.entries(exposure)) {
      if (field === "home_expected_starter_outs" || field === "away_expected_starter_outs") continue;
      derivedFields.add(field);
      compareValue({ row, expected: row[field], actual, field, identity, state });
    }

    const quality = Object.fromEntries(
      V66_QUALITY_FEATURE_NAMES.map((name) => [name, nullableNumber(row, name)]),
    ) as Record<(typeof V66_QUALITY_FEATURE_NAMES)[number], number | null>;
    const qualityInteractions = buildQualityHorizonInteractions(quality, exposure);
    for (const [field, actual] of Object.entries(qualityInteractions)) {
      derivedFields.add(field);
      compareValue({ row, expected: row[field], actual, field, identity, state });
    }

    const profile = (side: "home" | "away"): BullpenProfile => ({
      bullpen_pitches_1d: requiredNumber(row, `${side}_bullpen_pitches_1d`),
      bullpen_pitches_3d: requiredNumber(row, `${side}_bullpen_pitches_3d`),
      bullpen_core3_pitches_2d: requiredNumber(row, `${side}_bullpen_core3_pitches_2d`),
      bullpen_b2b_arms: requiredNumber(row, `${side}_bullpen_b2b_arms`),
      priorGames30d: requiredNumber(row, `${side}_bullpen_prior_games_30d`),
      relieverPool: requiredNumber(row, `${side}_bullpen_reliever_pool_30d`),
    });
    const bullpen = buildV66BullpenFeatures({
      homeProfile: profile("home"),
      awayProfile: profile("away"),
      exposure,
    });
    for (const [field, actual] of Object.entries(bullpen)) {
      derivedFields.add(field);
      compareValue({ row, expected: row[field], actual, field, identity, state });
    }
  }

  if (JSON.stringify(seasonCounts) !== JSON.stringify(EXPECTED_BY_SEASON)) {
    throw new Error(`V66_SEASON_COUNT_DRIFT:${JSON.stringify(seasonCounts)}`);
  }
  const totalMismatches = state.numericMismatches + state.missingnessMismatches;
  const report = {
    schemaVersion: "courtedge-mlb-router-input-v66-derived-parity.v1",
    classification: totalMismatches === 0 ? "V66_DERIVED_RUNTIME_PARITY_PASS" : "V66_DERIVED_RUNTIME_PARITY_FAIL",
    authority: {
      workflowRunId: 31962659793,
      workflowHeadSha: "1e5b68801181f900ee0531eee9e392da02599006",
      artifactId: 9267784926,
      pregameCustodyRawSha256: "sha256:1d7a7f35226186b0043606db3762c0e612ea90d6bca71fb4f1616a0dc493add2",
    },
    rows: rows.length,
    rowsBySeason: seasonCounts,
    uniqueIdentityRows: identities.size,
    tolerance: TOLERANCE,
    derivedFeatureCount: derivedFields.size,
    derivedFeatures: [...derivedFields].sort(),
    comparisons: state.comparisons,
    comparisonsByField: state.comparisonsByField,
    maximumAbsoluteDifference: state.maximumAbsoluteDifference,
    numericMismatches: state.numericMismatches,
    missingnessMismatches: state.missingnessMismatches,
    totalMismatches,
    mismatchesByField: state.mismatchesByField,
    mismatchExamples: state.examples,
    sameDateOutcomeInputsUsed: false,
    targetGameOutcomeInputsUsed: false,
    productionChanged: false,
    realFinancialExposure: 0,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("MLB_ROUTER_INPUT_V66_DERIVED_PARITY_REPORT_BEGIN");
  console.log(JSON.stringify(report));
  console.log("MLB_ROUTER_INPUT_V66_DERIVED_PARITY_REPORT_END");
  if (totalMismatches !== 0) throw new Error(`V66_DERIVED_RUNTIME_PARITY_FAILED:${totalMismatches}`);
}

main();
