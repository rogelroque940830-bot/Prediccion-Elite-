// @ts-ignore -- frozen JSON authority is bundled; repo-wide resolveJsonModule remains intentionally disabled.
import classifierAuthorityJson from "../research/mlb-frozen-classifier-authority-v1.json";
import {
  getMlbFullModularFrozenAuthority,
  getMlbPpHorizonFrozenSnapshot,
} from "./mlb-unified-elite-frozen-authority-v1";
import {
  scoreMlbFullModularFrozenLiveGame,
  type MlbFullModularFrozenLiveCandidate,
  type MlbFullModularFrozenLiveGame,
} from "./mlb-full-modular-frozen-live-scorer-v1";

export const MLB_PP_HORIZON_FROZEN_LIVE_SCORER_VERSION =
  "mlb-pp-horizon-frozen-live-scorer-v1" as const;

export interface MlbPpHorizonFrozenLiveCandidate extends MlbFullModularFrozenLiveCandidate {
  premium_core_support_count_0_to_3: number;
  premium_core_weakest_margin: number;
  frozen_c4_selected_side_probability: number;
  frozen_full13_selected_side_probability: number;
  sel_starter_kbb_adv: number | null;
  sel_team_win10_diff: number | null;
  sel_lineup_exposure_rate_adv: number | null;
  sel_team_ra10_adv: number | null;
  sel_starter_runrisk_adv: number | null;
  partialPoolProbability: number;
}

export interface MlbPpHorizonFrozenSlateScore {
  scorerVersion: typeof MLB_PP_HORIZON_FROZEN_LIVE_SCORER_VERSION;
  officialDate: string;
  candidateCount: number;
  candidates: readonly MlbPpHorizonFrozenLiveCandidate[];
  selection: MlbPpHorizonFrozenLiveCandidate | null;
  maximumDailySelections: 1;
  persistedSnapshotOnly: true;
  runtimeRefit: false;
  preprocessingRefit: false;
  outcomesRead: false;
  sportsbookPricesRead: false;
}

type Json = Readonly<Record<string, any>>;
const CLASSIFIER = classifierAuthorityJson as Json;

const PP_SELECTED_FEATURES = Object.freeze([
  "starter_kbb_adv",
  "team_win10_diff",
  "lineup_exposure_rate_adv",
  "team_ra10_adv",
  "starter_runrisk_adv",
] as const);

type SelectedFeature = (typeof PP_SELECTED_FEATURES)[number];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sigmoid(logit: number): number {
  if (logit >= 0) {
    const exp = Math.exp(-logit);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(logit);
  return exp / (1 + exp);
}

function validateClassifierAuthority(): void {
  if (CLASSIFIER.schemaVersion !== "courtedge-mlb-frozen-classifier-authority.v1") {
    throw new Error("PP_CLASSIFIER_AUTHORITY_SCHEMA_INVALID");
  }
  if (CLASSIFIER.source?.blob !== "b5b23d69aab6f9d8f3cef87af86d88a314b1cca2") {
    throw new Error("PP_CLASSIFIER_AUTHORITY_BLOB_DRIFT");
  }
  if (CLASSIFIER.runtimePolicy?.runtimeRefitAllowed !== false
      || CLASSIFIER.runtimePolicy?.thresholdSearchAllowed !== false
      || CLASSIFIER.runtimePolicy?.outcomeInputAllowed !== false
      || CLASSIFIER.runtimePolicy?.sportsbookPriceInputAllowed !== false) {
    throw new Error("PP_CLASSIFIER_RUNTIME_POLICY_DRIFT");
  }
  for (const modelId of ["A_PLUS_C4_2022_FROZEN", "A_PLUS_FULL13_2022_FROZEN"] as const) {
    const model = CLASSIFIER.models?.[modelId];
    if (!model || !finite(Number(model.intercept)) || !Array.isArray(model.features) || model.features.length === 0) {
      throw new Error(`PP_CLASSIFIER_MODEL_INVALID:${modelId}`);
    }
  }
}

function frozenClassifierHomeProbability(
  featureVector: Readonly<Record<string, number>>,
  modelId: "A_PLUS_C4_2022_FROZEN" | "A_PLUS_FULL13_2022_FROZEN",
): number {
  validateClassifierAuthority();
  const model = CLASSIFIER.models[modelId];
  let logit = Number(model.intercept);
  for (const spec of model.features) {
    const raw = featureVector[String(spec.name)];
    const value = finite(raw) ? raw : Number(spec.medianImpute);
    const scale = Number(spec.scale);
    if (!(Math.abs(scale) > 1e-15)) continue;
    logit += Number(spec.coef) * ((value - Number(spec.mean)) / scale);
  }
  const probability = sigmoid(logit);
  if (!finite(probability) || probability < 0 || probability > 1) {
    throw new Error(`PP_CLASSIFIER_PROBABILITY_INVALID:${modelId}`);
  }
  return probability;
}

function selectedValue(
  featureVector: Readonly<Record<string, number>>,
  feature: SelectedFeature,
  side: "HOME" | "AWAY",
): number | null {
  const raw = featureVector[feature];
  if (!finite(raw)) return null;
  return side === "HOME" ? raw : -raw;
}

function enrichCandidate(
  candidate: MlbFullModularFrozenLiveCandidate,
  featureVector: Readonly<Record<string, number>>,
): Omit<MlbPpHorizonFrozenLiveCandidate, "partialPoolProbability"> {
  const fullAuthority = getMlbFullModularFrozenAuthority();
  const selected = Object.fromEntries(
    PP_SELECTED_FEATURES.map((feature) => [feature, selectedValue(featureVector, feature, candidate.side)]),
  ) as Record<SelectedFeature, number | null>;

  let supports = 0;
  const normalizedMargins: number[] = [];
  for (const feature of ["team_win10_diff", "starter_kbb_adv", "lineup_exposure_rate_adv"] as const) {
    const threshold = Number(CLASSIFIER.premiumAThresholds[feature]);
    const stats = fullAuthority.premiumHeritageTrainingStats[feature];
    const raw = selected[feature] ?? Number(stats.median);
    const std = Number(stats.std);
    if (!(std > 1e-12)) throw new Error(`PP_PREMIUM_HERITAGE_STD_INVALID:${feature}`);
    if (raw >= threshold) supports += 1;
    normalizedMargins.push((raw - threshold) / std);
  }

  const c4Home = frozenClassifierHomeProbability(featureVector, "A_PLUS_C4_2022_FROZEN");
  const full13Home = frozenClassifierHomeProbability(featureVector, "A_PLUS_FULL13_2022_FROZEN");
  const frozenC4 = candidate.side === "HOME" ? c4Home : 1 - c4Home;
  const frozenFull13 = candidate.side === "HOME" ? full13Home : 1 - full13Home;

  return Object.freeze({
    ...candidate,
    premium_core_support_count_0_to_3: supports,
    premium_core_weakest_margin: Math.min(...normalizedMargins),
    frozen_c4_selected_side_probability: frozenC4,
    frozen_full13_selected_side_probability: frozenFull13,
    sel_starter_kbb_adv: selected.starter_kbb_adv,
    sel_team_win10_diff: selected.team_win10_diff,
    sel_lineup_exposure_rate_adv: selected.lineup_exposure_rate_adv,
    sel_team_ra10_adv: selected.team_ra10_adv,
    sel_starter_runrisk_adv: selected.starter_runrisk_adv,
  });
}

function zValue(candidate: Readonly<Record<string, unknown>>, field: string): number {
  const snapshot = getMlbPpHorizonFrozenSnapshot();
  const prep = snapshot.model.preprocessing[field];
  if (!prep) throw new Error(`PP_REQUIRED_PREPROCESSING_MISSING:${field}`);
  const raw = candidate[field];
  const value = finite(raw) ? raw : Number(prep.median);
  const std = Number(prep.std);
  if (!(std > 1e-12)) return 0;
  const clip = Number(prep.clip);
  return Math.max(-clip, Math.min(clip, (value - Number(prep.mean)) / std));
}

function designValue(candidate: MlbPpHorizonFrozenLiveCandidate | Omit<MlbPpHorizonFrozenLiveCandidate, "partialPoolProbability">, featureName: string): number {
  const snapshot = getMlbPpHorizonFrozenSnapshot();
  if (featureName.startsWith("GLOBAL::")) {
    const descriptor = featureName.slice("GLOBAL::".length);
    const separator = descriptor.indexOf("=");
    if (separator >= 0) {
      const field = descriptor.slice(0, separator);
      const level = descriptor.slice(separator + 1);
      return String((candidate as any)[field]) === level ? 1 : 0;
    }
    return zValue(candidate as Readonly<Record<string, unknown>>, descriptor);
  }

  const match = /^DEV::horizon=(F3|F5|FG)::(.+)$/.exec(featureName);
  if (!match) throw new Error(`PP_FEATURE_NAME_UNKNOWN:${featureName}`);
  if (candidate.horizon !== match[1]) return 0;
  if (match[2] === "INTERCEPT") return Number(snapshot.model.groupInterceptFeatureScale);
  return Number(snapshot.model.signalDeviationFeatureScale)
    * zValue(candidate as Readonly<Record<string, unknown>>, match[2]);
}

export function scoreMlbPpHorizonPersistedProbability(
  candidate: Omit<MlbPpHorizonFrozenLiveCandidate, "partialPoolProbability">,
): number {
  validateClassifierAuthority();
  const snapshot = getMlbPpHorizonFrozenSnapshot();
  let logit = Number(snapshot.model.intercept);
  const names: string[] = snapshot.model.featureNames;
  const coefficients: number[] = snapshot.model.rawCoefficients;
  if (names.length !== 49 || coefficients.length !== 49) throw new Error("PP_FEATURE_COUNT_DRIFT");
  for (let index = 0; index < names.length; index += 1) {
    logit += Number(coefficients[index]) * designValue(candidate, names[index]);
  }
  const probability = sigmoid(logit);
  if (!finite(probability) || probability < 0 || probability > 1) {
    throw new Error("PP_RUNTIME_PROBABILITY_INVALID");
  }
  return probability;
}

function comparePpCandidate(a: MlbPpHorizonFrozenLiveCandidate, b: MlbPpHorizonFrozenLiveCandidate): number {
  if (a.partialPoolProbability !== b.partialPoolProbability) return b.partialPoolProbability - a.partialPoolProbability;
  if (a.qualityPercentile !== b.qualityPercentile) return b.qualityPercentile - a.qualityPercentile;
  if (a.modelProbability !== b.modelProbability) return b.modelProbability - a.modelProbability;
  if (a.market !== b.market) return a.market < b.market ? -1 : 1;
  return a.gamePk - b.gamePk;
}

export function scoreMlbPpHorizonFrozenLiveSlate(input: {
  officialDate: string;
  games: readonly MlbFullModularFrozenLiveGame[];
}): MlbPpHorizonFrozenSlateScore {
  validateClassifierAuthority();
  const candidates: MlbPpHorizonFrozenLiveCandidate[] = [];
  for (const game of input.games) {
    if (game.assessment.officialDate !== input.officialDate) throw new Error("PP_MIXED_OFFICIAL_DATE");
    for (const fullCandidate of scoreMlbFullModularFrozenLiveGame(game)) {
      const enriched = enrichCandidate(fullCandidate, game.assessment.featureVector);
      candidates.push(Object.freeze({
        ...enriched,
        partialPoolProbability: scoreMlbPpHorizonPersistedProbability(enriched),
      }));
    }
  }
  candidates.sort(comparePpCandidate);
  return Object.freeze({
    scorerVersion: MLB_PP_HORIZON_FROZEN_LIVE_SCORER_VERSION,
    officialDate: input.officialDate,
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
    selection: candidates[0] ?? null,
    maximumDailySelections: 1,
    persistedSnapshotOnly: true,
    runtimeRefit: false,
    preprocessingRefit: false,
    outcomesRead: false,
    sportsbookPricesRead: false,
  });
}
