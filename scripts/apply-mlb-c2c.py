from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

outcomes = Path("server/mlb-injury-outcomes-report.ts")
text = outcomes.read_text(encoding="utf-8")
text = replace_once(text, "type OutcomeRow = {", "export type MlbInjuryOutcomeRow = {", "outcome row export")
text = replace_once(text, "function rowFrom(record: LedgerRecord): OutcomeRow | null {", "function rowFrom(record: LedgerRecord): MlbInjuryOutcomeRow | null {", "rowFrom type")
text = replace_once(text, "function cohortKeys(row: OutcomeRow): CohortKey[] {", "function cohortKeys(row: MlbInjuryOutcomeRow): CohortKey[] {", "cohort row type")
text = replace_once(text, "function summarizeRows(rows: OutcomeRow[]) {", "function summarizeRows(rows: MlbInjuryOutcomeRow[]) {", "summary row type")
text = replace_once(
    text,
    '''export function buildMlbInjuryOutcomesReport(records: LedgerRecord[]) {
  const rows = records.map(rowFrom).filter((row): row is OutcomeRow => Boolean(row));
''',
    '''export function buildMlbInjuryOutcomeRows(records: LedgerRecord[]): MlbInjuryOutcomeRow[] {
  return records.map(rowFrom).filter((row): row is MlbInjuryOutcomeRow => Boolean(row));
}

export function buildMlbInjuryOutcomesReport(records: LedgerRecord[]) {
  const rows = buildMlbInjuryOutcomeRows(records);
''',
    "outcome row builder",
)
outcomes.write_text(text, encoding="utf-8")

routes = Path("server/mlb-ledger.ts")
text = routes.read_text(encoding="utf-8")
text = replace_once(
    text,
    'import { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";\n',
    'import { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";\nimport { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";\n',
    "decision import",
)
anchor = '''  app.get("/api/mlb/ledger/v1/report", (req, res) => {
'''
panel = '''  app.get("/api/mlb/ledger/v1/injury-decisions", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = store.listRecords({ ...filters, limit: filters.limit ?? 10_000 });
      res.json({ success: true, data: buildMlbInjuryDecisionReport(records) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury decision report",
      });
    }
  });

'''
text = replace_once(text, anchor, panel + anchor, "decision endpoint")
text = replace_once(
    text,
    'export { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";\n',
    'export { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";\nexport { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";\n',
    "decision export",
)
routes.write_text(text, encoding="utf-8")

package = Path("package.json")
text = package.read_text(encoding="utf-8")
text = replace_once(
    text,
    "server/mlb-injury-outcomes-report.test.ts server/mlb-ledger-history-view.test.ts",
    "server/mlb-injury-outcomes-report.test.ts server/mlb-injury-decision-report.test.ts server/mlb-ledger-history-view.test.ts",
    "main test script",
)
package.write_text(text, encoding="utf-8")

history = Path("frontend/client/src/pages/mlb-history.tsx")
ui = history.read_text(encoding="utf-8")
interface_anchor = '''interface LedgerHistoryPick {
'''
interface_block = '''type InjuryDecisionVerdict = "MANTENER" | "REVISAR" | "AMPLIAR_CON_CAUTELA" | "RESTRINGIR";
type InjuryDecisionSampleStatus = "INSUFFICIENT" | "EARLY" | "ACTIONABLE" | "MATURE";

interface InjuryDecisionItem {
  key: string;
  label: string;
  verdict: InjuryDecisionVerdict;
  sampleStatus: InjuryDecisionSampleStatus;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  metrics: InjuryOutcomeMetricSummary;
  reasons: string[];
  guardrail: string;
}

interface InjuryDecisionReport {
  schemaVersion: "mlb-injury-decision-report.v1";
  generatedAt: string;
  policy: {
    minimumObserve: number;
    minimumActionable: number;
    minimumExpand: number;
    formulasChanged: false;
    automaticRuleChanges: false;
  };
  global: InjuryDecisionItem;
  cohorts: InjuryDecisionItem[];
  markets: InjuryDecisionItem[];
  windows: InjuryDecisionItem[];
  alerts: Array<{ key: string; label: string; verdict: InjuryDecisionVerdict; confidence: string }>;
}

'''
ui = replace_once(ui, interface_anchor, interface_block + interface_anchor, "decision interfaces")

helper_anchor = '''function signedUnits(value: number) {
  if (Math.abs(value) < 0.0001) return "0.00 u";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} u`;
}
'''
helpers = '''function signedUnits(value: number) {
  if (Math.abs(value) < 0.0001) return "0.00 u";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)} u`;
}

function verdictLabel(verdict: InjuryDecisionVerdict) {
  if (verdict === "AMPLIAR_CON_CAUTELA") return "AMPLIAR CON CAUTELA";
  return verdict;
}

function verdictClass(verdict: InjuryDecisionVerdict) {
  if (verdict === "AMPLIAR_CON_CAUTELA") return "border-green-500/40 bg-green-500/10 text-green-300";
  if (verdict === "RESTRINGIR") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (verdict === "REVISAR") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-blue-500/40 bg-blue-500/10 text-blue-300";
}

function sampleLabel(status: InjuryDecisionSampleStatus) {
  if (status === "INSUFFICIENT") return "Muestra insuficiente";
  if (status === "EARLY") return "Muestra temprana";
  if (status === "ACTIONABLE") return "Primera revisión";
  return "Muestra madura";
}
'''
ui = replace_once(ui, helper_anchor, helpers, "decision helpers")

query_anchor = '''  const ledgerHistory = historyQuery.data;
  const injuryReport = injuryReportQuery.data;
  const injuryOutcomes = injuryOutcomesQuery.data;
'''
query_block = '''  const injuryDecisionsQuery = useQuery({
    queryKey: ["mlb-injury-decisions-report"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: InjuryDecisionReport }>(
        "/api/mlb/ledger/v1/injury-decisions?limit=10000",
      );
      return response.data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const ledgerHistory = historyQuery.data;
  const injuryReport = injuryReportQuery.data;
  const injuryOutcomes = injuryOutcomesQuery.data;
  const injuryDecisions = injuryDecisionsQuery.data;
'''
ui = replace_once(ui, query_anchor, query_block, "decision query")
ui = replace_once(
    ui,
    '''  const refreshAll = () => {
    void Promise.all([historyQuery.refetch(), injuryReportQuery.refetch(), injuryOutcomesQuery.refetch()]);
  };
''',
    '''  const refreshAll = () => {
    void Promise.all([
      historyQuery.refetch(), injuryReportQuery.refetch(), injuryOutcomesQuery.refetch(), injuryDecisionsQuery.refetch(),
    ]);
  };
''',
    "decision refresh",
)

market_anchor = '''      {marketStats.length > 0 && (
'''
panel = '''      <Card className="border-indigo-500/30 bg-indigo-500/5">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-indigo-300 mt-0.5" />
            <div>
              <CardTitle className="text-sm text-indigo-100">Veredictos de calibración · Fase C2C</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">Interpreta C2B con umbrales de muestra. Nunca cambia reglas, pesos ni fórmulas automáticamente.</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {injuryDecisionsQuery.isLoading && <p className="text-sm text-muted-foreground">Evaluando evidencia C2C…</p>}
          {injuryDecisionsQuery.isError && <p className="text-sm text-red-300">No se pudo cargar C2C. C2A y C2B permanecen disponibles.</p>}
          {injuryDecisions && (
            <>
              <div className="rounded-lg border border-indigo-500/25 bg-slate-950/40 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-indigo-100">Veredicto global</p>
                  <Badge variant="outline" className={verdictClass(injuryDecisions.global.verdict)}>
                    {verdictLabel(injuryDecisions.global.verdict)}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">{sampleLabel(injuryDecisions.global.sampleStatus)} · confianza {injuryDecisions.global.confidence}</span>
                </div>
                <p className="text-xs text-muted-foreground">{injuryDecisions.global.reasons[0]}</p>
                <p className="text-[11px] text-indigo-200/80">Protección: {injuryDecisions.global.guardrail}</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                {[
                  ["Liquidados", injuryDecisions.global.metrics.settled],
                  ["Revisión inicial", injuryDecisions.policy.minimumActionable],
                  ["Ampliación", injuryDecisions.policy.minimumExpand],
                  ["Alertas activas", injuryDecisions.alerts.length],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border border-indigo-500/20 bg-slate-950/30 p-2">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className="text-lg font-bold text-indigo-100">{value}</p>
                  </div>
                ))}
              </div>

              <div>
                <p className="text-xs font-semibold text-indigo-200 mb-2">Decisiones por cohorte</p>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {injuryDecisions.cohorts.map((item) => (
                    <div key={item.key} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-semibold text-foreground">{item.label}</p>
                        <Badge variant="outline" className={`text-[9px] ${verdictClass(item.verdict)}`}>{verdictLabel(item.verdict)}</Badge>
                      </div>
                      <p className="text-muted-foreground">{item.metrics.settled}/{item.metrics.total} liquidados · ROI {item.metrics.roiPct.toFixed(1)}%</p>
                      <p className="text-muted-foreground">Brier {item.metrics.brierScore?.toFixed(3) ?? "—"} · {sampleLabel(item.sampleStatus)}</p>
                    </div>
                  ))}
                </div>
              </div>

              {injuryDecisions.markets.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-indigo-200 mb-2">Veredicto por mercado</p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                    {injuryDecisions.markets.map((item) => (
                      <div key={item.key} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-semibold">{item.label}</p>
                          <Badge variant="outline" className={`text-[9px] ${verdictClass(item.verdict)}`}>{verdictLabel(item.verdict)}</Badge>
                        </div>
                        <p className="text-muted-foreground mt-1">{item.metrics.settled} liquidados · {signedUnits(item.metrics.profitUnits)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-indigo-300 shrink-0" />
                <p>C2C exige 10 liquidaciones para señal preliminar, 20 para primera revisión y 30 para considerar ampliación. Dos señales negativas son necesarias para RESTRINGIR.</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

'''
ui = replace_once(ui, market_anchor, panel + market_anchor, "decision panel")
history.write_text(ui, encoding="utf-8")
