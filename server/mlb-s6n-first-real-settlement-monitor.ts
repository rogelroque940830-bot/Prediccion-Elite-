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
  computeMlbS6mIndependentMetrics,
  extractMlbS6mIndependentSample,
  MLB_S6M_CERTIFICATE_VERSION,
  type MlbS6mStatisticalMilestonesService,
  type S6mCertificateMap,
  type S6mManifestEntry,
  type S6mMilestoneCertificate,
  type S6mMilestoneReport,
} from "./mlb-s6m-statistical-milestones";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";

export const MLB_S6N_FIRST_REAL_SETTLEMENT_VERSION = "mlb-s6n-first-real-settlement-monitor.v1" as const;
export const MLB_S6N_BASELINE_VERSION = "mlb-s6n-first-real-settlement-baseline.v1" as const;
export const MLB_S6N_EVIDENCE_VERSION = "mlb-s6n-first-real-settlement-evidence.v1" as const;

export type S6nState =
  | "ARMED_AND_WAITING"
  | "OBSERVING_CERTIFICATE_STABILITY"
  | "FIRST_REAL_SETTLEMENT_CERTIFIED"
  | "ACTION_REQUIRED";

export type S6nBaseline = {
  schemaVersion: typeof MLB_S6N_BASELINE_VERSION;
  firstObservedAt: string;
  firstObservedDeploymentCommit: string;
  sourceS6mGeneratedAt: string;
  certificateDigestSha256: string;
  manifestDigestSha256: string;
  terminalPredictionId: string;
  settlementEventId: string;
  result: "WIN" | "LOSS";
  ownedLedgerRecordsAtFirstObservation: number;
  baselineDigestSha256: string;
};

export type S6nEvidence = {
  schemaVersion: typeof MLB_S6N_EVIDENCE_VERSION;
  certifiedAt: string;
  deploymentCommit: string;
  environment: string;
  sourceS6mGeneratedAt: string;
  sourceS6mState: string;
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
  firstDecision: S6mManifestEntry;
  metrics: S6mMilestoneCertificate["metrics"];
  checks: {
    milestoneOneCertificatePresent: true;
    certificateDigestValid: true;
    manifestDigestValid: true;
    currentLedgerManifestMatches: true;
    terminalRecordPresent: true;
    terminalStageFinal: true;
    settlementPresent: true;
    settlementIdentityMatches: true;
    settlementResultBinary: true;
    standardAmericanOdds: true;
    postFixCohort: true;
    s6mMetricParityPassed: true;
    noCriticalS6mIssues: true;
    ledgerCountMonotonic: true;
    certificateStableAcrossRuns: true;
  };
  evidenceDigestSha256: string;
};

export type S6nReport = {
  schemaVersion: typeof MLB_S6N_FIRST_REAL_SETTLEMENT_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6nState;
  sourceS6m: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    metricParityChecked: boolean;
    metricParityPassed: boolean;
    criticalIssues: number;
  };
  sample: {
    ownedLedgerRecords: number;
    binaryEligibleDecisions: number;
    certifiedTerminalPredictionIds: number;
  };
  target: {
    certificatePresent: boolean;
    terminalPredictionId: string | null;
    settlementEventId: string | null;
    result: "WIN" | "LOSS" | null;
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
    certificateIntegrity: boolean | null;
    currentLedgerManifestMatches: boolean | null;
    settlementIdentityMatches: boolean | null;
    s6mIntegrityGatePassed: boolean;
    ledgerCountMonotonic: boolean;
    appendOnlyBaseline: true;
    appendOnlyEvidence: true;
  };
  readiness: {
    armed: boolean;
    firstRealSettlementCertified: boolean;
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

type S6nOptions = {
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
  baseline: S6nBaseline | null;
  evidence: S6nEvidence | null;
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
  report: S6nReport;
  baselineToPersist: S6nBaseline | null;
  evidenceToPersist: S6nEvidence | null;
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
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function certificateCore(certificate: S6mMilestoneCertificate): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {
  const { certificateDigestSha256: _ignored, ...core } = certificate;
  return core;
}

function baselineCore(baseline: S6nBaseline): Omit<S6nBaseline, "baselineDigestSha256"> {
  const { baselineDigestSha256: _ignored, ...core } = baseline;
  return core;
}

function evidenceCore(evidence: S6nEvidence): Omit<S6nEvidence, "evidenceDigestSha256"> {
  const { evidenceDigestSha256: _ignored, ...core } = evidence;
  return core;
}

function expectedManifestEntry(records: LedgerRecord[], certifiedTerminalPredictionIds: string[]): S6mManifestEntry | null {
  const sample = extractMlbS6mIndependentSample(records, certifiedTerminalPredictionIds);
  const first = sample.binaryObservations[0];
  if (!first) return null;
  const { terminalRecordedAtMs: _ignored, ...entry } = first;
  return { ordinal: 1, ...entry };
}

function findTerminalRecord(records: LedgerRecord[], terminalPredictionId: string): LedgerRecord | null {
  return records.find((record) => record.prediction.id === terminalPredictionId) ?? null;
}

function makeBaseline(
  certificate: S6mMilestoneCertificate,
  ownedLedgerRecords: number,
  generatedAt: string,
  deploymentCommit: string,
  sourceS6mGeneratedAt: string,
): S6nBaseline {
  const manifest = certificate.manifest[0];
  const core: Omit<S6nBaseline, "baselineDigestSha256"> = {
    schemaVersion: MLB_S6N_BASELINE_VERSION,
    firstObservedAt: generatedAt,
    firstObservedDeploymentCommit: deploymentCommit,
    sourceS6mGeneratedAt,
    certificateDigestSha256: certificate.certificateDigestSha256,
    manifestDigestSha256: certificate.manifestDigestSha256,
    terminalPredictionId: manifest.terminalPredictionId,
    settlementEventId: manifest.settlementEventId,
    result: manifest.result as "WIN" | "LOSS",
    ownedLedgerRecordsAtFirstObservation: ownedLedgerRecords,
  };
  return { ...core, baselineDigestSha256: sha256(core) };
}

function makeEvidence(
  certificate: S6mMilestoneCertificate,
  baseline: S6nBaseline,
  report: S6mMilestoneReport,
  generatedAt: string,
  deploymentCommit: string,
  environment: string,
  minimumStabilityMs: number,
): S6nEvidence {
  const stableForMs = Math.max(0, Date.parse(generatedAt) - Date.parse(baseline.firstObservedAt));
  const core: Omit<S6nEvidence, "evidenceDigestSha256"> = {
    schemaVersion: MLB_S6N_EVIDENCE_VERSION,
    certifiedAt: generatedAt,
    deploymentCommit,
    environment,
    sourceS6mGeneratedAt: report.generatedAt,
    sourceS6mState: report.state,
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
    firstDecision: certificate.manifest[0],
    metrics: certificate.metrics,
    checks: {
      milestoneOneCertificatePresent: true,
      certificateDigestValid: true,
      manifestDigestValid: true,
      currentLedgerManifestMatches: true,
      terminalRecordPresent: true,
      terminalStageFinal: true,
      settlementPresent: true,
      settlementIdentityMatches: true,
      settlementResultBinary: true,
      standardAmericanOdds: true,
      postFixCohort: true,
      s6mMetricParityPassed: true,
      noCriticalS6mIssues: true,
      ledgerCountMonotonic: true,
      certificateStableAcrossRuns: true,
    },
  };
  return { ...core, evidenceDigestSha256: sha256(core) };
}

function pushIssue(
  issues: S6nReport["issues"],
  code: string,
  severity: "INFO" | "WARNING" | "CRITICAL",
  message: string,
): void {
  issues.push({ code, severity, message });
}

export function evaluateMlbS6nFirstRealSettlement(
  records: LedgerRecord[],
  s6mReport: S6mMilestoneReport | null,
  certificates: S6mCertificateMap,
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
  const issues: S6nReport["issues"] = [];
  let baselineToPersist: S6nBaseline | null = null;
  let evidenceToPersist: S6nEvidence | null = null;

  if (stored.baselineReadError) {
    pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);
  }
  if (stored.evidenceReadError) {
    pushIssue(issues, "EVIDENCE_UNREADABLE", "CRITICAL", stored.evidenceReadError);
  }
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

  const certificate = certificates["1"] ?? null;
  const milestoneOneRow = s6mReport?.milestones.find((entry) => entry.milestone === 1) ?? null;
  const s6mClaimsCertificate = milestoneOneRow?.status === "CERTIFIED"
    || (s6mReport?.highestCertifiedMilestone ?? 0) >= 1;

  if (s6mClaimsCertificate && !certificate) {
    pushIssue(
      issues,
      "S6M_CERTIFICATE_FILE_MISSING",
      "CRITICAL",
      "S6M reports milestone 1 as certified, but the append-only certificate is unavailable.",
    );
  }
  if (certificate && !s6mClaimsCertificate) {
    pushIssue(
      issues,
      "S6M_REPORT_CERTIFICATE_DIVERGENCE",
      "CRITICAL",
      "A milestone 1 certificate exists, but the current S6M report does not acknowledge it.",
    );
  }

  let certificateIntegrity: boolean | null = certificate ? true : null;
  let currentLedgerManifestMatches: boolean | null = certificate ? true : null;
  let settlementIdentityMatches: boolean | null = certificate ? true : null;
  let terminalRecord: LedgerRecord | null = null;

  if (!certificate) {
    if (stored.baseline || stored.evidence) {
      pushIssue(
        issues,
        "CERTIFICATE_DISAPPEARED_AFTER_OBSERVATION",
        "CRITICAL",
        "Milestone 1 evidence was previously observed, but its source certificate is now absent.",
      );
    }
  } else {
    if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION || certificate.milestone !== 1) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SCHEMA_INVALID", "CRITICAL", "Unexpected milestone 1 certificate schema or milestone value.");
    }
    if (certificate.manifest.length !== 1 || certificate.metrics.binaryDecisions !== 1) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_SAMPLE_SIZE_INVALID", "CRITICAL", "Milestone 1 certificate must contain exactly one binary decision.");
    }
    if (sha256(certificateCore(certificate)) !== certificate.certificateDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "CERTIFICATE_DIGEST_MISMATCH", "CRITICAL", "Milestone 1 certificate digest does not match its contents.");
    }
    if (sha256(certificate.manifest) !== certificate.manifestDigestSha256) {
      certificateIntegrity = false;
      pushIssue(issues, "MANIFEST_DIGEST_MISMATCH", "CRITICAL", "Milestone 1 manifest digest does not match its contents.");
    }

    const expectedManifest = expectedManifestEntry(records, certifiedTerminalPredictionIds);
    if (!expectedManifest || canonicalDigest(expectedManifest) !== canonicalDigest(certificate.manifest[0])) {
      currentLedgerManifestMatches = false;
      pushIssue(
        issues,
        "CURRENT_LEDGER_MANIFEST_MISMATCH",
        "CRITICAL",
        "The current deterministic first eligible binary decision differs from the immutable milestone 1 manifest.",
      );
    }
    const expectedMetrics = sample.binaryObservations[0]
      ? computeMlbS6mIndependentMetrics([sample.binaryObservations[0]])
      : null;
    if (!expectedMetrics || canonicalDigest(expectedMetrics) !== canonicalDigest(certificate.metrics)) {
      certificateIntegrity = false;
      pushIssue(
        issues,
        "CERTIFICATE_METRICS_MISMATCH",
        "CRITICAL",
        "The independently recomputed first-decision metrics differ from the certificate metrics.",
      );
    }

    const manifest = certificate.manifest[0];
    terminalRecord = findTerminalRecord(records, manifest.terminalPredictionId);
    if (!terminalRecord) {
      settlementIdentityMatches = false;
      pushIssue(issues, "TERMINAL_RECORD_MISSING", "CRITICAL", "The terminal prediction referenced by milestone 1 is not present in the owned ledger.");
    } else {
      const prediction = terminalRecord.prediction;
      const settlement = terminalRecord.settlement;
      if (prediction.analysisStage !== "FINAL") {
        settlementIdentityMatches = false;
        pushIssue(issues, "TERMINAL_STAGE_NOT_FINAL", "CRITICAL", "The milestone 1 terminal prediction is not FINAL.");
      }
      if (prediction.recordedAtMs < CUTOFF_MS) {
        settlementIdentityMatches = false;
        pushIssue(issues, "TERMINAL_OUTSIDE_POST_FIX_COHORT", "CRITICAL", "The milestone 1 terminal prediction predates the clean-cohort cutoff.");
      }
      if (!Number.isInteger(prediction.market.oddsAmerican) || Math.abs(prediction.market.oddsAmerican) < 100) {
        settlementIdentityMatches = false;
        pushIssue(issues, "TERMINAL_AMERICAN_ODDS_INVALID", "CRITICAL", "The milestone 1 terminal price is not standard American odds.");
      }
      if (!settlement) {
        settlementIdentityMatches = false;
        pushIssue(issues, "TERMINAL_SETTLEMENT_MISSING", "CRITICAL", "The milestone 1 terminal record no longer contains settlement evidence.");
      } else {
        const settlementMatches = String(settlement.eventId ?? "") === manifest.settlementEventId
          && String(settlement.source ?? "") === manifest.settlementSource
          && String(settlement.settledAt ?? "") === manifest.settledAt
          && settlement.result === manifest.result;
        if (!settlementMatches) {
          settlementIdentityMatches = false;
          pushIssue(issues, "SETTLEMENT_IDENTITY_MISMATCH", "CRITICAL", "The current settlement identity differs from the immutable milestone 1 manifest.");
        }
        if (settlement.result !== "WIN" && settlement.result !== "LOSS") {
          settlementIdentityMatches = false;
          pushIssue(issues, "SETTLEMENT_NOT_BINARY", "CRITICAL", "Milestone 1 must certify a WIN or LOSS binary result.");
        }
      }
    }
  }

  if (stored.baseline) {
    if (stored.baseline.schemaVersion !== MLB_S6N_BASELINE_VERSION
      || sha256(baselineCore(stored.baseline)) !== stored.baseline.baselineDigestSha256) {
      pushIssue(issues, "BASELINE_DIGEST_INVALID", "CRITICAL", "The append-only first-observation baseline failed integrity validation.");
    }
  }
  if (stored.evidence) {
    if (stored.evidence.schemaVersion !== MLB_S6N_EVIDENCE_VERSION
      || sha256(evidenceCore(stored.evidence)) !== stored.evidence.evidenceDigestSha256) {
      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only certification evidence failed integrity validation.");
    }
  }

  if (certificate && stored.baseline) {
    if (stored.baseline.certificateDigestSha256 !== certificate.certificateDigestSha256
      || stored.baseline.manifestDigestSha256 !== certificate.manifestDigestSha256
      || stored.baseline.terminalPredictionId !== certificate.manifest[0].terminalPredictionId
      || stored.baseline.settlementEventId !== certificate.manifest[0].settlementEventId) {
      pushIssue(issues, "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION", "CRITICAL", "Milestone 1 certificate identity changed after the append-only baseline was recorded.");
    }
  }
  if (certificate && stored.evidence) {
    if (stored.evidence.certificateDigestSha256 !== certificate.certificateDigestSha256
      || stored.evidence.manifestDigestSha256 !== certificate.manifestDigestSha256
      || stored.evidence.firstDecision.terminalPredictionId !== certificate.manifest[0].terminalPredictionId
      || stored.evidence.firstDecision.settlementEventId !== certificate.manifest[0].settlementEventId) {
      pushIssue(issues, "CERTIFICATE_CHANGED_AFTER_CERTIFICATION", "CRITICAL", "Milestone 1 certificate changed after S6N certification.");
    }
  }

  const critical = issues.some((entry) => entry.severity === "CRITICAL");
  const certificateValid = Boolean(
    certificate
      && certificateIntegrity
      && currentLedgerManifestMatches
      && settlementIdentityMatches
      && s6mIntegrityGatePassed
      && countMonotonic
      && !critical,
  );

  if (certificateValid && certificate && s6mReport) {
    if (!stored.baseline) {
      baselineToPersist = makeBaseline(
        certificate,
        records.length,
        generatedAt,
        deploymentCommit,
        s6mReport.generatedAt,
      );
    } else if (!stored.evidence) {
      const stableForMs = Date.parse(generatedAt) - Date.parse(stored.baseline.firstObservedAt);
      if (stableForMs >= minimumStabilityMs) {
        evidenceToPersist = makeEvidence(
          certificate,
          stored.baseline,
          s6mReport,
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

  let state: S6nState;
  if (critical) state = "ACTION_REQUIRED";
  else if (effectiveEvidence) state = "FIRST_REAL_SETTLEMENT_CERTIFIED";
  else if (certificateValid) state = "OBSERVING_CERTIFICATE_STABILITY";
  else state = "ARMED_AND_WAITING";

  if (!critical && state === "ARMED_AND_WAITING") {
    pushIssue(
      issues,
      "FIRST_ELIGIBLE_SETTLEMENT_PENDING",
      "INFO",
      `${sample.binaryObservations.length} eligible binary decisions are available; S6N remains armed for milestone 1.`,
    );
  } else if (!critical && state === "OBSERVING_CERTIFICATE_STABILITY") {
    pushIssue(
      issues,
      "CERTIFICATE_STABILITY_WINDOW_PENDING",
      "INFO",
      `Milestone 1 is valid and has remained stable for ${stableForMs ?? 0} ms; ${minimumStabilityMs} ms are required.`,
    );
  }

  const manifest = certificate?.manifest[0] ?? null;
  const report: S6nReport = {
    schemaVersion: MLB_S6N_FIRST_REAL_SETTLEMENT_VERSION,
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
    },
    sample: {
      ownedLedgerRecords: records.length,
      binaryEligibleDecisions: sample.binaryObservations.length,
      certifiedTerminalPredictionIds: certifiedTerminalPredictionIds.length,
    },
    target: {
      certificatePresent: Boolean(certificate),
      terminalPredictionId: manifest?.terminalPredictionId ?? null,
      settlementEventId: manifest?.settlementEventId ?? null,
      result: manifest?.result === "WIN" || manifest?.result === "LOSS" ? manifest.result : null,
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
      certificateIntegrity,
      currentLedgerManifestMatches,
      settlementIdentityMatches,
      s6mIntegrityGatePassed,
      ledgerCountMonotonic: countMonotonic,
      appendOnlyBaseline: true,
      appendOnlyEvidence: true,
    },
    readiness: {
      armed: state === "ARMED_AND_WAITING" || state === "OBSERVING_CERTIFICATE_STABILITY",
      firstRealSettlementCertified: state === "FIRST_REAL_SETTLEMENT_CERTIFIED",
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
  const configured = process.env.MLB_S6N_FIRST_REAL_SETTLEMENT?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6N_FIRST_REAL_SETTLEMENT_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6n-first-real-settlement-monitor");
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

export class MlbS6nFirstRealSettlementMonitorService {
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
    private readonly s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
    options: S6nOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6N_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6N_INITIAL_DELAY_MS, 270_000, 10_000);
    this.minimumStabilityMs = options.minimumStabilityMs
      ?? positiveInteger(process.env.MLB_S6N_MIN_STABILITY_MS, 5 * 60 * 1000, 60_000);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_S6N_MAX_SNAPSHOTS, 100, 10);
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
  readLatest(): S6nReport | null {
    return readJson<S6nReport>(path.join(this.root, "latest.json"));
  }
  readBaseline(): S6nBaseline | null {
    return readJson<S6nBaseline>(path.join(this.root, "baseline.json"));
  }
  readEvidence(): S6nEvidence | null {
    return readJson<S6nEvidence>(path.join(this.root, "evidence.json"));
  }
  status() {
    return {
      schemaVersion: MLB_S6N_FIRST_REAL_SETTLEMENT_VERSION,
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

  async run(trigger = "scheduled"): Promise<S6nReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const s6mReport = this.s6mMilestones.readLatest();
      const certificates = this.s6mMilestones.readCertificates();
      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])
        .filter((entry) => entry.state === "CERTIFIED")
        .map((entry) => entry.target.terminalPredictionId)
        .filter((entry): entry is string => Boolean(entry));
      const baselineArtifact = readJsonArtifact<S6nBaseline>(path.join(this.root, "baseline.json"));
      const evidenceArtifact = readJsonArtifact<S6nEvidence>(path.join(this.root, "evidence.json"));
      const evaluation = evaluateMlbS6nFirstRealSettlement(
        records,
        s6mReport,
        certificates,
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

      const refreshedBaseline = readJsonArtifact<S6nBaseline>(path.join(this.root, "baseline.json"));
      const refreshedEvidence = readJsonArtifact<S6nEvidence>(path.join(this.root, "evidence.json"));
      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist
        ? evaluateMlbS6nFirstRealSettlement(
          records,
          s6mReport,
          certificates,
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

export function startMlbS6nFirstRealSettlementMonitorWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s6mMilestones: MlbS6mStatisticalMilestonesService,
  s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
  options: S6nOptions,
): { service: MlbS6nFirstRealSettlementMonitorService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6nFirstRealSettlementMonitorService(
    store,
    ownershipStore,
    s6mMilestones,
    s6kFirstTen,
    options,
  );
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6n] first real settlement monitor failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
