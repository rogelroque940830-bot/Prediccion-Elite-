import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MLB_S6Q_EVIDENCE_VERSION,
  type MlbS6qFiftySettlementHumanReviewService,
  type S6qBreakdown,
  type S6qEvidence,
  type S6qReport,
} from "./mlb-s6q-fifty-settlement-human-review";
import type { S6lMetricSummary } from "./mlb-s6l-scientific-metrics";
import type { S6mManifestEntry } from "./mlb-s6m-statistical-milestones";

export const MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION = "mlb-s6r-human-review-dossier.v1" as const;
export const MLB_S6R_DOSSIER_VERSION = "mlb-s6r-human-review-dossier-artifact.v1" as const;
export const MLB_S6R_DOSSIER_ANCHOR_VERSION = "mlb-s6r-human-review-dossier-anchor.v1" as const;
export const MLB_S6R_REVIEW_DECISION_VERSION = "mlb-s6r-human-review-decision.v1" as const;
export const MLB_S6R_TARGET_SIZE = 50 as const;

export type S6rState =
  | "LOCKED_WAITING_FOR_S6Q"
  | "HUMAN_REVIEW_DOSSIER_READY"
  | "HUMAN_REVIEW_IN_PROGRESS"
  | "HUMAN_REVIEW_COMPLETED"
  | "CANDIDATE_SHADOW_STUDY_PROPOSED"
  | "ACTION_REQUIRED";

export type S6rSubgroupClassification =
  | "INSUFFICIENT_SUBGROUP_SAMPLE"
  | "DESCRIPTIVE_ONLY"
  | "CANDIDATE_FOR_FURTHER_STUDY"
  | "POTENTIAL_CALIBRATION_CONCERN";

export type S6rReviewConclusion =
  | "NO_CHANGE"
  | "COLLECT_MORE_DATA"
  | "DESIGN_SHADOW_CANDIDATE"
  | "INVESTIGATE_DATA_QUALITY"
  | "ACTION_REQUIRED";

export type S6rReviewStage = "IN_PROGRESS" | "FINAL";

export type S6rSubgroupReview = {
  key: string;
  sampleSize: number;
  classification: S6rSubgroupClassification;
  rationaleCodes: string[];
  metrics: S6lMetricSummary;
};

export type S6rDossier = {
  schemaVersion: typeof MLB_S6R_DOSSIER_VERSION;
  createdAt: string;
  deploymentCommit: string;
  environment: string;
  sourceS6qGeneratedAt: string;
  sourceS6qEvidenceDigestSha256: string;
  sourceCertificateDigestSha256: string;
  sourceManifestDigestSha256: string;
  sampleRule: "SEALED_S6Q_FIRST_50_ELIGIBLE_BINARY_DECISIONS";
  sampleSize: typeof MLB_S6R_TARGET_SIZE;
  manifest: S6mManifestEntry[];
  metrics: S6lMetricSummary;
  marketReviews: S6rSubgroupReview[];
  signalReviews: S6rSubgroupReview[];
  calibrationBuckets: S6qEvidence["calibrationBuckets"];
  provisionalFinalComparison: S6qEvidence["provisionalFinalComparison"];
  concentration: S6qEvidence["concentration"];
  exclusionsAndWarnings: Array<{
    code: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
    message: string;
  }>;
  reviewGuardrails: {
    humanInterpretationOnly: true;
    subgroupResultsAreDescriptive: true;
    profitabilityNotEstablishedAutomatically: true;
    candidateMustBeSeparatelyVersioned: true;
    candidateMustRunInShadow: true;
    automaticPromotionAllowed: false;
    automaticModelChangesAllowed: false;
    realFinancialExposure: 0;
  };
  dossierDigestSha256: string;
};

export type S6rDossierAnchor = {
  schemaVersion: typeof MLB_S6R_DOSSIER_ANCHOR_VERSION;
  createdAt: string;
  dossierCreatedAt: string;
  dossierDigestSha256: string;
  sourceS6qEvidenceDigestSha256: string;
  anchorDigestSha256: string;
};

export type S6rReviewDecision = {
  schemaVersion: typeof MLB_S6R_REVIEW_DECISION_VERSION;
  decisionId: string;
  submittedAt: string;
  reviewerUserId: number;
  stage: S6rReviewStage;
  conclusion: S6rReviewConclusion | null;
  rationale: string;
  candidateVersion: string | null;
  sourceDossierDigestSha256: string;
  supportingMetricsDigestSha256: string;
  previousDecisionDigestSha256: string | null;
  constraints: {
    shadowOnly: true;
    automaticPromotionAllowed: false;
    automaticModelChangesAllowed: false;
    realFinancialExposure: 0;
  };
  decisionDigestSha256: string;
};

export type S6rReviewSubmission = {
  stage: S6rReviewStage;
  conclusion?: S6rReviewConclusion | null;
  rationale: string;
  candidateVersion?: string | null;
};

export type S6rIssue = {
  code: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
};

export type S6rReport = {
  schemaVersion: typeof MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6rState;
  sourceS6q: {
    available: boolean;
    generatedAt: string | null;
    state: string | null;
    humanReviewReady: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    criticalIssues: number;
    evidenceAvailable: boolean;
    evidenceDigestSha256: string | null;
  };
  dossier: {
    present: boolean;
    everObserved: boolean;
    digestSha256: string | null;
    sourceEvidenceDigestSha256: string | null;
    sampleSize: number;
    marketSubgroups: number;
    signalSubgroups: number;
  };
  review: {
    decisions: number;
    latestStage: S6rReviewStage | null;
    latestConclusion: S6rReviewConclusion | null;
    latestSubmittedAt: string | null;
    latestDecisionDigestSha256: string | null;
    journalValid: boolean;
  };
  readiness: {
    dossierReady: boolean;
    humanReviewInProgress: boolean;
    humanReviewCompleted: boolean;
    candidateShadowStudyProposed: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  persistence: {
    dossierAppendOnly: true;
    dossierAnchorAppendOnly: true;
    reviewJournalAppendOnly: true;
    dossierAnchorPresent: boolean;
    dossierDigestAnchored: boolean;
  };
  issues: S6rIssue[];
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

type S6rOptions = {
  ownerUserId: number;
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  maxSnapshots?: number;
  root?: string;
  now?: () => Date;
  deploymentCommit?: string;
  environment?: string;
};

type StoredArtifact<T> = {
  value: T | null;
  present: boolean;
  error: string | null;
};

type EvaluationInput = {
  generatedAt?: string;
  trigger?: string;
  deploymentCommit?: string;
  environment?: string;
  previousDossierEverObserved?: boolean;
  previousReportReadError?: string | null;
};

type EvaluationResult = {
  report: S6rReport;
  dossierToPersist: S6rDossier | null;
  anchorToPersist: S6rDossierAnchor | null;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dossierCore(dossier: S6rDossier): Omit<S6rDossier, "dossierDigestSha256"> {
  const { dossierDigestSha256: _ignored, ...core } = dossier;
  return core;
}

function anchorCore(anchor: S6rDossierAnchor): Omit<S6rDossierAnchor, "anchorDigestSha256"> {
  const { anchorDigestSha256: _ignored, ...core } = anchor;
  return core;
}

function evidenceCore(evidence: S6qEvidence): Omit<S6qEvidence, "evidenceDigestSha256"> {
  const { evidenceDigestSha256: _ignored, ...core } = evidence;
  return core;
}

function decisionCore(decision: S6rReviewDecision): Omit<S6rReviewDecision, "decisionDigestSha256"> {
  const { decisionDigestSha256: _ignored, ...core } = decision;
  return core;
}

function pushIssue(
  issues: S6rIssue[],
  code: string,
  severity: S6rIssue["severity"],
  message: string,
): void {
  issues.push({ code, severity, message });
}

function allEvidenceChecksTrue(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  const required = [
    "milestoneFiftyCertificatePresent",
    "prerequisiteMinimumSample20Certified",
    "tenCertifiedCyclesReached",
    "exactFiftyDecisionSample",
    "duplicateFree",
    "certificateDigestValid",
    "manifestDigestValid",
    "currentLedgerManifestMatches",
    "terminalRecordsPresent",
    "terminalStagesFinal",
    "settlementsPresent",
    "settlementIdentitiesMatch",
    "settlementResultsBinary",
    "standardAmericanOdds",
    "postFixCohort",
    "s6mMetricParityPassed",
    "independentFiftyDecisionMetricsMatch",
    "noCriticalS6mIssues",
    "ledgerCountMonotonic",
    "certificateStableAcrossRuns",
  ];
  return required.every((key) => value[key] === true);
}

function isMetricSummary(value: unknown): value is S6lMetricSummary {
  if (!isObjectRecord(value)) return false;
  return typeof value.observations === "number"
    && typeof value.binaryDecisions === "number"
    && typeof value.wins === "number"
    && typeof value.losses === "number"
    && typeof value.flatStakeExposureUnits === "number"
    && typeof value.flatStakeProfitUnits === "number"
    && typeof value.clvAvailable === "number";
}

function isBreakdown(value: unknown): value is S6qBreakdown {
  return isObjectRecord(value)
    && typeof value.key === "string"
    && typeof value.sampleSize === "number"
    && isMetricSummary(value.metrics);
}

function isEvidenceShape(value: unknown): value is S6qEvidence {
  if (!isObjectRecord(value)) return false;
  return value.schemaVersion === MLB_S6Q_EVIDENCE_VERSION
    && typeof value.certifiedAt === "string"
    && typeof value.certificateDigestSha256 === "string"
    && typeof value.manifestDigestSha256 === "string"
    && typeof value.baselineDigestSha256 === "string"
    && Array.isArray(value.manifest)
    && value.manifest.length === MLB_S6R_TARGET_SIZE
    && isMetricSummary(value.metrics)
    && Array.isArray(value.marketBreakdowns)
    && value.marketBreakdowns.every(isBreakdown)
    && Array.isArray(value.signalBreakdowns)
    && value.signalBreakdowns.every(isBreakdown)
    && Array.isArray(value.calibrationBuckets)
    && isObjectRecord(value.provisionalFinalComparison)
    && isObjectRecord(value.concentration)
    && value.sampleAdequacy === "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW"
    && allEvidenceChecksTrue(value.checks)
    && isObjectRecord(value.independentCertification)
    && value.independentCertification.required === 10
    && typeof value.independentCertification.certifiedAtReview === "number"
    && value.independentCertification.certifiedAtReview >= 10
    && typeof value.evidenceDigestSha256 === "string";
}

function validateEvidence(value: unknown): { evidence: S6qEvidence | null; errors: string[] } {
  if (!isEvidenceShape(value)) {
    return { evidence: null, errors: ["The S6Q evidence artifact has an incomplete or incompatible structure."] };
  }
  const errors: string[] = [];
  if (sha256(evidenceCore(value)) !== value.evidenceDigestSha256) {
    errors.push("The S6Q evidence digest does not match its contents.");
  }
  if (value.metrics.binaryDecisions !== MLB_S6R_TARGET_SIZE) {
    errors.push("The S6Q evidence does not contain exactly fifty binary decisions.");
  }
  if (new Set(value.manifest.map((entry) => entry.terminalPredictionId)).size !== MLB_S6R_TARGET_SIZE) {
    errors.push("The S6Q manifest contains duplicate terminal prediction identities.");
  }
  if (new Set(value.manifest.map((entry) => entry.settlementEventId)).size !== MLB_S6R_TARGET_SIZE) {
    errors.push("The S6Q manifest contains duplicate settlement identities.");
  }
  return { evidence: errors.length ? null : value, errors };
}

function calibrationGap(metrics: S6lMetricSummary): number | null {
  return metrics.meanModelProbability == null || metrics.observedWinRate == null
    ? null
    : Math.abs(metrics.meanModelProbability - metrics.observedWinRate);
}

export function classifyMlbS6rBreakdown(
  breakdown: Pick<S6qBreakdown, "sampleSize" | "metrics">,
): { classification: S6rSubgroupClassification; rationaleCodes: string[] } {
  if (breakdown.sampleSize < 5) {
    return {
      classification: "INSUFFICIENT_SUBGROUP_SAMPLE",
      rationaleCodes: ["SUBGROUP_N_LT_5"],
    };
  }
  if (breakdown.sampleSize < 10) {
    return {
      classification: "DESCRIPTIVE_ONLY",
      rationaleCodes: ["SUBGROUP_N_5_TO_9", "NO_PROFITABILITY_CONCLUSION"],
    };
  }
  const gap = calibrationGap(breakdown.metrics);
  const concern = (gap != null && gap >= 0.1)
    || (breakdown.metrics.expectedCalibrationError != null
      && breakdown.metrics.expectedCalibrationError >= 0.1);
  if (concern) {
    return {
      classification: "POTENTIAL_CALIBRATION_CONCERN",
      rationaleCodes: ["SUBGROUP_N_GTE_10", "ABSOLUTE_CALIBRATION_GAP_GTE_10PP"],
    };
  }
  return {
    classification: "CANDIDATE_FOR_FURTHER_STUDY",
    rationaleCodes: ["SUBGROUP_N_GTE_10", "DESCRIPTIVE_SIGNAL_ONLY", "SHADOW_VALIDATION_REQUIRED"],
  };
}

function reviewBreakdown(entry: S6qBreakdown): S6rSubgroupReview {
  const classification = classifyMlbS6rBreakdown(entry);
  return {
    key: entry.key,
    sampleSize: entry.sampleSize,
    classification: classification.classification,
    rationaleCodes: classification.rationaleCodes,
    metrics: entry.metrics,
  };
}

function makeDossier(
  sourceReport: S6qReport,
  evidence: S6qEvidence,
  generatedAt: string,
  deploymentCommit: string,
  environment: string,
): S6rDossier {
  const core: Omit<S6rDossier, "dossierDigestSha256"> = {
    schemaVersion: MLB_S6R_DOSSIER_VERSION,
    createdAt: generatedAt,
    deploymentCommit,
    environment,
    sourceS6qGeneratedAt: sourceReport.generatedAt,
    sourceS6qEvidenceDigestSha256: evidence.evidenceDigestSha256,
    sourceCertificateDigestSha256: evidence.certificateDigestSha256,
    sourceManifestDigestSha256: evidence.manifestDigestSha256,
    sampleRule: "SEALED_S6Q_FIRST_50_ELIGIBLE_BINARY_DECISIONS",
    sampleSize: MLB_S6R_TARGET_SIZE,
    manifest: evidence.manifest,
    metrics: evidence.metrics,
    marketReviews: evidence.marketBreakdowns.map(reviewBreakdown),
    signalReviews: evidence.signalBreakdowns.map(reviewBreakdown),
    calibrationBuckets: evidence.calibrationBuckets,
    provisionalFinalComparison: evidence.provisionalFinalComparison,
    concentration: evidence.concentration,
    exclusionsAndWarnings: sourceReport.issues.filter((entry) =>
      entry.severity !== "INFO"
      || /EXCLUD|DUPLIC|MISSING|INVALID|WARNING|CONCENTRATION/i.test(entry.code)),
    reviewGuardrails: {
      humanInterpretationOnly: true,
      subgroupResultsAreDescriptive: true,
      profitabilityNotEstablishedAutomatically: true,
      candidateMustBeSeparatelyVersioned: true,
      candidateMustRunInShadow: true,
      automaticPromotionAllowed: false,
      automaticModelChangesAllowed: false,
      realFinancialExposure: 0,
    },
  };
  return { ...core, dossierDigestSha256: sha256(core) };
}

function makeAnchor(dossier: S6rDossier, generatedAt: string): S6rDossierAnchor {
  const core: Omit<S6rDossierAnchor, "anchorDigestSha256"> = {
    schemaVersion: MLB_S6R_DOSSIER_ANCHOR_VERSION,
    createdAt: generatedAt,
    dossierCreatedAt: dossier.createdAt,
    dossierDigestSha256: dossier.dossierDigestSha256,
    sourceS6qEvidenceDigestSha256: dossier.sourceS6qEvidenceDigestSha256,
  };
  return { ...core, anchorDigestSha256: sha256(core) };
}

function isDossierShape(value: unknown): value is S6rDossier {
  if (!isObjectRecord(value)) return false;
  return value.schemaVersion === MLB_S6R_DOSSIER_VERSION
    && typeof value.createdAt === "string"
    && typeof value.deploymentCommit === "string"
    && typeof value.environment === "string"
    && typeof value.sourceS6qGeneratedAt === "string"
    && typeof value.sourceS6qEvidenceDigestSha256 === "string"
    && typeof value.sourceCertificateDigestSha256 === "string"
    && typeof value.sourceManifestDigestSha256 === "string"
    && value.sampleRule === "SEALED_S6Q_FIRST_50_ELIGIBLE_BINARY_DECISIONS"
    && value.sampleSize === MLB_S6R_TARGET_SIZE
    && Array.isArray(value.manifest)
    && value.manifest.length === MLB_S6R_TARGET_SIZE
    && isMetricSummary(value.metrics)
    && Array.isArray(value.marketReviews)
    && Array.isArray(value.signalReviews)
    && Array.isArray(value.calibrationBuckets)
    && isObjectRecord(value.provisionalFinalComparison)
    && isObjectRecord(value.concentration)
    && Array.isArray(value.exclusionsAndWarnings)
    && isObjectRecord(value.reviewGuardrails)
    && value.reviewGuardrails.automaticModelChangesAllowed === false
    && value.reviewGuardrails.automaticPromotionAllowed === false
    && value.reviewGuardrails.realFinancialExposure === 0
    && typeof value.dossierDigestSha256 === "string";
}

function isAnchorShape(value: unknown): value is S6rDossierAnchor {
  if (!isObjectRecord(value)) return false;
  return value.schemaVersion === MLB_S6R_DOSSIER_ANCHOR_VERSION
    && typeof value.createdAt === "string"
    && typeof value.dossierCreatedAt === "string"
    && typeof value.dossierDigestSha256 === "string"
    && typeof value.sourceS6qEvidenceDigestSha256 === "string"
    && typeof value.anchorDigestSha256 === "string";
}

function isDecisionShape(value: unknown): value is S6rReviewDecision {
  if (!isObjectRecord(value)) return false;
  return value.schemaVersion === MLB_S6R_REVIEW_DECISION_VERSION
    && typeof value.decisionId === "string"
    && typeof value.submittedAt === "string"
    && Number.isInteger(value.reviewerUserId)
    && (value.stage === "IN_PROGRESS" || value.stage === "FINAL")
    && (value.conclusion === null || [
      "NO_CHANGE",
      "COLLECT_MORE_DATA",
      "DESIGN_SHADOW_CANDIDATE",
      "INVESTIGATE_DATA_QUALITY",
      "ACTION_REQUIRED",
    ].includes(String(value.conclusion)))
    && typeof value.rationale === "string"
    && (value.candidateVersion === null || typeof value.candidateVersion === "string")
    && typeof value.sourceDossierDigestSha256 === "string"
    && typeof value.supportingMetricsDigestSha256 === "string"
    && (value.previousDecisionDigestSha256 === null || typeof value.previousDecisionDigestSha256 === "string")
    && isObjectRecord(value.constraints)
    && value.constraints.shadowOnly === true
    && value.constraints.automaticPromotionAllowed === false
    && value.constraints.automaticModelChangesAllowed === false
    && value.constraints.realFinancialExposure === 0
    && typeof value.decisionDigestSha256 === "string";
}

export function createMlbS6rReviewDecision(
  dossier: S6rDossier,
  input: S6rReviewSubmission,
  reviewerUserId: number,
  submittedAt: string,
  previous: S6rReviewDecision | null,
): S6rReviewDecision {
  const validConclusions: S6rReviewConclusion[] = [
    "NO_CHANGE", "COLLECT_MORE_DATA", "DESIGN_SHADOW_CANDIDATE",
    "INVESTIGATE_DATA_QUALITY", "ACTION_REQUIRED",
  ];
  if (input.stage !== "IN_PROGRESS" && input.stage !== "FINAL") {
    throw new Error("Review stage must be IN_PROGRESS or FINAL.");
  }
  if (input.conclusion != null && !validConclusions.includes(input.conclusion)) {
    throw new Error("Unknown S6R review conclusion.");
  }
  const rationale = String(input.rationale ?? "").trim();
  if (rationale.length < 20 || rationale.length > 5_000) {
    throw new Error("Review rationale must contain between 20 and 5000 characters.");
  }
  if (input.stage === "FINAL" && !input.conclusion) {
    throw new Error("A final human review requires a conclusion.");
  }
  if (input.stage === "IN_PROGRESS" && input.conclusion != null) {
    throw new Error("An in-progress review cannot publish a final conclusion.");
  }
  const candidateVersion = input.candidateVersion?.trim() || null;
  if (input.conclusion === "DESIGN_SHADOW_CANDIDATE" && !candidateVersion) {
    throw new Error("A separately versioned candidate name is required for a shadow candidate proposal.");
  }
  if (input.conclusion !== "DESIGN_SHADOW_CANDIDATE" && candidateVersion) {
    throw new Error("candidateVersion is only valid for DESIGN_SHADOW_CANDIDATE.");
  }
  const identitySeed = {
    submittedAt,
    reviewerUserId,
    stage: input.stage,
    conclusion: input.conclusion ?? null,
    sourceDossierDigestSha256: dossier.dossierDigestSha256,
    previousDecisionDigestSha256: previous?.decisionDigestSha256 ?? null,
  };
  const core: Omit<S6rReviewDecision, "decisionDigestSha256"> = {
    schemaVersion: MLB_S6R_REVIEW_DECISION_VERSION,
    decisionId: "s6r-review-" + sha256(identitySeed).slice(0, 24),
    submittedAt,
    reviewerUserId,
    stage: input.stage,
    conclusion: input.conclusion ?? null,
    rationale,
    candidateVersion,
    sourceDossierDigestSha256: dossier.dossierDigestSha256,
    supportingMetricsDigestSha256: sha256({
      metrics: dossier.metrics,
      marketReviews: dossier.marketReviews,
      signalReviews: dossier.signalReviews,
      calibrationBuckets: dossier.calibrationBuckets,
      concentration: dossier.concentration,
    }),
    previousDecisionDigestSha256: previous?.decisionDigestSha256 ?? null,
    constraints: {
      shadowOnly: true,
      automaticPromotionAllowed: false,
      automaticModelChangesAllowed: false,
      realFinancialExposure: 0,
    },
  };
  return { ...core, decisionDigestSha256: sha256(core) };
}

function validateReviewJournal(
  decisions: S6rReviewDecision[],
  dossier: S6rDossier | null,
): string[] {
  const errors: string[] = [];
  let previous: S6rReviewDecision | null = null;
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (!isDecisionShape(decision)) {
      errors.push("The review journal contains an incompatible decision artifact.");
      continue;
    }
    if (ids.has(decision.decisionId)) errors.push("The review journal contains a duplicate decision identity.");
    ids.add(decision.decisionId);
    if (sha256(decisionCore(decision)) !== decision.decisionDigestSha256) {
      errors.push("Review decision " + decision.decisionId + " failed its digest check.");
    }
    if (decision.previousDecisionDigestSha256 !== (previous?.decisionDigestSha256 ?? null)) {
      errors.push("Review decision " + decision.decisionId + " breaks the append-only digest chain.");
    }
    if (dossier && decision.sourceDossierDigestSha256 !== dossier.dossierDigestSha256) {
      errors.push("Review decision " + decision.decisionId + " references a different dossier digest.");
    }
    if (decision.stage === "FINAL" && !decision.conclusion) {
      errors.push("Review decision " + decision.decisionId + " is FINAL without a conclusion.");
    }
    if (decision.conclusion === "DESIGN_SHADOW_CANDIDATE" && !decision.candidateVersion) {
      errors.push("Review decision " + decision.decisionId + " proposes a candidate without a version.");
    }
    previous = decision;
  }
  return errors;
}

function validSourceReport(report: S6qReport | null): boolean {
  return Boolean(report
    && report.state === "READY_FOR_HUMAN_REVIEW"
    && report.readiness.humanReviewReady
    && report.readiness.sampleAdequateForHumanReview
    && report.readiness.conclusionsAllowed
    && report.readiness.automaticModelChangesAllowed === false
    && report.issues.every((entry) => entry.severity !== "CRITICAL"));
}

export function evaluateMlbS6rHumanReviewDossier(
  sourceReport: S6qReport | null,
  sourceEvidenceInput: unknown,
  storedDossier: StoredArtifact<S6rDossier>,
  storedAnchor: StoredArtifact<S6rDossierAnchor>,
  reviewDecisions: S6rReviewDecision[],
  reviewJournalReadError: string | null,
  options: EvaluationInput = {},
): EvaluationResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const deploymentCommit = options.deploymentCommit ?? "unknown";
  const environment = options.environment ?? "unknown";
  const issues: S6rIssue[] = [];
  const sourceCriticalIssues = sourceReport?.issues.filter((entry) => entry.severity === "CRITICAL").length ?? 0;
  const sourceReady = validSourceReport(sourceReport);
  const evidenceValidation = validateEvidence(sourceEvidenceInput);
  const sourceEvidence = evidenceValidation.evidence;
  let dossierToPersist: S6rDossier | null = null;
  let anchorToPersist: S6rDossierAnchor | null = null;

  if (sourceReport && sourceCriticalIssues > 0) {
    pushIssue(issues, "S6Q_CRITICAL_ISSUES_PRESENT", "CRITICAL", "S6Q reports critical issues and cannot unlock human review.");
  }
  if (sourceReport?.state === "ACTION_REQUIRED") {
    pushIssue(issues, "S6Q_ACTION_REQUIRED", "CRITICAL", "S6Q is in ACTION_REQUIRED.");
  }
  if (sourceReport?.state === "READY_FOR_HUMAN_REVIEW" && !sourceReady) {
    pushIssue(issues, "S6Q_READINESS_FLAGS_INVALID", "CRITICAL", "S6Q claims readiness but its named readiness flags are inconsistent.");
  }
  if (sourceReady && evidenceValidation.errors.length) {
    for (const message of evidenceValidation.errors) {
      pushIssue(issues, "S6Q_EVIDENCE_INVALID", "CRITICAL", message);
    }
  }
  if (storedDossier.error) pushIssue(issues, "DOSSIER_UNREADABLE", "CRITICAL", storedDossier.error);
  if (storedAnchor.error) pushIssue(issues, "DOSSIER_ANCHOR_UNREADABLE", "CRITICAL", storedAnchor.error);
  if (reviewJournalReadError) pushIssue(issues, "REVIEW_JOURNAL_UNREADABLE", "CRITICAL", reviewJournalReadError);
  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);

  const validDossier = storedDossier.present && isDossierShape(storedDossier.value)
    ? storedDossier.value
    : null;
  const validAnchor = storedAnchor.present && isAnchorShape(storedAnchor.value)
    ? storedAnchor.value
    : null;

  if (storedDossier.present && !validDossier) {
    pushIssue(issues, "DOSSIER_SHAPE_INVALID", "CRITICAL", "The append-only S6R dossier has an incomplete or incompatible structure.");
  }
  if (storedAnchor.present && !validAnchor) {
    pushIssue(issues, "DOSSIER_ANCHOR_SHAPE_INVALID", "CRITICAL", "The append-only S6R dossier anchor has an incomplete or incompatible structure.");
  }
  if (options.previousDossierEverObserved && !storedDossier.present) {
    pushIssue(issues, "DOSSIER_DISAPPEARED", "CRITICAL", "The append-only S6R dossier was previously observed and is now absent.");
  }
  if (validDossier) {
    if (sha256(dossierCore(validDossier)) !== validDossier.dossierDigestSha256) {
      pushIssue(issues, "DOSSIER_DIGEST_INVALID", "CRITICAL", "The S6R dossier failed its digest check.");
    }
    if (!validAnchor) {
      pushIssue(issues, "DOSSIER_ANCHOR_MISSING", "CRITICAL", "A persisted dossier exists without its append-only anchor.");
    }
    if (sourceEvidence && (
      validDossier.sourceS6qEvidenceDigestSha256 !== sourceEvidence.evidenceDigestSha256
      || validDossier.sourceCertificateDigestSha256 !== sourceEvidence.certificateDigestSha256
      || validDossier.sourceManifestDigestSha256 !== sourceEvidence.manifestDigestSha256
    )) {
      pushIssue(issues, "SOURCE_EVIDENCE_CHANGED_AFTER_DOSSIER", "CRITICAL", "The current S6Q evidence differs from the evidence sealed into the S6R dossier.");
    }
    if (!sourceReady) {
      pushIssue(issues, "S6Q_READINESS_REGRESSION_AFTER_DOSSIER", "CRITICAL", "S6Q is no longer ready after the append-only dossier was created.");
    }
  }
  if (validAnchor) {
    if (sha256(anchorCore(validAnchor)) !== validAnchor.anchorDigestSha256) {
      pushIssue(issues, "DOSSIER_ANCHOR_DIGEST_INVALID", "CRITICAL", "The S6R dossier anchor failed its digest check.");
    }
    if (!validDossier
      || validAnchor.dossierDigestSha256 !== validDossier.dossierDigestSha256
      || validAnchor.sourceS6qEvidenceDigestSha256 !== validDossier.sourceS6qEvidenceDigestSha256) {
      pushIssue(issues, "DOSSIER_ANCHOR_LINK_INVALID", "CRITICAL", "The dossier anchor no longer matches the dossier artifact.");
    }
  }

  const journalErrors = validateReviewJournal(reviewDecisions, validDossier);
  for (const message of journalErrors) {
    pushIssue(issues, "REVIEW_JOURNAL_INTEGRITY_INVALID", "CRITICAL", message);
  }

  const criticalBeforeCreation = issues.some((entry) => entry.severity === "CRITICAL");
  if (!validDossier && !storedDossier.present && !storedAnchor.present
    && sourceReady && sourceReport && sourceEvidence && !criticalBeforeCreation) {
    dossierToPersist = makeDossier(sourceReport, sourceEvidence, generatedAt, deploymentCommit, environment);
    anchorToPersist = makeAnchor(dossierToPersist, generatedAt);
  }

  const effectiveDossier = validDossier ?? dossierToPersist;
  const effectiveAnchor = validAnchor ?? anchorToPersist;
  const effectiveDossierEverObserved = options.previousDossierEverObserved || Boolean(effectiveDossier);
  const latestDecision = reviewDecisions[reviewDecisions.length - 1] ?? null;
  const critical = issues.some((entry) => entry.severity === "CRITICAL");

  let state: S6rState;
  if (critical || latestDecision?.conclusion === "ACTION_REQUIRED") state = "ACTION_REQUIRED";
  else if (!effectiveDossier) state = "LOCKED_WAITING_FOR_S6Q";
  else if (!latestDecision) state = "HUMAN_REVIEW_DOSSIER_READY";
  else if (latestDecision.stage === "IN_PROGRESS") state = "HUMAN_REVIEW_IN_PROGRESS";
  else if (latestDecision.conclusion === "DESIGN_SHADOW_CANDIDATE") state = "CANDIDATE_SHADOW_STUDY_PROPOSED";
  else state = "HUMAN_REVIEW_COMPLETED";

  if (!critical && state === "LOCKED_WAITING_FOR_S6Q") {
    pushIssue(issues, "S6Q_REVIEW_GATE_PENDING", "INFO", "S6R remains locked until S6Q reaches READY_FOR_HUMAN_REVIEW with valid immutable evidence.");
  }
  if (!critical && state === "HUMAN_REVIEW_DOSSIER_READY") {
    pushIssue(issues, "HUMAN_REVIEW_DECISION_PENDING", "INFO", "The immutable dossier is ready for a documented human review decision.");
  }

  const report: S6rReport = {
    schemaVersion: MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION,
    generatedAt,
    trigger: options.trigger ?? "manual",
    deploymentCommit,
    environment,
    state,
    sourceS6q: {
      available: Boolean(sourceReport),
      generatedAt: sourceReport?.generatedAt ?? null,
      state: sourceReport?.state ?? null,
      humanReviewReady: Boolean(sourceReport?.readiness.humanReviewReady),
      conclusionsAllowed: Boolean(sourceReport?.readiness.conclusionsAllowed),
      automaticModelChangesAllowed: false,
      criticalIssues: sourceCriticalIssues,
      evidenceAvailable: Boolean(sourceEvidence),
      evidenceDigestSha256: sourceEvidence?.evidenceDigestSha256 ?? null,
    },
    dossier: {
      present: Boolean(effectiveDossier),
      everObserved: effectiveDossierEverObserved,
      digestSha256: effectiveDossier?.dossierDigestSha256 ?? null,
      sourceEvidenceDigestSha256: effectiveDossier?.sourceS6qEvidenceDigestSha256 ?? null,
      sampleSize: effectiveDossier?.sampleSize ?? 0,
      marketSubgroups: effectiveDossier?.marketReviews.length ?? 0,
      signalSubgroups: effectiveDossier?.signalReviews.length ?? 0,
    },
    review: {
      decisions: reviewDecisions.length,
      latestStage: latestDecision?.stage ?? null,
      latestConclusion: latestDecision?.conclusion ?? null,
      latestSubmittedAt: latestDecision?.submittedAt ?? null,
      latestDecisionDigestSha256: latestDecision?.decisionDigestSha256 ?? null,
      journalValid: journalErrors.length === 0 && !reviewJournalReadError,
    },
    readiness: {
      dossierReady: Boolean(effectiveDossier) && !critical,
      humanReviewInProgress: state === "HUMAN_REVIEW_IN_PROGRESS",
      humanReviewCompleted: state === "HUMAN_REVIEW_COMPLETED" || state === "CANDIDATE_SHADOW_STUDY_PROPOSED",
      candidateShadowStudyProposed: state === "CANDIDATE_SHADOW_STUDY_PROPOSED",
      conclusionsAllowed: Boolean(effectiveDossier) && !critical,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",
    },
    persistence: {
      dossierAppendOnly: true,
      dossierAnchorAppendOnly: true,
      reviewJournalAppendOnly: true,
      dossierAnchorPresent: Boolean(effectiveAnchor),
      dossierDigestAnchored: Boolean(effectiveDossier && effectiveAnchor
        && effectiveAnchor.dossierDigestSha256 === effectiveDossier.dossierDigestSha256),
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

  return { report, dossierToPersist, anchorToPersist };
}

function isReportShape(value: unknown): value is S6rReport {
  if (!isObjectRecord(value)) return false;
  const states: S6rState[] = [
    "LOCKED_WAITING_FOR_S6Q",
    "HUMAN_REVIEW_DOSSIER_READY",
    "HUMAN_REVIEW_IN_PROGRESS",
    "HUMAN_REVIEW_COMPLETED",
    "CANDIDATE_SHADOW_STUDY_PROPOSED",
    "ACTION_REQUIRED",
  ];
  return value.schemaVersion === MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION
    && typeof value.generatedAt === "string"
    && typeof value.trigger === "string"
    && typeof value.deploymentCommit === "string"
    && typeof value.environment === "string"
    && states.includes(value.state as S6rState)
    && isObjectRecord(value.sourceS6q)
    && isObjectRecord(value.dossier)
    && typeof value.dossier.everObserved === "boolean"
    && isObjectRecord(value.review)
    && isObjectRecord(value.readiness)
    && value.readiness.automaticModelChangesAllowed === false
    && value.readiness.automaticPromotionAllowed === false
    && isObjectRecord(value.persistence)
    && Array.isArray(value.issues)
    && isObjectRecord(value.safety)
    && value.safety.mode === "SHADOW"
    && value.safety.realFinancialExposure === 0;
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6R_HUMAN_REVIEW_DOSSIER?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6R_HUMAN_REVIEW_DOSSIER_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6r-human-review-dossier");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function writeAppendOnlyJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function readJsonArtifact<T>(filePath: string): StoredArtifact<T> {
  if (!fs.existsSync(filePath)) return { value: null, present: false, error: null };
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T, present: true, error: null };
  } catch (error) {
    return {
      value: null,
      present: true,
      error: "Unable to read " + path.basename(filePath) + ": "
        + (error instanceof Error ? error.message : String(error)),
    };
  }
}

function pruneSnapshots(directory: string, maxSnapshots: number): void {
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort();
  for (const entry of files.slice(0, Math.max(0, files.length - maxSnapshots))) {
    fs.rmSync(path.join(directory, entry), { force: true });
  }
}

function reviewFileName(decision: S6rReviewDecision, ordinal: number): string {
  return String(ordinal).padStart(6, "0") + "-"
    + decision.submittedAt.replace(/[:.]/g, "-") + "-"
    + decision.decisionDigestSha256.slice(0, 12) + ".json";
}

function readReviewJournal(root: string): { decisions: S6rReviewDecision[]; error: string | null } {
  const directory = path.join(root, "review-decisions");
  if (!fs.existsSync(directory)) return { decisions: [], error: null };
  try {
    const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort();
    const decisions = files.map((entry) =>
      JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8")) as S6rReviewDecision);
    return { decisions, error: null };
  } catch (error) {
    return {
      decisions: [],
      error: "Unable to read the append-only review journal: "
        + (error instanceof Error ? error.message : String(error)),
    };
  }
}

export class MlbS6rHumanReviewDossierService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
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
    private readonly s6qHumanReview: MlbS6qFiftySettlementHumanReviewService,
    options: S6rOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6R_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6R_INITIAL_DELAY_MS, 420_000, 10_000);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_S6R_MAX_SNAPSHOTS, 100, 10);
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
  private readLatestArtifact(): StoredArtifact<S6rReport> {
    const artifact = readJsonArtifact<unknown>(path.join(this.root, "latest.json"));
    if (artifact.error || !artifact.present) return { value: null, present: artifact.present, error: artifact.error };
    if (!isReportShape(artifact.value)) {
      return { value: null, present: true, error: "latest.json has an incomplete or incompatible S6R report structure." };
    }
    return { value: artifact.value, present: true, error: null };
  }
  readLatest(): S6rReport | null { return this.readLatestArtifact().value; }
  readDossier(): S6rDossier | null { return readJsonArtifact<S6rDossier>(path.join(this.root, "dossier.json")).value; }
  readReviewDecisions(): S6rReviewDecision[] { return readReviewJournal(this.root).decisions; }

  status() {
    return {
      schemaVersion: MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      maxSnapshots: this.maxSnapshots,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  async run(trigger = "scheduled"): Promise<S6rReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previousArtifact = this.readLatestArtifact();
      const previous = previousArtifact.value;
      const sourceReport = this.s6qHumanReview.readLatest();
      const sourceEvidence = this.s6qHumanReview.readEvidence();
      const dossierArtifact = readJsonArtifact<S6rDossier>(path.join(this.root, "dossier.json"));
      const anchorArtifact = readJsonArtifact<S6rDossierAnchor>(path.join(this.root, "dossier-anchor.json"));
      const journal = readReviewJournal(this.root);
      let evaluation = evaluateMlbS6rHumanReviewDossier(
        sourceReport,
        sourceEvidence,
        dossierArtifact,
        anchorArtifact,
        journal.decisions,
        journal.error,
        {
          generatedAt: now.toISOString(),
          trigger,
          deploymentCommit: this.deploymentCommit,
          environment: this.environment,
          previousDossierEverObserved: previous?.dossier.everObserved ?? false,
          previousReportReadError: previousArtifact.error,
        },
      );

      if (evaluation.anchorToPersist) {
        try {
          writeAppendOnlyJson(path.join(this.root, "dossier-anchor.json"), evaluation.anchorToPersist);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      if (evaluation.dossierToPersist) {
        try {
          writeAppendOnlyJson(path.join(this.root, "dossier.json"), evaluation.dossierToPersist);
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
        }
      }

      if (evaluation.dossierToPersist || evaluation.anchorToPersist) {
        evaluation = evaluateMlbS6rHumanReviewDossier(
          sourceReport,
          sourceEvidence,
          readJsonArtifact<S6rDossier>(path.join(this.root, "dossier.json")),
          readJsonArtifact<S6rDossierAnchor>(path.join(this.root, "dossier-anchor.json")),
          journal.decisions,
          journal.error,
          {
            generatedAt: now.toISOString(),
            trigger,
            deploymentCommit: this.deploymentCommit,
            environment: this.environment,
            previousDossierEverObserved: previous?.dossier.everObserved ?? false,
            previousReportReadError: previousArtifact.error,
          },
        );
      }

      const report = evaluation.report;
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const snapshotDirectory = path.join(this.root, "snapshots");
      const digest = sha256({ ...report, generatedAt: undefined, trigger: undefined });
      const previousDigest = previous
        ? sha256({ ...previous, generatedAt: undefined, trigger: undefined })
        : null;
      if (digest !== previousDigest) {
        atomicWriteJson(
          path.join(snapshotDirectory, report.generatedAt.replace(/[:.]/g, "-") + "-" + digest.slice(0, 12) + ".json"),
          report,
        );
        pruneSnapshots(snapshotDirectory, this.maxSnapshots);
      }
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async submitReviewDecision(
    input: S6rReviewSubmission,
    reviewerUserId: number,
  ): Promise<{ decision: S6rReviewDecision; report: S6rReport }> {
    if (reviewerUserId !== this.ownerUserId) throw new Error("Only the configured owner may submit an S6R review decision.");
    const preflight = await this.run("review-preflight");
    if (!preflight.readiness.dossierReady || preflight.state === "ACTION_REQUIRED") {
      throw new Error("The S6R dossier is not ready for a review decision.");
    }
    const dossier = this.readDossier();
    if (!dossier || !isDossierShape(dossier) || sha256(dossierCore(dossier)) !== dossier.dossierDigestSha256) {
      throw new Error("The append-only S6R dossier is unavailable or invalid.");
    }
    const journal = readReviewJournal(this.root);
    const journalErrors = validateReviewJournal(journal.decisions, dossier);
    if (journal.error || journalErrors.length) {
      throw new Error(journal.error ?? journalErrors[0]);
    }
    const decision = createMlbS6rReviewDecision(
      dossier,
      input,
      reviewerUserId,
      this.now().toISOString(),
      journal.decisions[journal.decisions.length - 1] ?? null,
    );
    writeAppendOnlyJson(
      path.join(this.root, "review-decisions", reviewFileName(decision, journal.decisions.length + 1)),
      decision,
    );
    const report = await this.run("review-submission");
    return { decision, report };
  }
}

export function startMlbS6rHumanReviewDossierWorker(
  s6qHumanReview: MlbS6qFiftySettlementHumanReviewService,
  options: S6rOptions,
): { service: MlbS6rHumanReviewDossierService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6rHumanReviewDossierService(s6qHumanReview, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6r] human-review dossier failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
