import { useQuery } from "@tanstack/react-query";
import { useAppContext } from "@/lib/context";
import { fetchJson } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, RefreshCw, ShieldCheck, Trash2, Trophy } from "lucide-react";

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

function signalColor(result: string) {
  if (result === "W") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (result === "L") return "bg-red-500/20 text-red-400 border-red-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

function signedRuns(value: number) {
  if (Math.abs(value) < 0.0001) return "0.00";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

export default function MLBHistory() {
  const { state, dispatch } = useAppContext();
  const picks = state.mlbPicks;
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
  const injuryReport = injuryReportQuery.data;

  const resolved = picks.filter((p) => p.result !== "P");
  const wins = resolved.filter((p) => p.result === "W").length;
  const losses = resolved.filter((p) => p.result === "L").length;
  const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
  const totalProfit = picks.reduce((s, p) => s + p.profit, 0);
  const totalStaked = resolved.reduce((s, p) => s + p.stake, 0);
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

  const markets = ["ML", "F5", "Run Line", "O/U", "F5 O/U"];
  const marketStats = markets.map((m) => {
    const mp = picks.filter((p) => p.market === m);
    const mr = mp.filter((p) => p.result !== "P");
    const mw = mr.filter((p) => p.result === "W").length;
    const mProfit = mp.reduce((s, p) => s + p.profit, 0);
    return { market: m, total: mp.length, wins: mw, resolved: mr.length, winRate: mr.length > 0 ? (mw / mr.length) * 100 : 0, profit: mProfit };
  }).filter((m) => m.total > 0);

  const progressPct = injuryReport
    ? Math.min(100, (injuryReport.readiness.settledAuditedPicks / injuryReport.readiness.targetSettledAuditedPicks) * 100)
    : 0;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-3">
        <Trophy className="h-5 w-5 text-amber-400" />
        <h1 className="text-xl font-display font-bold">Historial MLB</h1>
        <Badge variant="outline" className="ml-auto">{picks.length} picks</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="bg-blue-500/10 border-blue-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Total Picks</p>
            <p className="text-2xl font-bold text-blue-400">{picks.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-green-500/10 border-green-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Ganados</p>
            <p className="text-2xl font-bold text-green-400">{wins}</p>
          </CardContent>
        </Card>
        <Card className="bg-red-500/10 border-red-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Perdidos</p>
            <p className="text-2xl font-bold text-red-400">{losses}</p>
          </CardContent>
        </Card>
        <Card className={`${winRate >= 55 ? "bg-green-500/10 border-green-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-2xl font-bold ${winRate >= 55 ? "text-green-400" : "text-amber-400"}`}>{winRate.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card className={`${totalProfit >= 0 ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">G/P Total</p>
            <p className={`text-2xl font-bold ${totalProfit >= 0 ? "text-green-400" : "text-red-400"}`}>${totalProfit.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">ROI: {roi.toFixed(1)}%</p>
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
              onClick={() => injuryReportQuery.refetch()}
              disabled={injuryReportQuery.isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${injuryReportQuery.isFetching ? "animate-spin" : ""}`} />
              Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {injuryReportQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Cargando reporte del ledger…</p>
          )}
          {injuryReportQuery.isError && (
            <p className="text-sm text-red-300">No se pudo cargar el reporte de lesiones. Los picks locales permanecen disponibles.</p>
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

      {marketStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Rendimiento por Mercado</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {marketStats.map((m) => (
                <div key={m.market} className="bg-slate-800/50 rounded-lg p-2 text-center">
                  <p className="text-xs text-muted-foreground">{m.market}</p>
                  <p className="text-sm font-bold">{m.wins}/{m.resolved}</p>
                  <p className={`text-xs ${m.winRate >= 55 ? "text-green-400" : m.winRate >= 45 ? "text-amber-400" : "text-red-400"}`}>
                    {m.winRate.toFixed(0)}% · ${m.profit.toFixed(0)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {picks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No hay picks MLB guardados. Ve al Predictor MLB y guarda tus jugadas.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {[...picks].reverse().map((pick) => (
            <Card key={pick.id} className={`border-l-4 ${pick.result === "W" ? "border-l-green-500" : pick.result === "L" ? "border-l-red-500" : "border-l-amber-500"}`}>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={`${signalColor(pick.result)} text-xs`}>{pick.result}</Badge>
                  <span className="text-xs text-muted-foreground">{pick.date}</span>
                  <span className="text-sm font-medium">{pick.team} vs {pick.opponent}</span>
                  <Badge variant="outline" className="text-xs">{pick.market}</Badge>
                  <span className="text-xs text-muted-foreground ml-auto">{pick.pick}</span>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs">
                  <span>Cuota: {pick.odds > 0 ? "+" : ""}{pick.odds}</span>
                  <span>Modelo: {pick.modelProb.toFixed(1)}%</span>
                  <span>Edge: {pick.edge > 0 ? "+" : ""}{pick.edge.toFixed(1)}%</span>
                  <span>Stake: ${pick.stake.toFixed(2)}</span>
                  <span className={pick.profit >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {pick.profit >= 0 ? "+" : ""}${pick.profit.toFixed(2)}
                  </span>

                  {pick.result === "P" && (
                    <Select onValueChange={(val) => dispatch({ type: "UPDATE_MLB_PICK", payload: { id: pick.id, result: val } })}>
                      <SelectTrigger className="w-20 h-6 text-xs">
                        <SelectValue placeholder="Resultado" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="W">W</SelectItem>
                        <SelectItem value="L">L</SelectItem>
                      </SelectContent>
                    </Select>
                  )}

                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400 ml-auto"
                    onClick={() => dispatch({ type: "DELETE_MLB_PICK", payload: pick.id })}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
