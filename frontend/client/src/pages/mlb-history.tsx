import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/lib/context";
import { fetchJson } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Database, LockKeyhole, RefreshCw, ShieldCheck, Trophy } from "lucide-react";

interface InjuryCalibrationReport {
  schemaVersion: "mlb-injury-calibration-report.v1";
  generatedAt: string;
  readiness: {
    targetSettledAuditedPicks: number;
    settledAuditedPicks: number;
    remaining: number;
    readyForExpansion: boolean;
  };
  sample: {
    totalPredictions: number;
    auditedPredictions: number;
    legacyPredictionsWithoutAudit: number;
    settledAuditedPredictions: number;
    pendingAuditedPredictions: number;
    uniqueAuditContexts: number;
    duplicateMarketSnapshotsExcluded: number;
  };
  coverage: {
    teamContexts: number;
    full: number;
    partial: number;
    blocked: number;
    fullPct: number;
    partialPct: number;
    blockedPct: number;
  };
  decisions: {
    detected: number;
    candidates: number;
    backendEligible: number;
    autoApplied: number;
    retained: number;
    rejected: number;
    officialOnly: number;
    manualOverrideTeams: number;
    bullpenBlockedTeams: number;
  };
  adjustments: {
    teamsWithAutomaticAdjustment: number;
    teamsWithAnyFinalAdjustment: number;
    totalRawRuns: number;
    totalScaledRuns: number;
    totalFinalRuns: number;
    averageAbsRawRuns: number;
    averageAbsScaledRuns: number;
    averageAbsFinalRuns: number;
    maxAbsFinalRuns: number;
  };
  cohorts: {
    contextsWithAutoApplied: number;
    contextsWithRetained: number;
    contextsWithManualOverride: number;
    contextsWithBullpenBlock: number;
    contextsWithFullCoverage: number;
    contextsWithPartialCoverage: number;
    contextsWithBlockedCoverage: number;
  };
}

interface InjuryOutcomeMetricSummary {
  total: number;
  pending: number;
  settled: number;
  scored: number;
  wins: number;
  losses: number;
  pushesOrVoids: number;
  profitUnits: number;
  stakedUnits: number;
  roiPct: number;
  winRatePct: number;
  averageModelProbabilityPct: number | null;
  brierScore: number | null;
  logLoss: number | null;
  averageClvPp: number | null;
  effectAvailable: number;
  effectUnavailable: number;
  averageHomeProbabilityDeltaPp: number | null;
  averageTotalRunsDelta: number | null;
}

interface InjuryOutcomesReport {
  schemaVersion: "mlb-injury-outcomes-report.v1";
  generatedAt: string;
  methodology: {
    scoring: string;
    cohortsOverlap: boolean;
    probabilityEffectScope: string;
    formulasChanged: false;
  };
  summary: InjuryOutcomeMetricSummary;
  cohorts: Record<string, InjuryOutcomeMetricSummary & { key: string }>;
  recentSettled: Array<{
    predictionId: string;
    gameDate: string;
    homeTeam: string;
    awayTeam: string;
    marketType: string;
    selection: string;
    modelProbability: number;
    result: string | null;
    profitUnits: number;
    coverage: "FULL" | "PARTIAL" | "BLOCKED";
    autoApplied: boolean;
    retained: boolean;
    effect: {
      available: boolean;
      source: string;
      homeProbabilityDeltaPp: number | null;
      totalRunsDelta: number | null;
    };
  }>;
}

interface LedgerHistoryPick {
  id: string;
  clientRequestId: string | null;
  recordedAt: string;
  gameDate: string;
  commenceTime: string | null;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  marketLabel: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  book: string | null;
  modelProbabilityPct: number;
  marketImpliedProbabilityPct: number;
  edgePp: number;
  signal: string;
  confidenceLabel: string | null;
  stakeUnits: number;
  analysisStage: string;
  modelVersion: string;
  result: string;
  settlementResult: string | null;
  settledAt: string | null;
  profitUnits: number;
  closingOddsAmerican: number | null;
  clvPp: number | null;
  finalScore: { home: number; away: number } | null;
  immutable: true;
  hasInjuryAudit: boolean;
}

interface LedgerHistoryView {
  schemaVersion: "mlb-ledger-history-view.v1";
  generatedAt: string;
  source: "immutable-ledger";
  summary: {
    total: number;
    pending: number;
    settled: number;
    wins: number;
    losses: number;
    pushes: number;
    voids: number;
    winRatePct: number;
    totalProfitUnits: number;
    totalStakedUnits: number;
    roiPct: number;
  };
  marketStats: Array<{
    marketType: string;
    marketLabel: string;
    total: number;
    pending: number;
    wins: number;
    losses: number;
    settled: number;
    profitUnits: number;
    winRatePct: number;
  }>;
  picks: LedgerHistoryPick[];
}

function resultColor(result: string) {
  if (result === "W" || result === "½W") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (result === "L" || result === "½L") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (result === "PUSH" || result === "VOID") return "bg-slate-500/20 text-slate-300 border-slate-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

function resultLabel(result: string) {
  if (result === "PENDING") return "Pendiente";
  return result;
}

function signedRuns(value: number) {
  if (Math.abs(value) < 0.0001) return "0.00";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function signedUnits(value: number) {
  if (Math.abs(value) < 0.0001) return "0.00 u";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} u`;
}

export default function MLBHistory() {
  const { state } = useAppContext();
  const localPicks = state.mlbPicks;

  const historyQuery = useQuery({
    queryKey: ["mlb-ledger-history"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: LedgerHistoryView }>(
        "/api/mlb/ledger/v1/history?limit=10000",
      );
      return response.data;
    },
    staleTime: 15_000,
    refetchOnMount: "always",
  });

  const injuryReportQuery = useQuery({
    queryKey: ["mlb-injury-calibration-report"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: InjuryCalibrationReport }>(
        "/api/mlb/ledger/v1/injury-report?targetSettled=20",
      );
      return response.data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const injuryOutcomesQuery = useQuery({
    queryKey: ["mlb-injury-outcomes-report"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: InjuryOutcomesReport }>(
        "/api/mlb/ledger/v1/injury-outcomes?limit=10000",
      );
      return response.data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const ledgerHistory = historyQuery.data;
  const injuryReport = injuryReportQuery.data;
  const injuryOutcomes = injuryOutcomesQuery.data;
  const usingLedger = Boolean(ledgerHistory);

  const fallbackResolved = localPicks.filter((pick) => pick.result !== "P");
  const fallbackWins = fallbackResolved.filter((pick) => pick.result === "W").length;
  const fallbackLosses = fallbackResolved.filter((pick) => pick.result === "L").length;
  const fallbackProfit = localPicks.reduce((sum, pick) => sum + pick.profit, 0);
  const fallbackStaked = fallbackResolved.reduce((sum, pick) => sum + pick.stake, 0);

  const summary = ledgerHistory?.summary || {
    total: localPicks.length,
    pending: localPicks.filter((pick) => pick.result === "P").length,
    settled: fallbackResolved.length,
    wins: fallbackWins,
    losses: fallbackLosses,
    pushes: 0,
    voids: 0,
    winRatePct: fallbackWins + fallbackLosses > 0 ? (fallbackWins / (fallbackWins + fallbackLosses)) * 100 : 0,
    totalProfitUnits: fallbackProfit,
    totalStakedUnits: fallbackStaked,
    roiPct: fallbackStaked > 0 ? (fallbackProfit / fallbackStaked) * 100 : 0,
  };

  const fallbackMarketStats = ["ML", "F5", "Run Line", "O/U", "F5 O/U"]
    .map((marketLabel) => {
      const items = localPicks.filter((pick) => pick.market === marketLabel);
      const settled = items.filter((pick) => pick.result !== "P");
      const wins = settled.filter((pick) => pick.result === "W").length;
      return {
        marketType: marketLabel,
        marketLabel,
        total: items.length,
        pending: items.length - settled.length,
        wins,
        losses: settled.filter((pick) => pick.result === "L").length,
        settled: settled.length,
        profitUnits: items.reduce((sum, pick) => sum + pick.profit, 0),
        winRatePct: settled.length > 0 ? (wins / settled.length) * 100 : 0,
      };
    })
    .filter((market) => market.total > 0);

  const marketStats = ledgerHistory?.marketStats || fallbackMarketStats;
  const displayPicks: LedgerHistoryPick[] = ledgerHistory?.picks || [...localPicks].reverse().map((pick) => ({
    id: String(pick.id),
    clientRequestId: pick.serverId || null,
    recordedAt: pick.date,
    gameDate: pick.date,
    commenceTime: null,
    gamePk: null,
    homeTeam: pick.team,
    awayTeam: pick.opponent,
    marketType: pick.market,
    marketLabel: pick.market,
    selection: pick.pick,
    line: null,
    oddsAmerican: pick.odds,
    book: null,
    modelProbabilityPct: pick.modelProb,
    marketImpliedProbabilityPct: pick.impliedProb,
    edgePp: pick.edge,
    signal: "LOCAL",
    confidenceLabel: null,
    stakeUnits: pick.stake,
    analysisStage: "LOCAL",
    modelVersion: "legacy-local",
    result: pick.result === "P" ? "PENDING" : pick.result,
    settlementResult: pick.result === "P" ? null : pick.result,
    settledAt: null,
    profitUnits: pick.profit,
    closingOddsAmerican: pick.closingOdds ?? null,
    clvPp: pick.clvPercent ?? null,
    finalScore: null,
    immutable: true,
    hasInjuryAudit: Boolean(pick.scientificSnapshot?.analysis?.injuryAudit),
  }));

  const progressPct = injuryReport
    ? Math.min(100, (injuryReport.readiness.settledAuditedPicks / injuryReport.readiness.targetSettledAuditedPicks) * 100)
    : 0;

  const refreshAll = () => {
    void Promise.all([historyQuery.refetch(), injuryReportQuery.refetch(), injuryOutcomesQuery.refetch()]);
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-3">
        <Trophy className="h-5 w-5 text-amber-400" />
        <h1 className="text-xl font-display font-bold">Historial MLB</h1>
        <Badge variant="outline" className="ml-auto flex items-center gap-1.5">
          {usingLedger ? <Database className="h-3 w-3" /> : null}
          {summary.total} picks{usingLedger ? " · Ledger" : " · Respaldo local"}
        </Badge>
      </div>

      {historyQuery.isError && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3 text-sm text-amber-200">
            No se pudo consultar el ledger. Se muestra temporalmente el historial local de este navegador.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="bg-blue-500/10 border-blue-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Total Picks</p>
            <p className="text-2xl font-bold text-blue-400">{summary.total}</p>
            <p className="text-[10px] text-muted-foreground">{summary.pending} pendientes</p>
          </CardContent>
        </Card>
        <Card className="bg-green-500/10 border-green-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Ganados</p>
            <p className="text-2xl font-bold text-green-400">{summary.wins}</p>
          </CardContent>
        </Card>
        <Card className="bg-red-500/10 border-red-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Perdidos</p>
            <p className="text-2xl font-bold text-red-400">{summary.losses}</p>
          </CardContent>
        </Card>
        <Card className={`${summary.winRatePct >= 55 ? "bg-green-500/10 border-green-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-2xl font-bold ${summary.winRatePct >= 55 ? "text-green-400" : "text-amber-400"}`}>{summary.winRatePct.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card className={`${summary.totalProfitUnits >= 0 ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">G/P Total</p>
            <p className={`text-2xl font-bold ${summary.totalProfitUnits >= 0 ? "text-green-400" : "text-red-400"}`}>{signedUnits(summary.totalProfitUnits)}</p>
            <p className="text-xs text-muted-foreground">ROI: {summary.roiPct.toFixed(1)}%</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-cyan-500/30 bg-cyan-500/5">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-cyan-300 mt-0.5" />
            <div>
              <CardTitle className="text-sm text-cyan-100">Calibración automática de lesiones · Fase C2A</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">Lee las auditorías C1 del ledger sin modificar predicciones ni fórmulas.</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1 text-xs"
              onClick={refreshAll}
              disabled={injuryReportQuery.isFetching || historyQuery.isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${injuryReportQuery.isFetching || historyQuery.isFetching ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {injuryReportQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Cargando reporte del ledger…</p>
          )}
          {injuryReportQuery.isError && (
            <p className="text-sm text-red-300">No se pudo cargar el reporte de lesiones. El historial del ledger permanece disponible.</p>
          )}
          {injuryReport && (
            <>
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">Muestra liquidada para ampliar automatización</span>
                  <span className={injuryReport.readiness.readyForExpansion ? "text-green-300 font-semibold" : "text-cyan-200 font-semibold"}>
                    {injuryReport.readiness.settledAuditedPicks}/{injuryReport.readiness.targetSettledAuditedPicks}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div className="h-full bg-cyan-400 transition-all" style={{ width: `${progressPct}%` }} />
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {injuryReport.readiness.readyForExpansion
                    ? "Muestra mínima alcanzada; todavía requiere revisión técnica antes de ampliar reglas."
                    : `Faltan ${injuryReport.readiness.remaining} picks C1 liquidados para la primera revisión.`}
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  ["Picks auditados", injuryReport.sample.auditedPredictions],
                  ["Contextos únicos", injuryReport.sample.uniqueAuditContexts],
                  ["Autoaplicados", injuryReport.decisions.autoApplied],
                  ["Retenidos", injuryReport.decisions.retained],
                  ["Solo en MLB", injuryReport.decisions.officialOnly],
                  ["Overrides", injuryReport.decisions.manualOverrideTeams],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border border-cyan-500/20 bg-slate-950/40 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className="text-lg font-bold text-cyan-100">{value}</p>
                  </div>
                ))}
              </div>

              <div className="grid md:grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg bg-slate-900/60 p-3">
                  <p className="font-semibold text-cyan-200 mb-2">Cobertura de fuentes</p>
                  <div className="space-y-1 text-muted-foreground">
                    <p>FULL: <span className="text-green-300">{injuryReport.coverage.full} ({injuryReport.coverage.fullPct.toFixed(1)}%)</span></p>
                    <p>PARTIAL: <span className="text-amber-300">{injuryReport.coverage.partial} ({injuryReport.coverage.partialPct.toFixed(1)}%)</span></p>
                    <p>BLOCKED: <span className="text-red-300">{injuryReport.coverage.blocked} ({injuryReport.coverage.blockedPct.toFixed(1)}%)</span></p>
                  </div>
                </div>
                <div className="rounded-lg bg-slate-900/60 p-3">
                  <p className="font-semibold text-cyan-200 mb-2">Decisiones automáticas</p>
                  <div className="space-y-1 text-muted-foreground">
                    <p>Detectados: <span className="text-foreground">{injuryReport.decisions.detected}</span></p>
                    <p>Candidatos: <span className="text-foreground">{injuryReport.decisions.candidates}</span></p>
                    <p>Elegibles backend: <span className="text-foreground">{injuryReport.decisions.backendEligible}</span></p>
                    <p>Bloqueos bullpen: <span className="text-foreground">{injuryReport.decisions.bullpenBlockedTeams}</span></p>
                  </div>
                </div>
                <div className="rounded-lg bg-slate-900/60 p-3">
                  <p className="font-semibold text-cyan-200 mb-2">Ajuste de carreras</p>
                  <div className="space-y-1 text-muted-foreground">
                    <p>Promedio automático: <span className="text-foreground">{injuryReport.adjustments.averageAbsScaledRuns.toFixed(2)}</span></p>
                    <p>Promedio final: <span className="text-foreground">{injuryReport.adjustments.averageAbsFinalRuns.toFixed(2)}</span></p>
                    <p>Máximo final: <span className="text-foreground">{injuryReport.adjustments.maxAbsFinalRuns.toFixed(2)}</span></p>
                    <p>Neto acumulado: <span className="text-foreground">{signedRuns(injuryReport.adjustments.totalFinalRuns)}</span></p>
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <Activity className="h-4 w-4 text-cyan-300 shrink-0" />
                <p>
                  Se excluyeron {injuryReport.sample.duplicateMarketSnapshotsExcluded} snapshots duplicados de mercado al contar decisiones de lesiones. Así, guardar ML, F5 y total del mismo análisis no infla la calibración.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-violet-500/30 bg-violet-500/5">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <Activity className="h-5 w-5 text-violet-300 mt-0.5" />
            <div>
              <CardTitle className="text-sm text-violet-100">Resultado vs decisiones de lesiones · Fase C2B</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">Relaciona cada liquidación C1 con cobertura, retenciones, autoaplicaciones, unidades y calibración. No cambia fórmulas.</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {injuryOutcomesQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Calculando resultados C2B desde el ledger…</p>
          )}
          {injuryOutcomesQuery.isError && (
            <p className="text-sm text-red-300">No se pudo cargar C2B. El historial y C2A permanecen disponibles.</p>
          )}
          {injuryOutcomes && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  ["C1 liquidados", injuryOutcomes.summary.settled],
                  ["C1 pendientes", injuryOutcomes.summary.pending],
                  ["Brier", injuryOutcomes.summary.brierScore == null ? "—" : injuryOutcomes.summary.brierScore.toFixed(3)],
                  ["Log loss", injuryOutcomes.summary.logLoss == null ? "—" : injuryOutcomes.summary.logLoss.toFixed(3)],
                  ["ROI", `${injuryOutcomes.summary.roiPct.toFixed(1)}%`],
                  ["Efecto medible", `${injuryOutcomes.summary.effectAvailable}/${injuryOutcomes.summary.total}`],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border border-violet-500/20 bg-slate-950/40 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className="text-lg font-bold text-violet-100">{value}</p>
                  </div>
                ))}
              </div>

              {injuryOutcomes.summary.settled === 0 ? (
                <div className="rounded-lg border border-violet-500/20 bg-slate-950/30 p-3 text-sm text-muted-foreground">
                  Aún no hay picks C1 liquidados. C2B ya está listo y comenzará a calcular Brier, log loss, ROI y cohortes cuando terminen los juegos pendientes.
                </div>
              ) : (
                <div className="grid md:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg bg-slate-900/60 p-3">
                    <p className="font-semibold text-violet-200 mb-2">Calibración global</p>
                    <div className="space-y-1 text-muted-foreground">
                      <p>W-L: <span className="text-foreground">{injuryOutcomes.summary.wins}-{injuryOutcomes.summary.losses}</span></p>
                      <p>Unidades: <span className={injuryOutcomes.summary.profitUnits >= 0 ? "text-green-300" : "text-red-300"}>{signedUnits(injuryOutcomes.summary.profitUnits)}</span></p>
                      <p>Brier: <span className="text-foreground">{injuryOutcomes.summary.brierScore?.toFixed(3) ?? "—"}</span></p>
                      <p>Log loss: <span className="text-foreground">{injuryOutcomes.summary.logLoss?.toFixed(3) ?? "—"}</span></p>
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/60 p-3">
                    <p className="font-semibold text-violet-200 mb-2">Impacto contrafactual</p>
                    <div className="space-y-1 text-muted-foreground">
                      <p>Prob. local: <span className="text-foreground">{injuryOutcomes.summary.averageHomeProbabilityDeltaPp == null ? "—" : `${injuryOutcomes.summary.averageHomeProbabilityDeltaPp > 0 ? "+" : ""}${injuryOutcomes.summary.averageHomeProbabilityDeltaPp.toFixed(2)} pp`}</span></p>
                      <p>Total: <span className="text-foreground">{injuryOutcomes.summary.averageTotalRunsDelta == null ? "—" : signedRuns(injuryOutcomes.summary.averageTotalRunsDelta)}</span></p>
                      <p>Con medición: <span className="text-foreground">{injuryOutcomes.summary.effectAvailable}</span></p>
                      <p>Sin medición: <span className="text-foreground">{injuryOutcomes.summary.effectUnavailable}</span></p>
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/60 p-3">
                    <p className="font-semibold text-violet-200 mb-2">Precio de cierre</p>
                    <div className="space-y-1 text-muted-foreground">
                      <p>CLV promedio: <span className="text-foreground">{injuryOutcomes.summary.averageClvPp == null ? "—" : `${injuryOutcomes.summary.averageClvPp > 0 ? "+" : ""}${injuryOutcomes.summary.averageClvPp.toFixed(2)} pp`}</span></p>
                      <p>Prob. media: <span className="text-foreground">{injuryOutcomes.summary.averageModelProbabilityPct?.toFixed(1) ?? "—"}%</span></p>
                      <p>Scored: <span className="text-foreground">{injuryOutcomes.summary.scored}</span></p>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                {([
                  { label: "Autoaplicadas", cohort: injuryOutcomes.cohorts.AUTO_APPLIED },
                  { label: "Retenidas", cohort: injuryOutcomes.cohorts.RETAINED },
                  { label: "Sin autoajuste", cohort: injuryOutcomes.cohorts.NO_AUTO_ADJUSTMENT },
                  { label: "Cobertura parcial", cohort: injuryOutcomes.cohorts.PARTIAL_COVERAGE },
                ] as Array<{ label: string; cohort: InjuryOutcomeMetricSummary }>).map(({ label, cohort }) => {
                  return (
                    <div key={label} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
                      <p className="font-semibold text-violet-200">{label}</p>
                      <p className="text-muted-foreground mt-1">{cohort.settled}/{cohort.total} liquidados</p>
                      <p className="text-muted-foreground">W-L: {cohort.wins}-{cohort.losses} · {signedUnits(cohort.profitUnits)}</p>
                      <p className="text-muted-foreground">Brier: {cohort.brierScore?.toFixed(3) ?? "—"}</p>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-violet-300 shrink-0" />
                <p>Brier y log loss usan la probabilidad pregame guardada y el resultado inmutable. Las cohortes pueden superponerse; C2B observa y no recalibra el predictor automáticamente.</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {marketStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Rendimiento por Mercado</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {marketStats.map((market) => (
                <div key={market.marketType} className="bg-slate-800/50 rounded-lg p-2 text-center">
                  <p className="text-xs text-muted-foreground">{market.marketLabel}</p>
                  <p className="text-sm font-bold">{market.wins}/{market.settled}</p>
                  <p className={`text-xs ${market.winRatePct >= 55 ? "text-green-400" : market.winRatePct >= 45 ? "text-amber-400" : "text-red-400"}`}>
                    {market.winRatePct.toFixed(0)}% · {signedUnits(market.profitUnits)}
                  </p>
                  {market.pending > 0 && <p className="text-[10px] text-amber-300">{market.pending} pendiente(s)</p>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {historyQuery.isLoading && displayPicks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">Cargando historial inmutable del ledger…</p>
          </CardContent>
        </Card>
      ) : displayPicks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No hay picks MLB guardados en el ledger.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {displayPicks.map((pick) => (
            <Card key={pick.id} className={`border-l-4 ${pick.result === "W" || pick.result === "½W" ? "border-l-green-500" : pick.result === "L" || pick.result === "½L" ? "border-l-red-500" : pick.result === "PENDING" ? "border-l-amber-500" : "border-l-slate-500"}`}>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={`${resultColor(pick.result)} text-xs`}>{resultLabel(pick.result)}</Badge>
                  <span className="text-xs text-muted-foreground">{pick.gameDate}</span>
                  <span className="text-sm font-medium">{pick.awayTeam} @ {pick.homeTeam}</span>
                  <Badge variant="outline" className="text-xs">{pick.marketLabel}</Badge>
                  {pick.hasInjuryAudit && <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-300">C1</Badge>}
                  <span className="text-xs text-muted-foreground ml-auto">{pick.selection}</span>
                </div>
                <div className="flex items-center gap-x-4 gap-y-1 mt-2 text-xs flex-wrap">
                  <span>Cuota: {pick.oddsAmerican > 0 ? "+" : ""}{pick.oddsAmerican}</span>
                  <span>Modelo: {pick.modelProbabilityPct.toFixed(1)}%</span>
                  <span>Edge: {pick.edgePp > 0 ? "+" : ""}{pick.edgePp.toFixed(1)} pp</span>
                  <span>Stake: {pick.stakeUnits.toFixed(2)} u</span>
                  {pick.book && <span>Casa: {pick.book}</span>}
                  {pick.finalScore && <span>Final: {pick.finalScore.away}-{pick.finalScore.home}</span>}
                  {pick.result === "PENDING" ? (
                    <span className="text-amber-300 font-semibold">Esperando liquidación</span>
                  ) : (
                    <span className={pick.profitUnits >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                      {signedUnits(pick.profitUnits)}
                    </span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground" title="Registro protegido por el ledger inmutable">
                    <LockKeyhole className="h-3 w-3" /> Inmutable
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
