import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  classifyMlbS6rBreakdown,
  createMlbS6rReviewDecision,
  evaluateMlbS6rHumanReviewDossier,
  type S6rDossier,
} from "./mlb-s6r-human-review-dossier";
import { MLB_S6Q_EVIDENCE_VERSION } from "./mlb-s6q-fifty-settlement-human-review";

const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absent = <T>() => ({ value: null as T | null, present: false, error: null as string | null });

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    observations: 50, binaryDecisions: 50, wins: 28, losses: 22, pushes: 0, voids: 0,
    meanModelProbability: 0.62, observedWinRate: 0.56, winRateWilson95: { low: 0.42, high: 0.69 },
    brierScore: 0.24, logLoss: 0.68, expectedCalibrationError: 0.07, maximumCalibrationError: 0.13,
    flatStakeExposureUnits: 50, flatStakeProfitUnits: 1.8, flatStakeRoiPct: 3.6,
    clvAvailable: 40, clvCoveragePct: 80, meanClvPp: 0.42, medianClvPp: 0.31,
    ...overrides,
  };
}

function sourceEvidence() {
  const manifest = Array.from({ length: 50 }, (_, index) => ({
    ordinal: index + 1, rootPredictionId: `root-${index}`, terminalPredictionId: `final-${index}`,
    terminalRecordedAt: "2026-08-01T12:00:00.000Z", payloadSha256: `payload-${index}`,
    gamePk: 900000 + index, gameDate: "2026-08-01", marketType: index % 2 ? "F5_ML" : "F5_TOTAL",
    selection: index % 2 ? "HOME" : "OVER", line: index % 2 ? null : 4.5,
    signal: index % 3 ? "STRONG" : "STANDARD", modelProbability: 0.62,
    marketImpliedProbability: 0.53, oddsAmerican: -115, result: index % 2 ? "WIN" : "LOSS",
    outcome: index % 2 ? 1 : 0, clvPp: 0.2, independentlyCertified: index < 25,
    settlementEventId: `settlement-${index}`, settlementSource: "official", settledAt: "2026-08-02T01:00:00.000Z",
  }));
  const core = {
    schemaVersion: MLB_S6Q_EVIDENCE_VERSION, certifiedAt: "2026-08-03T15:00:00.000Z",
    deploymentCommit: "s6q", environment: "test", sourceS6mGeneratedAt: "2026-08-03T14:55:00.000Z",
    sourceS6mState: "MILESTONE_50_CERTIFIED", sourceS6pGeneratedAt: "2026-08-03T14:55:00.000Z",
    sourceS6pState: "MINIMUM_SAMPLE_20_CERTIFIED", baselineDigestSha256: "baseline",
    certificateDigestSha256: "certificate", manifestDigestSha256: "manifest",
    stability: { firstObservedAt: "2026-08-03T14:50:00.000Z", confirmedAt: "2026-08-03T15:00:00.000Z", stableForMs: 600000, minimumRequiredMs: 300000, distinctWorkerRuns: true },
    manifest,
    independentCertification: { required: 10, certifiedAtReview: 25, terminalPredictionIds: manifest.slice(0, 25).map((x) => x.terminalPredictionId), digestSha256: "independent" },
    metrics: metrics(),
    marketBreakdowns: [{ key: "F5_ML", sampleSize: 25, metrics: metrics({ observations: 25, binaryDecisions: 25 }) }],
    signalBreakdowns: [{ key: "STRONG", sampleSize: 33, metrics: metrics({ observations: 33, binaryDecisions: 33 }) }],
    calibrationBuckets: [], provisionalFinalComparison: {}, concentration: {},
    sampleAdequacy: "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW",
    checks: {
      milestoneFiftyCertificatePresent: true, prerequisiteMinimumSample20Certified: true,
      tenCertifiedCyclesReached: true, exactFiftyDecisionSample: true, duplicateFree: true,
      certificateDigestValid: true, manifestDigestValid: true, currentLedgerManifestMatches: true,
      terminalRecordsPresent: true, terminalStagesFinal: true, settlementsPresent: true,
      settlementIdentitiesMatch: true, settlementResultsBinary: true, standardAmericanOdds: true,
      postFixCohort: true, s6mMetricParityPassed: true, independentFiftyDecisionMetricsMatch: true,
      noCriticalS6mIssues: true, ledgerCountMonotonic: true, certificateStableAcrossRuns: true,
    },
  };
  return { ...core, evidenceDigestSha256: digest(core) } as any;
}

function sourceReport(state = "READY_FOR_HUMAN_REVIEW") {
  return {
    schemaVersion: "mlb-s6q-fifty-settlement-human-review.v1", generatedAt: "2026-08-03T15:00:00.000Z",
    trigger: "test", deploymentCommit: "s6q", environment: "test", state,
    sourceS6m: {}, sourceS6p: {}, sample: {}, target: {}, stability: {}, checks: {}, persistence: {}, issues: [],
    readiness: {
      armed: false, preferredSample50Certified: true, humanReviewReady: state === "READY_FOR_HUMAN_REVIEW",
      sampleAdequateForHumanReview: state === "READY_FOR_HUMAN_REVIEW", conclusionsAllowed: state === "READY_FOR_HUMAN_REVIEW",
      automaticModelChangesAllowed: false, recommendation: "NO_AUTOMATIC_MODEL_CHANGE",
    },
    safety: { mode: "SHADOW", realFinancialExposure: 0 },
  } as any;
}

function readyDossier() {
  const result = evaluateMlbS6rHumanReviewDossier(sourceReport(), sourceEvidence(), absent<S6rDossier>(), absent(), [], null,
    { generatedAt: "2026-08-03T15:05:00.000Z", deploymentCommit: "s6r", environment: "test" });
  assert.ok(result.dossierToPersist && result.anchorToPersist);
  return { dossier: result.dossierToPersist, anchor: result.anchorToPersist };
}

test("locks until S6Q is ready", () => {
  const result = evaluateMlbS6rHumanReviewDossier(sourceReport("ARMED_AND_WAITING_FOR_50"), null, absent(), absent(), [], null);
  assert.equal(result.report.state, "LOCKED_WAITING_FOR_S6Q");
  assert.equal(result.report.readiness.automaticModelChangesAllowed, false);
});

test("creates the immutable fifty-decision dossier", () => {
  const result = evaluateMlbS6rHumanReviewDossier(sourceReport(), sourceEvidence(), absent(), absent(), [], null);
  assert.equal(result.report.state, "HUMAN_REVIEW_DOSSIER_READY");
  assert.equal(result.dossierToPersist?.sampleSize, 50);
  assert.equal(result.dossierToPersist?.reviewGuardrails.candidateMustRunInShadow, true);
});

test("fails closed on tampered S6Q evidence", () => {
  const evidence = sourceEvidence();
  evidence.metrics.wins = 49;
  const result = evaluateMlbS6rHumanReviewDossier(sourceReport(), evidence, absent(), absent(), [], null);
  assert.equal(result.report.state, "ACTION_REQUIRED");
});

test("classifies subgroup sample sizes conservatively", () => {
  assert.equal(classifyMlbS6rBreakdown({ sampleSize: 4, metrics: metrics() as any }).classification, "INSUFFICIENT_SUBGROUP_SAMPLE");
  assert.equal(classifyMlbS6rBreakdown({ sampleSize: 8, metrics: metrics() as any }).classification, "DESCRIPTIVE_ONLY");
  assert.equal(classifyMlbS6rBreakdown({ sampleSize: 12, metrics: metrics({ meanModelProbability: 0.72, observedWinRate: 0.5 }) as any }).classification, "POTENTIAL_CALIBRATION_CONCERN");
});

test("records append-only in-progress and shadow-candidate decisions", () => {
  const { dossier, anchor } = readyDossier();
  const first = createMlbS6rReviewDecision(dossier, {
    stage: "IN_PROGRESS", rationale: "Reviewing calibration, concentration, CLV coverage and subgroup stability."
  }, 1, "2026-08-03T15:10:00.000Z", null);
  let result = evaluateMlbS6rHumanReviewDossier(sourceReport(), sourceEvidence(),
    { value: dossier, present: true, error: null }, { value: anchor, present: true, error: null }, [first], null);
  assert.equal(result.report.state, "HUMAN_REVIEW_IN_PROGRESS");

  const second = createMlbS6rReviewDecision(dossier, {
    stage: "FINAL", conclusion: "DESIGN_SHADOW_CANDIDATE",
    rationale: "The evidence supports a separately versioned shadow study but never automatic production promotion.",
    candidateVersion: "mlb-candidate-s6r-v1",
  }, 1, "2026-08-03T15:20:00.000Z", first);
  result = evaluateMlbS6rHumanReviewDossier(sourceReport(), sourceEvidence(),
    { value: dossier, present: true, error: null }, { value: anchor, present: true, error: null }, [first, second], null);
  assert.equal(result.report.state, "CANDIDATE_SHADOW_STUDY_PROPOSED");
  assert.equal(second.constraints.automaticPromotionAllowed, false);
});

test("detects review journal tampering", () => {
  const { dossier, anchor } = readyDossier();
  const decision = createMlbS6rReviewDecision(dossier, {
    stage: "FINAL", conclusion: "NO_CHANGE", rationale: "The first fifty results do not justify a model change."
  }, 1, "2026-08-03T15:10:00.000Z", null);
  const result = evaluateMlbS6rHumanReviewDossier(sourceReport(), sourceEvidence(),
    { value: dossier, present: true, error: null }, { value: anchor, present: true, error: null },
    [{ ...decision, rationale: "This text was changed after the digest was created and must fail closed." }], null);
  assert.equal(result.report.state, "ACTION_REQUIRED");
});
