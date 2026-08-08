import type { MlbInjuryShadowResult } from "./mlb-injury-shadow";

export interface MlbInjuryPhaseBPlayer {
  playerId: number;
  name: string;
  isPitcher: boolean;
  shadow: MlbInjuryShadowResult;
}

export interface MlbInjuryPhaseBInput {
  sourceStatus: string;
  officialValidationStatus: "VERIFIED" | "PARTIAL";
  stale?: boolean;
  anomalous?: boolean;
  rejectedCount?: number;
  officialOnly?: number;
  players: MlbInjuryPhaseBPlayer[];
}

export interface MlbInjuryPhaseBPlan {
  enabled: true;
  mode: "AUTO_CONSERVATIVE";
  autoApplyAllowed: boolean;
  coverage: "FULL" | "PARTIAL" | "BLOCKED";
  eligiblePlayerIds: number[];
  eligiblePlayerNames: string[];
  withheldCandidateNames: string[];
  candidateCount: number;
  scale: number;
  maxAbsRuns: number;
  requiresBullpenReconciliation: true;
  reason: string;
}

const ALLOWED_REASON_CODES = new Set([
  "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
]);

function isRecentHighConfidenceReliever(player: MlbInjuryPhaseBPlayer): boolean {
  const shadow = player.shadow;
  const days = shadow.daysSinceOfficialTransaction;
  const code = String(shadow.officialStatusCode || "").toUpperCase();

  return player.isPitcher
    && shadow.decision === "APPLY_CANDIDATE"
    && shadow.confidence === "HIGH"
    && (shadow.impact === "HIGH" || shadow.impact === "MEDIUM")
    && ALLOWED_REASON_CODES.has(shadow.reasonCode)
    && days !== null
    && days >= 0
    && days <= 14
    && /^D(?:10|15)$/i.test(code);
}

export function buildMlbInjuryPhaseBPlan(input: MlbInjuryPhaseBInput): MlbInjuryPhaseBPlan {
  const candidates = input.players.filter((player) => player.shadow.decision === "APPLY_CANDIDATE");
  const eligible = candidates.filter(isRecentHighConfidenceReliever);
  const withheld = candidates.filter((player) => !eligible.includes(player));

  const sourceHealthy = input.sourceStatus === "VERIFIED"
    && input.officialValidationStatus === "VERIFIED"
    && input.stale !== true
    && input.anomalous !== true;

  if (!sourceHealthy) {
    return {
      enabled: true,
      mode: "AUTO_CONSERVATIVE",
      autoApplyAllowed: false,
      coverage: "BLOCKED",
      eligiblePlayerIds: [],
      eligiblePlayerNames: [],
      withheldCandidateNames: candidates.map((player) => player.name),
      candidateCount: candidates.length,
      scale: 0,
      maxAbsRuns: 0,
      requiresBullpenReconciliation: true,
      reason: "Las fuentes no están completamente sanas; la automatización se abstiene.",
    };
  }

  const fullCoverage = (input.rejectedCount ?? 0) === 0 && (input.officialOnly ?? 0) === 0;
  const coverage = fullCoverage ? "FULL" : "PARTIAL";
  const scale = fullCoverage ? 0.50 : 0.35;
  const maxAbsRuns = fullCoverage ? 0.50 : 0.35;
  const autoApplyAllowed = eligible.length > 0;

  return {
    enabled: true,
    mode: "AUTO_CONSERVATIVE",
    autoApplyAllowed,
    coverage,
    eligiblePlayerIds: eligible.map((player) => player.playerId),
    eligiblePlayerNames: eligible.map((player) => player.name),
    withheldCandidateNames: withheld.map((player) => player.name),
    candidateCount: candidates.length,
    scale,
    maxAbsRuns,
    requiresBullpenReconciliation: true,
    reason: autoApplyAllowed
      ? fullCoverage
        ? "Solo relevistas de alto leverage, recientes y confirmados oficialmente pueden aplicarse; falta reconciliar bullpen."
        : "Se permite un ajuste reducido sobre relevistas confirmados, con cobertura parcial y tope más estricto."
      : candidates.length > 0
        ? "Los candidatos detectados no superaron todas las barreras de activación de la Fase B."
        : "No hay candidatos de alta confianza elegibles para ajuste automático.",
  };
}
