export const MLB_S6S_CONSOLE_VERSION = "mlb-s6s-human-review-console.v1" as const;

export type S6sReviewStage = "IN_PROGRESS" | "FINAL";

export type S6sReviewConclusion =
  | "NO_CHANGE"
  | "COLLECT_MORE_DATA"
  | "DESIGN_SHADOW_CANDIDATE"
  | "INVESTIGATE_DATA_QUALITY"
  | "ACTION_REQUIRED";

export type S6sSeverity = "INFO" | "WARNING" | "CRITICAL";

export type S6sProgressSource = {
  binaryEligibleDecisions?: number | null;
  targetSize?: number | null;
  independentlyCertifiedAmongFirstFifty?: number | null;
  requiredIndependentCertifications?: number | null;
};

export type S6sReviewGateSource = {
  authenticated: boolean;
  s6rState?: string | null;
  dossierReady?: boolean | null;
  criticalIssues?: number | null;
  journalValid?: boolean | null;
  automaticModelChangesAllowed?: boolean | null;
  automaticPromotionAllowed?: boolean | null;
  realFinancialExposure?: number | null;
};

export type S6sReviewDraft = {
  stage: S6sReviewStage;
  conclusion: S6sReviewConclusion | null;
  rationale: string;
  candidateVersion: string;
};

export const S6S_CONCLUSION_LABELS: Record<S6sReviewConclusion, string> = {
  NO_CHANGE: "No cambiar el modelo",
  COLLECT_MORE_DATA: "Recopilar más datos",
  DESIGN_SHADOW_CANDIDATE: "Diseñar candidato SHADOW",
  INVESTIGATE_DATA_QUALITY: "Investigar calidad de datos",
  ACTION_REQUIRED: "Acción correctiva requerida",
};

export const S6S_STATE_LABELS: Record<string, string> = {
  ARMED_AND_WAITING_FOR_50: "Esperando la muestra de 50",
  WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION: "Esperando certificación de 20",
  WAITING_FOR_TEN_CERTIFIED_CYCLES: "Esperando diez ciclos certificados",
  OBSERVING_FIFTY_RESULT_STABILITY: "Verificando estabilidad de la muestra",
  READY_FOR_HUMAN_REVIEW: "Lista para revisión humana",
  LOCKED_WAITING_FOR_S6Q: "Consola bloqueada hasta S6Q",
  HUMAN_REVIEW_DOSSIER_READY: "Expediente listo",
  HUMAN_REVIEW_IN_PROGRESS: "Revisión humana en curso",
  HUMAN_REVIEW_COMPLETED: "Revisión humana completada",
  CANDIDATE_SHADOW_STUDY_PROPOSED: "Candidato SHADOW propuesto",
  ACTION_REQUIRED: "Acción requerida",
};

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function buildS6sProgress(source: S6sProgressSource | null | undefined) {
  const target = Math.max(1, Math.floor(finiteNumber(source?.targetSize, 50)));
  const eligible = Math.max(0, Math.floor(finiteNumber(source?.binaryEligibleDecisions)));
  const independentRequired = Math.max(
    1,
    Math.floor(finiteNumber(source?.requiredIndependentCertifications, 10)),
  );
  const independent = Math.max(
    0,
    Math.floor(finiteNumber(source?.independentlyCertifiedAmongFirstFifty)),
  );

  return {
    eligible,
    target,
    remaining: Math.max(0, target - eligible),
    percent: Math.min(100, Math.max(0, (eligible / target) * 100)),
    independent,
    independentRequired,
    independentRemaining: Math.max(0, independentRequired - independent),
    independentPercent: Math.min(
      100,
      Math.max(0, (independent / independentRequired) * 100),
    ),
  };
}

export function summarizeS6sIssues(
  issues: Array<{ severity?: string | null }> | null | undefined,
): Record<S6sSeverity, number> {
  const counts: Record<S6sSeverity, number> = {
    INFO: 0,
    WARNING: 0,
    CRITICAL: 0,
  };
  for (const issue of issues ?? []) {
    if (issue.severity === "INFO" || issue.severity === "WARNING" || issue.severity === "CRITICAL") {
      counts[issue.severity] += 1;
    }
  }
  return counts;
}

export function validateS6sReviewDraft(draft: S6sReviewDraft): string[] {
  const errors: string[] = [];
  const rationale = draft.rationale.trim();
  const candidateVersion = draft.candidateVersion.trim();

  if (rationale.length < 20) {
    errors.push("La justificación debe contener al menos 20 caracteres.");
  }
  if (rationale.length > 5_000) {
    errors.push("La justificación no puede superar 5000 caracteres.");
  }
  if (draft.stage === "FINAL" && !draft.conclusion) {
    errors.push("Una revisión final requiere una conclusión.");
  }
  if (draft.stage === "IN_PROGRESS" && draft.conclusion !== null) {
    errors.push("Una revisión en curso no puede publicar una conclusión final.");
  }
  if (draft.conclusion === "DESIGN_SHADOW_CANDIDATE" && !candidateVersion) {
    errors.push("El candidato SHADOW necesita un nombre de versión separado.");
  }
  if (draft.conclusion !== "DESIGN_SHADOW_CANDIDATE" && candidateVersion) {
    errors.push("El nombre de versión solo se permite para un candidato SHADOW.");
  }

  return errors;
}

export function evaluateS6sReviewGate(source: S6sReviewGateSource) {
  const reasons: string[] = [];

  if (!source.authenticated) reasons.push("AUTHENTICATION_REQUIRED");
  if (source.s6rState === "ACTION_REQUIRED") reasons.push("S6R_ACTION_REQUIRED");
  if (source.s6rState !== "HUMAN_REVIEW_DOSSIER_READY"
    && source.s6rState !== "HUMAN_REVIEW_IN_PROGRESS"
    && source.s6rState !== "HUMAN_REVIEW_COMPLETED"
    && source.s6rState !== "CANDIDATE_SHADOW_STUDY_PROPOSED") {
    reasons.push("DOSSIER_NOT_READY");
  }
  if (source.dossierReady !== true) reasons.push("DOSSIER_NOT_VERIFIED");
  if (finiteNumber(source.criticalIssues) > 0) reasons.push("CRITICAL_ISSUES_PRESENT");
  if (source.journalValid !== true) reasons.push("REVIEW_JOURNAL_INVALID");
  if (source.automaticModelChangesAllowed !== false) reasons.push("AUTO_MODEL_CHANGE_GUARD_INVALID");
  if (source.automaticPromotionAllowed !== false) reasons.push("AUTO_PROMOTION_GUARD_INVALID");
  if (source.realFinancialExposure !== 0) reasons.push("NONZERO_FINANCIAL_EXPOSURE");

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

export function isS6sSafetyInvariantValid(source: {
  mode?: string | null;
  realFinancialExposure?: number | null;
  automaticModelChangesAllowed?: boolean | null;
  automaticPromotionAllowed?: boolean | null;
  sportsbookIntegration?: boolean | null;
  automaticBetPlacement?: boolean | null;
  productionWrites?: boolean | null;
}) {
  return source.mode === "SHADOW"
    && source.realFinancialExposure === 0
    && source.automaticModelChangesAllowed === false
    && source.automaticPromotionAllowed === false
    && source.sportsbookIntegration === false
    && source.automaticBetPlacement === false
    && source.productionWrites === false;
}

export function shortS6sDigest(value: string | null | undefined, edge = 8): string {
  const digest = String(value ?? "").trim();
  if (!digest) return "—";
  if (digest.length <= edge * 2 + 1) return digest;
  return `${digest.slice(0, edge)}…${digest.slice(-edge)}`;
}

export function s6sStateLabel(state: string | null | undefined): string {
  if (!state) return "Sin estado";
  return S6S_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

export function s6sSubgroupLabel(classification: string): string {
  const labels: Record<string, string> = {
    INSUFFICIENT_SUBGROUP_SAMPLE: "Muestra insuficiente",
    DESCRIPTIVE_ONLY: "Solo descriptivo",
    CANDIDATE_FOR_FURTHER_STUDY: "Candidato para estudiar",
    POTENTIAL_CALIBRATION_CONCERN: "Posible problema de calibración",
  };
  return labels[classification] ?? classification.replace(/_/g, " ");
}
