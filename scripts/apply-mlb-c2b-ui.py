from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


predictor = Path("frontend/client/src/pages/mlb-predictor.tsx")
text = predictor.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''        layers: {
          factorBreakdown: result.factorBreakdown,
          pickQualities: result.pickQualities,
          bestPlay: result.bestPlay,
          safePlay: result.safePlay,
          poisson: result.poisson,
        },
''',
    '''        layers: {
          factorBreakdown: result.factorBreakdown,
          injuryEffect: {
            schemaVersion: "mlb-injury-effect.v1",
            source: "COUNTERFACTUAL_RECALCULATION_V1",
            scope: "HOME_ML_AND_GAME_TOTAL_COUNTERFACTUAL",
            homeProbabilityDeltaPp: injuryProbDelta,
            totalRunsDelta: injuryTotalDelta,
            dataQuality: injuryDataQuality,
            hasAppliedAdjustment: hasInjuries,
          },
          pickQualities: result.pickQualities,
          bestPlay: result.bestPlay,
          safePlay: result.safePlay,
          poisson: result.poisson,
        },
''',
    "predictor injury effect layer",
)
predictor.write_text(text, encoding="utf-8")

history = Path("frontend/client/src/pages/mlb-history.tsx")
ui = history.read_text(encoding="utf-8")

interface_anchor = '''interface LedgerHistoryPick {
'''
interface_block = '''interface InjuryOutcomeMetricSummary {
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

'''
if interface_anchor not in ui:
    raise SystemExit("history interface anchor missing")
ui = ui.replace(interface_anchor, interface_block + interface_anchor, 1)

query_anchor = '''  const ledgerHistory = historyQuery.data;
  const injuryReport = injuryReportQuery.data;
'''
query_block = '''  const injuryOutcomesQuery = useQuery({
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
'''
ui = replace_once(ui, query_anchor, query_block, "history C2B query")

ui = replace_once(
    ui,
    '''  const refreshAll = () => {
    void Promise.all([historyQuery.refetch(), injuryReportQuery.refetch()]);
  };
''',
    '''  const refreshAll = () => {
    void Promise.all([historyQuery.refetch(), injuryReportQuery.refetch(), injuryOutcomesQuery.refetch()]);
  };
''',
    "history refresh all",
)

panel_anchor = '''      {marketStats.length > 0 && (
'''
panel = '''      <Card className="border-violet-500/30 bg-violet-500/5">
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
                {[
                  ["Autoaplicadas", injuryOutcomes.cohorts.AUTO_APPLIED],
                  ["Retenidas", injuryOutcomes.cohorts.RETAINED],
                  ["Sin autoajuste", injuryOutcomes.cohorts.NO_AUTO_ADJUSTMENT],
                  ["Cobertura parcial", injuryOutcomes.cohorts.PARTIAL_COVERAGE],
                ].map(([label, raw]) => {
                  const cohort = raw as InjuryOutcomeMetricSummary;
                  return (
                    <div key={String(label)} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
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

'''
if panel_anchor not in ui:
    raise SystemExit("history market panel anchor missing")
ui = ui.replace(panel_anchor, panel + panel_anchor, 1)
history.write_text(ui, encoding="utf-8")
