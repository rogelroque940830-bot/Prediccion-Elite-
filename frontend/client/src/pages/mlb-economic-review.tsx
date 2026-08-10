import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/queryClient";
import {
  MLB_P1_M3D_ENDPOINT,
  parseMlbP1M3dEconomicReviewEnvelope,
  type MlbP1M3dBreakdown,
  type MlbP1M3dMetricSummary,
  type MlbP1M3dReport,
  type MlbP1M3dReviewRow,
} from "@/lib/mlb-interactive-economic-review";

type BreakdownKey = keyof MlbP1M3dReport["breakdowns"];

const BREAKDOWN_LABELS: Record<BreakdownKey, string> = {
  byMarket: "Mercado",
  bySourceSignal: "Señal original",
  byEffectiveDecision: "Decisión efectiva",
  byActionability: "Accionabilidad",
  byStage: "Etapa",
  byProbabilityBand: "Banda de probabilidad",
};

const STATE_META: Record<MlbP1M3dReport["state"], { label: string; detail: string; className: string }> = {
  WAITING_FOR_FIRST_SETTLEMENT: {
    label: "Esperando primera liquidación",
    detail: "Todavía no existe una decisión interactiva liquidada. No hay base para interpretar ROI o calibración.",
    className: "border-slate-500/40 bg-slate-500/10 text-slate-200",
  },
  TECHNICAL_SAMPLE_ONLY: {
    label: "Muestra técnica solamente",
    detail: "Hay entre 1 y 4 liquidaciones. Las métricas sirven para comprobar el sistema, no para concluir rentabilidad.",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  },
  PRELIMINARY_REVIEW_ONLY: {
    label: "Revisión preliminar",
    detail: "La muestra permite observar patrones iniciales, pero todavía no autoriza conclusiones ni cambios de modelo.",
    className: "border-orange-500/40 bg-orange-500/10 text-orange-200",
  },
  COLLECTING_PREFERRED_SAMPLE: {
    label: "Recolectando muestra preferida",
    detail: "La muestra supera el mínimo preliminar y continúa hacia 50 liquidaciones para una revisión humana más estable.",
    className: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
  },
  READY_FOR_HUMAN_REVIEW: {
    label: "Lista para revisión humana",
    detail: "Se alcanzó la muestra preferida. Esto permite revisión humana, pero no cambios automáticos ni promesas de ganancia.",
    className: "border-green-500/40 bg-green-500/10 text-green-200",
  },
  ACTION_REQUIRED: {
    label: "Acción de integridad requerida",
    detail: "Existe una condición crítica de cohortes, revisiones o duplicados que debe resolverse antes de interpretar métricas.",
    className: "border-red-500/40 bg-red-500/10 text-red-200",
  },
};

function finite(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

function pct(value: number | null, digits = 1): string {
  return finite(value) ? `${value.toFixed(digits)}%` : "—";
}

function probability(value: number | null, digits = 1): string {
  return finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function decimal(value: number | null, digits = 3): string {
  return finite(value) ? value.toFixed(digits) : "—";
}

function signed(value: number | null, suffix = ""): string {
  if (!finite(value)) return "—";
  const normalized = Math.abs(value) < 0.0005 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(2)}${suffix}`;
}

function odds(value: number | null): string {
  if (!finite(value)) return "—";
  return value > 0 ? `+${Math.round(value)}` : `${Math.round(value)}`;
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function MetricTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border/65 bg-background/35 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-100">{value}</p>
      {detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function ProfitMetric({ label, profit, exposure, roi }: {
  label: string;
  profit: number;
  exposure: number;
  roi: number | null;
}) {
  const positive = profit > 0;
  const negative = profit < 0;
  return (
    <Card className={positive
      ? "border-green-500/30 bg-green-500/[0.05]"
      : negative
        ? "border-red-500/30 bg-red-500/[0.05]"
        : "border-border/70 bg-card/50"}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{label}</p>
            <p className="mt-1 text-xs text-muted-foreground">Exposición simulada: {exposure.toFixed(2)} u</p>
          </div>
          {positive ? <TrendingUp className="h-5 w-5 text-green-300" /> : negative ? <TrendingDown className="h-5 w-5 text-red-300" /> : <Gauge className="h-5 w-5 text-muted-foreground" />}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <MetricTile label="Beneficio" value={signed(profit, " u")} />
          <MetricTile label="ROI" value={pct(roi)} />
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryCard({ title, metrics }: { title: string; metrics: MlbP1M3dMetricSummary }) {
  return (
    <Card className="border-border/70 bg-card/45">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="Observaciones" value={String(metrics.observations)} />
        <MetricTile label="Liquidadas" value={String(metrics.settled)} />
        <MetricTile label="Acierto" value={pct(metrics.hitRatePct)} />
        <MetricTile label="CLV medio" value={signed(metrics.meanClvPp, " pp")} />
      </CardContent>
    </Card>
  );
}

function BreakdownCard({ item }: { item: MlbP1M3dBreakdown }) {
  return (
    <Card className="border-border/65 bg-card/40">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">{item.key.replaceAll("_", " ")}</p>
          <Badge variant="outline">n={item.metrics.observations}</Badge>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Liquidadas" value={String(item.metrics.settled)} />
          <MetricTile label="ROI plano" value={pct(item.metrics.flatStakeRoiPct)} />
          <MetricTile label="ROI política" value={pct(item.metrics.policyStakeRoiPct)} />
          <MetricTile label="CLV" value={signed(item.metrics.meanClvPp, " pp")} />
        </div>
      </CardContent>
    </Card>
  );
}

function resultClass(value: string | null): string {
  const normalized = String(value || "PENDING").toUpperCase();
  if (["W", "WIN", "½W"].includes(normalized)) return "border-green-500/40 bg-green-500/10 text-green-200";
  if (["L", "LOSS", "½L"].includes(normalized)) return "border-red-500/40 bg-red-500/10 text-red-200";
  return "border-slate-500/40 bg-slate-500/10 text-slate-200";
}

function ReviewRowCard({ row }: { row: MlbP1M3dReviewRow }) {
  return (
    <Card className="border-border/65 bg-card/40" data-testid={`p1-m3d-row-${row.predictionId}`}>
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={resultClass(row.result)}>{row.result || "PENDIENTE"}</Badge>
              <Badge variant="outline">{row.market}</Badge>
              <Badge variant="outline">{row.stage}</Badge>
              {row.effectiveDecision && <Badge variant="outline">{row.effectiveDecision}</Badge>}
            </div>
            <p className="mt-2 font-semibold">{row.awayTeam} vs {row.homeTeam}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {row.selection}{row.line == null ? "" : ` · ${row.line}`} · {odds(row.oddsAmerican)}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">Registrada: {formatTime(row.recordedAt)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:min-w-[310px]">
            <MetricTile label="Prob. modelo" value={probability(row.modelProbability)} />
            <MetricTile label="Edge" value={signed(row.edgePp, " pp")} />
            <MetricTile label="Beneficio plano" value={signed(row.flatProfitUnits, " u")} />
            <MetricTile label="Beneficio política" value={signed(row.policyProfitUnits, " u")} />
          </div>
        </div>
        {(!row.economicLayerValid || row.dataQualityMissing.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3 text-xs text-amber-100">
            {[...row.economicLayerErrors, ...row.dataQualityMissing].join(" · ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MlbEconomicReview() {
  const [breakdownKey, setBreakdownKey] = useState<BreakdownKey>("byMarket");
  const [visibleRows, setVisibleRows] = useState(20);

  const reviewQuery = useQuery({
    queryKey: ["p1-m3d-interactive-economic-review"],
    queryFn: async () => {
      const raw = await fetchJson<unknown>(MLB_P1_M3D_ENDPOINT);
      return parseMlbP1M3dEconomicReviewEnvelope(raw).data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const report = reviewQuery.data;
  const breakdown = report?.breakdowns[breakdownKey] ?? [];
  const rows = useMemo(() => report?.rows.slice(0, visibleRows) ?? [], [report?.rows, visibleRows]);

  if (reviewQuery.isLoading) {
    return (
      <div className="mx-auto max-w-[1150px] p-4 md:p-6">
        <Card className="border-cyan-500/25 bg-cyan-500/[0.04]">
          <CardContent className="flex items-center gap-3 p-6">
            <RefreshCw className="h-5 w-5 animate-spin text-cyan-300" />
            <div>
              <p className="font-semibold">Cargando rendimiento económico interactivo</p>
              <p className="text-sm text-muted-foreground">Leyendo el reporte privado y autoritativo del backend.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (reviewQuery.isError || !report) {
    const message = reviewQuery.error instanceof Error ? reviewQuery.error.message : "No se pudo cargar el reporte.";
    return (
      <div className="mx-auto max-w-[1150px] p-4 md:p-6">
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-red-300" />
            <p className="mt-3 font-semibold">Reporte económico no disponible</p>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            <Button className="mt-4" variant="outline" onClick={() => void reviewQuery.refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Reintentar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const stateMeta = STATE_META[report.state];
  const exclusions = Object.entries(report.sample.exclusionCounts).sort((left, right) => right[1] - left[1]);

  return (
    <div className="mx-auto max-w-[1150px] space-y-5 p-4 md:p-6" data-testid="p1-m3d-economic-review">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-6 w-6 text-cyan-300" />
            <h1 className="text-xl font-bold md:text-2xl">Rendimiento económico MLB</h1>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Solo incluye evaluaciones creadas al presionar Generar Predicción en tu sesión. Las métricas vienen calculadas por el backend sobre el ledger inmutable.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1.5"><Database className="h-3.5 w-3.5" /> Cohorte privada</Badge>
          <Badge variant="outline" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> SHADOW · exposición 0</Badge>
          <Button variant="outline" size="sm" onClick={() => void reviewQuery.refetch()} disabled={reviewQuery.isFetching}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${reviewQuery.isFetching ? "animate-spin" : ""}`} /> Actualizar
          </Button>
        </div>
      </div>

      <Card className={stateMeta.className} data-testid="p1-m3d-sample-state">
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-semibold">{stateMeta.label}</p>
              <p className="mt-1 text-sm opacity-85">{stateMeta.detail}</p>
            </div>
            <Badge variant="outline">{report.overall.settled}/50 liquidaciones</Badge>
          </div>
          <p className="mt-3 text-xs opacity-75">
            Conclusiones automáticas: NO · Cambios automáticos del modelo: NO · Promoción automática: NO
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <MetricTile label="Interactivas" value={String(report.sample.interactiveLedgerRecords)} />
        <MetricTile label="Decisiones únicas" value={String(report.sample.uniqueAnalyticalDecisions)} />
        <MetricTile label="Liquidadas" value={String(report.sample.settledDecisions)} />
        <MetricTile label="Pendientes" value={String(report.sample.pendingDecisions)} />
        <MetricTile label="CLV cubierto" value={String(report.sample.clvCoveredDecisions)} />
        <MetricTile label="Duplicados excluidos" value={String(report.sample.analyticalDuplicatesExcluded)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ProfitMetric
          label="Simulación plana de 1 unidad"
          profit={report.overall.flatStakeProfitUnits}
          exposure={report.overall.flatStakeExposureUnits}
          roi={report.overall.flatStakeRoiPct}
        />
        <ProfitMetric
          label="Política efectiva P1-M4 SHADOW"
          profit={report.overall.policyStakeProfitUnits}
          exposure={report.overall.policyStakeExposureUnits}
          roi={report.overall.policyStakeRoiPct}
        />
      </div>

      <Card className="border-violet-500/25 bg-violet-500/[0.04]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4 text-violet-300" /> Calibración y precio</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <MetricTile label="Brier" value={decimal(report.overall.brierScore)} />
          <MetricTile label="Log Loss" value={decimal(report.overall.logLoss)} />
          <MetricTile label="Prob. modelo" value={probability(report.overall.meanModelProbability)} />
          <MetricTile label="Acierto observado" value={probability(report.overall.observedWinRate)} />
          <MetricTile label="Prob. mercado" value={probability(report.overall.meanMarketImpliedProbability)} />
          <MetricTile label="Edge medio" value={signed(report.overall.meanEdgePp, " pp")} />
          <MetricTile label="CLV medio" value={signed(report.overall.meanClvPp, " pp")} />
          <MetricTile label="Cobertura CLV" value={pct(report.overall.clvCoveragePct)} />
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <SummaryCard title="Decisiones accionables" metrics={report.economicallyActionable} />
        <SummaryCard title="Señales BET/BET FUERTE" metrics={report.controls.acceptedSourceSignals} />
        <SummaryCard title="Controles LEAN/PASS/INFO" metrics={report.controls.leanPassInfoControls} />
      </div>

      <Card className="border-border/70 bg-card/45">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Desgloses del reporte</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(BREAKDOWN_LABELS) as BreakdownKey[]).map((key) => (
              <Button key={key} size="sm" variant={breakdownKey === key ? "default" : "outline"} onClick={() => setBreakdownKey(key)}>
                {BREAKDOWN_LABELS[key]}
              </Button>
            ))}
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {breakdown.length ? breakdown.map((item) => <BreakdownCard key={`${breakdownKey}-${item.key}`} item={item} />) : (
              <p className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                Aún no hay observaciones para este desglose.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {(report.issues.length > 0 || exclusions.length > 0) && (
        <Card className="border-amber-500/25 bg-amber-500/[0.04]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4 text-amber-300" /> Integridad y exclusiones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.issues.map((issue) => (
              <div key={`${issue.code}-${issue.message}`} className="rounded-lg border border-amber-500/20 bg-background/30 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{issue.severity}</Badge><span className="font-semibold">{issue.code}</span></div>
                <p className="mt-1 text-xs text-muted-foreground">{issue.message}</p>
              </div>
            ))}
            {exclusions.map(([code, count]) => (
              <div key={code} className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 p-3 text-sm">
                <span>{code.replaceAll("_", " ")}</span><Badge variant="outline">{count}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-card/45">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base"><Target className="h-4 w-4 text-cyan-300" /> Evaluaciones interactivas</CardTitle>
            <Badge variant="outline">{report.rows.length} registros</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.length ? rows.map((row) => <ReviewRowCard key={row.predictionId} row={row} />) : (
            <div className="rounded-lg border border-dashed border-border/70 p-8 text-center">
              <Clock3 className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-semibold">Todavía no hay evaluaciones interactivas</p>
              <p className="mt-1 text-sm text-muted-foreground">Genera predicciones MLB con una sesión autenticada para comenzar la cohorte.</p>
            </div>
          )}
          {report.rows.length > visibleRows && (
            <Button className="w-full" variant="outline" onClick={() => setVisibleRows((value) => value + 20)}>
              Mostrar 20 más
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="border-green-500/20 bg-green-500/[0.03]">
        <CardContent className="flex items-start gap-3 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-300" />
          <div>
            <p className="font-semibold">Reporte de solo lectura</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Esta pantalla no guarda picks, no liquida resultados, no modifica el ledger, no conecta sportsbooks y no coloca apuestas. Generado: {formatTime(report.generatedAt)}.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
