import type {
  MlbShortlistCandidate,
  MlbShortlistComponent,
  MlbShortlistNativeSignal,
  MlbShortlistResult,
} from "./mlb-shortlist";

export const MLB_INTRINSIC_EDGE_SCHEMA = "courtedge-p0-mlb-intrinsic-edge.v2" as const;

export type MlbIntrinsicComponent = MlbShortlistComponent | "BULLPEN";
export type MlbIntrinsicTarget = "HOME_RUNS" | "AWAY_RUNS" | "TOTAL_RUNS";
export type MlbIntrinsicDirection = "UP" | "DOWN";
export type MlbIntrinsicHorizon = "EARLY_STARTER" | "CROSS_HORIZON" | "LATE_BULLPEN";
export type MlbIntrinsicProjectionScope = "FULL_GAME" | "EARLY_WINDOW";
export type MlbIntrinsicPressureState =
  | "NONE"
  | "SINGLE_UP"
  | "SINGLE_DOWN"
  | "CONVERGENT_UP"
  | "CONVERGENT_DOWN"
  | "CONFLICTED";
export type MlbIntrinsicThesisKind =
  | "HOME_TEAM_RUNS_UP"
  | "HOME_TEAM_RUNS_DOWN"
  | "AWAY_TEAM_RUNS_UP"
  | "AWAY_TEAM_RUNS_DOWN"
  | "HOME_SIDE"
  | "AWAY_SIDE"
  | "TOTAL_OVER"
  | "TOTAL_UNDER";
export type MlbIntrinsicThesisStructure =
  | "MULTI_SOURCE_SINGLE_AXIS"
  | "TWO_SIDED_SEPARATION"
  | "MULTI_AXIS_CONVERGENCE";
export type MlbIntrinsicMarketSearchIntent = "SIDE" | "TOTAL";
export type MlbIntrinsicResearchClassification =
  | "GAME_ELITE_RESEARCH_CANDIDATE"
  | "INTRINSIC_WATCH"
  | "CONFLICTED_EVIDENCE"
  | "NO_STRONG_THESIS";

export interface MlbIntrinsicSignal {
  component: MlbIntrinsicComponent;
  metric: string;
  target: MlbIntrinsicTarget;
  direction: MlbIntrinsicDirection;
  horizon: MlbIntrinsicHorizon;
  valueRuns: number;
  absoluteRuns: number;
}

export interface MlbIntrinsicPressure {
  target: MlbIntrinsicTarget;
  state: MlbIntrinsicPressureState;
  upComponents: readonly MlbIntrinsicComponent[];
  downComponents: readonly MlbIntrinsicComponent[];
  supportingTargetsUp: readonly MlbIntrinsicTarget[];
  supportingTargetsDown: readonly MlbIntrinsicTarget[];
  signalCount: number;
  maxAbsoluteNativeRunSignal: number;
}

export interface MlbIntrinsicThesis {
  kind: MlbIntrinsicThesisKind;
  structure: MlbIntrinsicThesisStructure;
  supportingComponents: readonly MlbIntrinsicComponent[];
  opposingComponents: readonly MlbIntrinsicComponent[];
  supportingTargets: readonly MlbIntrinsicTarget[];
  signalCount: number;
  maxAbsoluteNativeRunSignal: number;
  marketSearchIntent: MlbIntrinsicMarketSearchIntent | null;
  researchEliteEligible: boolean;
}

export interface MlbIntrinsicProjection {
  scope: MlbIntrinsicProjectionScope;
  includedHorizons: readonly MlbIntrinsicHorizon[];
  signals: readonly MlbIntrinsicSignal[];
  pressures: {
    homeRuns: MlbIntrinsicPressure;
    awayRuns: MlbIntrinsicPressure;
    totalRuns: MlbIntrinsicPressure;
  };
  theses: readonly MlbIntrinsicThesis[];
  marketSearchIntents: readonly MlbIntrinsicMarketSearchIntent[];
  marketSearchEvidence: {
    side: readonly MlbIntrinsicComponent[];
    total: readonly MlbIntrinsicComponent[];
  };
  researchEliteCandidate: boolean;
  researchClassification: MlbIntrinsicResearchClassification;
  maxAbsoluteNativeRunSignal: number;
}

export interface MlbIntrinsicBullpenPair {
  home?: unknown;
  away?: unknown;
}

export type MlbIntrinsicBullpenByGame = Readonly<Record<number, MlbIntrinsicBullpenPair | undefined>>;

export interface MlbIntrinsicGameProfile {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  homeTeam: MlbShortlistCandidate["homeTeam"];
  awayTeam: MlbShortlistCandidate["awayTeam"];
  inputStage: "FINAL" | "PROVISIONAL";
  signals: readonly MlbIntrinsicSignal[];
  projections: {
    fullGame: MlbIntrinsicProjection;
    earlyWindow: MlbIntrinsicProjection;
  };
  researchEliteCandidate: boolean;
  researchClassification: MlbIntrinsicResearchClassification;
  certificationStatus: "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED";
  maxAbsoluteNativeRunSignal: number;
  warnings: readonly string[];
}

export interface MlbIntrinsicEdgeResult {
  schemaVersion: typeof MLB_INTRINSIC_EDGE_SCHEMA;
  generatedAt: string;
  date: string;
  sourceShortlistSchemaVersion: MlbShortlistResult["schemaVersion"];
  games: readonly MlbIntrinsicGameProfile[];
  rankedGames: readonly MlbIntrinsicGameProfile[];
  summary: {
    evaluated: number;
    researchEliteCandidates: number;
    provisionalResearchEliteCandidates: number;
    finalInputResearchEliteCandidates: number;
    fullGameResearchEliteCandidates: number;
    earlyWindowResearchEliteCandidates: number;
    intrinsicWatch: number;
    conflicted: number;
    noStrongThesis: number;
  };
  policy: {
    marketOddsUsed: false;
    oddsAffectIntrinsicRank: false;
    finalInputsAffectIntrinsicRank: false;
    gameStartTimeAffectsIntrinsicRank: false;
    weightedScoreApplied: false;
    numericEliteScoreProduced: false;
    legacyCompositeModelsCountAsIndependentEvidence: false;
    sameUnderlyingEvidenceDoubleCountingAllowed: false;
    contradictionsWithinQualifyingProjectionCanBeElite: false;
    requiresFinalInputsForResearchEliteCandidate: false;
    horizonScopedThesesRequired: true;
    lateBullpenEvidenceAllowedInEarlyWindow: false;
    researchOnlyNotOutcomeCertified: true;
    automaticBetPlacement: false;
    automaticPromotionAllowed: false;
  };
  safety: MlbShortlistResult["safety"];
}

interface CertifiedPayload {
  sourceStatus?: unknown;
  provenance?: { status?: unknown } | null;
  runsAdjustment?: unknown;
}

function record(value: unknown): CertifiedPayload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as CertifiedPayload
    : null;
}

function isCertified(value: unknown): boolean {
  const payload = record(value);
  return payload?.sourceStatus === "CERTIFIED" && payload?.provenance?.status === "CERTIFIED";
}

function sourceStatus(value: unknown): string {
  const payload = record(value);
  return String(payload?.sourceStatus ?? payload?.provenance?.status ?? "MISSING").trim().toUpperCase() || "MISSING";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pushSignal(
  output: MlbIntrinsicSignal[],
  input: {
    component: MlbIntrinsicComponent;
    metric: string;
    target: MlbIntrinsicTarget;
    horizon: MlbIntrinsicHorizon;
    valueRuns: number;
  },
): void {
  const valueRuns = round3(input.valueRuns);
  if (!Number.isFinite(valueRuns) || valueRuns === 0) return;
  output.push({
    component: input.component,
    metric: input.metric,
    target: input.target,
    direction: valueRuns > 0 ? "UP" : "DOWN",
    horizon: input.horizon,
    valueRuns,
    absoluteRuns: round3(Math.abs(valueRuns)),
  });
}

function mapShortlistSignal(signal: MlbShortlistNativeSignal): Omit<MlbIntrinsicSignal, "direction" | "absoluteRuns"> | null {
  if (signal.component === "STATCAST_QUALITY") {
    if (signal.metric === "homeSP.runsDelta") {
      return { component: signal.component, metric: signal.metric, target: "AWAY_RUNS", horizon: "EARLY_STARTER", valueRuns: signal.valueRuns };
    }
    if (signal.metric === "awaySP.runsDelta") {
      return { component: signal.component, metric: signal.metric, target: "HOME_RUNS", horizon: "EARLY_STARTER", valueRuns: signal.valueRuns };
    }
  }
  if (signal.component === "DISCIPLINE_SPEED") {
    if (signal.metric === "homeRunsDelta") {
      return { component: signal.component, metric: signal.metric, target: "HOME_RUNS", horizon: "EARLY_STARTER", valueRuns: signal.valueRuns };
    }
    if (signal.metric === "awayRunsDelta") {
      return { component: signal.component, metric: signal.metric, target: "AWAY_RUNS", horizon: "EARLY_STARTER", valueRuns: signal.valueRuns };
    }
  }
  if (signal.component === "SOS") {
    if (signal.metric === "home.adjustedRpgDelta") {
      return { component: signal.component, metric: signal.metric, target: "HOME_RUNS", horizon: "CROSS_HORIZON", valueRuns: signal.valueRuns };
    }
    if (signal.metric === "away.adjustedRpgDelta") {
      return { component: signal.component, metric: signal.metric, target: "AWAY_RUNS", horizon: "CROSS_HORIZON", valueRuns: signal.valueRuns };
    }
  }
  if (signal.component === "ADVANCED_CONTEXT" && signal.metric === "totalAdjustment") {
    return { component: signal.component, metric: signal.metric, target: "TOTAL_RUNS", horizon: "CROSS_HORIZON", valueRuns: signal.valueRuns };
  }
  return null;
}

function collectSignals(
  candidate: MlbShortlistCandidate,
  bullpen: MlbIntrinsicBullpenPair | undefined,
): { signals: MlbIntrinsicSignal[]; warnings: string[] } {
  const signals: MlbIntrinsicSignal[] = [];
  const warnings: string[] = [];

  for (const native of candidate.signals) {
    const mapped = mapShortlistSignal(native);
    if (!mapped) {
      warnings.push(`UNMAPPED_SHORTLIST_SIGNAL:${native.component}:${native.metric}`);
      continue;
    }
    pushSignal(signals, mapped);
  }

  for (const [side, payload, target] of [
    ["HOME", bullpen?.home, "AWAY_RUNS"],
    ["AWAY", bullpen?.away, "HOME_RUNS"],
  ] as const) {
    if (payload == null) continue;
    if (!isCertified(payload)) {
      warnings.push(`${side}_BULLPEN_${sourceStatus(payload)}`);
      continue;
    }
    const runsAdjustment = finite(record(payload)?.runsAdjustment);
    if (runsAdjustment == null) {
      warnings.push(`${side}_BULLPEN_RUNS_ADJUSTMENT_INVALID`);
      continue;
    }
    pushSignal(signals, {
      component: "BULLPEN",
      metric: `${side.toLowerCase()}Bullpen.runsAdjustment`,
      target,
      horizon: "LATE_BULLPEN",
      valueRuns: runsAdjustment,
    });
  }

  return { signals, warnings };
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function pressureFromSignals(
  signals: readonly MlbIntrinsicSignal[],
  target: MlbIntrinsicTarget,
  includeAllRunTargets = false,
): MlbIntrinsicPressure {
  const selected = includeAllRunTargets
    ? signals
    : signals.filter((signal) => signal.target === target);
  const upSignals = selected.filter((signal) => signal.direction === "UP");
  const downSignals = selected.filter((signal) => signal.direction === "DOWN");
  const upComponents = sortedUnique(upSignals.map((signal) => signal.component));
  const downComponents = sortedUnique(downSignals.map((signal) => signal.component));
  const supportingTargetsUp = sortedUnique(upSignals.map((signal) => signal.target));
  const supportingTargetsDown = sortedUnique(downSignals.map((signal) => signal.target));

  let state: MlbIntrinsicPressureState = "NONE";
  if (upComponents.length > 0 && downComponents.length > 0) state = "CONFLICTED";
  else if (upComponents.length >= 2) state = "CONVERGENT_UP";
  else if (downComponents.length >= 2) state = "CONVERGENT_DOWN";
  else if (upComponents.length === 1) state = "SINGLE_UP";
  else if (downComponents.length === 1) state = "SINGLE_DOWN";

  return {
    target,
    state,
    upComponents,
    downComponents,
    supportingTargetsUp,
    supportingTargetsDown,
    signalCount: selected.length,
    maxAbsoluteNativeRunSignal: round3(selected.reduce(
      (maximum, signal) => Math.max(maximum, signal.absoluteRuns),
      0,
    )),
  };
}

function thesisFromPressure(
  kind: MlbIntrinsicThesisKind,
  structure: MlbIntrinsicThesisStructure,
  pressure: MlbIntrinsicPressure,
  direction: MlbIntrinsicDirection,
  marketSearchIntent: MlbIntrinsicMarketSearchIntent | null,
  researchEliteEligible: boolean,
): MlbIntrinsicThesis {
  const supportingComponents = direction === "UP" ? pressure.upComponents : pressure.downComponents;
  const opposingComponents = direction === "UP" ? pressure.downComponents : pressure.upComponents;
  const supportingTargets = direction === "UP" ? pressure.supportingTargetsUp : pressure.supportingTargetsDown;
  return {
    kind,
    structure,
    supportingComponents,
    opposingComponents,
    supportingTargets,
    signalCount: pressure.signalCount,
    maxAbsoluteNativeRunSignal: pressure.maxAbsoluteNativeRunSignal,
    marketSearchIntent,
    researchEliteEligible,
  };
}

function buildTheses(
  homeRuns: MlbIntrinsicPressure,
  awayRuns: MlbIntrinsicPressure,
  totalRuns: MlbIntrinsicPressure,
): MlbIntrinsicThesis[] {
  const theses: MlbIntrinsicThesis[] = [];

  if (homeRuns.state === "CONVERGENT_UP") {
    theses.push(thesisFromPressure("HOME_TEAM_RUNS_UP", "MULTI_SOURCE_SINGLE_AXIS", homeRuns, "UP", null, false));
  } else if (homeRuns.state === "CONVERGENT_DOWN") {
    theses.push(thesisFromPressure("HOME_TEAM_RUNS_DOWN", "MULTI_SOURCE_SINGLE_AXIS", homeRuns, "DOWN", null, false));
  }

  if (awayRuns.state === "CONVERGENT_UP") {
    theses.push(thesisFromPressure("AWAY_TEAM_RUNS_UP", "MULTI_SOURCE_SINGLE_AXIS", awayRuns, "UP", null, false));
  } else if (awayRuns.state === "CONVERGENT_DOWN") {
    theses.push(thesisFromPressure("AWAY_TEAM_RUNS_DOWN", "MULTI_SOURCE_SINGLE_AXIS", awayRuns, "DOWN", null, false));
  }

  if (homeRuns.state === "CONVERGENT_UP" && awayRuns.state === "CONVERGENT_DOWN") {
    const combined: MlbIntrinsicPressure = {
      target: "TOTAL_RUNS",
      state: "CONVERGENT_UP",
      upComponents: sortedUnique([...homeRuns.upComponents, ...awayRuns.downComponents]),
      downComponents: [],
      supportingTargetsUp: ["HOME_RUNS", "AWAY_RUNS"],
      supportingTargetsDown: [],
      signalCount: homeRuns.signalCount + awayRuns.signalCount,
      maxAbsoluteNativeRunSignal: Math.max(homeRuns.maxAbsoluteNativeRunSignal, awayRuns.maxAbsoluteNativeRunSignal),
    };
    theses.push(thesisFromPressure("HOME_SIDE", "TWO_SIDED_SEPARATION", combined, "UP", "SIDE", true));
  }

  if (awayRuns.state === "CONVERGENT_UP" && homeRuns.state === "CONVERGENT_DOWN") {
    const combined: MlbIntrinsicPressure = {
      target: "TOTAL_RUNS",
      state: "CONVERGENT_UP",
      upComponents: sortedUnique([...awayRuns.upComponents, ...homeRuns.downComponents]),
      downComponents: [],
      supportingTargetsUp: ["HOME_RUNS", "AWAY_RUNS"],
      supportingTargetsDown: [],
      signalCount: homeRuns.signalCount + awayRuns.signalCount,
      maxAbsoluteNativeRunSignal: Math.max(homeRuns.maxAbsoluteNativeRunSignal, awayRuns.maxAbsoluteNativeRunSignal),
    };
    theses.push(thesisFromPressure("AWAY_SIDE", "TWO_SIDED_SEPARATION", combined, "UP", "SIDE", true));
  }

  if (totalRuns.state === "CONVERGENT_UP" && totalRuns.supportingTargetsUp.length >= 2) {
    theses.push(thesisFromPressure("TOTAL_OVER", "MULTI_AXIS_CONVERGENCE", totalRuns, "UP", "TOTAL", true));
  } else if (totalRuns.state === "CONVERGENT_DOWN" && totalRuns.supportingTargetsDown.length >= 2) {
    theses.push(thesisFromPressure("TOTAL_UNDER", "MULTI_AXIS_CONVERGENCE", totalRuns, "DOWN", "TOTAL", true));
  }

  return theses;
}

function marketSearchEvidence(
  theses: readonly MlbIntrinsicThesis[],
  intent: MlbIntrinsicMarketSearchIntent,
): MlbIntrinsicComponent[] {
  return sortedUnique(theses
    .filter((thesis) => thesis.marketSearchIntent === intent && thesis.researchEliteEligible)
    .flatMap((thesis) => thesis.supportingComponents));
}

function projectionClassification(
  researchEliteCandidate: boolean,
  pressures: MlbIntrinsicProjection["pressures"],
  theses: readonly MlbIntrinsicThesis[],
): MlbIntrinsicResearchClassification {
  if (researchEliteCandidate) return "GAME_ELITE_RESEARCH_CANDIDATE";
  if (Object.values(pressures).some((pressure) => pressure.state === "CONFLICTED")) {
    return "CONFLICTED_EVIDENCE";
  }
  if (theses.length > 0) return "INTRINSIC_WATCH";
  return "NO_STRONG_THESIS";
}

function buildProjection(
  allSignals: readonly MlbIntrinsicSignal[],
  scope: MlbIntrinsicProjectionScope,
): MlbIntrinsicProjection {
  const includedHorizons: readonly MlbIntrinsicHorizon[] = scope === "EARLY_WINDOW"
    ? ["EARLY_STARTER", "CROSS_HORIZON"]
    : ["EARLY_STARTER", "CROSS_HORIZON", "LATE_BULLPEN"];
  const allowed = new Set<MlbIntrinsicHorizon>(includedHorizons);
  const signals = allSignals.filter((signal) => allowed.has(signal.horizon));
  const homeRuns = pressureFromSignals(signals, "HOME_RUNS");
  const awayRuns = pressureFromSignals(signals, "AWAY_RUNS");
  const totalRuns = pressureFromSignals(signals, "TOTAL_RUNS", true);
  const pressures = { homeRuns, awayRuns, totalRuns };
  const theses = buildTheses(homeRuns, awayRuns, totalRuns);
  const marketSearchIntents = sortedUnique(theses
    .filter((thesis) => thesis.researchEliteEligible && thesis.marketSearchIntent != null)
    .map((thesis) => thesis.marketSearchIntent!));
  const researchEliteCandidate = marketSearchIntents.length > 0;

  return {
    scope,
    includedHorizons,
    signals,
    pressures,
    theses,
    marketSearchIntents,
    marketSearchEvidence: {
      side: marketSearchEvidence(theses, "SIDE"),
      total: marketSearchEvidence(theses, "TOTAL"),
    },
    researchEliteCandidate,
    researchClassification: projectionClassification(researchEliteCandidate, pressures, theses),
    maxAbsoluteNativeRunSignal: round3(signals.reduce(
      (maximum, signal) => Math.max(maximum, signal.absoluteRuns),
      0,
    )),
  };
}

function evaluateCandidate(
  candidate: MlbShortlistCandidate,
  bullpen: MlbIntrinsicBullpenPair | undefined,
): MlbIntrinsicGameProfile {
  const collected = collectSignals(candidate, bullpen);
  const fullGame = buildProjection(collected.signals, "FULL_GAME");
  const earlyWindow = buildProjection(collected.signals, "EARLY_WINDOW");
  const researchEliteCandidate = fullGame.researchEliteCandidate || earlyWindow.researchEliteCandidate;

  let researchClassification: MlbIntrinsicResearchClassification = "NO_STRONG_THESIS";
  if (researchEliteCandidate) researchClassification = "GAME_ELITE_RESEARCH_CANDIDATE";
  else if (
    fullGame.researchClassification === "CONFLICTED_EVIDENCE"
    || earlyWindow.researchClassification === "CONFLICTED_EVIDENCE"
  ) researchClassification = "CONFLICTED_EVIDENCE";
  else if (
    fullGame.researchClassification === "INTRINSIC_WATCH"
    || earlyWindow.researchClassification === "INTRINSIC_WATCH"
  ) researchClassification = "INTRINSIC_WATCH";

  return {
    gamePk: candidate.gamePk,
    officialDate: candidate.officialDate,
    startTime: candidate.startTime,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    inputStage: candidate.finalInputsAvailable ? "FINAL" : "PROVISIONAL",
    signals: collected.signals,
    projections: { fullGame, earlyWindow },
    researchEliteCandidate,
    researchClassification,
    certificationStatus: "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED",
    maxAbsoluteNativeRunSignal: round3(collected.signals.reduce(
      (maximum, signal) => Math.max(maximum, signal.absoluteRuns),
      0,
    )),
    warnings: collected.warnings,
  };
}

function allEliteTheses(game: MlbIntrinsicGameProfile): MlbIntrinsicThesis[] {
  return [
    ...game.projections.fullGame.theses,
    ...game.projections.earlyWindow.theses,
  ].filter((thesis) => thesis.researchEliteEligible);
}

function maxSupportingComponentCount(game: MlbIntrinsicGameProfile): number {
  return allEliteTheses(game).reduce(
    (maximum, thesis) => Math.max(maximum, thesis.supportingComponents.length),
    0,
  );
}

function eliteThesisCount(game: MlbIntrinsicGameProfile): number {
  return allEliteTheses(game).length;
}

export function rankMlbIntrinsicGames(
  games: readonly MlbIntrinsicGameProfile[],
): MlbIntrinsicGameProfile[] {
  return [...games].sort((left, right) => {
    if (left.researchEliteCandidate !== right.researchEliteCandidate) {
      return left.researchEliteCandidate ? -1 : 1;
    }
    if (eliteThesisCount(right) !== eliteThesisCount(left)) {
      return eliteThesisCount(right) - eliteThesisCount(left);
    }
    if (maxSupportingComponentCount(right) !== maxSupportingComponentCount(left)) {
      return maxSupportingComponentCount(right) - maxSupportingComponentCount(left);
    }
    if (right.maxAbsoluteNativeRunSignal !== left.maxAbsoluteNativeRunSignal) {
      return right.maxAbsoluteNativeRunSignal - left.maxAbsoluteNativeRunSignal;
    }
    return left.gamePk - right.gamePk;
  });
}

export function buildMlbIntrinsicEdge(input: {
  shortlist: MlbShortlistResult;
  bullpenByGame?: MlbIntrinsicBullpenByGame;
}): MlbIntrinsicEdgeResult {
  const games = input.shortlist.selected.map((candidate) =>
    evaluateCandidate(candidate, input.bullpenByGame?.[candidate.gamePk]));
  const rankedGames = rankMlbIntrinsicGames(games);

  return {
    schemaVersion: MLB_INTRINSIC_EDGE_SCHEMA,
    generatedAt: new Date().toISOString(),
    date: input.shortlist.date,
    sourceShortlistSchemaVersion: input.shortlist.schemaVersion,
    games,
    rankedGames,
    summary: {
      evaluated: games.length,
      researchEliteCandidates: games.filter((game) => game.researchEliteCandidate).length,
      provisionalResearchEliteCandidates: games.filter((game) => game.researchEliteCandidate && game.inputStage === "PROVISIONAL").length,
      finalInputResearchEliteCandidates: games.filter((game) => game.researchEliteCandidate && game.inputStage === "FINAL").length,
      fullGameResearchEliteCandidates: games.filter((game) => game.projections.fullGame.researchEliteCandidate).length,
      earlyWindowResearchEliteCandidates: games.filter((game) => game.projections.earlyWindow.researchEliteCandidate).length,
      intrinsicWatch: games.filter((game) => game.researchClassification === "INTRINSIC_WATCH").length,
      conflicted: games.filter((game) => game.researchClassification === "CONFLICTED_EVIDENCE").length,
      noStrongThesis: games.filter((game) => game.researchClassification === "NO_STRONG_THESIS").length,
    },
    policy: {
      marketOddsUsed: false,
      oddsAffectIntrinsicRank: false,
      finalInputsAffectIntrinsicRank: false,
      gameStartTimeAffectsIntrinsicRank: false,
      weightedScoreApplied: false,
      numericEliteScoreProduced: false,
      legacyCompositeModelsCountAsIndependentEvidence: false,
      sameUnderlyingEvidenceDoubleCountingAllowed: false,
      contradictionsWithinQualifyingProjectionCanBeElite: false,
      requiresFinalInputsForResearchEliteCandidate: false,
      horizonScopedThesesRequired: true,
      lateBullpenEvidenceAllowedInEarlyWindow: false,
      researchOnlyNotOutcomeCertified: true,
      automaticBetPlacement: false,
      automaticPromotionAllowed: false,
    },
    safety: input.shortlist.safety,
  };
}
