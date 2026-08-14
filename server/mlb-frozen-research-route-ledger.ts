import { createHash } from "node:crypto";

export const MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA = "courtedge-p0-mlb-frozen-research-route-ledger.v2" as const;

export const MLB_FROZEN_RESEARCH_ROUTE_IDS = [
  "PREMIUM_A_HOME_ML",
  "A_PLUS_HOME_ML",
  "A_PLUS_SLG_POS",
  "A_PLUS_PITCHMIX_AT2",
  "F5_HRPA_OR_AT2",
  "F5_PARETO_UNION",
] as const;

export const MLB_FROZEN_RESEARCH_ROUTER_IDS = [
  "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
] as const;

export type MlbFrozenResearchRouteId = typeof MLB_FROZEN_RESEARCH_ROUTE_IDS[number];
export type MlbFrozenResearchRouteState = "MATCH" | "NO_MATCH" | "NOT_EVALUATED";
export type MlbFrozenResearchRouterId = typeof MLB_FROZEN_RESEARCH_ROUTER_IDS[number];
export type MlbFrozenResearchRouterDecision =
  | "FIRST_5_HOME"
  | "FULL_GAME_HOME"
  | "NOT_APPLICABLE"
  | "NOT_EVALUATED";

export interface MlbFrozenResearchRouteAssessment {
  gamePk: number;
  gameDate: string;
  scheduledStartTime: string;
  evaluatedAt: string;
  finalInputs: boolean;
  featureSnapshotDigest: string;
  scorerVersion: string;
  routes: Record<MlbFrozenResearchRouteId, MlbFrozenResearchRouteState>;
  routers: Record<MlbFrozenResearchRouterId, MlbFrozenResearchRouterDecision>;
}

export interface MlbFrozenResearchRouteLedgerEntry {
  observationId: string;
  sourceRunId: string;
  gamePk: number;
  gameDate: string;
  scheduledStartTime: string;
  evaluatedAt: string;
  capturedAt: string;
  finalInputs: boolean;
  featureSnapshotDigest: string;
  scorerVersion: string;
  routes: Readonly<Record<MlbFrozenResearchRouteId, MlbFrozenResearchRouteState>>;
  routers: Readonly<Record<MlbFrozenResearchRouterId, MlbFrozenResearchRouterDecision>>;
}

export interface MlbFrozenResearchRouteLedger {
  schemaVersion: typeof MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA;
  sourceRunId: string;
  capturedAt: string;
  entries: readonly MlbFrozenResearchRouteLedgerEntry[];
  summary: {
    analysisEligibleGames: number;
    capturedGames: number;
    finalEvaluatedGames: number;
    provisionalNotEvaluatedGames: number;
    captureRetentionPct: number;
    routeMatches: Readonly<Record<MlbFrozenResearchRouteId, number>>;
    routerDecisions: Readonly<Record<MlbFrozenResearchRouterId, Readonly<{
      first5Home: number;
      fullGameHome: number;
      notApplicable: number;
      notEvaluated: number;
    }>>>;
  };
  policy: {
    companionToStep11c: true;
    changesStep11aPopulation: false;
    changesOriginalStep11cPopulation: false;
    allAnalysisEligibleGamesRequireOneRow: true;
    provisionalGamesMayBeDropped: false;
    provisionalRoutesMustBeNotEvaluated: true;
    provisionalRoutersMustBeNotEvaluated: true;
    finalAPlusRequiresRouterDecision: true;
    finalNonAPlusRouterMustBeNotApplicable: true;
    routerDecisionCanRemoveOpportunity: false;
    routerDecisionChangesLiveRecommendation: false;
    routerDecisionProspectiveOnly: true;
    outcomeMayAffectPregameAssessment: false;
    liveFilterChangeAllowed: false;
    rankingChangeAllowed: false;
    stakeChangeAllowed: false;
    betEliteAllowed: false;
    finalBetRecommendationProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validState(value: unknown): value is MlbFrozenResearchRouteState {
  return value === "MATCH" || value === "NO_MATCH" || value === "NOT_EVALUATED";
}

function validRouterDecision(value: unknown): value is MlbFrozenResearchRouterDecision {
  return value === "FIRST_5_HOME"
    || value === "FULL_GAME_HOME"
    || value === "NOT_APPLICABLE"
    || value === "NOT_EVALUATED";
}

function observationId(sourceRunId: string, row: MlbFrozenResearchRouteAssessment): string {
  const raw = `${sourceRunId}|${row.gameDate}|${row.gamePk}|${row.featureSnapshotDigest}`;
  return `mlb-route-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function assertRouteShape(row: MlbFrozenResearchRouteAssessment): void {
  const keys = Object.keys(row.routes).sort();
  const expected = [...MLB_FROZEN_RESEARCH_ROUTE_IDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`MLB_FROZEN_ROUTE_KEYS_INVALID:${row.gamePk}`);
  }
  for (const routeId of MLB_FROZEN_RESEARCH_ROUTE_IDS) {
    if (!validState(row.routes[routeId])) throw new Error(`MLB_FROZEN_ROUTE_STATE_INVALID:${row.gamePk}:${routeId}`);
  }
  if (!row.finalInputs && MLB_FROZEN_RESEARCH_ROUTE_IDS.some((routeId) => row.routes[routeId] !== "NOT_EVALUATED")) {
    throw new Error(`MLB_FROZEN_ROUTE_PROVISIONAL_MUST_NOT_EVALUATE:${row.gamePk}`);
  }
  if (row.finalInputs && MLB_FROZEN_RESEARCH_ROUTE_IDS.some((routeId) => row.routes[routeId] === "NOT_EVALUATED")) {
    throw new Error(`MLB_FROZEN_ROUTE_FINAL_MUST_EVALUATE_ALL:${row.gamePk}`);
  }
}

function assertRouterShape(row: MlbFrozenResearchRouteAssessment): void {
  const keys = Object.keys(row.routers).sort();
  const expected = [...MLB_FROZEN_RESEARCH_ROUTER_IDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`MLB_FROZEN_ROUTER_KEYS_INVALID:${row.gamePk}`);
  }
  for (const routerId of MLB_FROZEN_RESEARCH_ROUTER_IDS) {
    if (!validRouterDecision(row.routers[routerId])) {
      throw new Error(`MLB_FROZEN_ROUTER_DECISION_INVALID:${row.gamePk}:${routerId}`);
    }
  }

  if (!row.finalInputs) {
    if (MLB_FROZEN_RESEARCH_ROUTER_IDS.some((routerId) => row.routers[routerId] !== "NOT_EVALUATED")) {
      throw new Error(`MLB_FROZEN_ROUTER_PROVISIONAL_MUST_NOT_EVALUATE:${row.gamePk}`);
    }
    return;
  }

  if (MLB_FROZEN_RESEARCH_ROUTER_IDS.some((routerId) => row.routers[routerId] === "NOT_EVALUATED")) {
    throw new Error(`MLB_FROZEN_ROUTER_FINAL_MUST_EVALUATE_ALL:${row.gamePk}`);
  }

  const v15 = row.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1;
  const isAPlus = row.routes.A_PLUS_HOME_ML === "MATCH";
  if (isAPlus && v15 !== "FIRST_5_HOME" && v15 !== "FULL_GAME_HOME") {
    throw new Error(`MLB_FROZEN_ROUTER_APLUS_DECISION_REQUIRED:${row.gamePk}`);
  }
  if (!isAPlus && v15 !== "NOT_APPLICABLE") {
    throw new Error(`MLB_FROZEN_ROUTER_NON_APLUS_MUST_NOT_APPLY:${row.gamePk}`);
  }
}

export function captureMlbFrozenResearchRouteLedger(input: {
  sourceRunId: string;
  capturedAt: string;
  analysisEligibleGamePks: readonly number[];
  assessments: readonly MlbFrozenResearchRouteAssessment[];
}): MlbFrozenResearchRouteLedger {
  if (!input.sourceRunId.trim()) throw new Error("MLB_FROZEN_ROUTE_SOURCE_RUN_INVALID");
  if (!validIso(input.capturedAt)) throw new Error("MLB_FROZEN_ROUTE_CAPTURE_TIME_INVALID");
  const expected = new Set<number>();
  for (const gamePk of input.analysisEligibleGamePks) {
    if (!Number.isInteger(gamePk) || gamePk <= 0 || expected.has(gamePk)) throw new Error("MLB_FROZEN_ROUTE_ELIGIBLE_GAME_SET_INVALID");
    expected.add(gamePk);
  }
  if (input.assessments.length !== expected.size) throw new Error("MLB_FROZEN_ROUTE_COVERAGE_COUNT_MISMATCH");

  const seen = new Set<number>();
  const entries: MlbFrozenResearchRouteLedgerEntry[] = [];
  for (const row of input.assessments) {
    if (!expected.has(row.gamePk) || seen.has(row.gamePk)) throw new Error(`MLB_FROZEN_ROUTE_GAME_IDENTITY_INVALID:${row.gamePk}`);
    seen.add(row.gamePk);
    if (!validDate(row.gameDate) || !validIso(row.scheduledStartTime) || !validIso(row.evaluatedAt)
      || !validDigest(row.featureSnapshotDigest) || !row.scorerVersion.trim()) {
      throw new Error(`MLB_FROZEN_ROUTE_PREGAME_EVIDENCE_INVALID:${row.gamePk}`);
    }
    if (Date.parse(row.evaluatedAt) >= Date.parse(row.scheduledStartTime)) {
      throw new Error(`MLB_FROZEN_ROUTE_NOT_PREGAME:${row.gamePk}`);
    }
    if (Date.parse(input.capturedAt) >= Date.parse(row.scheduledStartTime)) {
      throw new Error(`MLB_FROZEN_ROUTE_CAPTURE_NOT_PREGAME:${row.gamePk}`);
    }
    assertRouteShape(row);
    assertRouterShape(row);
    entries.push(Object.freeze({
      observationId: observationId(input.sourceRunId, row),
      sourceRunId: input.sourceRunId,
      gamePk: row.gamePk,
      gameDate: row.gameDate,
      scheduledStartTime: row.scheduledStartTime,
      evaluatedAt: row.evaluatedAt,
      capturedAt: input.capturedAt,
      finalInputs: row.finalInputs,
      featureSnapshotDigest: row.featureSnapshotDigest,
      scorerVersion: row.scorerVersion,
      routes: Object.freeze({ ...row.routes }),
      routers: Object.freeze({ ...row.routers }),
    }));
  }
  if (seen.size !== expected.size) throw new Error("MLB_FROZEN_ROUTE_SILENT_GAME_DROP");
  entries.sort((a, b) => a.scheduledStartTime.localeCompare(b.scheduledStartTime) || a.gamePk - b.gamePk);

  const routeMatches = Object.fromEntries(
    MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id) => [id, entries.filter((row) => row.routes[id] === "MATCH").length]),
  ) as Record<MlbFrozenResearchRouteId, number>;

  const routerDecisions = Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTER_IDS.map((id) => [id, Object.freeze({
    first5Home: entries.filter((row) => row.routers[id] === "FIRST_5_HOME").length,
    fullGameHome: entries.filter((row) => row.routers[id] === "FULL_GAME_HOME").length,
    notApplicable: entries.filter((row) => row.routers[id] === "NOT_APPLICABLE").length,
    notEvaluated: entries.filter((row) => row.routers[id] === "NOT_EVALUATED").length,
  })])) as Record<MlbFrozenResearchRouterId, Readonly<{
    first5Home: number;
    fullGameHome: number;
    notApplicable: number;
    notEvaluated: number;
  }>>;

  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    schemaVersion: MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
    sourceRunId: input.sourceRunId,
    capturedAt: input.capturedAt,
    entries: frozenEntries,
    summary: Object.freeze({
      analysisEligibleGames: expected.size,
      capturedGames: entries.length,
      finalEvaluatedGames: entries.filter((row) => row.finalInputs).length,
      provisionalNotEvaluatedGames: entries.filter((row) => !row.finalInputs).length,
      captureRetentionPct: expected.size ? entries.length / expected.size * 100 : 100,
      routeMatches: Object.freeze(routeMatches),
      routerDecisions: Object.freeze(routerDecisions),
    }),
    policy: Object.freeze({
      companionToStep11c: true,
      changesStep11aPopulation: false,
      changesOriginalStep11cPopulation: false,
      allAnalysisEligibleGamesRequireOneRow: true,
      provisionalGamesMayBeDropped: false,
      provisionalRoutesMustBeNotEvaluated: true,
      provisionalRoutersMustBeNotEvaluated: true,
      finalAPlusRequiresRouterDecision: true,
      finalNonAPlusRouterMustBeNotApplicable: true,
      routerDecisionCanRemoveOpportunity: false,
      routerDecisionChangesLiveRecommendation: false,
      routerDecisionProspectiveOnly: true,
      outcomeMayAffectPregameAssessment: false,
      liveFilterChangeAllowed: false,
      rankingChangeAllowed: false,
      stakeChangeAllowed: false,
      betEliteAllowed: false,
      finalBetRecommendationProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    }),
  });
}
