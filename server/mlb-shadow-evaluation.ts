import { createHash } from "node:crypto";
import type { LedgerRecord } from "./mlb-ledger-store";

export const MLB_SHADOW_EVALUATION_VERSION = "mlb-shadow-evaluation.v1" as const;
export const MLB_SHADOW_FINGERPRINT_VERSION = "mlb-shadow-fingerprint.v1" as const;

export type MlbShadowDisposition = "ACCEPTED" | "BLOCKED" | "OBSERVED";
export type MlbShadowGateStatus = "GO_REVIEW" | "EXTEND" | "NO_GO";

export type MlbShadowRow = {
  predictionId: string;
  recordedAt: string;
  gameDate: string;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  book: string | null;
  modelName: string;
  modelVersion: string;
  modelCommit: string | null;
  modelProbability: number;
  marketImpliedProbability: number | null;
  edgePp: number | null;
  signal: string;
  category: string;
  disposition: MlbShadowDisposition;
  filterReasons: string[];
  recommendedStakeUnits: number;
  analysisStage: string;
  result: string | null;
  settledAt: string | null;
  outcomeValue: number | null;
  flatProfitUnits: number;
  policyProfitUnits: number;
  brierScore: number | null;
  logLoss: number | null;
  clvPp: number | null;
  fingerprint: string;
  analyticalDuplicate: boolean;
  analyticalDuplicateOfPredictionId: string | null;
  dataQuality: {
    checks: number;
    passed: number;
    coveragePct: number;
    missing: string[];
  };
};

type ShadowMetrics = {
  total: number;
  settled: number;
  pending: number;
  wins: number;
  losses: number;
  pushesOrVoids: number;
  hitRatePct: number;
  flatProfitUnits: number;
  flatStakedUnits: number;
  flatRoiPct: number;
  policyProfitUnits: number;
  policyStakedUnits: number;
  policyRoiPct: number;
  brierScore: number | null;
  logLoss: number | null;
  averageClvPp: number | null;
  averageModelProbabilityPct: number | null;
  averageEdgePp: number | null;
};

const TECHNICAL_KEYS = new Set([
  "capturedAt",
  "fetchedAt",
  "detectorFetchedAt",
  "validatorFetchedAt",
  "recordedAt",
  "settledAt",
  "latencyMs",
  "requestId",
  "clientRequestId",
]);

const GATE_POLICY = {
  minimumSettled: 30,
  minimumMarketImpliedCoveragePct: 80,
  minimumClosingCoveragePct: 70,
  minimumFinalSnapshotCoveragePct: 90,
  severeNegativeRoiPct: -10,
  severeBrierScore: 0.27,
  severeClvPp: -1.5,
} as const;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stableValue(value: unknown, key = ""): unknown {
  if (TECHNICAL_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => stableValue(entry))
      .filter((entry) => entry !== undefined)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((childKey) => [childKey, stableValue((value as Record<string, unknown>)[childKey], childKey)] as const)
        .filter(([, child]) => child !== undefined),
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 12) : null;
  return value;
}

function categoryFor(record: LedgerRecord): string {
  const label = String(record.prediction.decision.confidenceLabel ?? "").trim().toUpperCase();
  if (label.includes("ELITE")) return "ELITE";
  if (label.includes("PREMIUM")) return "PREMIUM";
  if (label.includes("LEAN")) return "LEAN";
  const signal = record.prediction.decision.signal;
  if (signal === "BET_FUERTE") return "ELITE";
  if (signal === "BET") return "PREMIUM";
  if (signal === "LEAN") return "LEAN";
  if (signal === "PASS") return "PASS";
  return "INFO";
}

function dispositionFor(record: LedgerRecord): MlbShadowDisposition {
  const signal = record.prediction.decision.signal;
  if (signal === "BET" || signal === "BET_FUERTE") return "ACCEPTED";
  if (signal === "PASS") return "BLOCKED";
  return "OBSERVED";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function extractFilterReasons(record: LedgerRecord, disposition: MlbShadowDisposition): string[] {
  const payload = record.prediction.payload as any;
  const analysis = payload?.analysis ?? {};
  const rawOutput = analysis?.rawOutput ?? {};
  const layers = analysis?.layers ?? {};
  const candidates = [
    ...stringArray(analysis?.warnings),
    ...stringArray(rawOutput?.filterReasons),
    ...stringArray(rawOutput?.blockedReasons),
    ...stringArray(rawOutput?.reasons),
    ...stringArray(layers?.filterReasons),
    ...stringArray(layers?.blockedReasons),
    ...stringArray(layers?.guardrails?.reasons),
  ];
  const explicit = [
    rawOutput?.blockedReason,
    layers?.blockedReason,
    layers?.guardrails?.blockedReason,
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const unique = [...new Set([...candidates, ...explicit])];
  if (unique.length) return unique;
  if (disposition === "BLOCKED") return ["SIGNAL_PASS"];
  if (disposition === "OBSERVED") return [`SIGNAL_${record.prediction.decision.signal}`];
  return [];
}

function buildFingerprint(record: LedgerRecord): string {
  const prediction = record.prediction;
  const payload = prediction.payload as any;
  const basis = stableValue({
    version: MLB_SHADOW_FINGERPRINT_VERSION,
    game: {
      gamePk: prediction.game.gamePk ?? null,
      gameDate: prediction.game.gameDate,
      homeTeam: normalizedText(prediction.game.homeTeam),
      awayTeam: normalizedText(prediction.game.awayTeam),
    },
    market: {
      type: prediction.market.type,
      selection: normalizedText(prediction.market.selection),
      line: finiteOrNull(prediction.market.line),
      oddsAmerican: prediction.market.oddsAmerican,
      book: normalizedText(prediction.market.book),
    },
    model: {
      name: normalizedText(prediction.model.name),
      version: normalizedText(prediction.model.version),
      gitCommit: normalizedText(prediction.model.gitCommit),
      probability: prediction.probabilities.model,
      marketImplied: finiteOrNull(prediction.probabilities.marketImplied),
      edgePp: finiteOrNull(prediction.probabilities.edgePp),
    },
    decision: {
      signal: prediction.decision.signal,
      category: categoryFor(record),
      stakeUnits: prediction.decision.stakeUnits,
    },
    evidence: {
      factors: payload?.analysis?.factors ?? [],
      sources: payload?.analysis?.sources ?? [],
      layers: payload?.analysis?.layers ?? {},
      injuryAudit: payload?.analysis?.injuryAudit ?? null,
      rawOutput: payload?.analysis?.rawOutput ?? null,
    },
  });
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

function outcomeFor(result: string | null): number | null {
  if (result === "WIN") return 1;
  if (result === "LOSS") return 0;
  if (result === "HALF_WIN") return 0.75;
  if (result === "HALF_LOSS") return 0.25;
  return null;
}

function decimalProfitMultiple(odds: number): number {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function simulatedProfit(result: string | null, stake: number, odds: number): number {
  if (!result || stake <= 0) return 0;
  const winProfit = stake * decimalProfitMultiple(odds);
  if (result === "WIN") return round(winProfit);
  if (result === "LOSS") return round(-stake);
  if (result === "HALF_WIN") return round(winProfit / 2);
  if (result === "HALF_LOSS") return round(-stake / 2);
  return 0;
}

function properScores(probability: number, outcome: number | null) {
  if (outcome == null) return { brierScore: null, logLoss: null };
  const p = Math.min(0.999999, Math.max(0.000001, probability));
  return {
    brierScore: round((p - outcome) ** 2, 6),
    logLoss: round(-(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p)), 6),
  };
}

function qualityFor(record: LedgerRecord) {
  const payload = record.prediction.payload as any;
  const capturedAt = payload?.market?.capturedAt ?? payload?.analysis?.sources?.[0]?.fetchedAt ?? null;
  const checks: Array<[string, boolean]> = [
    ["gamePk", Number.isInteger(record.prediction.game.gamePk)],
    ["commenceTime", Boolean(record.prediction.game.commenceTime)],
    ["marketCapturedAt", Boolean(capturedAt)],
    ["marketImpliedProbability", finiteOrNull(record.prediction.probabilities.marketImplied) != null],
    ["finalScientificSnapshot", record.prediction.analysisStage === "FINAL"],
    ["modelCommit", Boolean(record.prediction.model.gitCommit)],
  ];
  const missing = checks.filter(([, passed]) => !passed).map(([name]) => name);
  const passed = checks.length - missing.length;
  return {
    checks: checks.length,
    passed,
    coveragePct: round((passed / checks.length) * 100, 2),
    missing,
  };
}

function rowFrom(record: LedgerRecord, originalId: string | null): MlbShadowRow {
  const result = record.settlement?.result ?? null;
  const outcomeValue = outcomeFor(result);
  const scores = properScores(record.prediction.probabilities.model, outcomeValue);
  const disposition = dispositionFor(record);
  const stake = Math.max(0, finiteOrNull(record.prediction.decision.stakeUnits) ?? 0);
  const fingerprint = buildFingerprint(record);
  return {
    predictionId: record.prediction.id,
    recordedAt: record.prediction.recordedAt,
    gameDate: record.prediction.game.gameDate,
    gamePk: record.prediction.game.gamePk ?? null,
    homeTeam: record.prediction.game.homeTeam,
    awayTeam: record.prediction.game.awayTeam,
    marketType: record.prediction.market.type,
    selection: record.prediction.market.selection,
    line: finiteOrNull(record.prediction.market.line),
    oddsAmerican: record.prediction.market.oddsAmerican,
    book: record.prediction.market.book ?? null,
    modelName: record.prediction.model.name,
    modelVersion: record.prediction.model.version,
    modelCommit: record.prediction.model.gitCommit ?? null,
    modelProbability: record.prediction.probabilities.model,
    marketImpliedProbability: finiteOrNull(record.prediction.probabilities.marketImplied),
    edgePp: finiteOrNull(record.prediction.probabilities.edgePp),
    signal: record.prediction.decision.signal,
    category: categoryFor(record),
    disposition,
    filterReasons: extractFilterReasons(record, disposition),
    recommendedStakeUnits: stake,
    analysisStage: record.prediction.analysisStage,
    result,
    settledAt: record.settlement?.settledAt ?? null,
    outcomeValue,
    flatProfitUnits: simulatedProfit(result, result ? 1 : 0, record.prediction.market.oddsAmerican),
    policyProfitUnits: simulatedProfit(result, stake, record.prediction.market.oddsAmerican),
    brierScore: scores.brierScore,
    logLoss: scores.logLoss,
    clvPp: finiteOrNull(record.settlement?.clvPp),
    fingerprint,
    analyticalDuplicate: Boolean(originalId),
    analyticalDuplicateOfPredictionId: originalId,
    dataQuality: qualityFor(record),
  };
}

function allRows(records: LedgerRecord[]): MlbShadowRow[] {
  const ordered = [...records].sort((left, right) =>
    left.prediction.recordedAtMs - right.prediction.recordedAtMs
    || left.prediction.id.localeCompare(right.prediction.id),
  );
  const firstByFingerprint = new Map<string, string>();
  return ordered.map((record) => {
    const fingerprint = buildFingerprint(record);
    const originalId = firstByFingerprint.get(fingerprint) ?? null;
    if (!originalId) firstByFingerprint.set(fingerprint, record.prediction.id);
    return rowFrom(record, originalId);
  });
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null;
}

function metrics(rows: MlbShadowRow[]): ShadowMetrics {
  const settled = rows.filter((row) => row.result != null);
  const scored = settled.filter((row) => row.outcomeValue != null);
  const wins = settled.filter((row) => row.result === "WIN" || row.result === "HALF_WIN").length;
  const losses = settled.filter((row) => row.result === "LOSS" || row.result === "HALF_LOSS").length;
  const flatProfitUnits = settled.reduce((sum, row) => sum + row.flatProfitUnits, 0);
  const flatStakedUnits = settled.length;
  const policyRows = settled.filter((row) => row.recommendedStakeUnits > 0);
  const policyProfitUnits = policyRows.reduce((sum, row) => sum + row.policyProfitUnits, 0);
  const policyStakedUnits = policyRows.reduce((sum, row) => sum + row.recommendedStakeUnits, 0);
  return {
    total: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    wins,
    losses,
    pushesOrVoids: settled.length - wins - losses,
    hitRatePct: wins + losses > 0 ? round((wins / (wins + losses)) * 100, 2) : 0,
    flatProfitUnits: round(flatProfitUnits),
    flatStakedUnits: round(flatStakedUnits),
    flatRoiPct: flatStakedUnits > 0 ? round((flatProfitUnits / flatStakedUnits) * 100, 2) : 0,
    policyProfitUnits: round(policyProfitUnits),
    policyStakedUnits: round(policyStakedUnits),
    policyRoiPct: policyStakedUnits > 0 ? round((policyProfitUnits / policyStakedUnits) * 100, 2) : 0,
    brierScore: average(scored.map((row) => row.brierScore as number)),
    logLoss: average(scored.map((row) => row.logLoss as number)),
    averageClvPp: average(settled.filter((row) => row.clvPp != null).map((row) => row.clvPp as number)),
    averageModelProbabilityPct: average(rows.map((row) => row.modelProbability * 100)),
    averageEdgePp: average(rows.filter((row) => row.edgePp != null).map((row) => row.edgePp as number)),
  };
}

function probabilityBand(probability: number): string {
  if (probability < 0.55) return "P_LT_55";
  if (probability < 0.60) return "P_55_60";
  if (probability < 0.65) return "P_60_65";
  return "P_GE_65";
}

function grouped(rows: MlbShadowRow[], keyFor: (row: MlbShadowRow) => string) {
  const groups = new Map<string, MlbShadowRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, metrics(values)]));
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100, 2) : 0;
}

function gateFor(rows: MlbShadowRow[], summary: ShadowMetrics) {
  const closingCoveragePct = percentage(rows.filter((row) => row.clvPp != null).length, rows.filter((row) => row.result != null).length);
  const marketImpliedCoveragePct = percentage(rows.filter((row) => row.marketImpliedProbability != null).length, rows.length);
  const finalSnapshotCoveragePct = percentage(rows.filter((row) => row.analysisStage === "FINAL").length, rows.length);
  const reasons: string[] = [];

  const mature = summary.settled >= GATE_POLICY.minimumSettled;
  const severePerformance = mature && (
    (summary.flatRoiPct <= GATE_POLICY.severeNegativeRoiPct && (summary.brierScore ?? 0) >= GATE_POLICY.severeBrierScore)
    || (summary.averageClvPp ?? 0) <= GATE_POLICY.severeClvPp
  );

  let status: MlbShadowGateStatus = "GO_REVIEW";
  if (severePerformance) {
    status = "NO_GO";
    reasons.push("La muestra madura presenta múltiples señales negativas de rendimiento o calibración.");
  } else {
    if (!mature) reasons.push(`Solo ${summary.settled} decisiones liquidadas; se requieren ${GATE_POLICY.minimumSettled}.`);
    if (marketImpliedCoveragePct < GATE_POLICY.minimumMarketImpliedCoveragePct) reasons.push(`Cobertura de probabilidad implícita ${marketImpliedCoveragePct}% por debajo de ${GATE_POLICY.minimumMarketImpliedCoveragePct}%.`);
    if (closingCoveragePct < GATE_POLICY.minimumClosingCoveragePct) reasons.push(`Cobertura de closing line ${closingCoveragePct}% por debajo de ${GATE_POLICY.minimumClosingCoveragePct}%.`);
    if (finalSnapshotCoveragePct < GATE_POLICY.minimumFinalSnapshotCoveragePct) reasons.push(`Cobertura de snapshots FINAL ${finalSnapshotCoveragePct}% por debajo de ${GATE_POLICY.minimumFinalSnapshotCoveragePct}%.`);
    if (reasons.length) status = "EXTEND";
  }

  if (status === "GO_REVIEW") reasons.push("La muestra cumple los mínimos técnicos; requiere revisión humana antes de cualquier promoción.");
  return {
    status,
    reasons,
    policy: { ...GATE_POLICY },
    coverage: { closingCoveragePct, marketImpliedCoveragePct, finalSnapshotCoveragePct },
    automaticPromotion: false,
    formulasChanged: false,
    thresholdsChanged: false,
    stakePolicyChanged: false,
  };
}

export function buildMlbShadowRows(records: LedgerRecord[]): MlbShadowRow[] {
  return allRows(records).filter((row) => !row.analyticalDuplicate);
}

export function buildMlbShadowEvaluation(records: LedgerRecord[]) {
  const ledgerRows = allRows(records);
  const rows = ledgerRows.filter((row) => !row.analyticalDuplicate);
  const duplicates = ledgerRows.filter((row) => row.analyticalDuplicate);
  const summary = metrics(rows);
  const averageQualityCoveragePct = average(rows.map((row) => row.dataQuality.coveragePct));
  const missingFieldCounts: Record<string, number> = {};
  for (const row of rows) {
    for (const field of row.dataQuality.missing) missingFieldCounts[field] = (missingFieldCounts[field] ?? 0) + 1;
  }

  return {
    schemaVersion: MLB_SHADOW_EVALUATION_VERSION,
    generatedAt: new Date().toISOString(),
    mode: "SHADOW" as const,
    execution: {
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
    },
    methodology: {
      fingerprintVersion: MLB_SHADOW_FINGERPRINT_VERSION,
      immutableSource: "mlb-ledger.v1",
      flatAccounting: "Every settled unique decision is simulated at one unit using saved American odds.",
      policyAccounting: "Recommended stake is simulated analytically only; no wager is placed.",
      scoring: "Brier score and log loss use the immutable settlement classification and saved pregame model probability.",
      acceptedBlockedSeparation: true,
      formulasChanged: false,
    },
    deduplication: {
      ledgerRecords: ledgerRows.length,
      uniqueAnalyticalDecisions: rows.length,
      duplicatesExcluded: duplicates.length,
      duplicatePredictionIds: duplicates.map((row) => row.predictionId),
    },
    summary,
    breakdowns: {
      byMarket: grouped(rows, (row) => row.marketType),
      byCategory: grouped(rows, (row) => row.category),
      byDisposition: grouped(rows, (row) => row.disposition),
      byProbabilityBand: grouped(rows, (row) => probabilityBand(row.modelProbability)),
    },
    dataQuality: {
      averageCoveragePct: averageQualityCoveragePct,
      fullyCovered: rows.filter((row) => row.dataQuality.missing.length === 0).length,
      incomplete: rows.filter((row) => row.dataQuality.missing.length > 0).length,
      missingFieldCounts,
    },
    decisionGate: gateFor(rows, summary),
    rows,
  };
}

export type MlbShadowEvaluation = ReturnType<typeof buildMlbShadowEvaluation>;
