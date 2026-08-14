import { createHash } from "node:crypto";
import {
  MLB_FULL13_FEATURE_NAMES,
  type MlbFull13FeatureName,
  type MlbFull13FeatureVector,
} from "./mlb-full13-live-feature-builder";

export const MLB_TEAM_TOTAL_COUNT_MODEL_VERSION =
  "mlb-team-total-count-model-v20-frozen-20220814" as const;
export const MLB_TEAM_TOTAL_COUNT_MODEL_SCHEMA =
  "courtedge-p0-mlb-team-total-count-model.v1" as const;

export const MLB_TEAM_TOTAL_V20_CUSTODY = Object.freeze({
  workflowRunId: 31838474790,
  artifactId: 9233422245,
  artifactDigest: "sha256:5ef2e6525ccb67a27227b18422401db8672e5a74bf682af5c1e00c229570b43d",
  sourcePr: 558,
  sourceClassification: "PROSPECTIVE_TEAM_TOTAL_PRICE_CAPTURE_CANDIDATE",
  fitSeason: "2022",
  validationSeason: "2023",
  evaluationSeasons: ["2024", "2025", "2026_YTD"],
  historicalTeamTotalPricesUsed: false,
} as const);

export type MlbTeamTotalTeamSide = "HOME" | "AWAY";
export type MlbTeamTotalBetSide = "OVER" | "UNDER";

interface FrozenCountModel {
  readonly target: "HOME_FULL_GAME_RUNS" | "AWAY_FULL_GAME_RUNS";
  readonly intercept: number;
  readonly coef: readonly number[];
  readonly medianImpute: readonly number[];
  readonly mean: readonly number[];
  readonly scale: readonly number[];
  readonly nb2Dispersion: number;
}

const COMMON_MEDIAN = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  130,
  0,
  0.27669490811376757,
  8.5,
  8.5,
] as const;

const COMMON_MEAN = [
  -0.04855054476614112,
  -0.006396699630644582,
  0.0002749983103482041,
  -0.03795011054185365,
  0.0014282576209765502,
  0.0000929000879815013,
  -0.01060043422428744,
  0.00006480451002384634,
  175.07047539616346,
  -0.0011120378092855162,
  0.2802815709613019,
  8.598701960628567,
  8.593858142367317,
] as const;

const COMMON_SCALE = [
  2.4971425547182764,
  0.274683113002919,
  0.06101328572182062,
  1.5967371345575612,
  0.13754890844331727,
  0.029286479878661353,
  1.5154450853516441,
  0.012707059191563718,
  160.99370463302927,
  0.1689410167590224,
  0.061161610775338236,
  1.4987377310177847,
  1.5242881606498033,
] as const;

const HOME_MODEL: FrozenCountModel = Object.freeze({
  target: "HOME_FULL_GAME_RUNS",
  intercept: 1.4552624175157542,
  coef: Object.freeze([
    0.006952803446412194,
    0.006240091844638258,
    0.04880295516143411,
    0.003018058880467909,
    0.045865558011751295,
    0.005260419963583881,
    0.008276838793530467,
    -0.014557965002823733,
    0.010727164882876363,
    -0.0053459203030471825,
    -0.04894167628957566,
    0.02139845124317417,
    0.029988333208401413,
  ]),
  medianImpute: COMMON_MEDIAN,
  mean: COMMON_MEAN,
  scale: COMMON_SCALE,
  nb2Dispersion: 0.24430097249578325,
});

const AWAY_MODEL: FrozenCountModel = Object.freeze({
  target: "AWAY_FULL_GAME_RUNS",
  intercept: 1.43860580221994,
  coef: Object.freeze([
    -0.017101441461203227,
    -0.0064237230416500255,
    -0.06169239263454896,
    -0.028778999162299493,
    -0.05737167136939194,
    -0.04578618919395351,
    0.002143105988757751,
    -0.0012074885304832511,
    -0.007311121719861142,
    0.025611331878709943,
    -0.016255541809414624,
    -0.0005711815788187651,
    -0.002117425367704081,
  ]),
  medianImpute: COMMON_MEDIAN,
  mean: COMMON_MEAN,
  scale: COMMON_SCALE,
  nb2Dispersion: 0.29295531185235457,
});

const EXPECTED_FEATURES: readonly MlbFull13FeatureName[] = Object.freeze([
  "team_rd10_diff",
  "team_win10_diff",
  "starter_kbb_adv",
  "team_ra10_adv",
  "lineup_exposure_rate_adv",
  "starter_runrisk_adv",
  "team_rs10_diff",
  "starter_hr_adv",
  "min_probable_prior_bf",
  "lineup_continuity_rate_adv",
  "combined_starter_kbb",
  "combined_team_rs10",
  "combined_team_ra10",
]);

function assertFrozenFeatureParity(): void {
  if (
    MLB_FULL13_FEATURE_NAMES.length !== EXPECTED_FEATURES.length
    || MLB_FULL13_FEATURE_NAMES.some((feature, index) => feature !== EXPECTED_FEATURES[index])
  ) {
    throw new Error("MLB_TEAM_TOTAL_FULL13_FEATURE_CONTRACT_DRIFT");
  }
  for (const model of [HOME_MODEL, AWAY_MODEL]) {
    for (const vector of [model.coef, model.medianImpute, model.mean, model.scale]) {
      if (vector.length !== EXPECTED_FEATURES.length) {
        throw new Error("MLB_TEAM_TOTAL_FROZEN_MODEL_VECTOR_LENGTH_INVALID");
      }
    }
  }
}

assertFrozenFeatureParity();

function finiteOr(value: number | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function modelForSide(side: MlbTeamTotalTeamSide): FrozenCountModel {
  return side === "HOME" ? HOME_MODEL : AWAY_MODEL;
}

function exactFeatureDigest(
  gamePk: number,
  side: MlbTeamTotalTeamSide,
  line: number,
  features: MlbFull13FeatureVector,
): string {
  const payload = [
    MLB_TEAM_TOTAL_COUNT_MODEL_VERSION,
    gamePk.toString(),
    side,
    Object.is(line, -0) ? "-0" : line.toString(),
    ...EXPECTED_FEATURES.map((feature) => {
      const value = features[feature];
      if (value === null) return `${feature}=null`;
      if (Number.isNaN(value)) return `${feature}=NaN`;
      if (value === Number.POSITIVE_INFINITY) return `${feature}=+Infinity`;
      if (value === Number.NEGATIVE_INFINITY) return `${feature}=-Infinity`;
      return `${feature}=${Object.is(value, -0) ? "-0" : value.toString()}`;
    }),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export function scoreMlbTeamTotalExpectedRuns(
  features: MlbFull13FeatureVector,
  side: MlbTeamTotalTeamSide,
): { meanRuns: number; nb2Dispersion: number; target: FrozenCountModel["target"] } {
  const model = modelForSide(side);
  let linear = model.intercept;
  for (let index = 0; index < EXPECTED_FEATURES.length; index += 1) {
    const feature = EXPECTED_FEATURES[index];
    const value = finiteOr(features[feature], model.medianImpute[index]);
    const standardized = (value - model.mean[index]) / model.scale[index];
    linear += model.coef[index] * standardized;
  }
  const meanRuns = Math.exp(Math.max(-50, Math.min(50, linear)));
  if (!Number.isFinite(meanRuns) || meanRuns <= 0) {
    throw new Error("MLB_TEAM_TOTAL_EXPECTED_RUNS_INVALID");
  }
  return Object.freeze({ meanRuns, nb2Dispersion: model.nb2Dispersion, target: model.target });
}

function nb2MassesThrough(meanRuns: number, dispersion: number, maxK: number): number[] {
  if (!Number.isInteger(maxK) || maxK < 0) return [];
  if (!Number.isFinite(meanRuns) || meanRuns <= 0) throw new Error("MLB_TEAM_TOTAL_MEAN_INVALID");
  if (!Number.isFinite(dispersion) || dispersion < 0) throw new Error("MLB_TEAM_TOTAL_DISPERSION_INVALID");

  const masses: number[] = [];
  if (dispersion <= 1e-12) {
    let mass = Math.exp(-meanRuns);
    masses.push(mass);
    for (let k = 0; k < maxK; k += 1) {
      mass *= meanRuns / (k + 1);
      masses.push(mass);
    }
    return masses;
  }

  const r = 1 / dispersion;
  const p = r / (r + meanRuns);
  const q = 1 - p;
  let mass = Math.exp(r * Math.log(p));
  masses.push(mass);
  for (let k = 0; k < maxK; k += 1) {
    mass *= ((k + r) / (k + 1)) * q;
    masses.push(mass);
  }
  return masses;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) throw new Error("MLB_TEAM_TOTAL_PROBABILITY_INVALID");
  return Math.max(0, Math.min(1, value));
}

export interface MlbTeamTotalSettlementProbability {
  side: MlbTeamTotalBetSide;
  winProbability: number;
  pushProbability: number;
  lossProbability: number;
}

export interface MlbTeamTotalLineAssessment {
  schemaVersion: typeof MLB_TEAM_TOTAL_COUNT_MODEL_SCHEMA;
  modelVersion: typeof MLB_TEAM_TOTAL_COUNT_MODEL_VERSION;
  gamePk: number;
  generatedAt: string;
  teamSide: MlbTeamTotalTeamSide;
  target: FrozenCountModel["target"];
  line: number;
  meanRuns: number;
  nb2Dispersion: number;
  over: MlbTeamTotalSettlementProbability;
  under: MlbTeamTotalSettlementProbability;
  modelInputDigest: string;
  priceIndependent: true;
  historicalTeamTotalPricesUsed: false;
  positiveEvEstablished: false;
  recommendsBet: false;
  stakeCalculated: false;
  automaticBetPlacement: false;
  realFinancialExposure: 0;
}

export function assessMlbTeamTotalLine(input: {
  gamePk: number;
  generatedAt: string;
  teamSide: MlbTeamTotalTeamSide;
  line: number;
  features: MlbFull13FeatureVector;
}): MlbTeamTotalLineAssessment {
  if (!Number.isInteger(input.gamePk) || input.gamePk <= 0) throw new Error("MLB_TEAM_TOTAL_GAME_PK_INVALID");
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error("MLB_TEAM_TOTAL_GENERATED_AT_INVALID");
  if (!Number.isFinite(input.line) || input.line < 0 || input.line > 30) throw new Error("MLB_TEAM_TOTAL_LINE_INVALID");

  const scored = scoreMlbTeamTotalExpectedRuns(input.features, input.teamSide);
  const integerLine = Number.isInteger(input.line);
  const floorLine = Math.floor(input.line);
  const maxMass = integerLine ? floorLine : floorLine;
  const masses = nb2MassesThrough(scored.meanRuns, scored.nb2Dispersion, maxMass);
  const cdfThroughFloor = clampProbability(masses.reduce((sum, mass) => sum + mass, 0));
  const push = integerLine ? clampProbability(masses[floorLine] ?? 0) : 0;
  const underWin = integerLine
    ? clampProbability(cdfThroughFloor - push)
    : cdfThroughFloor;
  const overWin = clampProbability(1 - cdfThroughFloor);

  const over: MlbTeamTotalSettlementProbability = Object.freeze({
    side: "OVER",
    winProbability: overWin,
    pushProbability: push,
    lossProbability: clampProbability(1 - overWin - push),
  });
  const under: MlbTeamTotalSettlementProbability = Object.freeze({
    side: "UNDER",
    winProbability: underWin,
    pushProbability: push,
    lossProbability: clampProbability(1 - underWin - push),
  });

  return Object.freeze({
    schemaVersion: MLB_TEAM_TOTAL_COUNT_MODEL_SCHEMA,
    modelVersion: MLB_TEAM_TOTAL_COUNT_MODEL_VERSION,
    gamePk: input.gamePk,
    generatedAt: new Date(input.generatedAt).toISOString(),
    teamSide: input.teamSide,
    target: scored.target,
    line: input.line,
    meanRuns: scored.meanRuns,
    nb2Dispersion: scored.nb2Dispersion,
    over,
    under,
    modelInputDigest: exactFeatureDigest(input.gamePk, input.teamSide, input.line, input.features),
    priceIndependent: true,
    historicalTeamTotalPricesUsed: false,
    positiveEvEstablished: false,
    recommendsBet: false,
    stakeCalculated: false,
    automaticBetPlacement: false,
    realFinancialExposure: 0,
  });
}
