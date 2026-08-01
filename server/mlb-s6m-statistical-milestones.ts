import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS6kFirstTenCyclesCertificationService } from "./mlb-s6k-first-ten-cycles-certification";
import {
  type MlbS6lScientificMetricsService,
  type S6lMetricSummary,
  type S6lScientificMetricsReport,
} from "./mlb-s6l-scientific-metrics";
import {
  MLB_S6I_CLEAN_COHORT_CUTOFF,
  MLB_S6I_REQUIRED_CONSENSUS_METHOD,
} from "./mlb-s6i-postfix-certification";

export const MLB_S6M_STATISTICAL_MILESTONES_VERSION = "mlb-s6m-statistical-milestones.v1" as const;
export const MLB_S6M_CERTIFICATE_VERSION = "mlb-s6m-statistical-milestone-certificate.v1" as const;
export const MLB_S6M_MILESTONES = [1, 5, 20, 50] as const;

export type S6mMilestone = (typeof MLB_S6M_MILESTONES)[number];
export type S6mState =
  | "WAITING_FOR_MILESTONE_1"
  | "MILESTONE_1_CERTIFIED"
  | "MILESTONE_5_CERTIFIED"
  | "MILESTONE_20_CERTIFIED"
  | "MILESTONE_50_CERTIFIED"
  | "ACTION_REQUIRED";

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);
const EPSILON = 1e-15;

type S6mOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  now?: () => Date;
  deploymentCommit?: string;
  environment?: string;
};

export type S6mObservation = {
  rootPredictionId: string;
  terminalPredictionId: string;
  terminalRecordedAt: string;
  terminalRecordedAtMs: number;
  payloadSha256: string;
  gamePk: number | null;
  gameDate: string;
  marketType: string;
  selection: string;
  line: number | null;
  signal: string;
  modelProbability: number;
  marketImpliedProbability: number;
  oddsAmerican: number;
  result: "WIN" | "LOSS" | "PUSH" | "VOID";
  outcome: 0 | 1 | null;
  clvPp: number | null;
  independentlyCertified: boolean;
  settlementEventId: string;
  settlementSource: string;
  settledAt: string;
};

export type S6mIndependentSample = {
  observations: S6mObservation[];
  binaryObservations: S6mObservation[];
  s5cChains: number;
  uniqueAnalyticalCycles: number;
  duplicatesExcluded: number;
  exclusionCounts: Record<string, number>;
};

export type S6mManifestEntry = Omit<S6mObservation, "terminalRecordedAtMs"> & {
  ordinal: number;
};

export type S6mMilestoneCertificate = {
  schemaVersion: typeof MLB_S6M_CERTIFICATE_VERSION;
  milestone: S6mMilestone;
  createdAt: string;
  sourceS6lGeneratedAt: string;
  deploymentCommit: string;
  environment: string;
  sampleRule: "FIRST_N_ELIGIBLE_BINARY_DECISIONS_BY_TERMINAL_TIME";
  manifest: S6mManifestEntry[];
  manifestDigestSha256: string;
  metrics: S6lMetricSummary;
  checks: {
    exactSampleSize: true;
    duplicateFree: true;
    allPostFix: true;
    allTerminalFinal: true;
    allSettled: true;
    allStandardAmericanOdds: true;
    allPriceProvenanceComplete: true;
  };
  certificateDigestSha256: string;
};

export type S6mCertificateMap = Partial<Record<`${S6mMilestone}`, S6mMilestoneCertificate>>;

export type S6mMilestoneReport = {
  schemaVersion: typeof MLB_S6M_STATISTICAL_MILESTONES_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6mState;
  cohort: {
    cutoff: typeof MLB_S6I_CLEAN_COHORT_CUTOFF;
    requiredConsensusMethod: typeof MLB_S6I_REQUIRED_CONSENSUS_METHOD;
    milestones: readonly [1, 5, 20, 50];
  };
  sourceS6l: {
    available: boolean;
    schemaVersion: string | null;
    generatedAt: string | null;
    state: string | null;
  };
  sample: {
    ownedLedgerRecords: number;
    s5cChains: number;
    uniqueAnalyticalCycles: number;
    eligibleSettledDecisions: number;
    binaryScoredDecisions: number;
    independentlyCertifiedDecisions: number;
    duplicatesExcluded: number;
    exclusionCounts: Record<string, number>;
  };
  independentMetrics: S6lMetricSummary;
  metricParity: {
    checked: boolean;
    passed: boolean;
    mismatches: string[];
  };
  milestones: Array<{
    milestone: S6mMilestone;
    status: "PENDING" | "CERTIFIED" | "FAILED";
    certificateCreatedAt: string | null;
    certificateDigestSha256: string | null;
    manifestDigestSha256: string | null;
  }>;
  highestCertifiedMilestone: S6mMilestone | 0;
  nextMilestone: S6mMilestone | null;
  readiness: {
    firstSettlementCertified: boolean;
    fiveResultCheckCertified: boolean;
    minimumSampleCertified: boolean;
    preferredSampleCertified: boolean;
    tenCertifiedCyclesReached: boolean;
    humanReviewReady: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  persistence: {
    ledgerImmutable: true;
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
    certificatesAppendOnly: true;
  };
  issues: Array<{ code: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string }>;
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    historicalLedgerMutation: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S6mStatus = {
  schemaVersion: typeof MLB_S6M_STATISTICAL_MILESTONES_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S6mMilestoneReport | null;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stableDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isStandardAmericanOdds(value: unknown): value is number {
  const odds = finite(value);
  return odds != null && Number.isInteger(odds) && Math.abs(odds) >= 100 && Math.abs(odds) <= 100_000;
}

function impliedProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function americanWinProfit(odds: number): number {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function isS5cRecord(record: LedgerRecord): boolean {
  return (record.prediction.payload as any)?.analysis?.layers?.s5c?.schemaVersion === "mlb-s5c-shadow-ingestion.v1";
}

function rootIdFor(record: LedgerRecord, byId: Map<string, LedgerRecord>): string {
  const visited = new Set<string>();
  let current = record;
  while (current.prediction.supersedesId && !visited.has(current.prediction.id)) {
    visited.add(current.prediction.id);
    const parent = byId.get(current.prediction.supersedesId);
    if (!parent) break;
    current = parent;
  }
  return current.prediction.id;
}

function groupS5cChains(records: LedgerRecord[]): Map<string, LedgerRecord[]> {
  const s5c = records.filter(isS5cRecord);
  const byId = new Map(s5c.map((record) => [record.prediction.id, record]));
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of s5c) {
    const rootId = rootIdFor(record, byId);
    const chain = groups.get(rootId) ?? [];
    chain.push(record);
    groups.set(rootId, chain);
  }
  for (const chain of groups.values()) {
    chain.sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id));
  }
  return groups;
}

function terminalFor(chain: LedgerRecord[]): LedgerRecord | null {
  if (!chain.length) return null;
  const parentIds = new Set(chain.map((record) => record.prediction.supersedesId).filter(Boolean));
  return chain
    .filter((record) => !parentIds.has(record.prediction.id))
    .sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id))
    .at(-1) ?? null;
}

function analyticalIdentity(record: LedgerRecord): string {
  const prediction = record.prediction;
  return JSON.stringify({
    gamePk: prediction.game.gamePk ?? null,
    gameDate: prediction.game.gameDate,
    homeTeam: normalize(prediction.game.homeTeam),
    awayTeam: normalize(prediction.game.awayTeam),
    marketType: prediction.market.type,
    selection: normalize(prediction.market.selection),
    line: prediction.market.line ?? null,
  });
}

function priceProvenanceComplete(record: LedgerRecord): boolean {
  const payload = record.prediction.payload as any;
  const integrity = payload?.analysis?.layers?.marketPriceIntegrity ?? {};
  const capture = payload?.analysis?.rawInputs?.priceCapture ?? {};
  const provenance = payload?.analysis?.rawInputs?.marketProvenance ?? {};
  const capturedAt = Date.parse(String(payload?.market?.capturedAt ?? capture?.capturedAt ?? ""));
  const method = String(capture?.consensusMethod ?? provenance?.consensusMethod ?? integrity?.consensusMethod ?? "");
  const books = Array.isArray(provenance?.contributingBooks)
    ? provenance.contributingBooks.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return integrity?.standardAmericanOddsValidated === true
    && Number.isFinite(capturedAt)
    && method === MLB_S6I_REQUIRED_CONSENSUS_METHOD
    && books.length > 0;
}

function settlementResult(record: LedgerRecord): S6mObservation["result"] | null {
  const result = String(record.settlement?.result ?? "").toUpperCase();
  return result === "WIN" || result === "LOSS" || result === "PUSH" || result === "VOID" ? result : null;
}

function settlementSourceValid(record: LedgerRecord): boolean {
  const settlement = record.settlement;
  return Boolean(settlement && (settlement.source === "official"
    || (settlement.source === "correction" && settlement.correctionOfEventId)));
}

function exclusionCounter(): Record<string, number> {
  return {
    PRE_FIX_CHAIN: 0,
    ANALYTICAL_DUPLICATE: 0,
    NO_FINAL_TERMINAL: 0,
    INVALID_AMERICAN_ODDS: 0,
    INVALID_MODEL_PROBABILITY: 0,
    INCOMPLETE_PRICE_PROVENANCE: 0,
    UNSETTLED: 0,
    INVALID_SETTLEMENT_SOURCE: 0,
    UNSUPPORTED_SETTLEMENT_RESULT: 0,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function extractMlbS6mIndependentSample(
  records: LedgerRecord[],
  certifiedTerminalPredictionIds: string[] = [],
): S6mIndependentSample {
  const groups = groupS5cChains(records);
  const certified = new Set(certifiedTerminalPredictionIds);
  const exclusions = exclusionCounter();
  const seenIdentities = new Set<string>();
  const observations: S6mObservation[] = [];
  let duplicatesExcluded = 0;
  let uniqueAnalyticalCycles = 0;

  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const leftTerminal = terminalFor(left[1]);
    const rightTerminal = terminalFor(right[1]);
    return (leftTerminal?.prediction.recordedAtMs ?? 0) - (rightTerminal?.prediction.recordedAtMs ?? 0)
      || left[0].localeCompare(right[0]);
  });

  for (const [rootPredictionId, chain] of orderedGroups) {
    if (!chain.every((record) => record.prediction.recordedAtMs >= CUTOFF_MS)) {
      increment(exclusions, "PRE_FIX_CHAIN");
      continue;
    }
    const terminal = terminalFor(chain);
    if (!terminal) continue;
    const identity = analyticalIdentity(terminal);
    if (seenIdentities.has(identity)) {
      duplicatesExcluded += 1;
      increment(exclusions, "ANALYTICAL_DUPLICATE");
      continue;
    }
    seenIdentities.add(identity);
    uniqueAnalyticalCycles += 1;
    if (terminal.prediction.analysisStage !== "FINAL") {
      increment(exclusions, "NO_FINAL_TERMINAL");
      continue;
    }
    const odds = terminal.prediction.market.oddsAmerican;
    if (!isStandardAmericanOdds(odds)) {
      increment(exclusions, "INVALID_AMERICAN_ODDS");
      continue;
    }
    const modelProbability = finite(terminal.prediction.probabilities.model);
    if (modelProbability == null || modelProbability <= 0 || modelProbability >= 1) {
      increment(exclusions, "INVALID_MODEL_PROBABILITY");
      continue;
    }
    if (!priceProvenanceComplete(terminal)) {
      increment(exclusions, "INCOMPLETE_PRICE_PROVENANCE");
      continue;
    }
    if (!terminal.settlement) {
      increment(exclusions, "UNSETTLED");
      continue;
    }
    if (!settlementSourceValid(terminal)) {
      increment(exclusions, "INVALID_SETTLEMENT_SOURCE");
      continue;
    }
    const result = settlementResult(terminal);
    if (!result) {
      increment(exclusions, "UNSUPPORTED_SETTLEMENT_RESULT");
      continue;
    }
    observations.push({
      rootPredictionId,
      terminalPredictionId: terminal.prediction.id,
      terminalRecordedAt: terminal.prediction.recordedAt,
      terminalRecordedAtMs: terminal.prediction.recordedAtMs,
      payloadSha256: terminal.prediction.payloadSha256,
      gamePk: terminal.prediction.game.gamePk ?? null,
      gameDate: terminal.prediction.game.gameDate,
      marketType: terminal.prediction.market.type,
      selection: terminal.prediction.market.selection,
      line: terminal.prediction.market.line ?? null,
      signal: String(terminal.prediction.decision.signal ?? "UNKNOWN"),
      modelProbability,
      marketImpliedProbability: impliedProbability(odds),
      oddsAmerican: odds,
      result,
      outcome: result === "WIN" ? 1 : result === "LOSS" ? 0 : null,
      clvPp: finite(terminal.settlement.clvPp),
      independentlyCertified: certified.has(terminal.prediction.id),
      settlementEventId: String(terminal.settlement.eventId ?? ""),
      settlementSource: String(terminal.settlement.source ?? ""),
      settledAt: String(terminal.settlement.settledAt ?? ""),
    });
  }

  observations.sort((left, right) => left.terminalRecordedAtMs - right.terminalRecordedAtMs
    || left.terminalPredictionId.localeCompare(right.terminalPredictionId));
  return {
    observations,
    binaryObservations: observations.filter((entry) => entry.outcome != null),
    s5cChains: groups.size,
    uniqueAnalyticalCycles,
    duplicatesExcluded,
    exclusionCounts: exclusions,
  };
}

function wilson95(wins: number, total: number): { low: number; high: number } | null {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return { low: round(Math.max(0, center - margin)), high: round(Math.min(1, center + margin)) };
}

function calibrationErrors(observations: S6mObservation[]): { ece: number | null; mce: number | null } {
  const binary = observations.filter((entry) => entry.outcome != null);
  if (!binary.length) return { ece: null, mce: null };
  const gaps: Array<{ count: number; gap: number }> = [];
  for (let index = 0; index < 10; index += 1) {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const values = binary.filter((entry) => entry.modelProbability >= lower
      && (index === 9 ? entry.modelProbability <= upper : entry.modelProbability < upper));
    if (!values.length) continue;
    const predicted = average(values.map((entry) => entry.modelProbability)) ?? 0;
    const observed = average(values.map((entry) => entry.outcome as number)) ?? 0;
    gaps.push({ count: values.length, gap: Math.abs(observed - predicted) });
  }
  return {
    ece: round(gaps.reduce((sum, entry) => sum + (entry.count / binary.length) * entry.gap, 0)),
    mce: round(Math.max(...gaps.map((entry) => entry.gap))),
  };
}

export function computeMlbS6mIndependentMetrics(observations: S6mObservation[]): S6lMetricSummary {
  const binary = observations.filter((entry) => entry.outcome != null);
  const wins = observations.filter((entry) => entry.result === "WIN").length;
  const losses = observations.filter((entry) => entry.result === "LOSS").length;
  const pushes = observations.filter((entry) => entry.result === "PUSH").length;
  const voids = observations.filter((entry) => entry.result === "VOID").length;
  const brier = average(binary.map((entry) => (entry.modelProbability - (entry.outcome as number)) ** 2));
  const logLoss = average(binary.map((entry) => {
    const probability = Math.min(1 - EPSILON, Math.max(EPSILON, entry.modelProbability));
    return -((entry.outcome as number) * Math.log(probability)
      + (1 - (entry.outcome as number)) * Math.log(1 - probability));
  }));
  const calibration = calibrationErrors(observations);
  const flatStake = observations.filter((entry) => entry.result !== "VOID");
  const flatProfit = flatStake.reduce((sum, entry) => {
    if (entry.result === "WIN") return sum + americanWinProfit(entry.oddsAmerican);
    if (entry.result === "LOSS") return sum - 1;
    return sum;
  }, 0);
  const clv = observations.map((entry) => entry.clvPp).filter((value): value is number => value != null);
  return {
    observations: observations.length,
    binaryDecisions: binary.length,
    wins,
    losses,
    pushes,
    voids,
    meanModelProbability: binary.length ? round(average(binary.map((entry) => entry.modelProbability)) as number) : null,
    observedWinRate: binary.length ? round(wins / binary.length) : null,
    winRateWilson95: wilson95(wins, binary.length),
    brierScore: brier == null ? null : round(brier),
    logLoss: logLoss == null ? null : round(logLoss),
    expectedCalibrationError: calibration.ece,
    maximumCalibrationError: calibration.mce,
    flatStakeExposureUnits: flatStake.length,
    flatStakeProfitUnits: round(flatProfit, 4),
    flatStakeRoiPct: flatStake.length ? round((flatProfit / flatStake.length) * 100, 4) : null,
    clvAvailable: clv.length,
    clvCoveragePct: observations.length ? round((clv.length / observations.length) * 100, 2) : null,
    meanClvPp: clv.length ? round(average(clv) as number, 4) : null,
    medianClvPp: clv.length ? round(median(clv) as number, 4) : null,
  };
}

function manifestFor(observations: S6mObservation[]): S6mManifestEntry[] {
  return observations.map(({ terminalRecordedAtMs: _ignored, ...entry }, index) => ({
    ordinal: index + 1,
    ...entry,
  }));
}

function certificateCore(certificate: Omit<S6mMilestoneCertificate, "certificateDigestSha256">): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {
  return certificate;
}

export function buildMlbS6mMilestoneCertificate(
  binaryObservations: S6mObservation[],
  milestone: S6mMilestone,
  options: {
    createdAt: string;
    sourceS6lGeneratedAt: string;
    deploymentCommit?: string;
    environment?: string;
  },
): S6mMilestoneCertificate {
  const selected = binaryObservations.slice(0, milestone);
  if (selected.length !== milestone) throw new Error(`Milestone ${milestone} requires exactly ${milestone} binary decisions.`);
  const manifest = manifestFor(selected);
  const core = certificateCore({
    schemaVersion: MLB_S6M_CERTIFICATE_VERSION,
    milestone,
    createdAt: options.createdAt,
    sourceS6lGeneratedAt: options.sourceS6lGeneratedAt,
    deploymentCommit: options.deploymentCommit ?? "unknown",
    environment: options.environment ?? "unknown",
    sampleRule: "FIRST_N_ELIGIBLE_BINARY_DECISIONS_BY_TERMINAL_TIME",
    manifest,
    manifestDigestSha256: stableDigest(manifest),
    metrics: computeMlbS6mIndependentMetrics(selected),
    checks: {
      exactSampleSize: true,
      duplicateFree: true,
      allPostFix: true,
      allTerminalFinal: true,
      allSettled: true,
      allStandardAmericanOdds: true,
      allPriceProvenanceComplete: true,
    },
  });
  return { ...core, certificateDigestSha256: stableDigest(core) };
}

function compareNullableNumber(label: string, left: number | null, right: number | null, mismatches: string[], tolerance = 1e-6): void {
  if (left == null && right == null) return;
  if (left == null || right == null || Math.abs(left - right) > tolerance) {
    mismatches.push(`${label}: independent=${left} s6l=${right}`);
  }
}

function compareMetrics(independent: S6lMetricSummary, s6l: S6lMetricSummary): string[] {
  const mismatches: string[] = [];
  for (const key of ["observations", "binaryDecisions", "wins", "losses", "pushes", "voids", "flatStakeExposureUnits", "clvAvailable"] as const) {
    if (independent[key] !== s6l[key]) mismatches.push(`${key}: independent=${independent[key]} s6l=${s6l[key]}`);
  }
  for (const key of [
    "meanModelProbability",
    "observedWinRate",
    "brierScore",
    "logLoss",
    "expectedCalibrationError",
    "maximumCalibrationError",
    "flatStakeProfitUnits",
    "flatStakeRoiPct",
    "clvCoveragePct",
    "meanClvPp",
    "medianClvPp",
  ] as const) {
    compareNullableNumber(key, independent[key], s6l[key], mismatches);
  }
  compareNullableNumber("winRateWilson95.low", independent.winRateWilson95?.low ?? null, s6l.winRateWilson95?.low ?? null, mismatches);
  compareNullableNumber("winRateWilson95.high", independent.winRateWilson95?.high ?? null, s6l.winRateWilson95?.high ?? null, mismatches);
  return mismatches;
}

function certificateWithoutDigest(certificate: S6mMilestoneCertificate): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {
  const { certificateDigestSha256: _ignored, ...core } = certificate;
  return core;
}

function validateCertificate(
  certificate: S6mMilestoneCertificate,
  binaryObservations: S6mObservation[],
): string[] {
  const errors: string[] = [];
  if (!MLB_S6M_MILESTONES.includes(certificate.milestone)) errors.push("Unsupported milestone value.");
  if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION) errors.push("Unexpected certificate schema.");
  if (stableDigest(certificateWithoutDigest(certificate)) !== certificate.certificateDigestSha256) {
    errors.push("Certificate digest does not match its contents.");
  }
  const expected = binaryObservations.slice(0, certificate.milestone);
  if (expected.length !== certificate.milestone) {
    errors.push("Current ledger contains fewer binary decisions than the immutable certificate.");
    return errors;
  }
  const currentManifest = manifestFor(expected);
  const expectedManifest = currentManifest.map((entry, index) => ({
    ...entry,
    // Independent certification is a later lifecycle annotation, not part of the immutable pick identity.
    independentlyCertified: certificate.manifest[index]?.independentlyCertified ?? entry.independentlyCertified,
  }));
  if (stableDigest(certificate.manifest) !== certificate.manifestDigestSha256) {
    errors.push("Manifest digest does not match the stored manifest.");
  }
  if (stableDigest(expectedManifest) !== certificate.manifestDigestSha256) {
    errors.push("Current deterministic first-N manifest differs from the stored certificate.");
  }
  const expectedMetrics = computeMlbS6mIndependentMetrics(expected);
  const metricErrors = compareMetrics(expectedMetrics, certificate.metrics);
  errors.push(...metricErrors.map((entry) => `Certificate metric mismatch: ${entry}`));
  return errors;
}

function highestState(milestone: S6mMilestone | 0): S6mState {
  if (milestone === 50) return "MILESTONE_50_CERTIFIED";
  if (milestone === 20) return "MILESTONE_20_CERTIFIED";
  if (milestone === 5) return "MILESTONE_5_CERTIFIED";
  if (milestone === 1) return "MILESTONE_1_CERTIFIED";
  return "WAITING_FOR_MILESTONE_1";
}

export function evaluateMlbS6mMilestones(
  records: LedgerRecord[],
  s6lReport: S6lScientificMetricsReport | null,
  certifiedTerminalPredictionIds: string[],
  existingCertificates: S6mCertificateMap = {},
  options: {
    generatedAt?: string;
    trigger?: string;
    deploymentCommit?: string;
    environment?: string;
    previousOwnedLedgerRecords?: number | null;
    certificateReadErrors?: Array<{ milestone: S6mMilestone; message: string }>;
    previouslyCertifiedMilestones?: S6mMilestone[];
  } = {},
): { report: S6mMilestoneReport; newCertificates: S6mMilestoneCertificate[] } {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const deploymentCommit = options.deploymentCommit ?? "unknown";
  const environment = options.environment ?? "unknown";
  const sample = extractMlbS6mIndependentSample(records, certifiedTerminalPredictionIds);
  const independentMetrics = computeMlbS6mIndependentMetrics(sample.observations);
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || records.length >= previousCount;
  const issues: S6mMilestoneReport["issues"] = [];
  const parityMismatches: string[] = [];

  for (const readError of options.certificateReadErrors ?? []) {
    issues.push({
      code: `MILESTONE_${readError.milestone}_CERTIFICATE_UNREADABLE`,
      severity: "CRITICAL",
      message: readError.message,
    });
  }

  if (!s6lReport) {
    issues.push({ code: "S6L_REPORT_PENDING", severity: "INFO", message: "The scientific metrics source report is not available yet." });
  } else {
    parityMismatches.push(...compareMetrics(independentMetrics, s6lReport.overall));
    if (sample.binaryObservations.length !== s6lReport.sample.binaryScoredDecisions) {
      parityMismatches.push(`binaryScoredDecisions: independent=${sample.binaryObservations.length} s6l=${s6lReport.sample.binaryScoredDecisions}`);
    }
    if (sample.observations.length !== s6lReport.sample.eligibleSettledDecisions) {
      parityMismatches.push(`eligibleSettledDecisions: independent=${sample.observations.length} s6l=${s6lReport.sample.eligibleSettledDecisions}`);
    }
    const independentCertified = sample.observations.filter((entry) => entry.independentlyCertified).length;
    if (independentCertified !== s6lReport.sample.independentlyCertifiedDecisions) {
      parityMismatches.push(`independentlyCertifiedDecisions: independent=${independentCertified} s6l=${s6lReport.sample.independentlyCertifiedDecisions}`);
    }
    for (const [key, value] of Object.entries(sample.exclusionCounts)) {
      if ((s6lReport.sample.exclusionCounts[key] ?? 0) !== value) {
        parityMismatches.push(`exclusionCounts.${key}: independent=${value} s6l=${s6lReport.sample.exclusionCounts[key] ?? 0}`);
      }
    }
  }

  if (parityMismatches.length) {
    issues.push({
      code: "S6L_INDEPENDENT_RECOMPUTATION_MISMATCH",
      severity: "CRITICAL",
      message: parityMismatches.join(" | "),
    });
  }
  if (!countMonotonic) {
    issues.push({
      code: "PERSISTENCE_COUNT_REGRESSION",
      severity: "CRITICAL",
      message: `Owned ledger count decreased from ${previousCount} to ${records.length}.`,
    });
  }

  const certificates: S6mCertificateMap = { ...existingCertificates };
  for (const milestone of options.previouslyCertifiedMilestones ?? []) {
    if (certificates[`${milestone}`]) continue;
    issues.push({
      code: `MILESTONE_${milestone}_CERTIFICATE_MISSING`,
      severity: "CRITICAL",
      message: `Milestone ${milestone} was previously certified, but its append-only certificate file is missing.`,
    });
  }
  for (const milestone of MLB_S6M_MILESTONES) {
    const certificate = certificates[`${milestone}`];
    if (!certificate) continue;
    const errors = validateCertificate(certificate, sample.binaryObservations);
    if (errors.length) {
      issues.push({
        code: `MILESTONE_${milestone}_CERTIFICATE_INVALID`,
        severity: "CRITICAL",
        message: errors.join(" | "),
      });
    }
  }

  const criticalBeforeCreation = issues.some((entry) => entry.severity === "CRITICAL");
  const newCertificates: S6mMilestoneCertificate[] = [];
  if (s6lReport && !criticalBeforeCreation) {
    for (const milestone of MLB_S6M_MILESTONES) {
      if (sample.binaryObservations.length < milestone || certificates[`${milestone}`]) continue;
      const certificate = buildMlbS6mMilestoneCertificate(sample.binaryObservations, milestone, {
        createdAt: generatedAt,
        sourceS6lGeneratedAt: s6lReport.generatedAt,
        deploymentCommit,
        environment,
      });
      certificates[`${milestone}`] = certificate;
      newCertificates.push(certificate);
    }
  }

  const milestoneRows = MLB_S6M_MILESTONES.map((milestone) => {
    const certificate = certificates[`${milestone}`];
    const failed = issues.some((entry) => entry.code === `MILESTONE_${milestone}_CERTIFICATE_INVALID`);
    return {
      milestone,
      status: failed ? "FAILED" as const : certificate ? "CERTIFIED" as const : "PENDING" as const,
      certificateCreatedAt: certificate?.createdAt ?? null,
      certificateDigestSha256: certificate?.certificateDigestSha256 ?? null,
      manifestDigestSha256: certificate?.manifestDigestSha256 ?? null,
    };
  });
  const highestCertifiedMilestone = [...MLB_S6M_MILESTONES]
    .reverse()
    .find((milestone) => milestoneRows.some((entry) => entry.milestone === milestone && entry.status === "CERTIFIED")) ?? 0;
  const nextMilestone = MLB_S6M_MILESTONES.find((milestone) => milestone > highestCertifiedMilestone) ?? null;
  const independentlyCertifiedDecisions = sample.observations.filter((entry) => entry.independentlyCertified).length;
  const tenCertifiedCyclesReached = independentlyCertifiedDecisions >= 10;
  const preferredSampleCertified = highestCertifiedMilestone >= 50;
  const critical = issues.some((entry) => entry.severity === "CRITICAL");
  const humanReviewReady = !critical
    && preferredSampleCertified
    && tenCertifiedCyclesReached
    && s6lReport?.state === "READY_FOR_REVIEW"
    && s6lReport.readiness.conclusionsAllowed === true;
  if (!critical && highestCertifiedMilestone === 0) {
    issues.push({
      code: "FIRST_ELIGIBLE_SETTLEMENT_PENDING",
      severity: "INFO",
      message: `${sample.binaryObservations.length} eligible binary decisions are available; the first milestone requires 1.`,
    });
  } else if (!critical && nextMilestone) {
    issues.push({
      code: `MILESTONE_${nextMilestone}_PENDING`,
      severity: "INFO",
      message: `${sample.binaryObservations.length} eligible binary decisions are available; the next immutable milestone requires ${nextMilestone}.`,
    });
  }

  const report: S6mMilestoneReport = {
    schemaVersion: MLB_S6M_STATISTICAL_MILESTONES_VERSION,
    generatedAt,
    trigger: options.trigger ?? "manual",
    deploymentCommit,
    environment,
    state: critical ? "ACTION_REQUIRED" : highestState(highestCertifiedMilestone),
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      requiredConsensusMethod: MLB_S6I_REQUIRED_CONSENSUS_METHOD,
      milestones: MLB_S6M_MILESTONES,
    },
    sourceS6l: {
      available: Boolean(s6lReport),
      schemaVersion: s6lReport?.schemaVersion ?? null,
      generatedAt: s6lReport?.generatedAt ?? null,
      state: s6lReport?.state ?? null,
    },
    sample: {
      ownedLedgerRecords: records.length,
      s5cChains: sample.s5cChains,
      uniqueAnalyticalCycles: sample.uniqueAnalyticalCycles,
      eligibleSettledDecisions: sample.observations.length,
      binaryScoredDecisions: sample.binaryObservations.length,
      independentlyCertifiedDecisions,
      duplicatesExcluded: sample.duplicatesExcluded,
      exclusionCounts: sample.exclusionCounts,
    },
    independentMetrics,
    metricParity: {
      checked: Boolean(s6lReport),
      passed: Boolean(s6lReport) && parityMismatches.length === 0,
      mismatches: parityMismatches,
    },
    milestones: milestoneRows,
    highestCertifiedMilestone,
    nextMilestone,
    readiness: {
      firstSettlementCertified: highestCertifiedMilestone >= 1,
      fiveResultCheckCertified: highestCertifiedMilestone >= 5,
      minimumSampleCertified: highestCertifiedMilestone >= 20,
      preferredSampleCertified,
      tenCertifiedCyclesReached,
      humanReviewReady,
      conclusionsAllowed: humanReviewReady,
      automaticModelChangesAllowed: false,
      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",
    },
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: records.length,
      countMonotonic,
      certificatesAppendOnly: true,
    },
    issues,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  };
  return { report, newCertificates };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function writeAppendOnlyJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6M_STATISTICAL_MILESTONES?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6M_STATISTICAL_MILESTONES_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6m-statistical-milestones");
}

export class MlbS6mStatisticalMilestonesService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly s6lScientificMetrics: MlbS6lScientificMetricsService,
    private readonly s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
    options: S6mOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6M_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6M_INITIAL_DELAY_MS, 240_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.now = options.now ?? (() => new Date());
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S6mMilestoneReport | null {
    return readJson<S6mMilestoneReport>(path.join(this.root, "latest.json"));
  }
  private readCertificateInventory(): {
    certificates: S6mCertificateMap;
    errors: Array<{ milestone: S6mMilestone; message: string }>;
  } {
    const certificates: S6mCertificateMap = {};
    const errors: Array<{ milestone: S6mMilestone; message: string }> = [];
    for (const milestone of MLB_S6M_MILESTONES) {
      const filePath = path.join(this.root, "certificates", `milestone-${milestone}.json`);
      if (!fs.existsSync(filePath)) continue;
      try {
        certificates[`${milestone}`] = JSON.parse(fs.readFileSync(filePath, "utf8")) as S6mMilestoneCertificate;
      } catch (error) {
        errors.push({
          milestone,
          message: `Unable to read append-only milestone ${milestone} certificate: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { certificates, errors };
  }
  readCertificates(): S6mCertificateMap {
    return this.readCertificateInventory().certificates;
  }
  status(): S6mStatus {
    return {
      schemaVersion: MLB_S6M_STATISTICAL_MILESTONES_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  async run(trigger = "scheduled"): Promise<S6mMilestoneReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const s6lReport = this.s6lScientificMetrics.readLatest();
      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])
        .filter((entry) => entry.state === "CERTIFIED")
        .map((entry) => entry.target.terminalPredictionId)
        .filter((entry): entry is string => Boolean(entry));
      const certificateInventory = this.readCertificateInventory();
      const previouslyCertifiedMilestones = (previous?.milestones ?? [])
        .filter((entry) => entry.status === "CERTIFIED")
        .map((entry) => entry.milestone);
      const evaluation = evaluateMlbS6mMilestones(
        records,
        s6lReport,
        certifiedTerminalPredictionIds,
        certificateInventory.certificates,
        {
          generatedAt: now.toISOString(),
          trigger,
          deploymentCommit: this.deploymentCommit,
          environment: this.environment,
          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
          certificateReadErrors: certificateInventory.errors,
          previouslyCertifiedMilestones,
        },
      );
      for (const certificate of evaluation.newCertificates) {
        const filePath = path.join(this.root, "certificates", `milestone-${certificate.milestone}.json`);
        try {
          writeAppendOnlyJson(filePath, certificate);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      const finalEvaluation = evaluation.newCertificates.length
        ? (() => {
          const refreshedInventory = this.readCertificateInventory();
          return evaluateMlbS6mMilestones(
            records,
            s6lReport,
            certifiedTerminalPredictionIds,
            refreshedInventory.certificates,
            {
              generatedAt: now.toISOString(),
              trigger,
              deploymentCommit: this.deploymentCommit,
              environment: this.environment,
              previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
              certificateReadErrors: refreshedInventory.errors,
              previouslyCertifiedMilestones,
            },
          );
        })()
        : evaluation;
      const report = finalEvaluation.report;
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const previousDigest = previous ? stableDigest({ ...previous, generatedAt: undefined, trigger: undefined }) : null;
      const currentDigest = stableDigest({ ...report, generatedAt: undefined, trigger: undefined });
      if (currentDigest !== previousDigest) {
        atomicWriteJson(
          path.join(this.root, "snapshots", `${report.generatedAt.replace(/[:.]/g, "-")}-${currentDigest.slice(0, 12)}.json`),
          report,
        );
      }
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS6mStatisticalMilestoneWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s6lScientificMetrics: MlbS6lScientificMetricsService,
  s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
  options: S6mOptions,
): { service: MlbS6mStatisticalMilestonesService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6mStatisticalMilestonesService(
    store,
    ownershipStore,
    s6lScientificMetrics,
    s6kFirstTen,
    options,
  );
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6m] statistical milestone certifier failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
