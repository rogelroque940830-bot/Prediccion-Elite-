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
  MlbS6nFirstRealSettlementMonitorService,
  S6nReport,
} from "./mlb-s6n-first-real-settlement-monitor";
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

export const MLB_S6O_FIRST_FIVE_VERSION = "mlb-s6o-first-five-settlements-certification.v1" as const;
export const MLB_S6O_BASELINE_VERSION = "mlb-s6o-first-five-settlements-baseline.v1" as const;
export const MLB_S6O_EVIDENCE_VERSION = "mlb-s6o-first-five-settlements-evidence.v1" as const;
export const MLB_S6O_TARGET_SIZE = 5 as const;

export type S6oState =
  | "ARMED_AND_WAITING_FOR_5"
  | "OBSERVING_FIVE_RESULT_STABILITY"
  | "FIRST_FIVE_SETTLEMENTS_CERTIFIED"
  | "ACTION_REQUIRED";

export type S6oBaseline = {
  schemaVersion: typeof MLB_S6O_BASELINE_VERSION;
  firstObservedAt: string;
  firstObservedDeploymentCommit: string;
  sourceS6mGeneratedAt: string;
  sourceS6nGeneratedAt: string;
  certificateDigestSha256: string;
  manifestDigestSha256: string;
  terminalPredictionIds: string[];
  settlementEventIds: string[];
  results: Array<"WIN" | "LOSS">;
  ownedLedgerRecordsAtFirstObservation: number;
  baselineDigestSha256: string;
};

export type S6oBreakdown = {
  key: string;
  sampleSize: number;
  metrics: S6mMilestoneCertificate["metrics"];
};

export type S6oEvidence = {
  schemaVersion: typeof MLB_S6O_EVIDENCE_VERSION;
  certifiedAt: string;
  deploymentCommit: string;
  environment: string;
  sourceS6mGeneratedAt: string;
  sourceS6mState: string;
  sourceS6nGeneratedAt: string;
  sourceS6nState: string;
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
  marketBreakdowns: S6oBreakdown[];
  signalBreakdowns: S6oBreakdown[];
  sampleAdequacy: "TECHNICAL_REPETITION_CHECK_ONLY_TOO_SMALL_FOR_MODEL_CONCLUSIONS";
  checks: {
    milestoneFiveCertificatePresent: true;
    prerequisiteFirstSettlementCertified: true;
    exactFiveDecisionSample: true;
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
    independentFiveDecisionMetricsMatch: true;
    noCriticalS6mIssues: true;
    ledgerCountMonotonic: true;
    certificateStableAcrossRuns: true;
  };
  evidenceDigestSha256: string;
};

export type S6oReport = {
  schemaVersion: typeof MLB_S6O_FIRST_FIVE_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6oState;
  sourceS6m: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    metricParityChecked: boolean;
    metricParityPassed: boolean;
    criticalIssues: number;
    milestoneFiveClaimed: boolean;
  };
  sourceS6n: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    firstRealSettlementCertified: boolean;
    criticalIssues: number;
  };
  sample: {
    ownedLedgerRecords: number;
    binaryEligibleDecisions: number;
    targetSize: typeof MLB_S6O_TARGET_SIZE;
    independentlyCertifiedAmongFirstFive: number;
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
    prerequisiteFirstSettlementCertified: boolean;
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
    firstFiveSettlementsCertified: boolean;
    technicalRepetitionValidated: boolean;
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

type S6oOptions = {
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
  baseline: S6oBaseline | null;
  evidence: S6oEvidence | null;
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
  report: S6oReport;
  baselineToPersist: S6oBaseline | null;
  evidenceToPersist: S6oEvidence | null;
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

function baselineCore(baseline: S6oBaseline): Omit<S6oBaseline, "baselineDigestSha256"> {
  const { baselineDigestSha256: _ignored, ...core } = baseline;
  return core;
}

function evidenceCore(evidence: S6oEvidence): Omit<S6oEvidence, "evidenceDigestSha256"> {
  const { evidenceDigestSha256: _ignored, ...core } = evidence;
  return core;
}

function manifestFor(observations: S6mObservation[]): S6mManifestEntry[] {
  return observations.map(({ terminalRecordedAtMs: _ignored, ...entry }, index) => ({
    ordinal: index + 1,
    ...entry,
  }));
}

function pushIssue(
  issues: S6oReport["issues"],
  code: string,
  severity: "INFO" | "WARNING" | "CRITICAL",
  message: string,
): void {
  issues.push({ code, severity, message });
}

function groupedBreakdowns(
  observations: S6mObservation[],
  keyOf: (entry: S6mObservation) => string,
): S6oBreakdown[] {
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

function makeBaseline(
  certificate: S6mMilestoneCertificate,
  ownedLedgerRecords: number,
  generatedAt: string,
  deploymentCommit: string,
  sourceS6mGeneratedAt: string,
  sourceS6nGeneratedAt: string,
): S6oBaseline {
  const core: Omit<S6oBaseline, "baselineDigestSha256"> = {
    schemaVersion: MLB_S6O_BASELINE_VERSION,
    firstObservedAt: generatedAt,
    firstObservedDeploymentCommit: deploymentCommit,
    sourceS6mGeneratedAt,
    sourceS6nGeneratedAt,
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
  baseline: S6oBaseline,
  s6mReport: S6mMilestoneReport,
  s6nReport: S6nReport,
  selected: S6mObservation[],
  generatedAt: string,
  deploymentCommit: string,
  environment: string,
  minimumStabilityMs: number,
): S6oEvidence {
  const stableForMs = Math.max(0, Date.parse(generatedAt) - Date.parse(baseline.firstObservedAt));
  const core: Omit<S6oEvidence, "evidenceDigestSha256"> = {
    schemaVersion: MLB_S6O_EVIDENCE_VERSION,
    certifiedAt: generatedAt,
    deploymentCommit,
    environment,
    sourceS6mGeneratedAt: s6mReport.generatedAt,
    sourceS6mState: s6mReport.state,
    sourceS6nGeneratedAt: s6nReport.generatedAt,
    sourceS6nState: s6nReport.state,
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
    sampleAdequacy: "TECHNICAL_REPETITION_CHECK_ONLY_TOO_SMALL_FOR_MODEL_CONCLUSIONS",
    checks: {
      milestoneFiveCertificatePresent: true,
      prerequisiteFirstSettlementCertified: true,
      exactFiveDecisionSample: true,
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
      independentFiveDecisionMetricsMatch: true,
      noCriticalS6mIssues: true,
      ledgerCountMonotonic: true,
      certificateStableAcrossRuns: true,
    },
  };
  return { ...core, evidenceDigestSha256: sha256(core) };
}

function exactStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function evaluateMlbS6oFirstFiveSettlements(
  records: LedgerRecord[],
  s6mReport: S6mMilestoneReport | null,
  certificates: S6mCertificateMap,
  s6nReport: S6nReport | null,
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
  const selected = sample.binaryObservations.slice(0, MLB_S6O_TARGET_SIZE);
  const issues: S6oReport["issues"] = [];
  let baselineToPersist: S6oBaseline | null = null;
  let evidenceToPersist: S6oEvidence | null = null;

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

  const s6nCriticalIssues = s6nReport?.issues.filter((entry) => entry.severity === "CRITICAL").length ?? 0;
  const prerequisiteFirstSettlementCertified = Boolean(
    s6nReport
      && s6nReport.state === "FIRST_REAL_SETTLEMENT_CERTIFIED"
      && s6nReport.readiness.firstRealSettlementCertified
      && s6nCriticalIssues === 0,
  );

  const certificate = certificates["5"] ?? null;
  const milestoneFiveRow = s6mReport?.milestones.find((entry) => entry.milestone === 5) ?? null;
  const s6mClaimsCertificate = milestoneFiveRow?.status === "CERTIFIED"
    || (s6mReport?.highestCertifiedMilestone ?? 0) >= 5;

  if (s6mClaimsCertificate && !certificate) {
    pushIssue(
      issues,
      "S6M_MILESTONE_5_CERTIFICATE_MISSING",
      "CRITICAL",
      "S6M reports milestone 5 as certified, but the append-only certificate is unavailable.",
    );
  }
  if (certificate && !s6mClaimsCertificate) {
    pushIssue(
      issues,
      "S6M_REPORT_CERTIFICATE_DIVERGENCE",
      "CRITICAL",
      "A milestone 5 certificate exists, but the current S6M report does not acknowledge it.",
    );
  }
  if (certificate && !prerequisiteFirstSettlementCertified) {
    pushIssue(
      issues,
      "FIRST_SETTLEMENT_PREREQUISITE_NOT_CERTIFIED",
      "CRITICAL",
      "Milestone 5 exists before the S6N first-real-settlement chain is certified.",
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
        "Milestone 5 evidence was previously observed, but its source certificate is now absent.",
      );
    }
  } else {
    if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION || certificate.milestone !== 5) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SCHEMA_INVALID", "CRITICAL", "Unexpected milestone 5 certificate schema or milestone value.");
    }
    if (certificate.manifest.length !== MLB_S6O_TARGET_SIZE || certificate.metrics.binaryDecisions !== MLB_S6O_TARGET_SIZE) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SAMPLE_SIZE_INVALID", "CRITICAL", "Milestone 5 must contain exactly five binary decisions.");
    }
    if (!Object.values(certificate.checks).every((value) => value === true)) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_CHECK_FLAGS_INVALID", "CRITICAL", "Milestone 5 contains a failed or missing integrity assertion.");
    }
    if (sha256(certificateCore(certificate)) !== certificate.certificateDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_DIGEST_MISMATCH", "CRITICAL", "Milestone 5 certificate digest does not match its contents.");
    }
    if (sha256(certificate.manifest) !== certificate.manifestDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "MANIFEST_DIGEST_MISMATCH", "CRITICAL", "Milestone 5 manifest digest does not match its contents.");
    }

    const currentManifest = manifestFor(selected);
    const expectedManifest = currentManifest.map((entry, index) => ({
      ...entry,
      // Independent certification may mature after the immutable certificate was created.
      independentlyCertified: certificate.manifest[index]?.independentlyCertified ?? entry.independentlyCertified,
    }));
    if (expectedManifest.length !== MLB_S6O_TARGET_SIZE
      || canonicalDigest(expectedManifest) !== canonicalDigest(certificate.manifest)) {
      currentLedgerManifestMatches = false;
      pushIssue(
        issues,
        "CURRENT_LEDGER_MANIFEST_MISMATCH",
        "CRITICAL",
        "The current deterministic first-five sample differs from the immutable milestone 5 manifest.",
      );
    }

    const expectedMetrics = selected.length === MLB_S6O_TARGET_SIZE
      ? computeMlbS6mIndependentMetrics(selected)
      : null;
    if (!expectedMetrics || canonicalDigest(expectedMetrics) !== canonicalDigest(certificate.metrics)) {
      certificateIntegrity = false;
      pushIssue(
        issues,
        "CERTIFICATE_METRICS_MISMATCH",
        "CRITICAL",
        "The independently recomputed five-decision metrics differ from the certificate metrics.",
      );
    }

    const terminalIds = certificate.manifest.map((entry) => entry.terminalPredictionId);
    const rootIds = certificate.manifest.map((entry) => entry.rootPredictionId);
    const settlementIds = certificate.manifest.map((entry) => entry.settlementEventId);
    if (new Set(terminalIds).size !== MLB_S6O_TARGET_SIZE
      || new Set(rootIds).size !== MLB_S6O_TARGET_SIZE
      || new Set(settlementIds).size !== MLB_S6O_TARGET_SIZE) {
      certificateIntegrity = false;
      pushIssue(issues, "DUPLICATE_DECISION_IDENTITY", "CRITICAL", "Milestone 5 contains duplicate analytical or settlement identities.");
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
      const matches = String(settlement.eventId ?? "") === manifestEntry.settlementEventId
        && String(settlement.source ?? "") === manifestEntry.settlementSource
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

  if (stored.baseline) {
    const baselineIdsValid = stored.baseline.terminalPredictionIds.length === MLB_S6O_TARGET_SIZE
      && stored.baseline.settlementEventIds.length === MLB_S6O_TARGET_SIZE
      && stored.baseline.results.length === MLB_S6O_TARGET_SIZE
      && new Set(stored.baseline.terminalPredictionIds).size === MLB_S6O_TARGET_SIZE
      && new Set(stored.baseline.settlementEventIds).size === MLB_S6O_TARGET_SIZE
      && stored.baseline.results.every((entry) => entry === "WIN" || entry === "LOSS");
    if (stored.baseline.schemaVersion !== MLB_S6O_BASELINE_VERSION
      || sha256(baselineCore(stored.baseline)) !== stored.baseline.baselineDigestSha256
      || !Number.isFinite(Date.parse(stored.baseline.firstObservedAt))
      || stored.baseline.ownedLedgerRecordsAtFirstObservation < 1
      || !baselineIdsValid) {
      pushIssue(issues, "BASELINE_INTEGRITY_INVALID", "CRITICAL", "The append-only five-result baseline failed integrity or semantic validation.");
    }
  }

  if (stored.evidence) {
    if (stored.evidence.schemaVersion !== MLB_S6O_EVIDENCE_VERSION
      || sha256(evidenceCore(stored.evidence)) !== stored.evidence.evidenceDigestSha256) {
      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only five-result evidence failed integrity validation.");
    }
    if (!stored.baseline) {
      pushIssue(issues, "EVIDENCE_WITHOUT_BASELINE", "CRITICAL", "S6O evidence exists without its append-only baseline.");
    } else {
      const firstObservedMs = Date.parse(stored.evidence.stability.firstObservedAt);
      const confirmedMs = Date.parse(stored.evidence.stability.confirmedAt);
      const measuredStableMs = confirmedMs - firstObservedMs;
      const validLink = stored.evidence.baselineDigestSha256 === stored.baseline.baselineDigestSha256
        && stored.evidence.stability.firstObservedAt === stored.baseline.firstObservedAt
        && Number.isFinite(firstObservedMs)
        && Number.isFinite(confirmedMs)
        && measuredStableMs >= stored.evidence.stability.minimumRequiredMs
        && stored.evidence.stability.stableForMs === measuredStableMs;
      if (!validLink) {
        pushIssue(issues, "EVIDENCE_BASELINE_LINK_INVALID", "CRITICAL", "S6O evidence does not preserve a valid stability link to its baseline.");
      }
    }
    if (!Object.values(stored.evidence.checks).every((value) => value === true)) {
      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6O evidence contains a failed or missing verification assertion.");
    }
    if (stored.evidence.sampleAdequacy !== "TECHNICAL_REPETITION_CHECK_ONLY_TOO_SMALL_FOR_MODEL_CONCLUSIONS") {
      pushIssue(issues, "EVIDENCE_SAMPLE_ADEQUACY_INVALID", "CRITICAL", "S6O evidence overstates the scientific maturity of a five-result sample.");
    }
    if (certificate && (
      stored.evidence.certificateDigestSha256 !== certificate.certificateDigestSha256
      || stored.evidence.manifestDigestSha256 !== certificate.manifestDigestSha256
      || canonicalDigest(stored.evidence.manifest) !== canonicalDigest(certificate.manifest)
      || canonicalDigest(stored.evidence.metrics) !== canonicalDigest(certificate.metrics)
    )) {
      pushIssue(issues, "EVIDENCE_CERTIFICATE_LINK_INVALID", "CRITICAL", "S6O evidence no longer matches the immutable milestone 5 certificate.");
    }
  }

  if (certificate && stored.baseline) {
    const certificateTerminalIds = certificate.manifest.map((entry) => entry.terminalPredictionId);
    const certificateSettlementIds = certificate.manifest.map((entry) => entry.settlementEventId);
    if (stored.baseline.certificateDigestSha256 !== certificate.certificateDigestSha256
      || stored.baseline.manifestDigestSha256 !== certificate.manifestDigestSha256
      || !exactStringArray(stored.baseline.terminalPredictionIds, certificateTerminalIds)
      || !exactStringArray(stored.baseline.settlementEventIds, certificateSettlementIds)) {
      pushIssue(issues, "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION", "CRITICAL", "Milestone 5 identity changed after the append-only baseline was recorded.");
    }
  }

  const critical = issues.some((entry) => entry.severity === "CRITICAL");
  const certificateValid = Boolean(
    certificate
      && prerequisiteFirstSettlementCertified
      && certificateIntegrity
      && currentLedgerManifestMatches
      && settlementIdentitiesMatch
      && s6mIntegrityGatePassed
      && countMonotonic
      && !critical,
  );

  if (certificateValid && certificate && s6mReport && s6nReport) {
    if (!stored.baseline) {
      baselineToPersist = makeBaseline(
        certificate,
        records.length,
        generatedAt,
        deploymentCommit,
        s6mReport.generatedAt,
        s6nReport.generatedAt,
      );
    } else if (!stored.evidence) {
      const stableForMs = Date.parse(generatedAt) - Date.parse(stored.baseline.firstObservedAt);
      if (stableForMs >= minimumStabilityMs) {
        evidenceToPersist = makeEvidence(
          certificate,
          stored.baseline,
          s6mReport,
          s6nReport,
          selected,
          generatedAt,
          deploymentCommit,
          environment,
          minimumStabilityMs,
        );
      }
    }
  }

  const effectiveBaseline = stored.baseline ?? baselineToPersist;
  const effectiveEvidence = stored.evidence ?? evidenceToPersist;
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

  let state: S6oState;
  if (critical) state = "ACTION_REQUIRED";
  else if (effectiveEvidence) state = "FIRST_FIVE_SETTLEMENTS_CERTIFIED";
  else if (certificateValid) state = "OBSERVING_FIVE_RESULT_STABILITY";
  else state = "ARMED_AND_WAITING_FOR_5";

  if (!critical && state === "ARMED_AND_WAITING_FOR_5") {
    pushIssue(
      issues,
      "MILESTONE_5_PENDING",
      "INFO",
      `${sample.binaryObservations.length} eligible binary decisions are available; five are required.`,
    );
  } else if (!critical && state === "OBSERVING_FIVE_RESULT_STABILITY") {
    pushIssue(
      issues,
      "FIVE_RESULT_STABILITY_WINDOW_PENDING",
      "INFO",
      `Milestone 5 has remained stable for ${stableForMs ?? 0} ms; ${minimumStabilityMs} ms are required.`,
    );
  }

  const independentlyCertifiedAmongFirstFive = selected.filter((entry) => entry.independentlyCertified).length;
  const report: S6oReport = {
    schemaVersion: MLB_S6O_FIRST_FIVE_VERSION,
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
      milestoneFiveClaimed: s6mClaimsCertificate,
    },
    sourceS6n: {
      available: Boolean(s6nReport),
      generatedAt: s6nReport?.generatedAt ?? null,
      state: s6nReport?.state ?? null,
      firstRealSettlementCertified: prerequisiteFirstSettlementCertified,
      criticalIssues: s6nCriticalIssues,
    },
    sample: {
      ownedLedgerRecords: records.length,
      binaryEligibleDecisions: sample.binaryObservations.length,
      targetSize: MLB_S6O_TARGET_SIZE,
      independentlyCertifiedAmongFirstFive,
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
      prerequisiteFirstSettlementCertified,
      certificateIntegrity,
      currentLedgerManifestMatches,
      settlementIdentitiesMatch,
      s6mIntegrityGatePassed,
      ledgerCountMonotonic: countMonotonic,
      appendOnlyBaseline: true,
      appendOnlyEvidence: true,
    },
    readiness: {
      armed: state === "ARMED_AND_WAITING_FOR_5" || state === "OBSERVING_FIVE_RESULT_STABILITY",
      firstFiveSettlementsCertified: state === "FIRST_FIVE_SETTLEMENTS_CERTIFIED",
      technicalRepetitionValidated: state === "FIRST_FIVE_SETTLEMENTS_CERTIFIED",
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
  const configured = process.env.MLB_S6O_FIRST_FIVE_SETTLEMENTS?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6O_FIRST_FIVE_SETTLEMENTS_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6o-first-five-settlements-certification");
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

function readJsonArtifact<T>(filePath: string): { value: T | null; error: string | null } {
  if (!fs.existsSync(filePath)) return { value: null, error: null };
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T, error: null };
  } catch (error) {
    return {
      value: null,
      error: `Unable to read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
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

export class MlbS6oFirstFiveSettlementsCertificationService {
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
    private readonly s6nFirstSettlement: MlbS6nFirstRealSettlementMonitorService,
    private readonly s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
    options: S6oOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6O_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6O_INITIAL_DELAY_MS, 330_000, 10_000);
    this.minimumStabilityMs = options.minimumStabilityMs
      ?? positiveInteger(process.env.MLB_S6O_MIN_STABILITY_MS, 5 * 60 * 1000, 60_000);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_S6O_MAX_SNAPSHOTS, 100, 10);
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
  readLatest(): S6oReport | null {
    return readJson<S6oReport>(path.join(this.root, "latest.json"));
  }
  readBaseline(): S6oBaseline | null {
    return readJson<S6oBaseline>(path.join(this.root, "baseline.json"));
  }
  readEvidence(): S6oEvidence | null {
    return readJson<S6oEvidence>(path.join(this.root, "evidence.json"));
  }
  status() {
    return {
      schemaVersion: MLB_S6O_FIRST_FIVE_VERSION,
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

  async run(trigger = "scheduled"): Promise<S6oReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const s6mReport = this.s6mMilestones.readLatest();
      const certificates = this.s6mMilestones.readCertificates();
      const s6nReport = this.s6nFirstSettlement.readLatest();
      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])
        .filter((entry) => entry.state === "CERTIFIED")
        .map((entry) => entry.target.terminalPredictionId)
        .filter((entry): entry is string => Boolean(entry));
      const baselineArtifact = readJsonArtifact<S6oBaseline>(path.join(this.root, "baseline.json"));
      const evidenceArtifact = readJsonArtifact<S6oEvidence>(path.join(this.root, "evidence.json"));
      const evaluation = evaluateMlbS6oFirstFiveSettlements(
        records,
        s6mReport,
        certificates,
        s6nReport,
        certifiedTerminalPredictionIds,
        {
          baseline: baselineArtifact.value,
          evidence: evidenceArtifact.value,
          baselineReadError: baselineArtifact.error,
          evidenceReadError: evidenceArtifact.error,
        },
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

      const refreshedBaseline = readJsonArtifact<S6oBaseline>(path.join(this.root, "baseline.json"));
      const refreshedEvidence = readJsonArtifact<S6oEvidence>(path.join(this.root, "evidence.json"));
      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist
        ? evaluateMlbS6oFirstFiveSettlements(
          records,
          s6mReport,
          certificates,
          s6nReport,
          certifiedTerminalPredictionIds,
          {
            baseline: refreshedBaseline.value,
            evidence: refreshedEvidence.value,
            baselineReadError: refreshedBaseline.error,
            evidenceReadError: refreshedEvidence.error,
          },
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

export function startMlbS6oFirstFiveSettlementsCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s6mMilestones: MlbS6mStatisticalMilestonesService,
  s6nFirstSettlement: MlbS6nFirstRealSettlementMonitorService,
  s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
  options: S6oOptions,
): { service: MlbS6oFirstFiveSettlementsCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6oFirstFiveSettlementsCertificationService(
    store,
    ownershipStore,
    s6mMilestones,
    s6nFirstSettlement,
    s6kFirstTen,
    options,
  );
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6o] first five settlements certification failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
