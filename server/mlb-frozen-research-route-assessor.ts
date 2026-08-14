import { createHash } from "node:crypto";
import {
  MLB_FROZEN_RESEARCH_ROUTE_IDS,
  MLB_FROZEN_RESEARCH_ROUTER_IDS,
  type MlbFrozenResearchRouteAssessment,
  type MlbFrozenResearchRouteId,
  type MlbFrozenResearchRouteState,
  type MlbFrozenResearchRouterDecision,
  type MlbFrozenResearchRouterId,
} from "./mlb-frozen-research-route-ledger";

export const MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION =
  "mlb-frozen-research-route-assessor.v1" as const;

export interface MlbFrozenRouteClassifierSnapshot {
  premiumA: boolean;
  aPlus: boolean;
  slg: {
    eligible: boolean;
    adv: number | null;
  };
  pitchmix: {
    eligible: boolean;
    contactAdv: number | null;
    whiffAdv: number | null;
    tbpaAdv: number | null;
    hrpaAdv: number | null;
  };
  f5Consensus: boolean;
  bullpenD1Eligible: boolean;
  bullpenPitches1dAdv: number | null;
}

export interface MlbFrozenRouteAssessmentInput {
  gamePk: number;
  gameDate: string;
  scheduledStartTime: string;
  evaluatedAt: string;
  finalInputs: boolean;
  classifiers?: MlbFrozenRouteClassifierSnapshot;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function digest(input: MlbFrozenRouteAssessmentInput): string {
  return createHash("sha256").update(canonical({
    gamePk: input.gamePk,
    gameDate: input.gameDate,
    scheduledStartTime: input.scheduledStartTime,
    evaluatedAt: input.evaluatedAt,
    finalInputs: input.finalInputs,
    classifiers: input.classifiers ?? null,
    scorerVersion: MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION,
  })).digest("hex");
}

function finite(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function emptyRoutes(state: MlbFrozenResearchRouteState): Record<MlbFrozenResearchRouteId, MlbFrozenResearchRouteState> {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id) => [id, state])) as Record<
    MlbFrozenResearchRouteId,
    MlbFrozenResearchRouteState
  >;
}

function emptyRouters(decision: MlbFrozenResearchRouterDecision): Record<MlbFrozenResearchRouterId, MlbFrozenResearchRouterDecision> {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTER_IDS.map((id) => [id, decision])) as Record<
    MlbFrozenResearchRouterId,
    MlbFrozenResearchRouterDecision
  >;
}

function positivePitchmixCount(snapshot: MlbFrozenRouteClassifierSnapshot["pitchmix"]): number {
  const values = [snapshot.contactAdv, snapshot.whiffAdv, snapshot.tbpaAdv, snapshot.hrpaAdv];
  if (!snapshot.eligible) return 0;
  if (values.some((value) => !finite(value))) throw new Error("MLB_FROZEN_ROUTE_PITCHMIX_VALUES_REQUIRED");
  return values.filter((value) => (value as number) > 0).length;
}

function assertClassifierConsistency(snapshot: MlbFrozenRouteClassifierSnapshot): void {
  if (snapshot.aPlus && !snapshot.premiumA) {
    throw new Error("MLB_FROZEN_ROUTE_APLUS_REQUIRES_PREMIUM_A");
  }
  if (snapshot.slg.eligible && !finite(snapshot.slg.adv)) {
    throw new Error("MLB_FROZEN_ROUTE_SLG_ADV_REQUIRED");
  }
  if (snapshot.aPlus && !snapshot.bullpenD1Eligible) {
    throw new Error("MLB_FROZEN_ROUTE_BULLPEN_D1_INELIGIBLE_FOR_APLUS");
  }
  if (snapshot.aPlus && !finite(snapshot.bullpenPitches1dAdv)) {
    throw new Error("MLB_FROZEN_ROUTE_BULLPEN_D1_REQUIRED_FOR_APLUS");
  }
}

export function assessMlbFrozenResearchRoutes(
  input: MlbFrozenRouteAssessmentInput,
): MlbFrozenResearchRouteAssessment {
  if (!Number.isInteger(input.gamePk) || input.gamePk <= 0) throw new Error("MLB_FROZEN_ROUTE_GAME_PK_INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.gameDate)) throw new Error("MLB_FROZEN_ROUTE_GAME_DATE_INVALID");
  if (!Number.isFinite(Date.parse(input.scheduledStartTime)) || !Number.isFinite(Date.parse(input.evaluatedAt))) {
    throw new Error("MLB_FROZEN_ROUTE_TIME_INVALID");
  }
  if (Date.parse(input.evaluatedAt) >= Date.parse(input.scheduledStartTime)) {
    throw new Error("MLB_FROZEN_ROUTE_NOT_PREGAME");
  }

  if (!input.finalInputs) {
    return Object.freeze({
      gamePk: input.gamePk,
      gameDate: input.gameDate,
      scheduledStartTime: input.scheduledStartTime,
      evaluatedAt: input.evaluatedAt,
      finalInputs: false,
      featureSnapshotDigest: digest(input),
      scorerVersion: MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION,
      routes: Object.freeze(emptyRoutes("NOT_EVALUATED")),
      routers: Object.freeze(emptyRouters("NOT_EVALUATED")),
    });
  }

  const snapshot = input.classifiers;
  if (!snapshot) throw new Error("MLB_FROZEN_ROUTE_CLASSIFIERS_REQUIRED");
  assertClassifierConsistency(snapshot);

  const pitchmixCount = snapshot.pitchmix.eligible ? positivePitchmixCount(snapshot.pitchmix) : 0;
  const pitchmixAt2 = snapshot.pitchmix.eligible && pitchmixCount >= 2;
  const slgPos = snapshot.slg.eligible && (snapshot.slg.adv as number) > 0;
  const f5OutsidePremiumA = snapshot.f5Consensus && !snapshot.premiumA;
  const hrpaPos = snapshot.pitchmix.eligible && (snapshot.pitchmix.hrpaAdv as number) > 0;
  const tbpaPos = snapshot.pitchmix.eligible && (snapshot.pitchmix.tbpaAdv as number) > 0;

  const routes: Record<MlbFrozenResearchRouteId, MlbFrozenResearchRouteState> = {
    PREMIUM_A_HOME_ML: snapshot.premiumA ? "MATCH" : "NO_MATCH",
    A_PLUS_HOME_ML: snapshot.aPlus ? "MATCH" : "NO_MATCH",
    A_PLUS_SLG_POS: snapshot.aPlus && slgPos ? "MATCH" : "NO_MATCH",
    A_PLUS_PITCHMIX_AT2: snapshot.aPlus && pitchmixAt2 ? "MATCH" : "NO_MATCH",
    F5_HRPA_OR_AT2: f5OutsidePremiumA && snapshot.pitchmix.eligible && (hrpaPos || pitchmixAt2) ? "MATCH" : "NO_MATCH",
    F5_PARETO_UNION: f5OutsidePremiumA && snapshot.pitchmix.eligible && (hrpaPos || tbpaPos || pitchmixAt2) ? "MATCH" : "NO_MATCH",
  };

  let routerDecision: MlbFrozenResearchRouterDecision = "NOT_APPLICABLE";
  if (snapshot.aPlus) {
    routerDecision = (snapshot.bullpenPitches1dAdv as number) > 0
      ? "FIRST_5_HOME"
      : "FULL_GAME_HOME";
  }

  return Object.freeze({
    gamePk: input.gamePk,
    gameDate: input.gameDate,
    scheduledStartTime: input.scheduledStartTime,
    evaluatedAt: input.evaluatedAt,
    finalInputs: true,
    featureSnapshotDigest: digest(input),
    scorerVersion: MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION,
    routes: Object.freeze(routes),
    routers: Object.freeze({
      A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: routerDecision,
    }),
  });
}
