import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS6kFirstTenCyclesCertificationService } from "./mlb-s6k-first-ten-cycles-certification";
import type {
  MlbS6oFirstFiveSettlementsCertificationService,
  S6oReport,
} from "./mlb-s6o-first-five-settlements-certification";
import {
  computeMlbS6mIndependentMetrics,
  extractMlbS6mIndependentSample,
  MLB_S6M_CERTIFICATE_VERSION,
  type MlbS6mStatisticalMilestonesService,
  type S6mCertificateMap,
  type S6mManifestEntry,
  type S6mMilestoneCertificate,
  type S6mMilestoneReport,
  type S6mObservation,
} from "./mlb-s6m-statistical-milestones";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";

export const MLB_S6P_FIRST_TWENTY_VERSION = "mlb-s6p-first-twenty-settlements-certification.v1" as const;
export const MLB_S6P_BASELINE_VERSION = "mlb-s6p-first-twenty-settlements-baseline.v1" as const;
export const MLB_S6P_EVIDENCE_VERSION = "mlb-s6p-first-twenty-settlements-evidence.v1" as const;
export const MLB_S6P_TARGET_SIZE = 20 as const;

export type S6pState =
  | "ARMED_AND_WAITING_FOR_20"
  | "OBSERVING_TWENTY_RESULT_STABILITY"
  | "MINIMUM_SAMPLE_20_CERTIFIED"
  | "ACTION_REQUIRED";

export type S6pBaseline = {
  schemaVersion: typeof MLB_S6P_BASELINE_VERSION;
  firstObservedAt: string;
  firstObservedDeploymentCommit: string;
  sourceS6mGeneratedAt: string;
  sourceS6oGeneratedAt: string;
  certificateDigestSha256: string;
  manifestDigestSha256: string;
  terminalPredictionIds: string[];
  settlementEventIds: string[];
  results: Array<"WIN" | "LOSS">;
  ownedLedgerRecordsAtFirstObservation: number;
  baselineDigestSha256: string;
};

export type S6pBreakdown = {
  key: string;
  sampleSize: number;
  metrics: S6mMilestoneCertificate["metrics"];
};

export type S6pCalibrationBucket = {
  label: string;
  minimumProbability: number;
  maximumProbability: number;
  sampleSize: number;
  meanPredictedProbability: number | null;
  observedWinRate: number | null;
  calibrationGap: number | null;
};

export type S6pProvisionalFinalComparison = {
  comparableDecisions: number;
  meanSignedProbabilityChangePp: number | null;
  meanAbsoluteProbabilityChangePp: number | null;
  signalChangedCount: number;
  marketIdentityChangedCount: number;
};

export type S6pEvidence = {
  schemaVersion: typeof MLB_S6P_EVIDENCE_VERSION;
  certifiedAt: string;
  deploymentCommit: string;
  environment: string;
  sourceS6mGeneratedAt: string;
  sourceS6mState: string;
  sourceS6oGeneratedAt: string;
  sourceS6oState: string;
  baselineDigestSha256: string;
  certificateDigestSha256: string;
  manifestDigestSha256: string;
  stability: {
    firstObservedAt: string;
    confirmedAt: string;
    stableForMs: number;
    minimumRequiredMs: number;
    distinctWorkerRuns: true;
  };
  manifest: S6mManifestEntry[];
  metrics: S6mMilestoneCertificate["metrics"];
  marketBreakdowns: S6pBreakdown[];
  signalBreakdowns: S6pBreakdown[];
  calibrationBuckets: S6pCalibrationBucket[];
  provisionalFinalComparison: S6pProvisionalFinalComparison;
  sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS";
  checks: {
    milestoneTwentyCertificatePresent: true;
    prerequisiteFirstFiveSettlementsCertified: true;
    exactTwentyDecisionSample: true;
    duplicateFree: true;
    certificateDigestValid: true;
    manifestDigestValid: true;
    currentLedgerManifestMatches: true;
    terminalRecordsPresent: true;
    terminalStagesFinal: true;
    settlementsPresent: true;
    settlementIdentitiesMatch: true;
    settlementResultsBinary: true;
    standardAmericanOdds: true;
    postFixCohort: true;
    s6mMetricParityPassed: true;
    independentTwentyDecisionMetricsMatch: true;
    noCriticalS6mIssues: true;
    ledgerCountMonotonic: true;
    certificateStableAcrossRuns: true;
  };
  evidenceDigestSha256: string;
};

export type S6pReport = {
  schemaVersion: typeof MLB_S6P_FIRST_TWENTY_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6pState;
  sourceS6m: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    metricParityChecked: boolean;
    metricParityPassed: boolean;
    criticalIssues: number;
    milestoneTwentyClaimed: boolean;
  };
  sourceS6o: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    firstFiveSettlementsCertified: boolean;
    criticalIssues: number;
  };
  sample: {
    ownedLedgerRecords: number;
    binaryEligibleDecisions: number;
    targetSize: typeof MLB_S6P_TARGET_SIZE;
    independentlyCertifiedAmongFirstTwenty: number;
    certifiedTerminalPredictionIds: number;
  };
  target: {
    certificatePresent: boolean;
    manifestEntries: number;
    wins: number | null;
    losses: number | null;
    clvAvailable: number | null;
    certificateDigestSha256: string | null;
    manifestDigestSha256: string | null;
  };
  stability: {
    baselinePresent: boolean;
    evidencePresent: boolean;
    firstObservedAt: string | null;
    stableForMs: number | null;
    minimumRequiredMs: number;
    stableAcrossRuns: boolean;
  };
  checks: {
    prerequisiteFirstFiveSettlementsCertified: boolean;
    certificateIntegrity: boolean | null;
    currentLedgerManifestMatches: boolean | null;
    settlementIdentitiesMatch: boolean | null;
    s6mIntegrityGatePassed: boolean;
    ledgerCountMonotonic: boolean;
    appendOnlyBaseline: true;
    appendOnlyEvidence: true;
  };
  readiness: {
    armed: boolean;
    minimumSample20Certified: boolean;
    minimumSampleIntegrityValidated: boolean;
    preliminaryReviewAvailable: boolean;
    sampleAdequateForModelConclusions: false;
    conclusionsAllowed: false;
    automaticModelChangesAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  persistence: {
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
    baselineAppendOnly: true;
    evidenceAppendOnly: true;
  };
  issues: Array<{
    code: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    message: string;
  }>;
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    historicalLedgerMutation: false;
    automaticPromotion: false;
    formulasChanged: false;
    probabilitiesChanged: false;
    signalsChanged: false;
    marketsChanged: false;
    thresholdsChanged: false;
    settlementRulesChanged: false;
    stakePolicyChanged: false;
  };
};

type S6pOptions = {
  ownerUserId: number;
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  minimumStabilityMs?: number;
  maxSnapshots?: number;
  root?: string;
  now?: () => Date;
  deploymentCommit?: string;
  environment?: string;
};

type StoredArtifacts = {
  baseline: S6pBaseline | null;
  evidence: S6pEvidence | null;
  baselinePresent?: boolean;
  evidencePresent?: boolean;
  baselineReadError?: string | null;
  evidenceReadError?: string | null;
};

type EvaluationOptions = {
  generatedAt?: string;
  trigger?: string;
  deploymentCommit?: string;
  environment?: string;
  minimumStabilityMs?: number;
  previousOwnedLedgerRecords?: number | null;
};

type EvaluationResult = {
  report: S6pReport;
  baselineToPersist: S6pBaseline | null;
  evidenceToPersist: S6pEvidence | null;
};

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicalize(value));
}

function certificateCore(certificate: S6mMilestoneCertificate): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {
  const { certificateDigestSha256: _ignored, ...core } = certificate;
  return core;
}

function baselineCore(baseline: S6pBaseline): Omit<S6pBaseline, "baselineDigestSha256"> {
  const { baselineDigestSha256: _ignored, ...core } = baseline;
  return core;
}

function evidenceCore(evidence: S6pEvidence): Omit<S6pEvidence, "evidenceDigestSha256"> {
  const { evidenceDigestSha256: _ignored, ...core } = evidence;
  return core;
}

function manifestFor(observations: S6mObservation[]): S6mManifestEntry[] {
  return observations.map(({ terminalRecordedAtMs: _ignored, settlementCorrectionOfEventId: _correction, ...entry }, index) => ({
    ordinal: index + 1,
    ...entry,
  }));
}

function pushIssue(
  issues: S6pReport["issues"],
  code: string,
  severity: "INFO" | "WARNING" | "CRITICAL",
  message: string,
): void {
  issues.push({ code, severity, message });
}

function groupedBreakdowns(
  observations: S6mObservation[],
  keyOf: (entry: S6mObservation) => string,
): S6pBreakdown[] {
  const groups = new Map<string, S6mObservation[]>();
  for (const observation of observations) {
    const key = keyOf(observation);
    const entries = groups.get(key) ?? [];
    entries.push(observation);
    groups.set(key, entries);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => ({
      key,
      sampleSize: entries.length,
      metrics: computeMlbS6mIndependentMetrics(entries),
    }));
}

function roundS6p(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const S6P_CALIBRATION_BUCKETS = [
  { label: "0.00-0.49", minimumProbability: 0, maximumProbability: 0.5 },
  { label: "0.50-0.54", minimumProbability: 0.5, maximumProbability: 0.55 },
  { label: "0.55-0.59", minimumProbability: 0.55, maximumProbability: 0.6 },
  { label: "0.60-0.64", minimumProbability: 0.6, maximumProbability: 0.65 },
  { label: "0.65-0.69", minimumProbability: 0.65, maximumProbability: 0.7 },
  { label: "0.70-0.74", minimumProbability: 0.7, maximumProbability: 0.75 },
  { label: "0.75-1.00", minimumProbability: 0.75, maximumProbability: 1.0000001 },
] as const;

function buildCalibrationBuckets(observations: S6mObservation[]): S6pCalibrationBucket[] {
  return S6P_CALIBRATION_BUCKETS.map((bucket) => {
    const entries = observations.filter((entry) =>
      entry.modelProbability >= bucket.minimumProbability
      && entry.modelProbability < bucket.maximumProbability
      && (entry.outcome === 0 || entry.outcome === 1));
    if (!entries.length) {
      return { ...bucket, sampleSize: 0, meanPredictedProbability: null, observedWinRate: null, calibrationGap: null };
    }
    const meanPredictedProbability = entries.reduce((sum, entry) => sum + entry.modelProbability, 0) / entries.length;
    const observedWinRate = entries.reduce((sum, entry) => sum + (entry.outcome ?? 0), 0) / entries.length;
    return {
      ...bucket,
      sampleSize: entries.length,
      meanPredictedProbability: roundS6p(meanPredictedProbability),
      observedWinRate: roundS6p(observedWinRate),
      calibrationGap: roundS6p(Math.abs(observedWinRate - meanPredictedProbability)),
    };
  });
}

function buildProvisionalFinalComparison(
  records: LedgerRecord[],
  observations: S6mObservation[],
): S6pProvisionalFinalComparison {
  const probabilityChanges: number[] = [];
  let signalChangedCount = 0;
  let marketIdentityChangedCount = 0;
  for (const observation of observations) {
    const provisional = records.find((record) => record.prediction.id === observation.rootPredictionId) ?? null;
    const terminal = records.find((record) => record.prediction.id === observation.terminalPredictionId) ?? null;
    if (!provisional || !terminal || provisional.prediction.analysisStage !== "PROVISIONAL") continue;
    const provisionalProbability = provisional.prediction.probabilities.model;
    const finalProbability = terminal.prediction.probabilities.model;
    if (!Number.isFinite(provisionalProbability) || !Number.isFinite(finalProbability)) continue;
    probabilityChanges.push((finalProbability - provisionalProbability) * 100);
    if (provisional.prediction.decision.signal !== terminal.prediction.decision.signal) signalChangedCount += 1;
    const provisionalIdentity = JSON.stringify([
      provisional.prediction.market.type,
      provisional.prediction.market.selection,
      provisional.prediction.market.line ?? null,
    ]);
    const finalIdentity = JSON.stringify([
      terminal.prediction.market.type,
      terminal.prediction.market.selection,
      terminal.prediction.market.line ?? null,
    ]);
    if (provisionalIdentity !== finalIdentity) marketIdentityChangedCount += 1;
  }
  return {
    comparableDecisions: probabilityChanges.length,
    meanSignedProbabilityChangePp: probabilityChanges.length
      ? roundS6p(probabilityChanges.reduce((sum, value) => sum + value, 0) / probabilityChanges.length, 4)
      : null,
    meanAbsoluteProbabilityChangePp: probabilityChanges.length
      ? roundS6p(probabilityChanges.reduce((sum, value) => sum + Math.abs(value), 0) / probabilityChanges.length, 4)
      : null,
    signalChangedCount,
    marketIdentityChangedCount,
  };
}

function makeBaseline(
  certificate: S6mMilestoneCertificate,
  ownedLedgerRecords: number,
  generatedAt: string,
  deploymentCommit: string,
  sourceS6mGeneratedAt: string,
  sourceS6oGeneratedAt: string,
): S6pBaseline {
  const core: Omit<S6pBaseline, "baselineDigestSha256"> = {
    schemaVersion: MLB_S6P_BASELINE_VERSION,
    firstObservedAt: generatedAt,
    firstObservedDeploymentCommit: deploymentCommit,
    sourceS6mGeneratedAt,
    sourceS6oGeneratedAt,
    certificateDigestSha256: certificate.certificateDigestSha256,
    manifestDigestSha256: certificate.manifestDigestSha256,
    terminalPredictionIds: certificate.manifest.map((entry) => entry.terminalPredictionId),
    settlementEventIds: certificate.manifest.map((entry) => entry.settlementEventId),
    results: certificate.manifest.map((entry) => entry.result as "WIN" | "LOSS"),
    ownedLedgerRecordsAtFirstObservation: ownedLedgerRecords,
  };
  return { ...core, baselineDigestSha256: sha256(core) };
}

function makeEvidence(
  certificate: S6mMilestoneCertificate,
  baseline: S6pBaseline,
  s6mReport: S6mMilestoneReport,
  s6oReport: S6oReport,
  selected: S6mObservation[],
  records: LedgerRecord[],
  generatedAt: string,
  deploymentCommit: string,
  environment: string,
  minimumStabilityMs: number,
): S6pEvidence {
  const stableForMs = Math.max(0, Date.parse(generatedAt) - Date.parse(baseline.firstObservedAt));
  const core: Omit<S6pEvidence, "evidenceDigestSha256"> = {
    schemaVersion: MLB_S6P_EVIDENCE_VERSION,
    certifiedAt: generatedAt,
    deploymentCommit,
    environment,
    sourceS6mGeneratedAt: s6mReport.generatedAt,
    sourceS6mState: s6mReport.state,
    sourceS6oGeneratedAt: s6oReport.generatedAt,
    sourceS6oState: s6oReport.state,
    baselineDigestSha256: baseline.baselineDigestSha256,
    certificateDigestSha256: certificate.certificateDigestSha256,
    manifestDigestSha256: certificate.manifestDigestSha256,
    stability: {
      firstObservedAt: baseline.firstObservedAt,
      confirmedAt: generatedAt,
      stableForMs,
      minimumRequiredMs: minimumStabilityMs,
      distinctWorkerRuns: true,
    },
    manifest: certificate.manifest,
    metrics: certificate.metrics,
    marketBreakdowns: groupedBreakdowns(selected, (entry) => entry.marketType),
    signalBreakdowns: groupedBreakdowns(selected, (entry) => entry.signal),
    calibrationBuckets: buildCalibrationBuckets(selected),
    provisionalFinalComparison: buildProvisionalFinalComparison(records, selected),
    sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS",
    checks: {
      milestoneTwentyCertificatePresent: true,
      prerequisiteFirstFiveSettlementsCertified: true,
      exactTwentyDecisionSample: true,
      duplicateFree: true,
      certificateDigestValid: true,
      manifestDigestValid: true,
      currentLedgerManifestMatches: true,
      terminalRecordsPresent: true,
      terminalStagesFinal: true,
      settlementsPresent: true,
      settlementIdentitiesMatch: true,
      settlementResultsBinary: true,
      standardAmericanOdds: true,
      postFixCohort: true,
      s6mMetricParityPassed: true,
      independentTwentyDecisionMetricsMatch: true,
      noCriticalS6mIssues: true,
      ledgerCountMonotonic: true,
      certificateStableAcrossRuns: true,
    },
  };
  return { ...core, evidenceDigestSha256: sha256(core) };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isS6pBaselineArtifactShape(value: unknown): value is S6pBaseline {
  if (!isObjectRecord(value)) return false;
  return typeof value.schemaVersion === "string"
    && typeof value.firstObservedAt === "string"
    && typeof value.firstObservedDeploymentCommit === "string"
    && typeof value.sourceS6mGeneratedAt === "string"
    && typeof value.sourceS6oGeneratedAt === "string"
    && typeof value.certificateDigestSha256 === "string"
    && typeof value.manifestDigestSha256 === "string"
    && isStringArray(value.terminalPredictionIds)
    && isStringArray(value.settlementEventIds)
    && Array.isArray(value.results)
    && value.results.every((entry) => entry === "WIN" || entry === "LOSS")
    && typeof value.ownedLedgerRecordsAtFirstObservation === "number"
    && typeof value.baselineDigestSha256 === "string";
}

function isS6pEvidenceArtifactShape(value: unknown): value is S6pEvidence {
  if (!isObjectRecord(value)) return false;
  const stability = value.stability;
  const checks = value.checks;
  return typeof value.schemaVersion === "string"
    && typeof value.certifiedAt === "string"
    && typeof value.deploymentCommit === "string"
    && typeof value.environment === "string"
    && typeof value.sourceS6mGeneratedAt === "string"
    && typeof value.sourceS6mState === "string"
    && typeof value.sourceS6oGeneratedAt === "string"
    && typeof value.sourceS6oState === "string"
    && typeof value.baselineDigestSha256 === "string"
    && typeof value.certificateDigestSha256 === "string"
    && typeof value.manifestDigestSha256 === "string"
    && isObjectRecord(stability)
    && typeof stability.firstObservedAt === "string"
    && typeof stability.confirmedAt === "string"
    && typeof stability.stableForMs === "number"
    && typeof stability.minimumRequiredMs === "number"
    && stability.distinctWorkerRuns === true
    && Array.isArray(value.manifest)
    && isObjectRecord(value.metrics)
    && Array.isArray(value.marketBreakdowns)
    && Array.isArray(value.signalBreakdowns)
    && Array.isArray(value.calibrationBuckets)
    && isObjectRecord(value.provisionalFinalComparison)
    && typeof value.sampleAdequacy === "string"
    && isObjectRecord(checks)
    && typeof value.evidenceDigestSha256 === "string";
}

function exactStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function evaluateMlbS6pFirstTwentySettlements(
  records: LedgerRecord[],
  s6mReport: S6mMilestoneReport | null,
  certificates: S6mCertificateMap,
  s6oReport: S6oReport | null,
  certifiedTerminalPredictionIds: string[],
  stored: StoredArtifacts,
  options: EvaluationOptions = {},
): EvaluationResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const deploymentCommit = options.deploymentCommit ?? "unknown";
  const environment = options.environment ?? "unknown";
  const minimumStabilityMs = options.minimumStabilityMs ?? 5 * 60 * 1000;
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || records.length >= previousCount;
  const sample = extractMlbS6mIndependentSample(records, certifiedTerminalPredictionIds);
  const selected = sample.binaryObservations.slice(0, MLB_S6P_TARGET_SIZE);
  const baselinePresent = stored.baselinePresent
    ?? (stored.baseline !== null && stored.baseline !== undefined);
  const evidencePresent = stored.evidencePresent
    ?? (stored.evidence !== null && stored.evidence !== undefined);
  const issues: S6pReport["issues"] = [];
  let baselineToPersist: S6pBaseline | null = null;
  let evidenceToPersist: S6pEvidence | null = null;

  if (stored.baselineReadError) pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);
  if (stored.evidenceReadError) pushIssue(issues, "EVIDENCE_UNREADABLE", "CRITICAL", stored.evidenceReadError);
  if (!countMonotonic) {
    pushIssue(
      issues,
      "PERSISTENCE_COUNT_REGRESSION",
      "CRITICAL",
      `Owned ledger count decreased from ${previousCount} to ${records.length}.`,
    );
  }

  const s6mCriticalIssues = s6mReport?.issues.filter((entry) => entry.severity === "CRITICAL").length ?? 0;
  const s6mIntegrityGatePassed = Boolean(
    s6mReport
      && s6mReport.state !== "ACTION_REQUIRED"
      && s6mReport.metricParity.checked
      && s6mReport.metricParity.passed
      && s6mReport.metricParity.mismatches.length === 0
      && s6mCriticalIssues === 0,
  );
  if (s6mReport && !s6mIntegrityGatePassed) {
    pushIssue(
      issues,
      "S6M_INTEGRITY_GATE_FAILED",
      "CRITICAL",
      `S6M state=${s6mReport.state}, parityPassed=${s6mReport.metricParity.passed}, criticalIssues=${s6mCriticalIssues}.`,
    );
  }

  const s6oCriticalIssues = s6oReport?.issues.filter((entry) => entry.severity === "CRITICAL").length ?? 0;
  const prerequisiteFirstFiveSettlementsCertified = Boolean(
    s6oReport
      && s6oReport.state === "FIRST_FIVE_SETTLEMENTS_CERTIFIED"
      && s6oReport.readiness.firstFiveSettlementsCertified
      && s6oCriticalIssues === 0,
  );

  const certificate = certificates["20"] ?? null;
  const milestoneTwentyRow = s6mReport?.milestones.find((entry) => entry.milestone === 20) ?? null;
  const s6mClaimsCertificate = milestoneTwentyRow?.status === "CERTIFIED"
    || (s6mReport?.highestCertifiedMilestone ?? 0) >= 20;

  if (s6mClaimsCertificate && !certificate) {
    pushIssue(
      issues,
      "S6M_MILESTONE_20_CERTIFICATE_MISSING",
      "CRITICAL",
      "S6M reports milestone 20 as certified, but the append-only certificate is unavailable.",
    );
  }
  if (certificate && !s6mClaimsCertificate) {
    pushIssue(
      issues,
      "S6M_REPORT_CERTIFICATE_DIVERGENCE",
      "CRITICAL",
      "A milestone 20 certificate exists, but the current S6M report does not acknowledge it.",
    );
  }
  if (certificate && !prerequisiteFirstFiveSettlementsCertified) {
    pushIssue(
      issues,
      "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED",
      "CRITICAL",
      "Milestone 20 exists before the S6O first-twenty-settlements chain is certified.",
    );
  }

  let certificateIntegrity: boolean | null = certificate ? true : null;
  let currentLedgerManifestMatches: boolean | null = certificate ? true : null;
  let settlementIdentitiesMatch: boolean | null = certificate ? true : null;

  if (!certificate) {
    if (stored.baseline || stored.evidence) {
      pushIssue(
        issues,
        "CERTIFICATE_DISAPPEARED_AFTER_OBSERVATION",
        "CRITICAL",
        "Milestone 20 evidence was previously observed, but its source certificate is now absent.",
      );
    }
  } else {
    if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION || certificate.milestone !== 20) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SCHEMA_INVALID", "CRITICAL", "Unexpected milestone 20 certificate schema or milestone value.");
    }
    if (certificate.manifest.length !== MLB_S6P_TARGET_SIZE || certificate.metrics.binaryDecisions !== MLB_S6P_TARGET_SIZE) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SAMPLE_SIZE_INVALID", "CRITICAL", "Milestone 20 must contain exactly twenty binary decisions.");
    }
    if (!Object.values(certificate.checks).every((value) => value === true)) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_CHECK_FLAGS_INVALID", "CRITICAL", "Milestone 20 contains a failed or missing integrity assertion.");
    }
    if (sha256(certificateCore(certificate)) !== certificate.certificateDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_DIGEST_MISMATCH", "CRITICAL", "Milestone 20 certificate digest does not match its contents.");
    }
    if (sha256(certificate.manifest) !== certificate.manifestDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "MANIFEST_DIGEST_MISMATCH", "CRITICAL", "Milestone 20 manifest digest does not match its contents.");
    }

    const currentManifest = manifestFor(selected);
    const expectedManifest = currentManifest.map((entry, index) => ({
      ...entry,
      // Independent certification may mature after the immutable certificate was created.
      independentlyCertified: certificate.manifest[index]?.independentlyCertified ?? entry.independentlyCertified,
    }));
    if (expectedManifest.length !== MLB_S6P_TARGET_SIZE
      || canonicalDigest(expectedManifest) !== canonicalDigest(certificate.manifest)) {
      currentLedgerManifestMatches = false;
      pushIssue(
        issues,
        "CURRENT_LEDGER_MANIFEST_MISMATCH",
        "CRITICAL",
        "The current deterministic first-twenty sample differs from the immutable milestone 20 manifest.",
      );
    }

    const expectedMetrics = selected.length === MLB_S6P_TARGET_SIZE
      ? computeMlbS6mIndependentMetrics(selected)
      : null;
    if (!expectedMetrics || canonicalDigest(expectedMetrics) !== canonicalDigest(certificate.metrics)) {
      certificateIntegrity = false;
      pushIssue(
        issues,
        "CERTIFICATE_METRICS_MISMATCH",
        "CRITICAL",
        "The independently recomputed twenty-decision metrics differ from the certificate metrics.",
      );
    }

    const terminalIds = certificate.manifest.map((entry) => entry.terminalPredictionId);
    const rootIds = certificate.manifest.map((entry) => entry.rootPredictionId);
    const settlementIds = certificate.manifest.map((entry) => entry.settlementEventId);
    if (new Set(terminalIds).size !== MLB_S6P_TARGET_SIZE
      || new Set(rootIds).size !== MLB_S6P_TARGET_SIZE
      || new Set(settlementIds).size !== MLB_S6P_TARGET_SIZE) {
      certificateIntegrity = false;
      pushIssue(issues, "DUPLICATE_DECISION_IDENTITY", "CRITICAL", "Milestone 20 contains duplicate analytical or settlement identities.");
    }

    for (const manifestEntry of certificate.manifest) {
      const terminal = records.find((record) => record.prediction.id === manifestEntry.terminalPredictionId) ?? null;
      if (!terminal) {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "TERMINAL_RECORD_MISSING", "CRITICAL", `Terminal ${manifestEntry.ordinal} is absent from the owned ledger.`);
        continue;
      }
      const prediction = terminal.prediction;
      const settlement = terminal.settlement;
      if (prediction.analysisStage !== "FINAL") {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "TERMINAL_STAGE_NOT_FINAL", "CRITICAL", `Terminal ${manifestEntry.ordinal} is not FINAL.`);
      }
      if (prediction.recordedAtMs < CUTOFF_MS) {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "TERMINAL_OUTSIDE_POST_FIX_COHORT", "CRITICAL", `Terminal ${manifestEntry.ordinal} predates the clean-cohort cutoff.`);
      }
      if (!Number.isInteger(prediction.market.oddsAmerican) || Math.abs(prediction.market.oddsAmerican) < 100) {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "TERMINAL_AMERICAN_ODDS_INVALID", "CRITICAL", `Terminal ${manifestEntry.ordinal} does not use standard American odds.`);
      }
      if (!settlement) {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "TERMINAL_SETTLEMENT_MISSING", "CRITICAL", `Terminal ${manifestEntry.ordinal} no longer contains settlement evidence.`);
        continue;
      }
      const sameSealedSettlement = String(settlement.eventId ?? "") === manifestEntry.settlementEventId
        && String(settlement.source ?? "") === manifestEntry.settlementSource;
      const explicitlyCorrectsSealedSettlement = settlement.source === "correction"
        && String(settlement.correctionOfEventId ?? "") === manifestEntry.settlementEventId;
      const matches = (sameSealedSettlement || explicitlyCorrectsSealedSettlement)
        && String(settlement.settledAt ?? "") === manifestEntry.settledAt
        && settlement.result === manifestEntry.result;
      if (!matches) {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "SETTLEMENT_IDENTITY_MISMATCH", "CRITICAL", `Settlement ${manifestEntry.ordinal} differs from the immutable manifest.`);
      }
      if (settlement.result !== "WIN" && settlement.result !== "LOSS") {
        settlementIdentitiesMatch = false;
        pushIssue(issues, "SETTLEMENT_NOT_BINARY", "CRITICAL", `Settlement ${manifestEntry.ordinal} is not WIN or LOSS.`);
      }
    }
  }

  const validStoredBaseline = isS6pBaselineArtifactShape(stored.baseline) ? stored.baseline : null;
  const validStoredEvidence = isS6pEvidenceArtifactShape(stored.evidence) ? stored.evidence : null;

  if (baselinePresent && !validStoredBaseline) {
    pushIssue(
      issues,
      "BASELINE_SHAPE_INVALID",
      "CRITICAL",
      "The append-only twenty-result baseline is syntactically valid JSON but has an incomplete or incompatible shape.",
    );
  } else if (validStoredBaseline) {
    const baselineIdsValid = validStoredBaseline.terminalPredictionIds.length === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.settlementEventIds.length === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.results.length === MLB_S6P_TARGET_SIZE
      && new Set(validStoredBaseline.terminalPredictionIds).size === MLB_S6P_TARGET_SIZE
      && new Set(validStoredBaseline.settlementEventIds).size === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.results.every((entry) => entry === "WIN" || entry === "LOSS");
    if (validStoredBaseline.schemaVersion !== MLB_S6P_BASELINE_VERSION
      || sha256(baselineCore(validStoredBaseline)) !== validStoredBaseline.baselineDigestSha256
      || !Number.isFinite(Date.parse(validStoredBaseline.firstObservedAt))
      || validStoredBaseline.ownedLedgerRecordsAtFirstObservation < 1
      || !baselineIdsValid) {
      pushIssue(issues, "BASELINE_INTEGRITY_INVALID", "CRITICAL", "The append-only twenty-result baseline failed integrity or semantic validation.");
    }
  }

  if (evidencePresent && !validStoredEvidence) {
    pushIssue(
      issues,
      "EVIDENCE_SHAPE_INVALID",
      "CRITICAL",
      "The append-only twenty-result evidence is syntactically valid JSON but has an incomplete or incompatible shape.",
    );
  } else if (validStoredEvidence) {
    if (validStoredEvidence.schemaVersion !== MLB_S6P_EVIDENCE_VERSION
      || sha256(evidenceCore(validStoredEvidence)) !== validStoredEvidence.evidenceDigestSha256) {
      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only twenty-result evidence failed integrity validation.");
    }
    if (!validStoredBaseline) {
      pushIssue(issues, "EVIDENCE_WITHOUT_BASELINE", "CRITICAL", "S6P evidence exists without a valid append-only baseline.");
    } else {
      const firstObservedMs = Date.parse(validStoredEvidence.stability.firstObservedAt);
      const confirmedMs = Date.parse(validStoredEvidence.stability.confirmedAt);
      const measuredStableMs = confirmedMs - firstObservedMs;
      const validLink = validStoredEvidence.baselineDigestSha256 === validStoredBaseline.baselineDigestSha256
        && validStoredEvidence.stability.firstObservedAt === validStoredBaseline.firstObservedAt
        && Number.isFinite(firstObservedMs)
        && Number.isFinite(confirmedMs)
        && measuredStableMs >= validStoredEvidence.stability.minimumRequiredMs
        && validStoredEvidence.stability.stableForMs === measuredStableMs;
      if (!validLink) {
        pushIssue(issues, "EVIDENCE_BASELINE_LINK_INVALID", "CRITICAL", "S6P evidence does not preserve a valid stability link to its baseline.");
      }
    }
    if (!Object.values(validStoredEvidence.checks).every((value) => value === true)) {
      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6P evidence contains a failed or missing verification assertion.");
    }
    if (validStoredEvidence.sampleAdequacy !== "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS") {
      pushIssue(issues, "EVIDENCE_SAMPLE_ADEQUACY_INVALID", "CRITICAL", "S6P evidence overstates the scientific maturity of a twenty-result sample.");
    }
    if (certificate && (
      validStoredEvidence.certificateDigestSha256 !== certificate.certificateDigestSha256
      || validStoredEvidence.manifestDigestSha256 !== certificate.manifestDigestSha256
      || canonicalDigest(validStoredEvidence.manifest) !== canonicalDigest(certificate.manifest)
      || canonicalDigest(validStoredEvidence.metrics) !== canonicalDigest(certificate.metrics)
    )) {
      pushIssue(issues, "EVIDENCE_CERTIFICATE_LINK_INVALID", "CRITICAL", "S6P evidence no longer matches the immutable milestone 20 certificate.");
    }
  }

  if (certificate && validStoredBaseline) {
    const certificateTerminalIds = certificate.manifest.map((entry) => entry.terminalPredictionId);
    const certificateSettlementIds = certificate.manifest.map((entry) => entry.settlementEventId);
    if (validStoredBaseline.certificateDigestSha256 !== certificate.certificateDigestSha256
      || validStoredBaseline.manifestDigestSha256 !== certificate.manifestDigestSha256
      || !exactStringArray(validStoredBaseline.terminalPredictionIds, certificateTerminalIds)
      || !exactStringArray(validStoredBaseline.settlementEventIds, certificateSettlementIds)) {
      pushIssue(issues, "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION", "CRITICAL", "Milestone 20 identity changed after the append-only baseline was recorded.");
    }
  }

  const critical = issues.some((entry) => entry.severity === "CRITICAL");
  const certificateValid = Boolean(
    certificate
      && prerequisiteFirstFiveSettlementsCertified
      && certificateIntegrity
      && currentLedgerManifestMatches
      && settlementIdentitiesMatch
      && s6mIntegrityGatePassed
      && countMonotonic
      && !critical,
  );

  if (certificateValid && certificate && s6mReport && s6oReport) {
    if (!validStoredBaseline) {
      baselineToPersist = makeBaseline(
        certificate,
        records.length,
        generatedAt,
        deploymentCommit,
        s6mReport.generatedAt,
        s6oReport.generatedAt,
      );
    } else if (!validStoredEvidence) {
      const stableForMs = Date.parse(generatedAt) - Date.parse(validStoredBaseline.firstObservedAt);
      if (stableForMs >= minimumStabilityMs) {
        evidenceToPersist = makeEvidence(
          certificate,
          validStoredBaseline,
          s6mReport,
          s6oReport,
          selected,
          records,
          generatedAt,
          deploymentCommit,
          environment,
          minimumStabilityMs,
        );
      }
    }
  }

  const effectiveBaseline = validStoredBaseline ?? baselineToPersist;
  const effectiveEvidence = validStoredEvidence ?? evidenceToPersist;
  const stableForMs = effectiveBaseline
    ? Math.max(0, Date.parse(generatedAt) - Date.parse(effectiveBaseline.firstObservedAt))
    : null;
  const stableAcrossRuns = Boolean(
    effectiveBaseline
      && certificate
      && effectiveBaseline.certificateDigestSha256 === certificate.certificateDigestSha256
      && stableForMs != null
      && stableForMs >= minimumStabilityMs,
  );

  let state: S6pState;
  if (critical) state = "ACTION_REQUIRED";
  else if (effectiveEvidence) state = "MINIMUM_SAMPLE_20_CERTIFIED";
  else if (certificateValid) state = "OBSERVING_TWENTY_RESULT_STABILITY";
  else state = "ARMED_AND_WAITING_FOR_20";

  if (!critical && state === "ARMED_AND_WAITING_FOR_20") {
    pushIssue(
      issues,
      "MILESTONE_20_PENDING",
      "INFO",
      `${sample.binaryObservations.length} eligible binary decisions are available; twenty are required.`,
    );
  } else if (!critical && state === "OBSERVING_TWENTY_RESULT_STABILITY") {
    pushIssue(
      issues,
      "TWENTY_RESULT_STABILITY_WINDOW_PENDING",
      "INFO",
      `Milestone 20 has remained stable for ${stableForMs ?? 0} ms; ${minimumStabilityMs} ms are required.`,
    );
  }

  const independentlyCertifiedAmongFirstTwenty = selected.filter((entry) => entry.independentlyCertified).length;
  const report: S6pReport = {
    schemaVersion: MLB_S6P_FIRST_TWENTY_VERSION,
    generatedAt,
    trigger: options.trigger ?? "manual",
    deploymentCommit,
    environment,
    state,
    sourceS6m: {
      available: Boolean(s6mReport),
      generatedAt: s6mReport?.generatedAt ?? null,
      state: s6mReport?.state ?? null,
      metricParityChecked: s6mReport?.metricParity.checked ?? false,
      metricParityPassed: s6mReport?.metricParity.passed ?? false,
      criticalIssues: s6mCriticalIssues,
      milestoneTwentyClaimed: s6mClaimsCertificate,
    },
    sourceS6o: {
      available: Boolean(s6oReport),
      generatedAt: s6oReport?.generatedAt ?? null,
      state: s6oReport?.state ?? null,
      firstFiveSettlementsCertified: prerequisiteFirstFiveSettlementsCertified,
      criticalIssues: s6oCriticalIssues,
    },
    sample: {
      ownedLedgerRecords: records.length,
      binaryEligibleDecisions: sample.binaryObservations.length,
      targetSize: MLB_S6P_TARGET_SIZE,
      independentlyCertifiedAmongFirstTwenty,
      certifiedTerminalPredictionIds: certifiedTerminalPredictionIds.length,
    },
    target: {
      certificatePresent: Boolean(certificate),
      manifestEntries: certificate?.manifest.length ?? 0,
      wins: certificate?.metrics.wins ?? null,
      losses: certificate?.metrics.losses ?? null,
      clvAvailable: certificate?.metrics.clvAvailable ?? null,
      certificateDigestSha256: certificate?.certificateDigestSha256 ?? null,
      manifestDigestSha256: certificate?.manifestDigestSha256 ?? null,
    },
    stability: {
      baselinePresent: Boolean(effectiveBaseline),
      evidencePresent: Boolean(effectiveEvidence),
      firstObservedAt: effectiveBaseline?.firstObservedAt ?? null,
      stableForMs,
      minimumRequiredMs: minimumStabilityMs,
      stableAcrossRuns,
    },
    checks: {
      prerequisiteFirstFiveSettlementsCertified,
      certificateIntegrity,
      currentLedgerManifestMatches,
      settlementIdentitiesMatch,
      s6mIntegrityGatePassed,
      ledgerCountMonotonic: countMonotonic,
      appendOnlyBaseline: true,
      appendOnlyEvidence: true,
    },
    readiness: {
      armed: state === "ARMED_AND_WAITING_FOR_20" || state === "OBSERVING_TWENTY_RESULT_STABILITY",
      minimumSample20Certified: state === "MINIMUM_SAMPLE_20_CERTIFIED",
      minimumSampleIntegrityValidated: state === "MINIMUM_SAMPLE_20_CERTIFIED",
      preliminaryReviewAvailable: state === "MINIMUM_SAMPLE_20_CERTIFIED",
      sampleAdequateForModelConclusions: false,
      conclusionsAllowed: false,
      automaticModelChangesAllowed: false,
      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",
    },
    persistence: {
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: records.length,
      countMonotonic,
      baselineAppendOnly: true,
      evidenceAppendOnly: true,
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
      probabilitiesChanged: false,
      signalsChanged: false,
      marketsChanged: false,
      thresholdsChanged: false,
      settlementRulesChanged: false,
      stakePolicyChanged: false,
    },
  };

  return { report, baselineToPersist, evidenceToPersist };
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6P_FIRST_TWENTY_SETTLEMENTS?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6P_FIRST_TWENTY_SETTLEMENTS_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6p-first-twenty-settlements-certification");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function buildMlbS6pStoredArtifacts(
  baselineArtifact: { value: S6pBaseline | null; error: string | null; present: boolean },
  evidenceArtifact: { value: S6pEvidence | null; error: string | null; present: boolean },
): StoredArtifacts {
  return {
    baseline: baselineArtifact.value,
    evidence: evidenceArtifact.value,
    baselinePresent: baselineArtifact.present,
    evidencePresent: evidenceArtifact.present,
    baselineReadError: baselineArtifact.error,
    evidenceReadError: evidenceArtifact.error,
  };
}

function writeAppendOnlyJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function readJsonArtifact<T>(filePath: string): { value: T | null; error: string | null; present: boolean } {
  if (!fs.existsSync(filePath)) return { value: null, error: null, present: false };
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T, error: null, present: true };
  } catch (error) {
    return {
      value: null,
      error: `Unable to read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
      present: true,
    };
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function pruneSnapshots(directory: string, maxSnapshots: number): void {
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  for (const entry of files.slice(0, Math.max(0, files.length - maxSnapshots))) {
    fs.rmSync(path.join(directory, entry), { force: true });
  }
}

export class MlbS6pFirstTwentySettlementsCertificationService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly minimumStabilityMs: number;
  private readonly maxSnapshots: number;
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
    private readonly s6mMilestones: MlbS6mStatisticalMilestonesService,
    private readonly s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService,
    private readonly s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
    options: S6pOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6P_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6P_INITIAL_DELAY_MS, 330_000, 10_000);
    this.minimumStabilityMs = options.minimumStabilityMs
      ?? positiveInteger(process.env.MLB_S6P_MIN_STABILITY_MS, 5 * 60 * 1000, 60_000);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_S6P_MAX_SNAPSHOTS, 100, 10);
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
  getMinimumStabilityMs(): number { return this.minimumStabilityMs; }
  readLatest(): S6pReport | null {
    return readJson<S6pReport>(path.join(this.root, "latest.json"));
  }
  readBaseline(): S6pBaseline | null {
    return readJson<S6pBaseline>(path.join(this.root, "baseline.json"));
  }
  readEvidence(): S6pEvidence | null {
    return readJson<S6pEvidence>(path.join(this.root, "evidence.json"));
  }
  status() {
    return {
      schemaVersion: MLB_S6P_FIRST_TWENTY_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      minimumStabilityMs: this.minimumStabilityMs,
      maxSnapshots: this.maxSnapshots,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  async run(trigger = "scheduled"): Promise<S6pReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const s6mReport = this.s6mMilestones.readLatest();
      const certificates = this.s6mMilestones.readCertificates();
      const s6oReport = this.s6oFirstFive.readLatest();
      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])
        .filter((entry) => entry.state === "CERTIFIED")
        .map((entry) => entry.target.terminalPredictionId)
        .filter((entry): entry is string => Boolean(entry));
      const baselineArtifact = readJsonArtifact<S6pBaseline>(path.join(this.root, "baseline.json"));
      const evidenceArtifact = readJsonArtifact<S6pEvidence>(path.join(this.root, "evidence.json"));
      const evaluation = evaluateMlbS6pFirstTwentySettlements(
        records,
        s6mReport,
        certificates,
        s6oReport,
        certifiedTerminalPredictionIds,
        buildMlbS6pStoredArtifacts(baselineArtifact, evidenceArtifact),
        {
          generatedAt: now.toISOString(),
          trigger,
          deploymentCommit: this.deploymentCommit,
          environment: this.environment,
          minimumStabilityMs: this.minimumStabilityMs,
          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
        },
      );

      if (evaluation.baselineToPersist) {
        try {
          writeAppendOnlyJson(path.join(this.root, "baseline.json"), evaluation.baselineToPersist);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      if (evaluation.evidenceToPersist) {
        try {
          writeAppendOnlyJson(path.join(this.root, "evidence.json"), evaluation.evidenceToPersist);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }

      const refreshedBaseline = readJsonArtifact<S6pBaseline>(path.join(this.root, "baseline.json"));
      const refreshedEvidence = readJsonArtifact<S6pEvidence>(path.join(this.root, "evidence.json"));
      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist
        ? evaluateMlbS6pFirstTwentySettlements(
          records,
          s6mReport,
          certificates,
          s6oReport,
          certifiedTerminalPredictionIds,
          buildMlbS6pStoredArtifacts(refreshedBaseline, refreshedEvidence),
          {
            generatedAt: now.toISOString(),
            trigger,
            deploymentCommit: this.deploymentCommit,
            environment: this.environment,
            minimumStabilityMs: this.minimumStabilityMs,
            previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
          },
        )
        : evaluation;

      const report = finalEvaluation.report;
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const previousDigest = previous
        ? canonicalDigest({ ...previous, generatedAt: undefined, trigger: undefined })
        : null;
      const currentDigest = canonicalDigest({ ...report, generatedAt: undefined, trigger: undefined });
      if (currentDigest !== previousDigest) {
        const snapshotDir = path.join(this.root, "snapshots");
        atomicWriteJson(
          path.join(snapshotDir, `${report.generatedAt.replace(/[:.]/g, "-")}-${currentDigest.slice(0, 12)}.json`),
          report,
        );
        pruneSnapshots(snapshotDir, this.maxSnapshots);
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

export function startMlbS6pFirstTwentySettlementsCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s6mMilestones: MlbS6mStatisticalMilestonesService,
  s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService,
  s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
  options: S6pOptions,
): { service: MlbS6pFirstTwentySettlementsCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6pFirstTwentySettlementsCertificationService(
    store,
    ownershipStore,
    s6mMilestones,
    s6oFirstFive,
    s6kFirstTen,
    options,
  );
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6p] first five settlements certification failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
