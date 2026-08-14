import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import {
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_BROTLI_BASE64,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
} from "./mlb-frozen-matchup-canonical-seed.generated";
import type {
  MlbFrozenHandSplitGameAggregate,
  MlbFrozenPitchmixGameAggregate,
  MlbPitchFamily,
  MlbPitcherHand,
} from "./mlb-frozen-matchup-live-feature-builder";

export {
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
};

export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_SCHEMA =
  "courtedge-p0-v17-frozen-matchup-canonical-seed.v1" as const;

interface PackedSeed {
  schemaVersion: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SCHEMA;
  seedThroughDate: string;
  supportedTargetDateGte: string;
  supportedTargetDateLte: string;
  supportRationale: string;
  sourceCustody: {
    v9_2026_YTD: { workflowRunId: number; artifactId: number; artifactDigest: string };
    v12_2025: { workflowRunId: number; artifactId: number; artifactDigest: string };
    v12_2026_YTD: { workflowRunId: number; artifactId: number; artifactDigest: string };
  };
  pitchmix2025TailByDate: Array<[string, number[][], Array<[number, string, ...number[]]>]>;
  pitchmix2026CumulativeThroughSeed: [number[][], Array<[number, string, ...number[]]>];
  handSplits2026CumulativeThroughSeed: Array<[number, string, number, number, number]>;
  policy: {
    priceIndependent: boolean;
    sameDateOutcomeLeakageAllowed: boolean;
    seedIsFrozenHistoricalAggregateOnly: boolean;
  };
}

export interface MlbFrozenMatchupCanonicalSeed {
  schemaVersion: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SCHEMA;
  rawSha256: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256;
  seedThroughDate: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE;
  supportedTargetDateGte: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE;
  supportedTargetDateLte: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE;
  supportRationale: string;
  pitchmixGames: readonly MlbFrozenPitchmixGameAggregate[];
  handSplitGames: readonly MlbFrozenHandSplitGameAggregate[];
  sourceCustody: Readonly<PackedSeed["sourceCustody"]>;
  policy: {
    priceIndependent: true;
    sameDateOutcomeLeakageAllowed: false;
    seedIsFrozenHistoricalAggregateOnly: true;
    syntheticAggregateGameIdentities: true;
  };
}

let cached: Readonly<MlbFrozenMatchupCanonicalSeed> | null = null;

function finiteNonNegative(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`MLB_FROZEN_MATCHUP_SEED_NUMERIC_INVALID:${label}`);
  return n;
}

function positiveInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`MLB_FROZEN_MATCHUP_SEED_ID_INVALID:${label}`);
  return n;
}

function pitchFamily(value: unknown): MlbPitchFamily {
  if (value === "FASTBALL" || value === "BREAKING" || value === "OFFSPEED") return value;
  throw new Error(`MLB_FROZEN_MATCHUP_SEED_PITCH_FAMILY_INVALID:${String(value)}`);
}

function pitcherHand(value: unknown): MlbPitcherHand {
  if (value === "R" || value === "L") return value;
  throw new Error(`MLB_FROZEN_MATCHUP_SEED_PITCHER_HAND_INVALID:${String(value)}`);
}

function unpackPitchmix(
  gamePk: number,
  officialDate: string,
  pitchers: number[][],
  teams: Array<[number, string, ...number[]]>,
): MlbFrozenPitchmixGameAggregate {
  return {
    gamePk,
    officialDate,
    pitcherTotals: pitchers.map((row, index) => {
      if (row.length !== 6) throw new Error(`MLB_FROZEN_MATCHUP_SEED_PITCHER_WIDTH:${officialDate}:${index}`);
      return {
        pitcherId: positiveInt(row[0], `pitcher:${officialDate}:${index}`),
        allPitches: finiteNonNegative(row[1], `allPitches:${officialDate}:${index}`),
        categorizedPitches: finiteNonNegative(row[2], `categorizedPitches:${officialDate}:${index}`),
        FASTBALL: finiteNonNegative(row[3], `FASTBALL:${officialDate}:${index}`),
        BREAKING: finiteNonNegative(row[4], `BREAKING:${officialDate}:${index}`),
        OFFSPEED: finiteNonNegative(row[5], `OFFSPEED:${officialDate}:${index}`),
      };
    }),
    teamPitchFamilyTotals: teams.map((row, index) => {
      if (row.length !== 8) throw new Error(`MLB_FROZEN_MATCHUP_SEED_TEAM_PITCH_WIDTH:${officialDate}:${index}`);
      return {
        teamId: positiveInt(row[0], `team:${officialDate}:${index}`),
        pitchFamily: pitchFamily(row[1]),
        swings: finiteNonNegative(row[2], `swings:${officialDate}:${index}`),
        whiffs: finiteNonNegative(row[3], `whiffs:${officialDate}:${index}`),
        contacts: finiteNonNegative(row[4], `contacts:${officialDate}:${index}`),
        terminalPa: finiteNonNegative(row[5], `terminalPa:${officialDate}:${index}`),
        tb: finiteNonNegative(row[6], `tb:${officialDate}:${index}`),
        hr: finiteNonNegative(row[7], `hr:${officialDate}:${index}`),
      };
    }),
  };
}

function decodePackedSeed(): PackedSeed {
  const compressed = Buffer.from(MLB_FROZEN_MATCHUP_CANONICAL_SEED_BROTLI_BASE64, "base64");
  const raw = brotliDecompressSync(compressed);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256) {
    throw new Error(`MLB_FROZEN_MATCHUP_SEED_DIGEST_MISMATCH:${digest}`);
  }
  const parsed = JSON.parse(raw.toString("utf8")) as PackedSeed;
  if (parsed.schemaVersion !== MLB_FROZEN_MATCHUP_CANONICAL_SEED_SCHEMA) throw new Error("MLB_FROZEN_MATCHUP_SEED_SCHEMA_INVALID");
  if (parsed.seedThroughDate !== MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE) throw new Error("MLB_FROZEN_MATCHUP_SEED_THROUGH_DRIFT");
  if (parsed.supportedTargetDateGte !== MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE) throw new Error("MLB_FROZEN_MATCHUP_SEED_GTE_DRIFT");
  if (parsed.supportedTargetDateLte !== MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE) throw new Error("MLB_FROZEN_MATCHUP_SEED_LTE_DRIFT");
  if (parsed.policy?.priceIndependent !== true || parsed.policy?.sameDateOutcomeLeakageAllowed !== false || parsed.policy?.seedIsFrozenHistoricalAggregateOnly !== true) {
    throw new Error("MLB_FROZEN_MATCHUP_SEED_POLICY_INVALID");
  }
  return parsed;
}

export function loadMlbFrozenMatchupCanonicalSeed(): Readonly<MlbFrozenMatchupCanonicalSeed> {
  if (cached) return cached;
  const packed = decodePackedSeed();
  const pitchmixGames: MlbFrozenPitchmixGameAggregate[] = packed.pitchmix2025TailByDate.map(
    ([officialDate, pitchers, teams], index) => unpackPitchmix(925_000_000 + index, officialDate, pitchers, teams),
  );
  const [pitchers2026, teams2026] = packed.pitchmix2026CumulativeThroughSeed;
  pitchmixGames.push(unpackPitchmix(926_000_000, MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE, pitchers2026, teams2026));

  const handSplitGames: MlbFrozenHandSplitGameAggregate[] = [{
    gamePk: 927_000_000,
    officialDate: MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
    teamHandTotals: packed.handSplits2026CumulativeThroughSeed.map((row, index) => {
      if (row.length !== 5) throw new Error(`MLB_FROZEN_MATCHUP_SEED_TEAM_HAND_WIDTH:${index}`);
      return {
        teamId: positiveInt(row[0], `handTeam:${index}`),
        vsHand: pitcherHand(row[1]),
        pa: finiteNonNegative(row[2], `handPa:${index}`),
        ab: finiteNonNegative(row[3], `handAb:${index}`),
        tb: finiteNonNegative(row[4], `handTb:${index}`),
      };
    }),
  }];

  cached = Object.freeze({
    schemaVersion: MLB_FROZEN_MATCHUP_CANONICAL_SEED_SCHEMA,
    rawSha256: MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
    seedThroughDate: MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
    supportedTargetDateGte: MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
    supportedTargetDateLte: MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
    supportRationale: packed.supportRationale,
    pitchmixGames: Object.freeze(pitchmixGames),
    handSplitGames: Object.freeze(handSplitGames),
    sourceCustody: Object.freeze(packed.sourceCustody),
    policy: Object.freeze({
      priceIndependent: true,
      sameDateOutcomeLeakageAllowed: false,
      seedIsFrozenHistoricalAggregateOnly: true,
      syntheticAggregateGameIdentities: true,
    }),
  });
  return cached;
}

export function resetMlbFrozenMatchupCanonicalSeedForTests(): void {
  cached = null;
}
