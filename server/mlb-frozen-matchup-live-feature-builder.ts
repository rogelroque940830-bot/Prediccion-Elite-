export const MLB_FROZEN_MATCHUP_LIVE_FEATURE_BUILDER_VERSION =
  "mlb-frozen-matchup-live-canonical-v1" as const;

export const MLB_FROZEN_MATCHUP_SLG_MIN_PRIOR_PA = 50 as const;
export const MLB_FROZEN_MATCHUP_PITCHMIX_LOOKBACK_DAYS = 365 as const;
export const MLB_FROZEN_MATCHUP_PITCHER_MIN_ALL_PITCHES = 250 as const;
export const MLB_FROZEN_MATCHUP_PITCHER_MIN_CATEGORY_SHARE = 0.90 as const;
export const MLB_FROZEN_MATCHUP_TEAM_MIN_SWINGS_PER_FAMILY = 20 as const;
export const MLB_FROZEN_MATCHUP_TEAM_MIN_TERMINAL_PA_PER_FAMILY = 20 as const;
export const MLB_FROZEN_MATCHUP_MIN_WEIGHTED_COVERAGE_SHARE = 0.80 as const;

export type MlbPitcherHand = "R" | "L";
export type MlbPitchFamily = "FASTBALL" | "BREAKING" | "OFFSPEED";

export interface MlbFrozenHandSplitTeamTotal {
  teamId: number;
  vsHand: MlbPitcherHand;
  pa: number;
  ab: number;
  tb: number;
}

export interface MlbFrozenHandSplitGameAggregate {
  gamePk: number;
  officialDate: string;
  teamHandTotals: MlbFrozenHandSplitTeamTotal[];
}

export interface MlbFrozenPitcherMixTotal {
  pitcherId: number;
  allPitches: number;
  categorizedPitches: number;
  FASTBALL: number;
  BREAKING: number;
  OFFSPEED: number;
}

export interface MlbFrozenTeamPitchFamilyTotal {
  teamId: number;
  pitchFamily: MlbPitchFamily;
  swings: number;
  whiffs: number;
  contacts: number;
  terminalPa: number;
  tb: number;
  hr: number;
}

export interface MlbFrozenPitchmixGameAggregate {
  gamePk: number;
  officialDate: string;
  pitcherTotals: MlbFrozenPitcherMixTotal[];
  teamPitchFamilyTotals: MlbFrozenTeamPitchFamilyTotal[];
}

export interface MlbFrozenMatchupLivePregameInput {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeStarterId: number;
  awayStarterId: number;
  homeStarterHand: MlbPitcherHand;
  awayStarterHand: MlbPitcherHand;
  handSplitGames: readonly MlbFrozenHandSplitGameAggregate[];
  pitchmixGames: readonly MlbFrozenPitchmixGameAggregate[];
}

export interface MlbFrozenMatchupLiveFeatureAssessment {
  builderVersion: typeof MLB_FROZEN_MATCHUP_LIVE_FEATURE_BUILDER_VERSION;
  priceIndependent: true;
  sameDateOutcomeLeakageAllowed: false;
  slg: {
    eligible: boolean;
    adv: number | null;
    homePriorPaRequiredHand: number;
    awayPriorPaRequiredHand: number;
    minimumPriorPa: number;
  };
  pitchmix: {
    eligible: boolean;
    contactAdv: number | null;
    whiffAdv: number | null;
    tbpaAdv: number | null;
    hrpaAdv: number | null;
    positiveCount: number;
  };
  diagnostics: {
    pitchmixWindowStart: string;
    pitchmixPriorGames: number;
    handSplitPriorSeasonGames: number;
    homeStarterAllPitches: number;
    awayStarterAllPitches: number;
    homeStarterCategorizedShare: number;
    awayStarterCategorizedShare: number;
    metricCoverage: Record<"CONTACT" | "WHIFF" | "TBPA" | "HRPA", { home: number; away: number }>;
    eligibilityReasons: string[];
    canonicalV9V12FormulaContractFrozen: true;
  };
}

const FAMILIES: readonly MlbPitchFamily[] = ["FASTBALL", "BREAKING", "OFFSPEED"];

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00.000Z`))) {
    throw new Error(`MLB_FROZEN_MATCHUP_DATE_INVALID:${value}`);
  }
}

function dateMinusDays(value: string, days: number): string {
  assertDate(value);
  return new Date(Date.parse(`${value}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function assertId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`MLB_FROZEN_MATCHUP_${label}_INVALID`);
}

function assertAggregateNumbers(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    const value = Number(row[key]);
    if (!finiteNonNegative(value)) throw new Error(`MLB_FROZEN_MATCHUP_${label}_${key.toUpperCase()}_INVALID`);
  }
}

function blankHand(): { pa: number; ab: number; tb: number } {
  return { pa: 0, ab: 0, tb: 0 };
}

function slgAggregate(
  games: readonly MlbFrozenHandSplitGameAggregate[],
  targetDate: string,
  teamId: number,
  requiredHand: MlbPitcherHand,
): { pa: number; ab: number; tb: number; slg: number | null; priorGames: number } {
  const season = targetDate.slice(0, 4);
  const total = blankHand();
  let priorGames = 0;
  for (const game of games) {
    assertDate(game.officialDate);
    if (game.officialDate >= targetDate || game.officialDate.slice(0, 4) !== season) continue;
    let touched = false;
    for (const row of game.teamHandTotals) {
      if (row.teamId !== teamId || row.vsHand !== requiredHand) continue;
      assertAggregateNumbers(row as unknown as Record<string, unknown>, ["pa", "ab", "tb"], "HAND_SPLIT");
      total.pa += row.pa;
      total.ab += row.ab;
      total.tb += row.tb;
      touched = true;
    }
    if (touched) priorGames += 1;
  }
  return { ...total, slg: total.ab > 0 ? total.tb / total.ab : null, priorGames };
}

function blankPitcher(): MlbFrozenPitcherMixTotal {
  return { pitcherId: 0, allPitches: 0, categorizedPitches: 0, FASTBALL: 0, BREAKING: 0, OFFSPEED: 0 };
}

function pitcherAggregate(
  games: readonly MlbFrozenPitchmixGameAggregate[],
  lowerDate: string,
  targetDate: string,
  pitcherId: number,
): MlbFrozenPitcherMixTotal {
  const out = blankPitcher();
  out.pitcherId = pitcherId;
  for (const game of games) {
    assertDate(game.officialDate);
    if (game.officialDate < lowerDate || game.officialDate >= targetDate) continue;
    for (const row of game.pitcherTotals) {
      if (row.pitcherId !== pitcherId) continue;
      assertAggregateNumbers(
        row as unknown as Record<string, unknown>,
        ["allPitches", "categorizedPitches", "FASTBALL", "BREAKING", "OFFSPEED"],
        "PITCHER_MIX",
      );
      out.allPitches += row.allPitches;
      out.categorizedPitches += row.categorizedPitches;
      out.FASTBALL += row.FASTBALL;
      out.BREAKING += row.BREAKING;
      out.OFFSPEED += row.OFFSPEED;
    }
  }
  return out;
}

function blankFamily(): MlbFrozenTeamPitchFamilyTotal {
  return { teamId: 0, pitchFamily: "FASTBALL", swings: 0, whiffs: 0, contacts: 0, terminalPa: 0, tb: 0, hr: 0 };
}

function blankFamilyMap(): Record<MlbPitchFamily, MlbFrozenTeamPitchFamilyTotal> {
  return {
    FASTBALL: { ...blankFamily(), pitchFamily: "FASTBALL" },
    BREAKING: { ...blankFamily(), pitchFamily: "BREAKING" },
    OFFSPEED: { ...blankFamily(), pitchFamily: "OFFSPEED" },
  };
}

function familyAggregate(
  games: readonly MlbFrozenPitchmixGameAggregate[],
  lowerDate: string,
  targetDate: string,
  teamId: number | null,
): Record<MlbPitchFamily, MlbFrozenTeamPitchFamilyTotal> {
  const out = blankFamilyMap();
  for (const game of games) {
    if (game.officialDate < lowerDate || game.officialDate >= targetDate) continue;
    for (const row of game.teamPitchFamilyTotals) {
      if (teamId !== null && row.teamId !== teamId) continue;
      if (!FAMILIES.includes(row.pitchFamily)) continue;
      assertAggregateNumbers(
        row as unknown as Record<string, unknown>,
        ["swings", "whiffs", "contacts", "terminalPa", "tb", "hr"],
        "TEAM_PITCH_FAMILY",
      );
      const bucket = out[row.pitchFamily];
      bucket.swings += row.swings;
      bucket.whiffs += row.whiffs;
      bucket.contacts += row.contacts;
      bucket.terminalPa += row.terminalPa;
      bucket.tb += row.tb;
      bucket.hr += row.hr;
    }
  }
  return out;
}

function starterMix(row: MlbFrozenPitcherMixTotal): {
  allPitches: number;
  categorizedShare: number;
  mix: Record<MlbPitchFamily, number>;
} {
  const den = row.categorizedPitches;
  return {
    allPitches: row.allPitches,
    categorizedShare: row.allPitches > 0 ? row.categorizedPitches / row.allPitches : 0,
    mix: {
      FASTBALL: den > 0 ? row.FASTBALL / den : 0,
      BREAKING: den > 0 ? row.BREAKING / den : 0,
      OFFSPEED: den > 0 ? row.OFFSPEED / den : 0,
    },
  };
}

type RelativeMetric = "contact" | "whiff" | "tbpa" | "hrpa";

function rate(row: MlbFrozenTeamPitchFamilyTotal, metric: RelativeMetric): number | null {
  if (metric === "contact" || metric === "whiff") {
    if (row.swings < MLB_FROZEN_MATCHUP_TEAM_MIN_SWINGS_PER_FAMILY || row.swings <= 0) return null;
    return (metric === "contact" ? row.contacts : row.whiffs) / row.swings;
  }
  if (row.terminalPa < MLB_FROZEN_MATCHUP_TEAM_MIN_TERMINAL_PA_PER_FAMILY || row.terminalPa <= 0) return null;
  return (metric === "tbpa" ? row.tb : row.hr) / row.terminalPa;
}

function weightedRelative(
  team: Record<MlbPitchFamily, MlbFrozenTeamPitchFamilyTotal>,
  league: Record<MlbPitchFamily, MlbFrozenTeamPitchFamilyTotal>,
  mix: Record<MlbPitchFamily, number>,
  metric: RelativeMetric,
): { value: number | null; coverage: number } {
  let numerator = 0;
  let coverage = 0;
  for (const family of FAMILIES) {
    const teamRate = rate(team[family], metric);
    const leagueRate = rate(league[family], metric);
    if (teamRate === null || leagueRate === null) continue;
    const weight = mix[family];
    numerator += weight * (teamRate - leagueRate);
    coverage += weight;
  }
  return { value: coverage > 0 ? numerator / coverage : null, coverage };
}

export function buildMlbFrozenMatchupLiveFeatures(
  input: MlbFrozenMatchupLivePregameInput,
): MlbFrozenMatchupLiveFeatureAssessment {
  assertId(input.gamePk, "GAME_PK");
  assertDate(input.officialDate);
  assertId(input.homeTeamId, "HOME_TEAM_ID");
  assertId(input.awayTeamId, "AWAY_TEAM_ID");
  assertId(input.homeStarterId, "HOME_STARTER_ID");
  assertId(input.awayStarterId, "AWAY_STARTER_ID");
  if (input.homeStarterHand !== "R" && input.homeStarterHand !== "L") throw new Error("MLB_FROZEN_MATCHUP_HOME_STARTER_HAND_INVALID");
  if (input.awayStarterHand !== "R" && input.awayStarterHand !== "L") throw new Error("MLB_FROZEN_MATCHUP_AWAY_STARTER_HAND_INVALID");

  const homeHand = slgAggregate(input.handSplitGames, input.officialDate, input.homeTeamId, input.awayStarterHand);
  const awayHand = slgAggregate(input.handSplitGames, input.officialDate, input.awayTeamId, input.homeStarterHand);
  const minimumPriorPa = Math.min(homeHand.pa, awayHand.pa);
  const slgEligible = homeHand.slg !== null && awayHand.slg !== null && minimumPriorPa >= MLB_FROZEN_MATCHUP_SLG_MIN_PRIOR_PA;
  const slgAdv = homeHand.slg !== null && awayHand.slg !== null ? homeHand.slg - awayHand.slg : null;

  const lowerDate = dateMinusDays(input.officialDate, MLB_FROZEN_MATCHUP_PITCHMIX_LOOKBACK_DAYS);
  const homePitcher = pitcherAggregate(input.pitchmixGames, lowerDate, input.officialDate, input.homeStarterId);
  const awayPitcher = pitcherAggregate(input.pitchmixGames, lowerDate, input.officialDate, input.awayStarterId);
  const homeMix = starterMix(homePitcher);
  const awayMix = starterMix(awayPitcher);
  const homeTeam = familyAggregate(input.pitchmixGames, lowerDate, input.officialDate, input.homeTeamId);
  const awayTeam = familyAggregate(input.pitchmixGames, lowerDate, input.officialDate, input.awayTeamId);
  const league = familyAggregate(input.pitchmixGames, lowerDate, input.officialDate, null);

  const hContact = weightedRelative(homeTeam, league, awayMix.mix, "contact");
  const aContact = weightedRelative(awayTeam, league, homeMix.mix, "contact");
  const hWhiff = weightedRelative(homeTeam, league, awayMix.mix, "whiff");
  const aWhiff = weightedRelative(awayTeam, league, homeMix.mix, "whiff");
  const hTbpa = weightedRelative(homeTeam, league, awayMix.mix, "tbpa");
  const aTbpa = weightedRelative(awayTeam, league, homeMix.mix, "tbpa");
  const hHrpa = weightedRelative(homeTeam, league, awayMix.mix, "hrpa");
  const aHrpa = weightedRelative(awayTeam, league, homeMix.mix, "hrpa");

  const reasons: string[] = [];
  for (const [label, mix] of [["HOME_STARTER", homeMix], ["AWAY_STARTER", awayMix]] as const) {
    if (mix.allPitches < MLB_FROZEN_MATCHUP_PITCHER_MIN_ALL_PITCHES) reasons.push(`${label}_LOW_PITCHES`);
    if (mix.categorizedShare < MLB_FROZEN_MATCHUP_PITCHER_MIN_CATEGORY_SHARE) reasons.push(`${label}_LOW_CATEGORY_SHARE`);
  }
  const coveragePairs = {
    CONTACT: { home: hContact.coverage, away: aContact.coverage },
    WHIFF: { home: hWhiff.coverage, away: aWhiff.coverage },
    TBPA: { home: hTbpa.coverage, away: aTbpa.coverage },
    HRPA: { home: hHrpa.coverage, away: aHrpa.coverage },
  };
  for (const [name, pair] of Object.entries(coveragePairs)) {
    if (pair.home < MLB_FROZEN_MATCHUP_MIN_WEIGHTED_COVERAGE_SHARE || pair.away < MLB_FROZEN_MATCHUP_MIN_WEIGHTED_COVERAGE_SHARE) {
      reasons.push(`${name}_LOW_COVERAGE`);
    }
  }

  const values = {
    contactAdv: hContact.value === null || aContact.value === null ? null : hContact.value - aContact.value,
    whiffAdv: hWhiff.value === null || aWhiff.value === null ? null : aWhiff.value - hWhiff.value,
    tbpaAdv: hTbpa.value === null || aTbpa.value === null ? null : hTbpa.value - aTbpa.value,
    hrpaAdv: hHrpa.value === null || aHrpa.value === null ? null : hHrpa.value - aHrpa.value,
  };
  if (Object.values(values).some((value) => value === null || !Number.isFinite(value))) reasons.push("METRIC_VALUE_MISSING");
  const pitchmixEligible = reasons.length === 0;
  const positiveCount = Object.values(values).filter((value) => value !== null && Number.isFinite(value) && value > 0).length;

  const pitchmixPriorGames = input.pitchmixGames.filter((game) => game.officialDate >= lowerDate && game.officialDate < input.officialDate).length;
  const handSplitPriorSeasonGames = input.handSplitGames.filter((game) => game.officialDate < input.officialDate && game.officialDate.slice(0, 4) === input.officialDate.slice(0, 4)).length;

  return Object.freeze({
    builderVersion: MLB_FROZEN_MATCHUP_LIVE_FEATURE_BUILDER_VERSION,
    priceIndependent: true,
    sameDateOutcomeLeakageAllowed: false,
    slg: Object.freeze({
      eligible: slgEligible,
      adv: slgAdv,
      homePriorPaRequiredHand: homeHand.pa,
      awayPriorPaRequiredHand: awayHand.pa,
      minimumPriorPa,
    }),
    pitchmix: Object.freeze({
      eligible: pitchmixEligible,
      contactAdv: values.contactAdv,
      whiffAdv: values.whiffAdv,
      tbpaAdv: values.tbpaAdv,
      hrpaAdv: values.hrpaAdv,
      positiveCount,
    }),
    diagnostics: Object.freeze({
      pitchmixWindowStart: lowerDate,
      pitchmixPriorGames,
      handSplitPriorSeasonGames,
      homeStarterAllPitches: homeMix.allPitches,
      awayStarterAllPitches: awayMix.allPitches,
      homeStarterCategorizedShare: homeMix.categorizedShare,
      awayStarterCategorizedShare: awayMix.categorizedShare,
      metricCoverage: Object.freeze(coveragePairs),
      eligibilityReasons: Object.freeze([...reasons]) as unknown as string[],
      canonicalV9V12FormulaContractFrozen: true,
    }),
  });
}
