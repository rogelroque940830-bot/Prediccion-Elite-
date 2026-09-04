import type { MlbCheapScreenGameResult, MlbCheapScreeningResult } from "./mlb-cheap-screening";

export const MLB_SHORTLIST_SCHEMA = "courtedge-p0-mlb-shortlist.v1" as const;
export const MLB_SHORTLIST_MAX_CANDIDATES = 8 as const;

export type MlbShortlistComponent =
  | "STATCAST_QUALITY"
  | "DISCIPLINE_SPEED"
  | "SOS"
  | "ADVANCED_CONTEXT";

export const MLB_SHORTLIST_CORE_COMPONENTS = Object.freeze([
  "STATCAST_QUALITY",
  "DISCIPLINE_SPEED",
  "SOS",
] as const);

export type MlbShortlistCoreComponent = (typeof MLB_SHORTLIST_CORE_COMPONENTS)[number];
export type MlbShortlistCoreEvidenceState = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export type MlbShortlistQualificationDisposition =
  | "QUALIFIED_SIGNAL"
  | "PENDING_EVIDENCE"
  | "COMPLETE_NO_SIGNAL";

export interface MlbShortlistNativeSignal {
  component: MlbShortlistComponent;
  metric: string;
  valueRuns: number;
  absoluteRuns: number;
}

export interface MlbShortlistFactorPayloads {
  statcastQuality?: unknown;
  disciplineSpeed?: unknown;
  sos?: unknown;
  advancedContext?: unknown;
}

export type MlbShortlistEvidenceByGame = Readonly<Record<number, MlbShortlistFactorPayloads | undefined>>;

export interface MlbShortlistCoreEvidenceCoverage {
  state: MlbShortlistCoreEvidenceState;
  certifiedComponents: readonly MlbShortlistCoreComponent[];
  signalComponents: readonly MlbShortlistCoreComponent[];
  neutralComponents: readonly MlbShortlistCoreComponent[];
  unavailableComponents: readonly MlbShortlistCoreComponent[];
}

export interface MlbShortlistCandidate {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  homeTeam: MlbCheapScreenGameResult["homeTeam"];
  awayTeam: MlbCheapScreenGameResult["awayTeam"];
  cheapScreenDisposition: MlbCheapScreenGameResult["disposition"];
  finalInputsAvailable: boolean;
  certifiedComponentCount: number;
  independentSignalCount: number;
  maxAbsoluteNativeRunSignal: number;
  signals: MlbShortlistNativeSignal[];
  warnings: string[];
  coreEvidenceCoverage: MlbShortlistCoreEvidenceCoverage;
  qualificationDisposition: MlbShortlistQualificationDisposition;
  qualifiedForShortlist: boolean;
}

export interface MlbShortlistResult {
  schemaVersion: typeof MLB_SHORTLIST_SCHEMA;
  generatedAt: string;
  date: string;
  sourceCheapScreenSchemaVersion: MlbCheapScreeningResult["schemaVersion"];
  candidates: MlbShortlistCandidate[];
  selected: MlbShortlistCandidate[];
  summary: {
    cheapScreenEligible: number;
    evaluated: number;
    qualified: number;
    selected: number;
    overflowQualified: number;
    noCertifiedSignal: number;
    pendingEvidence: number;
    completeNoSignal: number;
    completeEvidence: number;
    partialEvidence: number;
    unavailableEvidence: number;
  };
  policy: {
    marketAgnostic: true;
    predictsWinner: false;
    recommendsBet: false;
    requiresMarketOdds: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    weightsApplied: false;
    forcedQuota: false;
    requiresCertifiedProvenance: true;
    maxCandidates: number;
    hardMaximumCandidates: typeof MLB_SHORTLIST_MAX_CANDIDATES;
    qualificationRule: "NONZERO_SIGNAL_OR_PENDING_CORE_EVIDENCE";
    rankingRule: "OBSERVED_SIGNAL_COMPONENT_COUNT_THEN_MAX_NATIVE_RUN_MAGNITUDE";
    missingDataCountsAsNegativeEvidence: false;
    pendingCoreEvidencePreservedInCompetition: true;
    completeCertifiedNoSignalMayBeExcluded: true;
  };
  safety: MlbCheapScreeningResult["safety"];
}

interface PayloadRecord {
  sourceStatus?: unknown;
  provenance?: { status?: unknown } | null;
  [key: string]: unknown;
}

function record(value: unknown): PayloadRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PayloadRecord
    : null;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function certified(payload: unknown): boolean {
  const value = record(payload);
  return value?.sourceStatus === "CERTIFIED" && value?.provenance?.status === "CERTIFIED";
}

function sourceStatus(payload: unknown): string {
  const value = record(payload);
  return String(value?.sourceStatus ?? value?.provenance?.status ?? "MISSING").trim().toUpperCase() || "MISSING";
}

function pushSignal(
  signals: MlbShortlistNativeSignal[],
  component: MlbShortlistComponent,
  metric: string,
  rawValue: unknown,
): void {
  const value = finite(rawValue);
  if (value == null || value === 0) return;
  const valueRuns = round3(value);
  signals.push({
    component,
    metric,
    valueRuns,
    absoluteRuns: round3(Math.abs(valueRuns)),
  });
}

function statcastSignals(payload: unknown, signals: MlbShortlistNativeSignal[]): void {
  if (!certified(payload)) return;
  const value = record(payload)!;
  const homeSP = record(value.homeSP);
  const awaySP = record(value.awaySP);
  pushSignal(signals, "STATCAST_QUALITY", "homeSP.runsDelta", homeSP?.runsDelta);
  pushSignal(signals, "STATCAST_QUALITY", "awaySP.runsDelta", awaySP?.runsDelta);
}

function disciplineSignals(payload: unknown, signals: MlbShortlistNativeSignal[]): void {
  if (!certified(payload)) return;
  const value = record(payload)!;
  pushSignal(signals, "DISCIPLINE_SPEED", "homeRunsDelta", value.homeRunsDelta);
  pushSignal(signals, "DISCIPLINE_SPEED", "awayRunsDelta", value.awayRunsDelta);
}

function sosSignals(payload: unknown, signals: MlbShortlistNativeSignal[]): void {
  if (!certified(payload)) return;
  const value = record(payload)!;
  for (const side of ["home", "away"] as const) {
    const team = record(value[side]);
    const recentRpg = finite(team?.recentRpg);
    const adjustedRpg = finite(team?.adjustedRpg);
    if (recentRpg == null || adjustedRpg == null) continue;
    pushSignal(signals, "SOS", `${side}.adjustedRpgDelta`, adjustedRpg - recentRpg);
  }
}

function advancedContextSignals(payload: unknown, signals: MlbShortlistNativeSignal[]): void {
  if (!certified(payload)) return;
  const value = record(payload)!;
  pushSignal(signals, "ADVANCED_CONTEXT", "totalAdjustment", value.totalAdjustment);
}

function coreCoverage(
  payloads: MlbShortlistFactorPayloads,
  signals: readonly MlbShortlistNativeSignal[],
): MlbShortlistCoreEvidenceCoverage {
  const corePayloads: Readonly<Record<MlbShortlistCoreComponent, unknown>> = {
    STATCAST_QUALITY: payloads.statcastQuality,
    DISCIPLINE_SPEED: payloads.disciplineSpeed,
    SOS: payloads.sos,
  };
  const signalSet = new Set(signals.map((signal) => signal.component));
  const certifiedComponents = MLB_SHORTLIST_CORE_COMPONENTS.filter((component) => certified(corePayloads[component]));
  const unavailableComponents = MLB_SHORTLIST_CORE_COMPONENTS.filter((component) => !certified(corePayloads[component]));
  const signalComponents = certifiedComponents.filter((component) => signalSet.has(component));
  const neutralComponents = certifiedComponents.filter((component) => !signalSet.has(component));
  const state: MlbShortlistCoreEvidenceState = certifiedComponents.length === MLB_SHORTLIST_CORE_COMPONENTS.length
    ? "COMPLETE"
    : certifiedComponents.length === 0
      ? "UNAVAILABLE"
      : "PARTIAL";
  return Object.freeze({
    state,
    certifiedComponents: Object.freeze([...certifiedComponents]),
    signalComponents: Object.freeze([...signalComponents]),
    neutralComponents: Object.freeze([...neutralComponents]),
    unavailableComponents: Object.freeze([...unavailableComponents]),
  });
}

function evaluateGame(
  game: MlbCheapScreenGameResult,
  factors: MlbShortlistFactorPayloads | undefined,
): MlbShortlistCandidate {
  const payloads = factors ?? {};
  const components: Array<[MlbShortlistComponent, unknown]> = [
    ["STATCAST_QUALITY", payloads.statcastQuality],
    ["DISCIPLINE_SPEED", payloads.disciplineSpeed],
    ["SOS", payloads.sos],
    ["ADVANCED_CONTEXT", payloads.advancedContext],
  ];

  const warnings = components
    .filter(([, payload]) => payload != null && !certified(payload))
    .map(([component, payload]) => `${component}_${sourceStatus(payload)}`);

  const certifiedComponentCount = components.filter(([, payload]) => certified(payload)).length;
  const signals: MlbShortlistNativeSignal[] = [];
  statcastSignals(payloads.statcastQuality, signals);
  disciplineSignals(payloads.disciplineSpeed, signals);
  sosSignals(payloads.sos, signals);
  advancedContextSignals(payloads.advancedContext, signals);

  const independentSignalCount = new Set(signals.map((signal) => signal.component)).size;
  const maxAbsoluteNativeRunSignal = signals.reduce(
    (maximum, signal) => Math.max(maximum, signal.absoluteRuns),
    0,
  );
  const coreEvidenceCoverage = coreCoverage(payloads, signals);
  const qualificationDisposition: MlbShortlistQualificationDisposition = independentSignalCount > 0
    ? "QUALIFIED_SIGNAL"
    : coreEvidenceCoverage.state !== "COMPLETE"
      ? "PENDING_EVIDENCE"
      : "COMPLETE_NO_SIGNAL";

  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    startTime: game.startTime,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    cheapScreenDisposition: game.disposition,
    finalInputsAvailable: game.finalInputsAvailable,
    certifiedComponentCount,
    independentSignalCount,
    maxAbsoluteNativeRunSignal: round3(maxAbsoluteNativeRunSignal),
    signals,
    warnings,
    coreEvidenceCoverage,
    qualificationDisposition,
    qualifiedForShortlist: qualificationDisposition !== "COMPLETE_NO_SIGNAL",
  };
}

function resolveMaxCandidates(value: number | undefined): number {
  if (value == null) return MLB_SHORTLIST_MAX_CANDIDATES;
  if (!Number.isInteger(value) || value < 0 || value > MLB_SHORTLIST_MAX_CANDIDATES) {
    throw new Error("MLB_SHORTLIST_MAX_CANDIDATES_OUT_OF_RANGE");
  }
  return value;
}

export function rankMlbShortlistCandidates(
  candidates: readonly MlbShortlistCandidate[],
): MlbShortlistCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.independentSignalCount !== a.independentSignalCount) {
      return b.independentSignalCount - a.independentSignalCount;
    }
    if (b.maxAbsoluteNativeRunSignal !== a.maxAbsoluteNativeRunSignal) {
      return b.maxAbsoluteNativeRunSignal - a.maxAbsoluteNativeRunSignal;
    }
    // Coverage is intentionally not a sporting tie-breaker. Missing evidence is
    // uncertainty, not negative evidence. Completeness is tracked separately and
    // may keep a provisional comparison unresolved until the source recovers.
    if (a.finalInputsAvailable !== b.finalInputsAvailable) {
      return a.finalInputsAvailable ? -1 : 1;
    }
    return a.gamePk - b.gamePk;
  });
}

export function buildMlbShortlist(input: {
  cheapScreen: MlbCheapScreeningResult;
  evidenceByGame: MlbShortlistEvidenceByGame;
  maxCandidates?: number;
}): MlbShortlistResult {
  const maxCandidates = resolveMaxCandidates(input.maxCandidates);
  const eligibleGames = input.cheapScreen.games.filter((game) => game.eligibleForDeepPrefilterNow);
  const candidates = eligibleGames.map((game) => evaluateGame(game, input.evidenceByGame[game.gamePk]));
  const qualified = rankMlbShortlistCandidates(candidates.filter((candidate) => candidate.qualifiedForShortlist));
  const selected = qualified.slice(0, maxCandidates);

  return {
    schemaVersion: MLB_SHORTLIST_SCHEMA,
    generatedAt: new Date().toISOString(),
    date: input.cheapScreen.date,
    sourceCheapScreenSchemaVersion: input.cheapScreen.schemaVersion,
    candidates,
    selected,
    summary: {
      cheapScreenEligible: eligibleGames.length,
      evaluated: candidates.length,
      qualified: qualified.length,
      selected: selected.length,
      overflowQualified: Math.max(0, qualified.length - selected.length),
      noCertifiedSignal: candidates.filter((candidate) => candidate.independentSignalCount === 0).length,
      pendingEvidence: candidates.filter((candidate) => candidate.coreEvidenceCoverage.state !== "COMPLETE").length,
      completeNoSignal: candidates.filter((candidate) => candidate.qualificationDisposition === "COMPLETE_NO_SIGNAL").length,
      completeEvidence: candidates.filter((candidate) => candidate.coreEvidenceCoverage.state === "COMPLETE").length,
      partialEvidence: candidates.filter((candidate) => candidate.coreEvidenceCoverage.state === "PARTIAL").length,
      unavailableEvidence: candidates.filter((candidate) => candidate.coreEvidenceCoverage.state === "UNAVAILABLE").length,
    },
    policy: {
      marketAgnostic: true,
      predictsWinner: false,
      recommendsBet: false,
      requiresMarketOdds: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      weightsApplied: false,
      forcedQuota: false,
      requiresCertifiedProvenance: true,
      maxCandidates,
      hardMaximumCandidates: MLB_SHORTLIST_MAX_CANDIDATES,
      qualificationRule: "NONZERO_SIGNAL_OR_PENDING_CORE_EVIDENCE",
      rankingRule: "OBSERVED_SIGNAL_COMPONENT_COUNT_THEN_MAX_NATIVE_RUN_MAGNITUDE",
      missingDataCountsAsNegativeEvidence: false,
      pendingCoreEvidencePreservedInCompetition: true,
      completeCertifiedNoSignalMayBeExcluded: true,
    },
    safety: input.cheapScreen.safety,
  };
}
