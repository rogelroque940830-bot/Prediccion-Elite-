export const FROZEN_V39_FEATURES = [
  "pitcher_outs_per_start_shrunk",
  "pitcher_bf_per_start_shrunk",
  "pitcher_pitches_per_start_shrunk",
  "pitcher_kbf_shrunk",
  "pitcher_bbbf_shrunk",
  "pitcher_erbf_shrunk",
  "pitcher_recent5_outs_per_start",
  "pitcher_recent5_pitches_per_start",
  "opponent_vs_starters_outs_per_game_shrunk",
  "opponent_rs10",
  "opponent_lineup_continuity",
  "pitcher_prior_starts",
] as const;

export type FrozenV39FeatureName = (typeof FROZEN_V39_FEATURES)[number];
export type NullableNumber = number | null | undefined;

export const FROZEN_V39_MODEL = Object.freeze({
  fitSeason: "2022",
  alpha: 1.0,
  maxIter: 1000,
  intercept: 2.744740694633872,
  medianImpute: Object.freeze([
    15.412825018533262,
    21.68806657124414,
    84.4045634050022,
    0.21499449608124652,
    0.07683456050663819,
    0.1029987395598155,
    15.8,
    87.4,
    15.307954545454544,
    4.211111111111112,
    0.7777777777777778,
    9.0,
  ]),
  mean: Object.freeze([
    15.465055990941428,
    21.651538622092147,
    83.97043140821603,
    0.21819424167465346,
    0.07756823989928466,
    0.10329558079481943,
    15.754012281069013,
    85.52808247854303,
    15.209859248182932,
    4.298913444381312,
    0.7467494708440909,
    10.675319238015492,
  ]),
  scale: Object.freeze([
    1.447241373222674,
    1.6900465350423275,
    6.328557350421655,
    0.03752812970492753,
    0.018131849260105973,
    0.021215389428418465,
    2.7986648417855124,
    12.06702981178793,
    0.8341772803421766,
    1.0646192444106428,
    0.12036107192344651,
    8.155612105847807,
  ]),
  coefficients: Object.freeze([
    0.020267278253949222,
    0.021067992246530252,
    -0.004602790140888043,
    0.0077479405191903244,
    -0.0041752323311302336,
    -0.002599687206457183,
    0.01940743060865778,
    0.04836472135186163,
    -0.005595854885672543,
    -0.007573928518193434,
    0.001898077179502012,
    0.020933639462693998,
  ]),
  parameterPayloadSha256: "sha256:29efa6b950c3dde20e6362cb604341add4df8528ef6d16deadb5f60869d8c0fa",
});

export const V62_RECOGNIZED_PITCH_TYPES = Object.freeze([
  "FF", "FT", "SI", "FC", "SL", "ST", "SV", "CU",
  "KC", "CS", "CH", "FS", "FO", "SC", "KN", "EP",
]);

const RECOGNIZED_PITCH_TYPE_SET = new Set<string>(V62_RECOGNIZED_PITCH_TYPES);
const DAY_MS = 86_400_000;

function finite(value: NullableNumber): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clip01(value: NullableNumber): number | null {
  return finite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function mean2(a: NullableNumber, b: NullableNumber): number | null {
  return finite(a) && finite(b) ? (a + b) / 2 : null;
}

function mul(a: NullableNumber, b: NullableNumber): number | null {
  return finite(a) && finite(b) ? a * b : null;
}

function dayNumber(officialDate: string): number {
  const ms = Date.parse(`${officialDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`INVALID_OFFICIAL_DATE:${officialDate}`);
  return Math.floor(ms / DAY_MS);
}

/**
 * Exact persisted V39 Poisson scoring path used by V66.
 * Runtime training and preprocessing fitting are deliberately absent.
 */
export function scoreFrozenV39ExpectedOuts(
  features: Partial<Record<FrozenV39FeatureName, NullableNumber>>,
): number {
  let eta = FROZEN_V39_MODEL.intercept;
  for (let i = 0; i < FROZEN_V39_FEATURES.length; i += 1) {
    const name = FROZEN_V39_FEATURES[i];
    const raw = features[name];
    const x = finite(raw) ? raw : FROZEN_V39_MODEL.medianImpute[i];
    const z = (x - FROZEN_V39_MODEL.mean[i]) / FROZEN_V39_MODEL.scale[i];
    eta += FROZEN_V39_MODEL.coefficients[i] * z;
  }
  const prediction = Math.exp(eta);
  if (!Number.isFinite(prediction)) throw new Error("V39_EXPECTED_OUTS_NONFINITE");
  return prediction;
}

export type Horizon = "f3" | "f5" | "fg";

export interface HorizonExposureFeatures {
  home_expected_starter_outs: number | null;
  away_expected_starter_outs: number | null;
  home_f3_starter_share: number | null;
  away_f3_starter_share: number | null;
  mean_f3_starter_share: number | null;
  min_f3_starter_share: number | null;
  f3_exposure_adv: number | null;
  home_f5_starter_share: number | null;
  away_f5_starter_share: number | null;
  mean_f5_starter_share: number | null;
  min_f5_starter_share: number | null;
  f5_exposure_adv: number | null;
  home_f5_expected_bullpen_share: number | null;
  away_f5_expected_bullpen_share: number | null;
  combined_f5_expected_bullpen_share: number | null;
  home_fg_starter_share: number | null;
  away_fg_starter_share: number | null;
  mean_fg_starter_share: number | null;
  min_fg_starter_share: number | null;
  fg_exposure_adv: number | null;
  home_fg_expected_bullpen_share: number | null;
  away_fg_expected_bullpen_share: number | null;
  combined_fg_expected_bullpen_share: number | null;
}

export function buildHorizonExposureFeatures(
  homeExpectedOuts: NullableNumber,
  awayExpectedOuts: NullableNumber,
): HorizonExposureFeatures {
  const out: Record<string, number | null> = {
    home_expected_starter_outs: finite(homeExpectedOuts) ? homeExpectedOuts : null,
    away_expected_starter_outs: finite(awayExpectedOuts) ? awayExpectedOuts : null,
  };
  const horizons: Array<[Horizon, number]> = [["f3", 9], ["f5", 15], ["fg", 27]];
  for (const [horizon, denominator] of horizons) {
    const homeShare = clip01(finite(homeExpectedOuts) ? homeExpectedOuts / denominator : null);
    const awayShare = clip01(finite(awayExpectedOuts) ? awayExpectedOuts / denominator : null);
    out[`home_${horizon}_starter_share`] = homeShare;
    out[`away_${horizon}_starter_share`] = awayShare;
    out[`mean_${horizon}_starter_share`] = mean2(homeShare, awayShare);
    out[`min_${horizon}_starter_share`] = finite(homeShare) && finite(awayShare) ? Math.min(homeShare, awayShare) : null;
    out[`${horizon}_exposure_adv`] = finite(homeShare) && finite(awayShare) ? homeShare - awayShare : null;
    if (horizon === "f5" || horizon === "fg") {
      const homeBullpen = finite(homeShare) ? 1 - homeShare : null;
      const awayBullpen = finite(awayShare) ? 1 - awayShare : null;
      out[`home_${horizon}_expected_bullpen_share`] = homeBullpen;
      out[`away_${horizon}_expected_bullpen_share`] = awayBullpen;
      out[`combined_${horizon}_expected_bullpen_share`] = finite(homeBullpen) && finite(awayBullpen)
        ? homeBullpen + awayBullpen
        : null;
    }
  }
  return out as unknown as HorizonExposureFeatures;
}

export interface PitchTypeTotals {
  pitches: number;
  strikes: number;
  swings: number;
  whiffs: number;
  velocityN: number;
  velocitySum: number;
  spinN: number;
  spinSum: number;
  battedBallN: number;
  hardHitN: number;
}

export interface PitcherPitchTypeTotals extends PitchTypeTotals {
  pitcherId: number;
  pitchType: string;
}

export interface PitchQualityHistoryGame {
  officialDate: string;
  gamePk?: number;
  pitcherPitchTypeTotals: PitcherPitchTypeTotals[];
}

export interface StarterPitchQuality {
  velocity: number;
  spin: number;
  whiff: number;
  strike: number;
  hard: number;
  starterPriorRecognizedPitches: number;
}

function emptyPitchTotals(): PitchTypeTotals {
  return {
    pitches: 0,
    strikes: 0,
    swings: 0,
    whiffs: 0,
    velocityN: 0,
    velocitySum: 0,
    spinN: 0,
    spinSum: 0,
    battedBallN: 0,
    hardHitN: 0,
  };
}

function addPitchTotals(target: PitchTypeTotals, source: PitchTypeTotals): void {
  target.pitches += Number(source.pitches || 0);
  target.strikes += Number(source.strikes || 0);
  target.swings += Number(source.swings || 0);
  target.whiffs += Number(source.whiffs || 0);
  target.velocityN += Number(source.velocityN || 0);
  target.velocitySum += Number(source.velocitySum || 0);
  target.spinN += Number(source.spinN || 0);
  target.spinSum += Number(source.spinSum || 0);
  target.battedBallN += Number(source.battedBallN || 0);
  target.hardHitN += Number(source.hardHitN || 0);
}

function mean(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function shrinkMean(total: number, n: number, anchor: number, weight: number): number {
  return (total + weight * anchor) / (n + weight);
}

function shrinkRate(numerator: number, denominator: number, anchor: number, weight: number): number {
  return (numerator + weight * anchor) / (denominator + weight);
}

/** Reproduces V62 starter_quality() using only strictly-prior official dates. */
export function computeV62StarterPitchQuality(args: {
  starterId: number;
  targetOfficialDate: string;
  history: PitchQualityHistoryGame[];
}): StarterPitchQuality | null {
  const targetDay = dayNumber(args.targetOfficialDate);
  const cutoff = targetDay - 365;
  const starter = new Map<string, PitchTypeTotals>();
  const league = new Map<string, PitchTypeTotals>();

  for (const game of args.history) {
    const d = dayNumber(game.officialDate);
    if (d < cutoff || d >= targetDay) continue;
    for (const row of game.pitcherPitchTypeTotals || []) {
      if (!RECOGNIZED_PITCH_TYPE_SET.has(String(row.pitchType))) continue;
      const pitchType = String(row.pitchType);
      const l = league.get(pitchType) ?? emptyPitchTotals();
      addPitchTotals(l, row);
      league.set(pitchType, l);
      if (Number(row.pitcherId) === Number(args.starterId)) {
        const s = starter.get(pitchType) ?? emptyPitchTotals();
        addPitchTotals(s, row);
        starter.set(pitchType, s);
      }
    }
  }

  const totalPitches = [...starter.values()].reduce((sum, row) => sum + row.pitches, 0);
  if (!(args.starterId > 0) || totalPitches < 1) return null;

  const q = { velocity: 0, spin: 0, whiff: 0, strike: 0, hard: 0 };
  for (const [pitchType, row] of starter.entries()) {
    if (!(row.pitches > 0)) continue;
    const lg = league.get(pitchType);
    if (!lg || !(lg.pitches > 0)) continue;
    const usage = row.pitches / totalPitches;
    const leagueVelocity = mean(lg.velocitySum, lg.velocityN);
    const leagueSpin = mean(lg.spinSum, lg.spinN);
    const leagueWhiff = rate(lg.whiffs, lg.swings);
    const leagueStrike = rate(lg.strikes, lg.pitches);
    const leagueHard = rate(lg.hardHitN, lg.battedBallN);

    if (leagueVelocity !== null) {
      const starterVelocity = shrinkMean(row.velocitySum, row.velocityN, leagueVelocity, 100);
      q.velocity += usage * (starterVelocity - leagueVelocity);
    }
    if (leagueSpin !== null) {
      const starterSpin = shrinkMean(row.spinSum, row.spinN, leagueSpin, 100);
      q.spin += usage * (starterSpin - leagueSpin);
    }
    if (leagueWhiff !== null) {
      const starterWhiff = shrinkRate(row.whiffs, row.swings, leagueWhiff, 50);
      q.whiff += usage * (starterWhiff - leagueWhiff);
    }
    if (leagueStrike !== null) {
      const starterStrike = shrinkRate(row.strikes, row.pitches, leagueStrike, 100);
      q.strike += usage * (starterStrike - leagueStrike);
    }
    if (leagueHard !== null) {
      const starterHard = shrinkRate(row.hardHitN, row.battedBallN, leagueHard, 30);
      q.hard += usage * (leagueHard - starterHard);
    }
  }

  return { ...q, starterPriorRecognizedPitches: totalPitches };
}

export const V66_QUALITY_FEATURE_NAMES = Object.freeze([
  "starter_velocity_adv",
  "starter_spin_adv",
  "starter_swing_miss_adv",
  "starter_in_zone_adv",
  "starter_weak_contact_adv",
] as const);

export function buildStarterQualityAdvantages(
  home: StarterPitchQuality | null,
  away: StarterPitchQuality | null,
): Record<(typeof V66_QUALITY_FEATURE_NAMES)[number], number | null> {
  if (!home || !away) {
    return {
      starter_velocity_adv: null,
      starter_spin_adv: null,
      starter_swing_miss_adv: null,
      starter_in_zone_adv: null,
      starter_weak_contact_adv: null,
    };
  }
  return {
    starter_velocity_adv: home.velocity - away.velocity,
    starter_spin_adv: home.spin - away.spin,
    starter_swing_miss_adv: home.whiff - away.whiff,
    starter_in_zone_adv: home.strike - away.strike,
    starter_weak_contact_adv: home.hard - away.hard,
  };
}

export function buildQualityHorizonInteractions(
  quality: Record<(typeof V66_QUALITY_FEATURE_NAMES)[number], number | null>,
  exposure: HorizonExposureFeatures,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const horizon of ["f3", "f5", "fg"] as const) {
    const meanShare = exposure[`mean_${horizon}_starter_share`];
    for (const name of V66_QUALITY_FEATURE_NAMES) {
      out[`${name}_x_${horizon}_mean_starter_share`] = mul(quality[name], meanShare);
    }
  }
  return out;
}

export interface BullpenUsageGame {
  officialDate: string;
  bullpenPitches: number;
  relievers: Record<string, number>;
}

export interface BullpenProfile {
  bullpen_pitches_1d: number;
  bullpen_pitches_3d: number;
  bullpen_core3_pitches_2d: number;
  bullpen_b2b_arms: number;
  priorGames30d: number;
  relieverPool: number;
}

export const V66_BULLPEN_FEATURE_NAMES = Object.freeze([
  "bullpen_pitches_1d",
  "bullpen_pitches_3d",
  "bullpen_core3_pitches_2d",
  "bullpen_b2b_arms",
] as const);

/** Reproduces V66 bullpen_profile() exactly at the official-date level. */
export function buildV66BullpenProfile(
  history: BullpenUsageGame[],
  targetOfficialDate: string,
): BullpenProfile {
  const target = dayNumber(targetOfficialDate);
  const rows = history.filter((row) => {
    const d = dayNumber(row.officialDate);
    return d >= target - 30 && d < target;
  });
  const pool = new Map<number, number>();
  for (const row of rows) {
    for (const [rawPid, rawPitches] of Object.entries(row.relievers || {})) {
      const pid = Number(rawPid);
      if (!Number.isFinite(pid)) continue;
      pool.set(pid, (pool.get(pid) ?? 0) + Number(rawPitches || 0));
    }
  }
  const core = [...pool.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, 3)
    .map(([pid]) => pid);
  const coreSet = new Set(core);
  const d1 = target - 1;
  const d2 = target - 2;
  const d3 = target - 3;
  const pitches1d = rows
    .filter((row) => dayNumber(row.officialDate) === d1)
    .reduce((sum, row) => sum + Number(row.bullpenPitches || 0), 0);
  const pitches3d = rows
    .filter((row) => {
      const d = dayNumber(row.officialDate);
      return d >= d3 && d < target;
    })
    .reduce((sum, row) => sum + Number(row.bullpenPitches || 0), 0);
  let core3Pitches2d = 0;
  const ids1 = new Set<number>();
  const ids2 = new Set<number>();
  for (const row of rows) {
    const d = dayNumber(row.officialDate);
    for (const [rawPid, rawPitches] of Object.entries(row.relievers || {})) {
      const pid = Number(rawPid);
      if (!Number.isFinite(pid)) continue;
      if (d >= target - 2 && d < target && coreSet.has(pid)) core3Pitches2d += Number(rawPitches || 0);
      if (d === d1) ids1.add(pid);
      if (d === d2) ids2.add(pid);
    }
  }
  let b2b = 0;
  for (const pid of ids1) if (ids2.has(pid)) b2b += 1;
  return {
    bullpen_pitches_1d: pitches1d,
    bullpen_pitches_3d: pitches3d,
    bullpen_core3_pitches_2d: core3Pitches2d,
    bullpen_b2b_arms: b2b,
    priorGames30d: rows.length,
    relieverPool: pool.size,
  };
}

export function buildV66BullpenFeatures(args: {
  homeProfile: BullpenProfile;
  awayProfile: BullpenProfile;
  exposure: HorizonExposureFeatures;
}): Record<string, number | null> {
  const out: Record<string, number | null> = {
    home_bullpen_prior_games_30d: args.homeProfile.priorGames30d,
    away_bullpen_prior_games_30d: args.awayProfile.priorGames30d,
    home_bullpen_reliever_pool_30d: args.homeProfile.relieverPool,
    away_bullpen_reliever_pool_30d: args.awayProfile.relieverPool,
  };
  for (const name of V66_BULLPEN_FEATURE_NAMES) {
    const home = args.homeProfile[name];
    const away = args.awayProfile[name];
    const advantage = away - home;
    out[`home_${name}`] = home;
    out[`away_${name}`] = away;
    out[`${name}_adv`] = advantage;
    for (const horizon of ["f5", "fg"] as const) {
      const bpMean = mean2(
        args.exposure[`home_${horizon}_expected_bullpen_share`],
        args.exposure[`away_${horizon}_expected_bullpen_share`],
      );
      out[`${name}_adv_weighted_${horizon}`] = mul(advantage, bpMean);
      out[`${name}_combined_weighted_${horizon}`] = mul(home + away, bpMean);
    }
  }
  return out;
}

export interface FullModularMechanisticInputs {
  homeExpectedOuts: NullableNumber;
  awayExpectedOuts: NullableNumber;
  homeStarterQuality: StarterPitchQuality | null;
  awayStarterQuality: StarterPitchQuality | null;
  homeBullpenProfile: BullpenProfile;
  awayBullpenProfile: BullpenProfile;
}

/** Pure V66-derived mechanistic layer required by Full Modular. */
export function buildFullModularMechanisticFeatures(
  input: FullModularMechanisticInputs,
): Record<string, number | null> {
  const exposure = buildHorizonExposureFeatures(input.homeExpectedOuts, input.awayExpectedOuts);
  const quality = buildStarterQualityAdvantages(input.homeStarterQuality, input.awayStarterQuality);
  return {
    ...exposure,
    ...quality,
    ...buildQualityHorizonInteractions(quality, exposure),
    ...buildV66BullpenFeatures({
      homeProfile: input.homeBullpenProfile,
      awayProfile: input.awayBullpenProfile,
      exposure,
    }),
  };
}
