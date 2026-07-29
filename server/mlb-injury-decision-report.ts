import type { LedgerRecord } from "./mlb-ledger-store";
import {
  buildMlbInjuryOutcomeRows,
  buildMlbInjuryOutcomesReport,
  type MlbInjuryOutcomeRow,
} from "./mlb-injury-outcomes-report";

export const MLB_INJURY_DECISION_REPORT_VERSION = "mlb-injury-decision-report.v1" as const;

export type InjuryDecisionVerdict = "MANTENER" | "REVISAR" | "AMPLIAR_CON_CAUTELA" | "RESTRINGIR";
export type InjuryDecisionSampleStatus = "INSUFFICIENT" | "EARLY" | "ACTIONABLE" | "MATURE";
export type InjuryDecisionConfidence = "LOW" | "MEDIUM" | "HIGH";

type Metrics = {
  total: number;
  settled: number;
  pending: number;
  wins: number;
  losses: number;
  pushesOrVoids: number;
  profitUnits: number;
  stakedUnits: number;
  roiPct: number;
  winRatePct: number;
  brierScore: number | null;
  logLoss: number | null;
  averageClvPp: number | null;
};

type Decision = {
  key: string;
  label: string;
  verdict: InjuryDecisionVerdict;
  sampleStatus: InjuryDecisionSampleStatus;
  confidence: InjuryDecisionConfidence;
  metrics: Metrics;
  reasons: string[];
  guardrail: string;
};

const POLICY = {
  minimumObserve: 10,
  minimumActionable: 20,
  minimumExpand: 30,
  negativeRoiPct: -8,
  positiveRoiPct: 5,
  poorBrierAbsolute: 0.27,
  goodBrierAbsolute: 0.235,
  poorLogLossAbsolute: 0.75,
  goodLogLossAbsolute: 0.67,
  negativeClvPp: -1,
  positiveClvPp: 0.5,
  relativeBrierBad: 0.025,
  relativeBrierGood: -0.015,
  relativeLogLossBad: 0.06,
  relativeLogLossGood: -0.04,
} as const;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function avg(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null;
}

function metrics(rows: MlbInjuryOutcomeRow[]): Metrics {
  const settled = rows.filter((row) => row.result != null);
  const scored = settled.filter((row) => row.outcomeValue != null);
  const wins = settled.filter((row) => row.result === "WIN" || row.result === "HALF_WIN").length;
  const losses = settled.filter((row) => row.result === "LOSS" || row.result === "HALF_LOSS").length;
  const profitUnits = settled.reduce((sum, row) => sum + row.profitUnits, 0);
  const stakedUnits = settled.reduce((sum, row) => sum + row.stakeUnits, 0);
  return {
    total: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    wins,
    losses,
    pushesOrVoids: settled.length - wins - losses,
    profitUnits: round(profitUnits),
    stakedUnits: round(stakedUnits),
    roiPct: stakedUnits > 0 ? round((profitUnits / stakedUnits) * 100, 2) : 0,
    winRatePct: wins + losses > 0 ? round((wins / (wins + losses)) * 100, 2) : 0,
    brierScore: avg(scored.map((row) => row.brierScore as number)),
    logLoss: avg(scored.map((row) => row.logLoss as number)),
    averageClvPp: avg(settled.filter((row) => row.clvPp != null).map((row) => row.clvPp as number)),
  };
}

function sampleStatus(settled: number): InjuryDecisionSampleStatus {
  if (settled < POLICY.minimumObserve) return "INSUFFICIENT";
  if (settled < POLICY.minimumActionable) return "EARLY";
  if (settled < POLICY.minimumExpand) return "ACTIONABLE";
  return "MATURE";
}

function decide(key: string, label: string, current: Metrics, baseline: Metrics): Decision {
  const status = sampleStatus(current.settled);
  const reasons: string[] = [];
  const negative: string[] = [];
  const positive: string[] = [];

  if (current.roiPct <= POLICY.negativeRoiPct) negative.push(`ROI ${current.roiPct.toFixed(1)}% por debajo del umbral ${POLICY.negativeRoiPct}%`);
  if (current.roiPct >= POLICY.positiveRoiPct) positive.push(`ROI ${current.roiPct.toFixed(1)}% por encima del umbral +${POLICY.positiveRoiPct}%`);

  if (current.brierScore != null) {
    if (current.brierScore >= POLICY.poorBrierAbsolute) negative.push(`Brier ${current.brierScore.toFixed(3)} en zona débil`);
    if (current.brierScore <= POLICY.goodBrierAbsolute) positive.push(`Brier ${current.brierScore.toFixed(3)} en zona favorable`);
    if (baseline.brierScore != null) {
      const delta = current.brierScore - baseline.brierScore;
      if (delta >= POLICY.relativeBrierBad) negative.push(`Brier empeora ${delta.toFixed(3)} frente al total auditado`);
      if (delta <= POLICY.relativeBrierGood) positive.push(`Brier mejora ${Math.abs(delta).toFixed(3)} frente al total auditado`);
    }
  }

  if (current.logLoss != null) {
    if (current.logLoss >= POLICY.poorLogLossAbsolute) negative.push(`Log loss ${current.logLoss.toFixed(3)} en zona débil`);
    if (current.logLoss <= POLICY.goodLogLossAbsolute) positive.push(`Log loss ${current.logLoss.toFixed(3)} en zona favorable`);
    if (baseline.logLoss != null) {
      const delta = current.logLoss - baseline.logLoss;
      if (delta >= POLICY.relativeLogLossBad) negative.push(`Log loss empeora ${delta.toFixed(3)} frente al total auditado`);
      if (delta <= POLICY.relativeLogLossGood) positive.push(`Log loss mejora ${Math.abs(delta).toFixed(3)} frente al total auditado`);
    }
  }

  if (current.averageClvPp != null) {
    if (current.averageClvPp <= POLICY.negativeClvPp) negative.push(`CLV promedio ${current.averageClvPp.toFixed(2)} pp es negativo`);
    if (current.averageClvPp >= POLICY.positiveClvPp) positive.push(`CLV promedio +${current.averageClvPp.toFixed(2)} pp es favorable`);
  }

  if (status === "INSUFFICIENT") {
    reasons.push(`Solo ${current.settled} picks liquidados; se requieren ${POLICY.minimumObserve} para una señal preliminar.`);
    return { key, label, verdict: "MANTENER", sampleStatus: status, confidence: "LOW", metrics: current, reasons, guardrail: "No cambiar reglas ni pesos con esta muestra." };
  }

  if (status === "EARLY") {
    reasons.push(...(negative.length || positive.length ? [...negative, ...positive] : ["La evidencia temprana no muestra una desviación clara."]));
    return {
      key, label, verdict: negative.length || positive.length ? "REVISAR" : "MANTENER",
      sampleStatus: status, confidence: "LOW", metrics: current,
      reasons, guardrail: `Esperar al menos ${POLICY.minimumActionable} liquidaciones antes de actuar.`,
    };
  }

  if (negative.length >= 2) {
    return {
      key, label, verdict: "RESTRINGIR", sampleStatus: status,
      confidence: status === "MATURE" ? "HIGH" : "MEDIUM", metrics: current,
      reasons: negative, guardrail: "Revisión humana obligatoria; no restringir automáticamente el modelo.",
    };
  }

  if (positive.length >= 2) {
    if (status === "MATURE") {
      return {
        key, label, verdict: "AMPLIAR_CON_CAUTELA", sampleStatus: status, confidence: "HIGH", metrics: current,
        reasons: positive, guardrail: "Solo ampliar una regla a la vez, con límites conservadores y monitoreo posterior.",
      };
    }
    return {
      key, label, verdict: "REVISAR", sampleStatus: status, confidence: "MEDIUM", metrics: current,
      reasons: [...positive, `La señal es prometedora, pero se requieren ${POLICY.minimumExpand} liquidaciones para ampliar.`],
      guardrail: "Mantener reglas actuales mientras madura la muestra.",
    };
  }

  if (negative.length || positive.length) {
    return {
      key, label, verdict: "REVISAR", sampleStatus: status, confidence: "MEDIUM", metrics: current,
      reasons: [...negative, ...positive], guardrail: "Revisar evidencia sin modificar automáticamente fórmulas ni pesos.",
    };
  }

  return {
    key, label, verdict: "MANTENER", sampleStatus: status,
    confidence: status === "MATURE" ? "HIGH" : "MEDIUM", metrics: current,
    reasons: ["ROI, calibración y CLV no muestran una desviación suficiente para cambiar la política."],
    guardrail: "Continuar acumulando evidencia bajo las reglas actuales.",
  };
}

function marketLabel(key: string): string {
  const labels: Record<string, string> = { ML: "Moneyline", F5: "First 5", RUN_LINE: "Run Line", TOTAL: "Total", F5_TOTAL: "F5 Total" };
  return labels[key] || key;
}

export function buildMlbInjuryDecisionReport(records: LedgerRecord[]) {
  const outcomeReport = buildMlbInjuryOutcomesReport(records);
  const rows = buildMlbInjuryOutcomeRows(records);
  const baseline = metrics(rows);

  const cohortDefinitions: Array<[string, string, (row: MlbInjuryOutcomeRow) => boolean]> = [
    ["AUTO_APPLIED", "Lesiones autoaplicadas", (row) => row.autoApplied],
    ["RETAINED", "Candidatos retenidos", (row) => row.retained],
    ["NO_AUTO_ADJUSTMENT", "Sin autoajuste", (row) => !row.autoApplied],
    ["FULL_COVERAGE", "Cobertura completa", (row) => row.coverage === "FULL"],
    ["PARTIAL_COVERAGE", "Cobertura parcial", (row) => row.coverage === "PARTIAL"],
    ["BLOCKED_COVERAGE", "Cobertura bloqueada", (row) => row.coverage === "BLOCKED"],
    ["MANUAL_OVERRIDE", "Override manual", (row) => row.manualOverride],
    ["BULLPEN_BLOCKED", "Bloqueo por bullpen", (row) => row.bullpenBlocked],
  ];

  const cohorts = cohortDefinitions.map(([key, label, predicate]) => decide(key, label, metrics(rows.filter(predicate)), baseline));
  const marketKeys = [...new Set(rows.map((row) => row.marketType))].sort();
  const markets = marketKeys.map((key) => decide(`MARKET_${key}`, marketLabel(key), metrics(rows.filter((row) => row.marketType === key)), baseline));
  const settledByTime = rows.filter((row) => row.result != null).sort((a, b) => Date.parse(a.settledAt || a.recordedAt) - Date.parse(b.settledAt || b.recordedAt));
  const windows = [10, 20].map((size) => decide(`LAST_${size}`, `Últimos ${size}`, metrics(settledByTime.slice(-size)), baseline));
  const global = decide("GLOBAL", "Todos los picks C1", baseline, baseline);
  const alerts = [global, ...cohorts, ...markets]
    .filter((item) => item.verdict === "RESTRINGIR" || item.verdict === "AMPLIAR_CON_CAUTELA")
    .map((item) => ({ key: item.key, label: item.label, verdict: item.verdict, confidence: item.confidence }));

  return {
    schemaVersion: MLB_INJURY_DECISION_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    policy: { ...POLICY, formulasChanged: false, automaticRuleChanges: false },
    deduplication: outcomeReport.deduplication,
    global,
    cohorts,
    markets,
    windows,
    alerts,
  };
}

export type MlbInjuryDecisionReport = ReturnType<typeof buildMlbInjuryDecisionReport>;
