import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, TrendingUp } from "lucide-react";
import { fetchJson } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ClosingLineRow {
  predictionId: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  ticketOddsAmerican: number;
  requestedBook: string | null;
  status: "PENDING" | "OBSERVED" | "FINAL" | "UNAVAILABLE" | "UNSUPPORTED";
  observation: null | {
    checkpoint: "T180" | "T60" | "T15";
    quoteAt: string;
    bookmakerKey: string;
    bookmakerTitle: string | null;
    matchMode: "EXACT_BOOK" | "PROXY_BOOK";
    oddsAmerican: number;
    line: number | null;
    comparable: boolean;
    clvPp: number | null;
    priceClvPct: number | null;
    lineClv: number | null;
    quoteAgeMinutes: number | null;
    quality: "VERIFIED" | "ACCEPTABLE" | "STALE" | "UNKNOWN";
  };
  analyticalDuplicate: boolean;
}

interface ClosingLineReport {
  schemaVersion: "mlb-closing-line-report.v1";
  generatedAt: string;
  summary: {
    ledgerRecords: number;
    uniqueAnalyticalDecisions: number;
    analyticalDuplicatesExcluded: number;
    final: number;
    pending: number;
    unavailable: number;
    unsupported: number;
    exactBookMeasured: number;
    proxyBookMeasured: number;
    positiveExactClv: number;
    negativeExactClv: number;
    averageExactClvPp: number | null;
    averageExactPriceClvPct: number | null;
    averageProxyClvPp: number | null;
    quality: { verified: number; acceptable: number; stale: number; unknown: number };
  };
  rows: ClosingLineRow[];
  methodology: {
    checkpointsMinutesBeforeStart: number[];
    historicalBackfill: boolean;
    immutableObservations: boolean;
  };
}

function signed(value: number | null, suffix = "") {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function odds(value: number | null | undefined) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value}`;
}

function statusLabel(status: ClosingLineRow["status"]) {
  if (status === "FINAL") return "Cierre final";
  if (status === "OBSERVED") return "Observado";
  if (status === "PENDING") return "Pendiente";
  if (status === "UNSUPPORTED") return "No soportado";
  return "No disponible";
}

function statusClass(status: ClosingLineRow["status"]) {
  if (status === "FINAL") return "border-green-500/40 bg-green-500/10 text-green-300";
  if (status === "OBSERVED") return "border-cyan-500/40 bg-cyan-500/10 text-cyan-300";
  if (status === "PENDING") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-slate-600 bg-slate-900/50 text-slate-300";
}

export function MlbClosingLinePanel() {
  const query = useQuery({
    queryKey: ["mlb-closing-line-report"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: ClosingLineReport }>(
        "/api/mlb/ledger/v1/closing-lines?limit=10000",
      );
      return response.data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });
  const report = query.data;
  const recent = report?.rows.filter((row) => !row.analyticalDuplicate).slice(0, 8) ?? [];

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <TrendingUp className="h-5 w-5 text-emerald-300 mt-0.5" />
          <div>
            <CardTitle className="text-sm text-emerald-100">Cuota de cierre y CLV · Fase C2D</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Guarda observaciones inmutables antes del inicio. Prefiere la misma casa y nunca inventa cierres históricos.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 gap-1 text-xs"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && <p className="text-sm text-muted-foreground">Cargando cuotas de cierre…</p>}
        {query.isError && <p className="text-sm text-red-300">No se pudo cargar C2D. El ledger y las demás fases permanecen disponibles.</p>}
        {report && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {[
                ["Decisiones únicas", report.summary.uniqueAnalyticalDecisions],
                ["Cierres finales", report.summary.final],
                ["Pendientes", report.summary.pending],
                ["No disponibles", report.summary.unavailable],
                ["Casa exacta", report.summary.exactBookMeasured],
                ["CLV medio", signed(report.summary.averageExactClvPp, " pp")],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border border-emerald-500/20 bg-slate-950/40 p-2 text-center">
                  <p className="text-[10px] text-muted-foreground">{label}</p>
                  <p className="text-lg font-bold text-emerald-100">{value}</p>
                </div>
              ))}
            </div>

            <div className="grid md:grid-cols-3 gap-3 text-xs">
              <div className="rounded-lg bg-slate-900/60 p-3">
                <p className="font-semibold text-emerald-200 mb-2">Calidad del cierre</p>
                <p className="text-muted-foreground">≤20 min: <span className="text-green-300">{report.summary.quality.verified}</span></p>
                <p className="text-muted-foreground">≤60 min: <span className="text-cyan-300">{report.summary.quality.acceptable}</span></p>
                <p className="text-muted-foreground">≤180 min: <span className="text-amber-300">{report.summary.quality.stale}</span></p>
              </div>
              <div className="rounded-lg bg-slate-900/60 p-3">
                <p className="font-semibold text-emerald-200 mb-2">Resultado del CLV exacto</p>
                <p className="text-muted-foreground">Positivo: <span className="text-green-300">{report.summary.positiveExactClv}</span></p>
                <p className="text-muted-foreground">Negativo: <span className="text-red-300">{report.summary.negativeExactClv}</span></p>
                <p className="text-muted-foreground">Precio medio: <span className="text-foreground">{signed(report.summary.averageExactPriceClvPct, "%")}</span></p>
              </div>
              <div className="rounded-lg bg-slate-900/60 p-3">
                <p className="font-semibold text-emerald-200 mb-2">Cobertura</p>
                <p className="text-muted-foreground">Proxy etiquetado: <span className="text-foreground">{report.summary.proxyBookMeasured}</span></p>
                <p className="text-muted-foreground">No soportados: <span className="text-foreground">{report.summary.unsupported}</span></p>
                <p className="text-muted-foreground">Duplicados excluidos: <span className="text-foreground">{report.summary.analyticalDuplicatesExcluded}</span></p>
              </div>
            </div>

            {recent.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-emerald-200">Estado por decisión</p>
                {recent.map((row) => (
                  <div key={row.predictionId} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`text-[9px] ${statusClass(row.status)}`}>{statusLabel(row.status)}</Badge>
                      <span className="font-semibold">{row.awayTeam} @ {row.homeTeam}</span>
                      <Badge variant="outline" className="text-[9px]">{row.marketType}</Badge>
                      <span className="text-muted-foreground ml-auto">Ticket {odds(row.ticketOddsAmerican)}</span>
                    </div>
                    <div className="mt-1 flex gap-x-4 gap-y-1 flex-wrap text-muted-foreground">
                      {row.observation ? (
                        <>
                          <span>Cierre {odds(row.observation.oddsAmerican)}</span>
                          <span>{row.observation.matchMode === "EXACT_BOOK" ? "Misma casa" : "Proxy"}: {row.observation.bookmakerTitle || row.observation.bookmakerKey}</span>
                          <span>CLV {signed(row.observation.clvPp, " pp")}</span>
                          {row.observation.lineClv != null && <span>CLV línea {signed(row.observation.lineClv)}</span>}
                          <span>{row.observation.checkpoint} · {row.observation.quality}</span>
                        </>
                      ) : (
                        <span>{row.status === "UNAVAILABLE" ? "Pick anterior a C2D: no se hará backfill artificial." : "Esperando ventana automática de captura."}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-slate-950/30 p-2.5 text-[11px] text-muted-foreground">
              <Activity className="h-4 w-4 text-emerald-300 shrink-0" />
              <p>
                C2D intenta capturar a 180, 60 y 15 minutos del inicio. El CLV probabilístico solo se calcula cuando selección y línea son comparables; los movimientos de línea se informan aparte.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
