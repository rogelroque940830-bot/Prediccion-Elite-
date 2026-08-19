import type { FullModularLiveReadyAssessment } from "./mlb-full-modular-live-operational-bridge";
import { getMlbFullModularFrozenAuthority } from "./mlb-unified-elite-frozen-authority-v1";

export const MLB_FULL_MODULAR_FROZEN_LIVE_SCORER_VERSION =
  "mlb-full-modular-frozen-live-scorer-v1" as const;

export type MlbFullModularStrengthTier = "STRONG" | "MIDDLE" | "WEAK" | "UNSTABLE";
export type MlbFullModularHorizon = "F3" | "F5" | "FG";
export type MlbFullModularStructure = "SUPPORTIVE" | "MIXED" | "CONFLICTING" | "UNKNOWN";
export type MlbFullModularGeometry = "PROTECTED" | "NEUTRAL_ML" | "AGGRESSIVE";
export type MlbFullModularFrontier = "Q80" | "Q85" | "Q90" | "Q95";
export type MlbFullModularSide = "HOME" | "AWAY";

export const MLB_FULL_MODULAR_VARIANTS = Object.freeze([
  "F3_RL_HOME_PLUS_0_5",
  "F5_ML",
  "F5_RL_HOME_MINUS_0_5",
  "F5_RL_HOME_PLUS_0_5",
  "FG_ML",
  "FG_RL_HOME_MINUS_1_5",
  "FG_RL_HOME_PLUS_1_5",
] as const);

export type MlbFullModularVariant = (typeof MLB_FULL_MODULAR_VARIANTS)[number];

export interface MlbFullModularFrozenLiveGame {
  assessment: FullModularLiveReadyAssessment;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
}

export interface MlbFullModularFrozenLiveCandidate {
  officialDate: string;
  gamePk: number;
  market: MlbFullModularVariant;
  horizon: MlbFullModularHorizon;
  side: MlbFullModularSide;
  selectedLine: number | null;
  lineGeometry: MlbFullModularGeometry;
  strengthTier: MlbFullModularStrengthTier;
  matchupStructure: MlbFullModularStructure;
  structureScore: number | null;
  structureObservedFeatureFraction: number;
  frontier: MlbFullModularFrontier;
  qualityScore: number;
  qualityPercentile: number;
  modelProbability: number;
}

export interface MlbFullModularFrozenSlateScore {
  scorerVersion: typeof MLB_FULL_MODULAR_FROZEN_LIVE_SCORER_VERSION;
  officialDate: string;
  candidateCount: number;
  candidates: readonly MlbFullModularFrozenLiveCandidate[];
  selection: MlbFullModularFrozenLiveCandidate | null;
  maximumDailySelections: 1;
  runtimeRefit: false;
  runtimeThresholdFit: false;
  sameDateStateUpdate: false;
  outcomesRead: false;
  sportsbookPricesRead: false;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function horizonForVariant(variant: MlbFullModularVariant): MlbFullModularHorizon {
  if (variant.startsWith("F3_")) return "F3";
  if (variant.startsWith("F5_")) return "F5";
  return "FG";
}

export function predictMlbFullModularDirectionalProbabilities(
  featureVector: Readonly<Record<string, number>>,
  horizon: MlbFullModularHorizon,
): readonly number[] {
  const authority = getMlbFullModularFrozenAuthority();
  const model = authority.directionalModels[horizon];
  const x: number[] = model.features.map((feature: string, index: number) => {
    const raw = featureVector[feature];
    const value = finite(raw) ? raw : Number(model.median[index]);
    const scale = Number(model.scale[index]);
    return scale > 1e-12 ? (value - Number(model.mean[index])) / scale : 0;
  });
  const logits: number[] = model.weights.map((row: number[]) => {
    let value = Number(row[0]);
    for (let index = 0; index < x.length; index += 1) {
      value += Number(row[index + 1]) * x[index];
    }
    return value;
  });
  logits.push(0);
  const max = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - max));
  const denominator = exponentials.reduce((sum, value) => sum + value, 0);
  const probabilities = exponentials.map((value) => value / denominator);
  if (probabilities.length !== Number(model.classCount)
      || probabilities.some((value) => !finite(value) || value < 0 || value > 1)) {
    throw new Error(`FULL_MODULAR_DIRECTIONAL_PROBABILITY_INVALID:${horizon}`);
  }
  return Object.freeze(probabilities);
}

export function pairMlbFullModularSettlementProbability(
  probabilities: readonly number[],
  horizon: MlbFullModularHorizon,
  variant: MlbFullModularVariant,
): Readonly<{ homeProbability: number; awayProbability: number }> {
  let homeProbability: number;
  let awayProbability: number;
  if (horizon === "F3" || horizon === "F5") {
    if (probabilities.length !== 5) throw new Error(`FULL_MODULAR_CLASS_COUNT_INVALID:${horizon}`);
    const [p0, p1, p2, p3, p4] = probabilities;
    if (variant.endsWith("_ML")) {
      const decisive = Math.max(p0 + p1 + p3 + p4, 1e-12);
      homeProbability = (p3 + p4) / decisive;
      awayProbability = (p0 + p1) / decisive;
    } else if (variant.endsWith("HOME_MINUS_0_5")) {
      homeProbability = p3 + p4;
      awayProbability = p0 + p1 + p2;
    } else if (variant.endsWith("HOME_PLUS_0_5")) {
      homeProbability = p2 + p3 + p4;
      awayProbability = p0 + p1;
    } else {
      throw new Error(`FULL_MODULAR_VARIANT_INVALID:${variant}`);
    }
  } else {
    if (probabilities.length !== 4) throw new Error("FULL_MODULAR_CLASS_COUNT_INVALID:FG");
    const [p0, p1, p2, p3] = probabilities;
    if (variant === "FG_ML") {
      homeProbability = p2 + p3;
      awayProbability = p0 + p1;
    } else if (variant === "FG_RL_HOME_MINUS_1_5") {
      homeProbability = p3;
      awayProbability = p0 + p1 + p2;
    } else if (variant === "FG_RL_HOME_PLUS_1_5") {
      homeProbability = p1 + p2 + p3;
      awayProbability = p0;
    } else {
      throw new Error(`FULL_MODULAR_VARIANT_INVALID:${variant}`);
    }
  }
  return Object.freeze({ homeProbability, awayProbability });
}

export function selectMlbFullModularDirection(input: {
  homeProbability: number;
  awayProbability: number;
  baselineHomeProbability: number;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
}): Readonly<{
  side: MlbFullModularSide;
  qualityScore: number;
  modelProbability: number;
  strengthTier: MlbFullModularStrengthTier;
}> {
  const homeScore = input.homeProbability - input.baselineHomeProbability;
  const awayScore = input.awayProbability - (1 - input.baselineHomeProbability);
  if (homeScore >= awayScore) {
    return Object.freeze({
      side: "HOME",
      qualityScore: homeScore,
      modelProbability: input.homeProbability,
      strengthTier: input.homeStrengthTier,
    });
  }
  return Object.freeze({
    side: "AWAY",
    qualityScore: awayScore,
    modelProbability: input.awayProbability,
    strengthTier: input.awayStrengthTier,
  });
}

export function getMlbFullModularLineGeometry(
  variant: MlbFullModularVariant,
  side: MlbFullModularSide,
): Readonly<{ lineGeometry: MlbFullModularGeometry; selectedLine: number | null }> {
  if (variant === "F5_ML" || variant === "FG_ML") {
    return Object.freeze({ lineGeometry: "NEUTRAL_ML", selectedLine: null });
  }
  const homeLine: Partial<Record<MlbFullModularVariant, number>> = {
    F3_RL_HOME_PLUS_0_5: 0.5,
    F5_RL_HOME_MINUS_0_5: -0.5,
    F5_RL_HOME_PLUS_0_5: 0.5,
    FG_RL_HOME_MINUS_1_5: -1.5,
    FG_RL_HOME_PLUS_1_5: 1.5,
  };
  const raw = homeLine[variant];
  if (!finite(raw)) throw new Error(`FULL_MODULAR_LINE_GEOMETRY_UNKNOWN:${variant}`);
  const selectedLine = side === "HOME" ? raw : -raw;
  return Object.freeze({
    lineGeometry: selectedLine > 0 ? "PROTECTED" : "AGGRESSIVE",
    selectedLine,
  });
}

function standardizedStructureValue(
  featureVector: Readonly<Record<string, number>>,
  feature: string,
  preprocessing: Readonly<Record<string, any>>,
  clipZ: number,
): number {
  const p = preprocessing[feature];
  if (!p) throw new Error(`FULL_MODULAR_STRUCTURE_PREPROCESSING_MISSING:${feature}`);
  const raw = featureVector[feature];
  const value = finite(raw) ? raw : Number(p.median);
  const std = Number(p.std);
  if (!(std > 1e-12)) return 0;
  return Math.max(-clipZ, Math.min(clipZ, (value - Number(p.mean)) / std));
}

export function classifyMlbFullModularStructure(input: {
  featureVector: Readonly<Record<string, number>>;
  side: MlbFullModularSide;
  horizon: MlbFullModularHorizon;
  strengthTier: MlbFullModularStrengthTier;
}): Readonly<{
  matchupStructure: MlbFullModularStructure;
  structureScore: number | null;
  observedFeatureFraction: number;
}> {
  const authority = getMlbFullModularFrozenAuthority();
  const cfg = authority.matchupStructure.config;
  const preprocessing = authority.matchupStructure.preprocessing;
  const requiredRoles: string[] = cfg.requiredRolesByHorizon[input.horizon];
  const roleFeatures = requiredRoles.map((role) => cfg.roles[role] as string[]);
  const total = roleFeatures.reduce((sum, features) => sum + features.length, 0);
  const observedByRole = new Map<string, number>();
  let observed = 0;
  for (let index = 0; index < requiredRoles.length; index += 1) {
    const count = roleFeatures[index].filter((feature) => finite(input.featureVector[feature])).length;
    observedByRole.set(requiredRoles[index], count);
    observed += count;
  }
  const observedFeatureFraction = total ? observed / total : 0;
  const observable = observedFeatureFraction + 1e-15 >= Number(cfg.minimumObservedFeatureFraction)
    && requiredRoles.every((role) => (observedByRole.get(role) ?? 0) >= Number(cfg.minimumObservedFeaturesPerRequiredRole));
  if (!observable) {
    return Object.freeze({ matchupStructure: "UNKNOWN", structureScore: null, observedFeatureFraction });
  }
  const orientation = input.side === "HOME" ? 1 : -1;
  const clipZ = Number(cfg.trainingOnlyPreprocessing.clipZ);
  const roleScores = requiredRoles.map((role) => {
    const values = (cfg.roles[role] as string[]).map((feature) =>
      orientation * standardizedStructureValue(input.featureVector, feature, preprocessing, clipZ));
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  const structureScore = roleScores.reduce((sum, value) => sum + value, 0) / roleScores.length;
  const boundary = authority.matchupStructure.boundariesByHorizonAndTeamState[input.horizon][input.strengthTier];
  const matchupStructure: MlbFullModularStructure = structureScore >= Number(boundary.upper) - 1e-15
    ? "SUPPORTIVE"
    : structureScore <= Number(boundary.lower) + 1e-15
      ? "CONFLICTING"
      : "MIXED";
  return Object.freeze({ matchupStructure, structureScore, observedFeatureFraction });
}

export function resolveMlbFullModularFrontier(input: {
  strengthTier: MlbFullModularStrengthTier;
  matchupStructure: MlbFullModularStructure;
  lineGeometry: MlbFullModularGeometry;
}): MlbFullModularFrontier | "NO_PLAY" {
  const authority = getMlbFullModularFrozenAuthority();
  const matrix = authority.stateStructurePolicy.matrix;
  const order: Array<MlbFullModularFrontier | "NO_PLAY"> = authority.fullModularPolicy.frontierOrder;
  const base = matrix[input.strengthTier][input.matchupStructure] as MlbFullModularFrontier | "NO_PLAY";
  let index = order.indexOf(base);
  if (index < 0) throw new Error(`FULL_MODULAR_FRONTIER_UNKNOWN:${base}`);
  if (input.lineGeometry === "PROTECTED") {
    index = Math.max(0, index - 1);
    const floor = authority.fullModularPolicy.teamStateFloor[input.strengthTier] as MlbFullModularFrontier | "NO_PLAY";
    const floorIndex = order.indexOf(floor);
    if (floorIndex < 0) throw new Error(`FULL_MODULAR_TEAM_STATE_FLOOR_UNKNOWN:${floor}`);
    index = Math.max(index, floorIndex);
  } else if (input.lineGeometry === "AGGRESSIVE") {
    index = Math.min(order.length - 1, index + 1);
  } else if (input.lineGeometry !== "NEUTRAL_ML") {
    throw new Error(`FULL_MODULAR_GEOMETRY_UNKNOWN:${input.lineGeometry}`);
  }
  return order[index];
}

function bisectRight(sortedValues: readonly number[], value: number): number {
  let low = 0;
  let high = sortedValues.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (value < sortedValues[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

function compareCandidate(a: MlbFullModularFrozenLiveCandidate, b: MlbFullModularFrozenLiveCandidate): number {
  if (a.qualityPercentile !== b.qualityPercentile) return b.qualityPercentile - a.qualityPercentile;
  if (a.modelProbability !== b.modelProbability) return b.modelProbability - a.modelProbability;
  if (a.market !== b.market) return a.market < b.market ? -1 : 1;
  return a.gamePk - b.gamePk;
}

export function scoreMlbFullModularFrozenLiveGame(
  game: MlbFullModularFrozenLiveGame,
): readonly MlbFullModularFrozenLiveCandidate[] {
  const authority = getMlbFullModularFrozenAuthority();
  const featureVector = game.assessment.featureVector;
  const probabilities: Record<MlbFullModularHorizon, readonly number[]> = {
    F3: predictMlbFullModularDirectionalProbabilities(featureVector, "F3"),
    F5: predictMlbFullModularDirectionalProbabilities(featureVector, "F5"),
    FG: predictMlbFullModularDirectionalProbabilities(featureVector, "FG"),
  };
  const candidates: MlbFullModularFrozenLiveCandidate[] = [];
  for (const variant of MLB_FULL_MODULAR_VARIANTS) {
    const horizon = horizonForVariant(variant);
    const variantAuthority = authority.variants[variant];
    if (!variantAuthority || variantAuthority.horizon !== horizon) {
      throw new Error(`FULL_MODULAR_VARIANT_AUTHORITY_DRIFT:${variant}`);
    }
    const pair = pairMlbFullModularSettlementProbability(probabilities[horizon], horizon, variant);
    const selected = selectMlbFullModularDirection({
      ...pair,
      baselineHomeProbability: Number(variantAuthority.baselineHomeProbability),
      homeStrengthTier: game.homeStrengthTier,
      awayStrengthTier: game.awayStrengthTier,
    });
    const structure = classifyMlbFullModularStructure({
      featureVector,
      side: selected.side,
      horizon,
      strengthTier: selected.strengthTier,
    });
    const geometry = getMlbFullModularLineGeometry(variant, selected.side);
    const validationScores = (variantAuthority.validationQualityScoresByTeamState[selected.strengthTier] as number[]).map(Number);
    if (validationScores.length === 0) continue;
    const qualityPercentile = bisectRight(validationScores, selected.qualityScore) / validationScores.length;
    const frontier = resolveMlbFullModularFrontier({
      strengthTier: selected.strengthTier,
      matchupStructure: structure.matchupStructure,
      lineGeometry: geometry.lineGeometry,
    });
    if (frontier === "NO_PLAY") continue;
    const rawThreshold = variantAuthority.thresholdsByTeamState[selected.strengthTier]?.[frontier];
    if (rawThreshold === null || rawThreshold === undefined) continue;
    const threshold = Number(rawThreshold);
    if (!finite(threshold)
        || selected.qualityScore <= 0
        || selected.modelProbability < Number(authority.minimumSelectedSideModelProbability)
        || selected.qualityScore + 1e-15 < threshold) {
      continue;
    }
    candidates.push(Object.freeze({
      officialDate: game.assessment.officialDate,
      gamePk: game.assessment.gamePk,
      market: variant,
      horizon,
      side: selected.side,
      selectedLine: geometry.selectedLine,
      lineGeometry: geometry.lineGeometry,
      strengthTier: selected.strengthTier,
      matchupStructure: structure.matchupStructure,
      structureScore: structure.structureScore,
      structureObservedFeatureFraction: structure.observedFeatureFraction,
      frontier,
      qualityScore: selected.qualityScore,
      qualityPercentile,
      modelProbability: selected.modelProbability,
    }));
  }
  candidates.sort(compareCandidate);
  return Object.freeze(candidates);
}

export function scoreMlbFullModularFrozenLiveSlate(input: {
  officialDate: string;
  games: readonly MlbFullModularFrozenLiveGame[];
}): MlbFullModularFrozenSlateScore {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.officialDate)) throw new Error("FULL_MODULAR_OFFICIAL_DATE_INVALID");
  const candidates: MlbFullModularFrozenLiveCandidate[] = [];
  for (const game of input.games) {
    if (game.assessment.officialDate !== input.officialDate) throw new Error("FULL_MODULAR_MIXED_OFFICIAL_DATE");
    candidates.push(...scoreMlbFullModularFrozenLiveGame(game));
  }
  candidates.sort(compareCandidate);
  const selection = candidates.length ? candidates[0] : null;
  return Object.freeze({
    scorerVersion: MLB_FULL_MODULAR_FROZEN_LIVE_SCORER_VERSION,
    officialDate: input.officialDate,
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
    selection,
    maximumDailySelections: 1,
    runtimeRefit: false,
    runtimeThresholdFit: false,
    sameDateStateUpdate: false,
    outcomesRead: false,
    sportsbookPricesRead: false,
  });
}
