// The two JSON files below are frozen scientific authorities and are bundled by esbuild/tsx.
// @ts-ignore -- TypeScript resolveJsonModule is intentionally not enabled repo-wide.
import authorityJson from "../research/mlb-unified-elite-live-authority-v1.json";
// @ts-ignore -- TypeScript resolveJsonModule is intentionally not enabled repo-wide.
import ppSnapshotJson from "../research/mlb-full-modular-pp-horizon-model-snapshot-v1.json";
import {
  MLB_FROZEN_PREMIUM_A_THRESHOLDS,
  scoreMlbFrozenClassifierModel,
  type MlbFrozenClassifierFeatureSnapshot,
} from "./mlb-frozen-a-plus-classifier";
import type { FullModularLiveOperationalReady } from "./mlb-full-modular-live-operational-bridge";
import type {
  EliteSelectionInput,
  MlbUnifiedEliteLowerTierShadowDecisions as _Unused,
} from "./mlb-unified-elite-router-v1";
import type { MlbUnifiedEliteLowerTierShadowDecisions } from "./mlb-unified-elite-shadow-v1";

export const MLB_UNIFIED_ELITE_LOWER_TIER_SCORER_VERSION =
  "mlb-unified-elite-lower-tier-scorer-v1" as const;

export type MlbFullModularStrengthTier = "STRONG" | "MIDDLE" | "WEAK" | "UNSTABLE";
export type MlbFullModularHorizon = "F3" | "F5" | "FG";
export type MlbFullModularStructure = "SUPPORTIVE" | "MIXED" | "CONFLICTING" | "UNKNOWN";
export type MlbFullModularGeometry = "PROTECTED" | "NEUTRAL_ML" | "AGGRESSIVE";

export interface MlbUnifiedEliteLowerTierScorerGame {
  assessment: FullModularLiveOperationalReady;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
}

export interface MlbFullModularLiveCandidate extends EliteSelectionInput {
  strengthTier: MlbFullModularStrengthTier;
  matchupStructure: MlbFullModularStructure;
  lineGeometry: MlbFullModularGeometry;
  frontier: "Q80" | "Q85" | "Q90" | "Q95";
  structureScore: number;
  structureObservedFeatureFraction: number;
  qualityScore: number;
  qualityPercentile: number;
  modelProbability: number;
  premium_core_support_count_0_to_3: number;
  premium_core_weakest_margin: number;
  frozen_c4_selected_side_probability: number;
  frozen_full13_selected_side_probability: number;
  sel_starter_kbb_adv: number;
  sel_team_win10_diff: number;
  sel_lineup_exposure_rate_adv: number;
  sel_team_ra10_adv: number;
  sel_starter_runrisk_adv: number;
  partialPoolProbability?: number;
}

export interface MlbUnifiedEliteLowerTierScoreResult {
  scorerVersion: typeof MLB_UNIFIED_ELITE_LOWER_TIER_SCORER_VERSION;
  officialDate: string;
  decisions: MlbUnifiedEliteLowerTierShadowDecisions;
  fullModularCandidateCount: number;
  fullModularSelection: MlbFullModularLiveCandidate | null;
  ppHorizonSelection: MlbFullModularLiveCandidate | null;
  runtimeRefit: false;
  runtimeThresholdFit: false;
  outcomesRead: false;
  sportsbookPricesRead: false;
}

type J = Record<string, any>;
const AUTHORITY = authorityJson as J;
const PP = ppSnapshotJson as J;
const VARIANTS = [
  "F3_RL_HOME_PLUS_0_5",
  "F5_ML",
  "F5_RL_HOME_MINUS_0_5",
  "F5_RL_HOME_PLUS_0_5",
  "FG_ML",
  "FG_RL_HOME_MINUS_1_5",
  "FG_RL_HOME_PLUS_1_5",
] as const;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sigmoid(logit: number): number {
  if (logit >= 0) {
    const e = Math.exp(-logit);
    return 1 / (1 + e);
  }
  const e = Math.exp(logit);
  return e / (1 + e);
}

function validateFrozenAuthorities(): void {
  if (AUTHORITY.schemaVersion !== "courtedge-mlb-unified-elite-live-authority.v1") throw new Error("FULL_MODULAR_AUTHORITY_SCHEMA_INVALID");
  if (AUTHORITY.runtimePolicy?.runtimeRefitAllowed !== false) throw new Error("FULL_MODULAR_RUNTIME_REFIT_BOUNDARY_DRIFT");
  if (AUTHORITY.runtimePolicy?.runtimeThresholdFitAllowed !== false) throw new Error("FULL_MODULAR_RUNTIME_THRESHOLD_BOUNDARY_DRIFT");
  if (AUTHORITY.runtimePolicy?.outcomeInputAllowed !== false) throw new Error("FULL_MODULAR_OUTCOME_BOUNDARY_DRIFT");
  if (AUTHORITY.runtimePolicy?.sportsbookPriceInputAllowed !== false) throw new Error("FULL_MODULAR_PRICE_BOUNDARY_DRIFT");
  if (AUTHORITY.minimumSelectedSideModelProbability !== 0.6) throw new Error("FULL_MODULAR_MIN_PROBABILITY_DRIFT");
  if (PP.schemaVersion !== "courtedge-mlb-full-modular-pp-horizon-model-snapshot.v1") throw new Error("PP_SNAPSHOT_SCHEMA_INVALID");
  if (PP.model?.parameterPayloadDigest !== "sha256:02f64630d94f5951fa684294e879937d1ad531acc6ecdedf56fc3b225526b275") throw new Error("PP_SNAPSHOT_PARAMETER_DIGEST_DRIFT");
  if (PP.postSnapshotAuthority?.modelRefitAllowed !== false || PP.postSnapshotAuthority?.preprocessingRefitAllowed !== false) throw new Error("PP_REFIT_BOUNDARY_DRIFT");
  if (!Array.isArray(PP.model?.featureNames) || !Array.isArray(PP.model?.rawCoefficients) || PP.model.featureNames.length !== 49 || PP.model.rawCoefficients.length !== 49) throw new Error("PP_FEATURE_COUNT_DRIFT");
  for (const horizon of ["F3", "F5", "FG"]) {
    const model = AUTHORITY.directionalModels?.[horizon];
    if (!model || !Array.isArray(model.features) || !Array.isArray(model.median) || !Array.isArray(model.mean) || !Array.isArray(model.scale) || !Array.isArray(model.weights)) throw new Error(`FULL_MODULAR_DIRECTIONAL_AUTHORITY_MISSING:${horizon}`);
    if (![4,5].includes(Number(model.classCount))) throw new Error(`FULL_MODULAR_CLASS_COUNT_INVALID:${horizon}`);
    if (model.features.length !== model.median.length || model.features.length !== model.mean.length || model.features.length !== model.scale.length) throw new Error(`FULL_MODULAR_DIRECTIONAL_PREPROCESSING_DRIFT:${horizon}`);
    if (model.weights.length !== Number(model.classCount) - 1) throw new Error(`FULL_MODULAR_DIRECTIONAL_WEIGHT_ROWS_DRIFT:${horizon}`);
  }
}

function standardizedVector(featureVector: Record<string, number>, model: J): number[] {
  return model.features.map((name: string, i: number) => {
    const raw = featureVector[name];
    const value = finite(raw) ? raw : Number(model.median[i]);
    const scale = Number(model.scale[i]);
    return Math.abs(scale) <= 1e-12 ? 0 : (value - Number(model.mean[i])) / scale;
  });
}

function multinomialProbabilities(featureVector: Record<string, number>, horizon: MlbFullModularHorizon): number[] {
  const model = AUTHORITY.directionalModels[horizon];
  const x = standardizedVector(featureVector, model);
  const logits = model.weights.map((row: number[]) => {
    let z = Number(row[0]);
    for (let i = 0; i < x.length; i += 1) z += Number(row[i + 1]) * x[i];
    return z;
  });
  logits.push(0);
  const max = Math.max(...logits);
  const exp = logits.map((z: number) => Math.exp(z - max));
  const denom = exp.reduce((a: number, b: number) => a + b, 0);
  return exp.map((e: number) => e / denom);
}

function pairProbability(prob: number[], horizon: MlbFullModularHorizon, variant: string): [number, number] {
  if (horizon === "F3" || horizon === "F5") {
    const [p0,p1,p2,p3,p4] = prob;
    if (variant.endsWith("_ML")) {
      const decisive = Math.max(p0 + p1 + p3 + p4, 1e-12);
      return [(p3+p4)/decisive,(p0+p1)/decisive];
    }
    if (variant.endsWith("HOME_MINUS_0_5")) return [p3+p4,p0+p1+p2];
    if (variant.endsWith("HOME_PLUS_0_5")) return [p2+p3+p4,p0+p1];
  }
  if (horizon === "FG") {
    const [p0,p1,p2,p3] = prob;
    if (variant === "FG_ML") return [p2+p3,p0+p1];
    if (variant === "FG_RL_HOME_MINUS_1_5") return [p3,p0+p1+p2];
    if (variant === "FG_RL_HOME_PLUS_1_5") return [p1+p2+p3,p0];
  }
  throw new Error(`FULL_MODULAR_UNKNOWN_VARIANT:${variant}`);
}

function selectedLineAndGeometry(variant: string, side: "HOME" | "AWAY"): [number | null, MlbFullModularGeometry] {
  if (variant === "F5_ML" || variant === "FG_ML") return [null,"NEUTRAL_ML"];
  const homeLine: Record<string, number> = {
    F3_RL_HOME_PLUS_0_5: 0.5,
    F5_RL_HOME_MINUS_0_5: -0.5,
    F5_RL_HOME_PLUS_0_5: 0.5,
    FG_RL_HOME_MINUS_1_5: -1.5,
    FG_RL_HOME_PLUS_1_5: 1.5,
  };
  if (!Object.prototype.hasOwnProperty.call(homeLine, variant)) throw new Error(`FULL_MODULAR_LINE_GEOMETRY_UNKNOWN:${variant}`);
  const line = side === "HOME" ? homeLine[variant] : -homeLine[variant];
  return [line, line > 0 ? "PROTECTED" : "AGGRESSIVE"];
}

function structure(featureVector: Record<string, number>, side: "HOME" | "AWAY", horizon: MlbFullModularHorizon, tier: MlbFullModularStrengthTier): { state: MlbFullModularStructure; score: number; observedFraction: number } {
  const cfg = AUTHORITY.matchupStructure.config;
  const prep = AUTHORITY.matchupStructure.preprocessing;
  const roles: string[] = cfg.requiredRolesByHorizon[horizon];
  const featureGroups = roles.map((role) => cfg.roles[role] as string[]);
  const total = featureGroups.reduce((sum, fields) => sum + fields.length, 0);
  let observed = 0;
  const observedByRole: Record<string, number> = {};
  for (let i=0;i<roles.length;i+=1) {
    const count = featureGroups[i].filter((name) => finite(featureVector[name])).length;
    observedByRole[roles[i]] = count;
    observed += count;
  }
  const observedFraction = total ? observed / total : 0;
  const observable = observedFraction + 1e-15 >= Number(cfg.minimumObservedFeatureFraction)
    && roles.every((role) => observedByRole[role] >= Number(cfg.minimumObservedFeaturesPerRequiredRole));
  if (!observable) return { state:"UNKNOWN",score:0,observedFraction };
  const orientation = side === "HOME" ? 1 : -1;
  const roleScores = roles.map((role) => {
    const values = (cfg.roles[role] as string[]).map((name) => {
      const p = prep[name];
      const raw = featureVector[name];
      const x = finite(raw) ? raw : Number(p.median);
      const std = Number(p.std);
      const z = std <= 1e-12 ? 0 : Math.max(-Number(cfg.trainingOnlyPreprocessing.clipZ), Math.min(Number(cfg.trainingOnlyPreprocessing.clipZ), (x-Number(p.mean))/std));
      return orientation * z;
    });
    return values.reduce((a,b)=>a+b,0)/values.length;
  });
  const score = roleScores.reduce((a,b)=>a+b,0)/roleScores.length;
  const boundary = AUTHORITY.matchupStructure.boundariesByHorizonAndTeamState[horizon][tier];
  const state: MlbFullModularStructure = score >= Number(boundary.upper)-1e-15
    ? "SUPPORTIVE"
    : score <= Number(boundary.lower)+1e-15
      ? "CONFLICTING"
      : "MIXED";
  return { state, score, observedFraction };
}

function resolveFrontier(tier: MlbFullModularStrengthTier, state: MlbFullModularStructure, geometry: MlbFullModularGeometry): "Q80"|"Q85"|"Q90"|"Q95"|"NO_PLAY" {
  const order = AUTHORITY.fullModularPolicy.frontierOrder as Array<"Q80"|"Q85"|"Q90"|"Q95"|"NO_PLAY">;
  const base = AUTHORITY.stateStructurePolicy.matrix[tier][state] as (typeof order)[number];
  let index = order.indexOf(base);
  if (index < 0) throw new Error(`FULL_MODULAR_FRONTIER_UNKNOWN:${base}`);
  if (geometry === "PROTECTED") {
    index = Math.max(0,index-1);
    const floor = AUTHORITY.fullModularPolicy.teamStateFloor[tier] as (typeof order)[number];
    const floorIndex = order.indexOf(floor);
    if (floorIndex < 0) throw new Error(`FULL_MODULAR_FLOOR_UNKNOWN:${floor}`);
    index = Math.max(index,floorIndex);
  } else if (geometry === "AGGRESSIVE") {
    index = Math.min(order.length-1,index+1);
  }
  return order[index];
}

function bisectRight(sorted: number[], value: number): number {
  let lo=0,hi=sorted.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(value<sorted[mid])hi=mid;else lo=mid+1;}
  return lo;
}

function selectedFeature(featureVector: Record<string, number>, name: string, side: "HOME"|"AWAY"): number {
  const raw = featureVector[name];
  if (!finite(raw)) throw new Error(`PP_REQUIRED_FEATURE_MISSING:${name}`);
  return (name.endsWith("_adv") || name.endsWith("_diff")) && side === "AWAY" ? -raw : raw;
}

function addHeritage(candidate: Omit<MlbFullModularLiveCandidate,
  "premium_core_support_count_0_to_3"|"premium_core_weakest_margin"|"frozen_c4_selected_side_probability"|"frozen_full13_selected_side_probability"|"sel_starter_kbb_adv"|"sel_team_win10_diff"|"sel_lineup_exposure_rate_adv"|"sel_team_ra10_adv"|"sel_starter_runrisk_adv">,
  featureVector: Record<string, number>,
): MlbFullModularLiveCandidate {
  const side = candidate.side as "HOME"|"AWAY";
  const selected = {
    starter_kbb_adv: selectedFeature(featureVector,"starter_kbb_adv",side),
    team_win10_diff: selectedFeature(featureVector,"team_win10_diff",side),
    lineup_exposure_rate_adv: selectedFeature(featureVector,"lineup_exposure_rate_adv",side),
    team_ra10_adv: selectedFeature(featureVector,"team_ra10_adv",side),
    starter_runrisk_adv: selectedFeature(featureVector,"starter_runrisk_adv",side),
  };
  const pillars: Array<keyof typeof MLB_FROZEN_PREMIUM_A_THRESHOLDS> = ["team_win10_diff","starter_kbb_adv","lineup_exposure_rate_adv"];
  let supports=0;
  const margins:number[]=[];
  for(const feature of pillars){
    const threshold=Number(MLB_FROZEN_PREMIUM_A_THRESHOLDS[feature]);
    const raw=selected[feature];
    if(raw>=threshold)supports+=1;
    const std=Number(AUTHORITY.premiumHeritageTrainingStats[feature].std);
    if(!(std>1e-12))throw new Error(`PP_PREMIUM_STD_INVALID:${feature}`);
    margins.push((raw-threshold)/std);
  }
  const snapshot = featureVector as MlbFrozenClassifierFeatureSnapshot;
  const c4Home=scoreMlbFrozenClassifierModel("A_PLUS_C4_2022_FROZEN",snapshot);
  const fullHome=scoreMlbFrozenClassifierModel("A_PLUS_FULL13_2022_FROZEN",snapshot);
  return {
    ...candidate,
    premium_core_support_count_0_to_3:supports,
    premium_core_weakest_margin:Math.min(...margins),
    frozen_c4_selected_side_probability:side==="HOME"?c4Home:1-c4Home,
    frozen_full13_selected_side_probability:side==="HOME"?fullHome:1-fullHome,
    sel_starter_kbb_adv:selected.starter_kbb_adv,
    sel_team_win10_diff:selected.team_win10_diff,
    sel_lineup_exposure_rate_adv:selected.lineup_exposure_rate_adv,
    sel_team_ra10_adv:selected.team_ra10_adv,
    sel_starter_runrisk_adv:selected.starter_runrisk_adv,
  };
}

function candidateRows(game: MlbUnifiedEliteLowerTierScorerGame): MlbFullModularLiveCandidate[] {
  const assessment=game.assessment;
  const featureVector=assessment.featureVector as Record<string,number>;
  const probabilities: Record<MlbFullModularHorizon,number[]> = {
    F3:multinomialProbabilities(featureVector,"F3"),
    F5:multinomialProbabilities(featureVector,"F5"),
    FG:multinomialProbabilities(featureVector,"FG"),
  };
  const result:MlbFullModularLiveCandidate[]=[];
  for(const variant of VARIANTS){
    const v=AUTHORITY.variants[variant];
    const horizon=v.horizon as MlbFullModularHorizon;
    const [homeProbability,awayProbability]=pairProbability(probabilities[horizon],horizon,variant);
    const baselineHome=Number(v.baselineHomeProbability);
    const homeScore=homeProbability-baselineHome;
    const awayScore=awayProbability-(1-baselineHome);
    const side:"HOME"|"AWAY"=homeScore>=awayScore?"HOME":"AWAY";
    const qualityScore=side==="HOME"?homeScore:awayScore;
    const modelProbability=side==="HOME"?homeProbability:awayProbability;
    const tier=side==="HOME"?game.homeStrengthTier:game.awayStrengthTier;
    const s=structure(featureVector,side,horizon,tier);
    const [selectedLine,lineGeometry]=selectedLineAndGeometry(variant,side);
    const scores=(v.validationQualityScoresByTeamState[tier] as number[]).map(Number);
    if(scores.length===0)continue;
    const qualityPercentile=bisectRight(scores,qualityScore)/scores.length;
    const frontier=resolveFrontier(tier,s.state,lineGeometry);
    if(frontier==="NO_PLAY")continue;
    const threshold=Number(v.thresholdsByTeamState[tier][frontier]);
    if(!finite(threshold) || qualityScore<=0 || modelProbability<Number(AUTHORITY.minimumSelectedSideModelProbability) || qualityScore+1e-15<threshold)continue;
    const base={
      officialDate:assessment.officialDate,
      gamePk:assessment.gamePk,
      market:variant,
      horizon,
      side,
      selectedLine,
      strengthTier:tier,
      matchupStructure:s.state,
      lineGeometry,
      frontier,
      structureScore:s.score,
      structureObservedFeatureFraction:s.observedFraction,
      qualityScore,
      qualityPercentile,
      modelProbability,
    } as const;
    result.push(addHeritage(base,featureVector));
  }
  return result;
}

function compareControl(a:MlbFullModularLiveCandidate,b:MlbFullModularLiveCandidate):number{
  return (b.qualityPercentile-a.qualityPercentile)||(b.modelProbability-a.modelProbability)||a.market.localeCompare(b.market)||(a.gamePk-b.gamePk);
}

function zNumeric(candidate:MlbFullModularLiveCandidate,field:string):number{
  const prep=PP.model.preprocessing[field];
  if(!prep)throw new Error(`PP_PREPROCESSING_MISSING:${field}`);
  let x=(candidate as any)[field];
  if(!finite(x))x=Number(prep.median);
  const std=Number(prep.std);
  if(std<=1e-12)return 0;
  return Math.max(-Number(prep.clip),Math.min(Number(prep.clip),(x-Number(prep.mean))/std));
}

function ppDesignValue(name:string,c:MlbFullModularLiveCandidate):number{
  if(name.startsWith("GLOBAL::")){
    const rest=name.slice("GLOBAL::".length);
    const eq=rest.indexOf("=");
    if(eq>=0){const field=rest.slice(0,eq);const level=rest.slice(eq+1);return String((c as any)[field])===level?1:0;}
    return zNumeric(c,rest);
  }
  const match=/^DEV::horizon=(F3|F5|FG)::(.+)$/.exec(name);
  if(!match)throw new Error(`PP_FEATURE_NAME_UNKNOWN:${name}`);
  const active=c.horizon===match[1];
  if(!active)return 0;
  if(match[2]==="INTERCEPT")return Number(PP.model.groupInterceptFeatureScale);
  return Number(PP.model.signalDeviationFeatureScale)*zNumeric(c,match[2]);
}

export function scoreFrozenPpHorizonCandidate(candidate:MlbFullModularLiveCandidate):number{
  validateFrozenAuthorities();
  let logit=Number(PP.model.intercept);
  for(let i=0;i<PP.model.featureNames.length;i+=1){
    logit+=Number(PP.model.rawCoefficients[i])*ppDesignValue(String(PP.model.featureNames[i]),candidate);
  }
  const p=sigmoid(logit);
  if(!finite(p))throw new Error("PP_RUNTIME_PROBABILITY_NONFINITE");
  return p;
}

export function scoreUnifiedEliteLowerTierDecisions(input:{officialDate:string;games:readonly MlbUnifiedEliteLowerTierScorerGame[]}):MlbUnifiedEliteLowerTierScoreResult{
  validateFrozenAuthorities();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.officialDate))throw new Error("LOWER_TIER_DATE_INVALID");
  for(const game of input.games){if(game.assessment.officialDate!==input.officialDate)throw new Error("LOWER_TIER_MIXED_OFFICIAL_DATE");}
  const candidates=input.games.flatMap(candidateRows).sort(compareControl);
  const full=candidates[0]??null;
  let pp:MlbFullModularLiveCandidate|null=null;
  try{
    const scored=candidates.map((row)=>({...row,partialPoolProbability:scoreFrozenPpHorizonCandidate(row)}));
    scored.sort((a,b)=>(Number(b.partialPoolProbability)-Number(a.partialPoolProbability))||compareControl(a,b));
    pp=scored[0]??null;
  }catch(error){
    const message=String((error as Error)?.message??"");
    return Object.freeze({
      scorerVersion:MLB_UNIFIED_ELITE_LOWER_TIER_SCORER_VERSION,
      officialDate:input.officialDate,
      decisions:Object.freeze({
        ppHorizon:Object.freeze({status:"TECHNICAL_UNAVAILABLE" as const,reason:message.startsWith("PP_REQUIRED_FEATURE_MISSING")?"PP_REQUIRED_FEATURE_MISSING" as const:"PP_RUNTIME_INTEGRITY_FAILED" as const}),
        fullModular:full?Object.freeze({status:"SELECTION" as const,selection:full}):Object.freeze({status:"NO_PLAY" as const,reason:"NO_FULL_MODULAR_SELECTION"}),
        sourceStatus:"FROZEN_SCORER_PP_FAILED_CLOSED",
      }),
      fullModularCandidateCount:candidates.length,
      fullModularSelection:full,
      ppHorizonSelection:null,
      runtimeRefit:false,runtimeThresholdFit:false,outcomesRead:false,sportsbookPricesRead:false,
    });
  }
  return Object.freeze({
    scorerVersion:MLB_UNIFIED_ELITE_LOWER_TIER_SCORER_VERSION,
    officialDate:input.officialDate,
    decisions:Object.freeze({
      ppHorizon:pp?Object.freeze({status:"SELECTION" as const,selection:pp}):Object.freeze({status:"NO_PLAY" as const,reason:"NO_PP_SELECTION"}),
      fullModular:full?Object.freeze({status:"SELECTION" as const,selection:full}):Object.freeze({status:"NO_PLAY" as const,reason:"NO_FULL_MODULAR_SELECTION"}),
      sourceStatus:"FROZEN_FULL_MODULAR_AND_PP_HORIZON_SCORED",
    }),
    fullModularCandidateCount:candidates.length,
    fullModularSelection:full,
    ppHorizonSelection:pp,
    runtimeRefit:false,runtimeThresholdFit:false,outcomesRead:false,sportsbookPricesRead:false,
  });
}
