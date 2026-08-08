import assert from "node:assert/strict";
import test from "node:test";
import {
  buildS6sProgress,
  evaluateS6sReviewGate,
  isS6sSafetyInvariantValid,
  shortS6sDigest,
  summarizeS6sIssues,
  validateS6sReviewDraft,
} from "./mlb-human-review-console";

test("buildS6sProgress clamps progress and preserves remaining counts", () => {
  assert.deepEqual(buildS6sProgress({
    binaryEligibleDecisions: 46,
    targetSize: 50,
    independentlyCertifiedAmongFirstFifty: 25,
    requiredIndependentCertifications: 10,
  }), {
    eligible: 46,
    target: 50,
    remaining: 4,
    percent: 92,
    independent: 25,
    independentRequired: 10,
    independentRemaining: 0,
    independentPercent: 100,
  });

  const over = buildS6sProgress({
    binaryEligibleDecisions: 70,
    targetSize: 50,
    independentlyCertifiedAmongFirstFifty: 20,
    requiredIndependentCertifications: 10,
  });
  assert.equal(over.percent, 100);
  assert.equal(over.remaining, 0);
});

test("summarizeS6sIssues ignores unknown severities", () => {
  assert.deepEqual(summarizeS6sIssues([
    { severity: "INFO" },
    { severity: "WARNING" },
    { severity: "WARNING" },
    { severity: "CRITICAL" },
    { severity: "UNKNOWN" },
  ]), { INFO: 1, WARNING: 2, CRITICAL: 1 });
});

test("review draft requires rationale and a final conclusion", () => {
  assert.deepEqual(validateS6sReviewDraft({
    stage: "FINAL",
    conclusion: null,
    rationale: "muy corta",
    candidateVersion: "",
  }), [
    "La justificación debe contener al menos 20 caracteres.",
    "Una revisión final requiere una conclusión.",
  ]);
});

test("in-progress review cannot publish a conclusion", () => {
  const errors = validateS6sReviewDraft({
    stage: "IN_PROGRESS",
    conclusion: "NO_CHANGE",
    rationale: "La revisión continúa y todavía no existe una conclusión final.",
    candidateVersion: "",
  });
  assert.deepEqual(errors, [
    "Una revisión en curso no puede publicar una conclusión final.",
  ]);
});

test("shadow candidate requires an isolated version name", () => {
  const errors = validateS6sReviewDraft({
    stage: "FINAL",
    conclusion: "DESIGN_SHADOW_CANDIDATE",
    rationale: "La evidencia permite diseñar un candidato separado para observación.",
    candidateVersion: "",
  });
  assert.deepEqual(errors, [
    "El candidato SHADOW necesita un nombre de versión separado.",
  ]);

  assert.deepEqual(validateS6sReviewDraft({
    stage: "FINAL",
    conclusion: "DESIGN_SHADOW_CANDIDATE",
    rationale: "La evidencia permite diseñar un candidato separado para observación.",
    candidateVersion: "mlb-shadow-candidate-v2",
  }), []);
});

test("review gate remains locked until dossier and all safety guards are valid", () => {
  const locked = evaluateS6sReviewGate({
    authenticated: true,
    s6rState: "LOCKED_WAITING_FOR_S6Q",
    dossierReady: false,
    criticalIssues: 0,
    journalValid: true,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    realFinancialExposure: 0,
  });
  assert.equal(locked.allowed, false);
  assert.ok(locked.reasons.includes("DOSSIER_NOT_READY"));
  assert.ok(locked.reasons.includes("DOSSIER_NOT_VERIFIED"));

  const ready = evaluateS6sReviewGate({
    authenticated: true,
    s6rState: "HUMAN_REVIEW_DOSSIER_READY",
    dossierReady: true,
    criticalIssues: 0,
    journalValid: true,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    realFinancialExposure: 0,
  });
  assert.deepEqual(ready, { allowed: true, reasons: [] });
});

test("review gate fails closed for critical issues or unsafe automation flags", () => {
  const result = evaluateS6sReviewGate({
    authenticated: true,
    s6rState: "HUMAN_REVIEW_DOSSIER_READY",
    dossierReady: true,
    criticalIssues: 1,
    journalValid: false,
    automaticModelChangesAllowed: true,
    automaticPromotionAllowed: true,
    realFinancialExposure: 1,
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, [
    "CRITICAL_ISSUES_PRESENT",
    "REVIEW_JOURNAL_INVALID",
    "AUTO_MODEL_CHANGE_GUARD_INVALID",
    "AUTO_PROMOTION_GUARD_INVALID",
    "NONZERO_FINANCIAL_EXPOSURE",
  ]);
});

test("safety invariant requires SHADOW, zero exposure and zero write paths", () => {
  assert.equal(isS6sSafetyInvariantValid({
    mode: "SHADOW",
    realFinancialExposure: 0,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    sportsbookIntegration: false,
    automaticBetPlacement: false,
    productionWrites: false,
  }), true);

  assert.equal(isS6sSafetyInvariantValid({
    mode: "LIVE",
    realFinancialExposure: 0,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    sportsbookIntegration: false,
    automaticBetPlacement: false,
    productionWrites: false,
  }), false);
});

test("shortS6sDigest keeps identity readable without exposing a full wall of text", () => {
  assert.equal(shortS6sDigest("abcdef", 4), "abcdef");
  assert.equal(shortS6sDigest("1234567890abcdef", 4), "1234…cdef");
  assert.equal(shortS6sDigest(null), "—");
});
