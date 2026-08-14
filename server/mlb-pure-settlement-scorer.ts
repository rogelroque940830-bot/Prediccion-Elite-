import {
  C4_FEATURE_NAMES,
  C4_LIVE_FEATURE_BUILDER_VERSION,
  type C4LiveFeatureAssessment,
  type C4LiveFeatureVector,
} from "./mlb-c4-live-feature-builder";
import {
  MLB_V16_MANIFEST_SHA256,
  MLB_V16_SETTLEMENT_MODEL_VERSION,
  type MlbV16SettlementEvidence,
} from "./mlb-pure-settlement-evidence-adapter";

export const MLB_V16_RUNTIME_SCORER_VERSION = "mlb-v16-runtime-scorer-v1" as const;

const PREPROCESSOR = {
  mean: [0.0014282576209765502, 0.0002749983103482041, 8.598701960628567, -0.04855054476614112],
  medianImpute: [0.0, 0.0, 8.5, 0.0],
  scale: [0.13754890844331727, 0.06101328572182062, 1.4987377310177847, 2.4971425547182764],
} as const;

const FULL_GAME = {
  intercept: 0.1352480105191782,
  coefficients: [0.18692160183674042, 0.22772115196081583, 0.1013213063064697, 0.14470684957750546],
  calibrationSlope: 0.7493426069804996,
  calibrationIntercept: -0.04291166046773749,
} as const;

const FIRST_5 = {
  homeIntercept: 0.1269821500426285,
  awayIntercept: 0.0,
  tieIntercept: -0.767640130539062,
  homeCoefficients: [0.1156133299872011, 0.32496678819857117, 0.0858036644380019, 0.12037914761617022],
  awayCoefficients: [0.0, 0.0, 0.0, 0.0],
  tieCoefficients: [0.038912866443574126, 0.17663822535955867, 0.06809298555168213, 0.04394372987158844],
  temperature: 1.407198157140183,
  homeBias: -0.006417595835653408,
  awayBias: 0.0,
  tieBias: -0.45360555077244363,
} as const;

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

function sigmoid(value: number): number {
  const z = Math.max(-50, Math.min(50, value));
  return 1 / (1 + Math.exp(-z));
}

function softmax(values: readonly number[]): number[] {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0);
  return exp.map((value) => value / total);
}

function transformedVector(features: C4LiveFeatureVector): number[] {
  return C4_FEATURE_NAMES.map((name, i) => {
    const raw = features[name];
    const value = raw === null ? PREPROCESSOR.medianImpute[i] : raw;
    if (!Number.isFinite(value)) throw new Error(`MLB_V16_RUNTIME_FEATURE_NONFINITE:${name}`);
    return (value - PREPROCESSOR.mean[i]) / PREPROCESSOR.scale[i];
  });
}

function validAssessment(c4: C4LiveFeatureAssessment): void {
  if (c4.builderVersion !== C4_LIVE_FEATURE_BUILDER_VERSION) throw new Error("MLB_V16_RUNTIME_C4_VERSION_INVALID");
  if (c4.priceIndependent !== true) throw new Error("MLB_V16_RUNTIME_PRICE_INDEPENDENCE_INVALID");
  if (c4.sameDateHistoryAllowed !== false || c4.seasonResetHistory !== true) throw new Error("MLB_V16_RUNTIME_TEMPORAL_BOUNDARY_INVALID");
}

export function scoreMlbV16SettlementEvidence(
  gamePk: number,
  generatedAt: string,
  c4: C4LiveFeatureAssessment,
): MlbV16SettlementEvidence {
  if (!Number.isInteger(gamePk) || gamePk <= 0) throw new Error("MLB_V16_RUNTIME_GAME_PK_INVALID");
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("MLB_V16_RUNTIME_GENERATED_AT_INVALID");
  validAssessment(c4);

  const x = transformedVector(c4.featureVector);
  const fgRaw = FULL_GAME.intercept + dot(FULL_GAME.coefficients, x);
  const fgHome = sigmoid(FULL_GAME.calibrationSlope * fgRaw + FULL_GAME.calibrationIntercept);
  const fgAway = 1 - fgHome;

  const rawHome = FIRST_5.homeIntercept + dot(FIRST_5.homeCoefficients, x);
  const rawAway = FIRST_5.awayIntercept + dot(FIRST_5.awayCoefficients, x);
  const rawTie = FIRST_5.tieIntercept + dot(FIRST_5.tieCoefficients, x);
  const [f5Home, f5Away, f5Tie] = softmax([
    rawHome / FIRST_5.temperature + FIRST_5.homeBias,
    rawAway / FIRST_5.temperature + FIRST_5.awayBias,
    rawTie / FIRST_5.temperature + FIRST_5.tieBias,
  ]);

  return Object.freeze({
    gamePk,
    generatedAt,
    modelVersion: MLB_V16_SETTLEMENT_MODEL_VERSION,
    manifestSha256: MLB_V16_MANIFEST_SHA256,
    priceIndependent: true,
    fullGame: Object.freeze({ homeWinProbability: fgHome, awayWinProbability: fgAway, pushProbability: 0 as const }),
    first5: Object.freeze({ homeWinProbability: f5Home, awayWinProbability: f5Away, pushProbability: f5Tie }),
  });
}

export const MLB_V16_RUNTIME_MODEL_LOCK = Object.freeze({
  scorerVersion: MLB_V16_RUNTIME_SCORER_VERSION,
  featureNames: C4_FEATURE_NAMES,
  preprocessor: PREPROCESSOR,
  fullGame: FULL_GAME,
  first5: FIRST_5,
  modelVersion: MLB_V16_SETTLEMENT_MODEL_VERSION,
  manifestSha256: MLB_V16_MANIFEST_SHA256,
});
