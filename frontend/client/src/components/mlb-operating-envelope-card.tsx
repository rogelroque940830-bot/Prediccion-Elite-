import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatMlbP1M3eAtom,
  type MlbP1M3eBootstrapInterval,
  type MlbP1M3eMetricSummary,
  type MlbP1M3eReport,
} from "@/lib/mlb-operating-envelope";

const STATE_META: Record<MlbP1M3eReport["state"], {
  label: string;
  detail: string;
  className: string;
}> = {
  INSUFFICIENT_SAMPLE: {
    label: "Muestra insuficiente",
    detail: "Todavía no existen suficientes decisiones scoreables y fechas distintas para buscar condiciones élite sin sobreajustar.",
    className: "border-amber-500/35 bg-amber-500/[0.06] text-amber-100",
  },
  NO_DISCOVERY_RULE: {
    label: "Sin regla candidata",
    detail: "La muestra ya permite buscar, pero ninguna condición preregistrada mejora simultáneamente log loss, Brier y calibración en discovery.",
    className: "border-slate-500/35 bg-slate-500/[0.06] text-slate-100",
  },
  CANDIDATE_NOT_CONFIRMED: {
    label: "Candidata no confirmada",
    detail: "Una zona pareció mejor en discovery, pero no sobrevivió la confirmación cronológica. No se declara condición élite.",
    className: "border-orange-500/35 bg-orange-500/[0.06] text-orange-100",
  },
  ELITE_MODEL_QUALITY_SUPPORTED: {
    label: "Calidad élite respaldada",
    detail: "La misma regla pregame sobrevivió discovery y confirmación posterior con mejora de proper scoring y calibración aceptable.",
    className: "border-green-500/40 bg-green-500/[0.07] text-green-100",
  },
};

function pct(value: number | null, digits = 1): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

function probability(value: number | null, digits = 1): string {
  return value != null && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function decimal(value: number | null, digits = 4): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function signed(value: number | null, digits = 4): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const normalized = Math.abs(value) < 10 ** -(digits + 1) ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(digits)}`;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-border/65 bg-background/35 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-slate-100">{value}</p>
      {detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function CohortSummary({ report }: { report: MlbP1M3eReport }) {
  const obsReady = report.cohort.scoreableRows >= report.configuration.minimumTotalObservations;
  const datesReady = report.cohort.uniqueDates >= report.configuration.minimumTotalDates;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric
        label="Scoreables"
        value={`${report.cohort.scoreableRows}/${report.configuration.minimumTotalObservations}`}
        detail={obsReady ? "mínimo alcanzado" : "mínimo pendiente"}
      />
      <Metric
        label="Fechas únicas"
        value={`${report.cohort.uniqueDates}/${report.configuration.minimumTotalDates}`}
        detail={datesReady ? "mínimo alcanzado" : "mínimo pendiente"}
      />
      <Metric label="Discovery" value={String(report.temporalSplit.discoveryRows)} detail={`${report.temporalSplit.discoveryDates} fechas`} />
      <Metric label="Confirmación" value={String(report.temporalSplit.confirmationRows)} detail={`${report.temporalSplit.confirmationDates} fechas`} />
    </div>
  );
}

function QualitySummary({ title, metrics }: { title: string; metrics: MlbP1M3eMetricSummary }) {
  return (
    <div className="rounded-xl border border-border/65 bg-card/35 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <Badge variant="outline">n={metrics.observations}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Log loss" value={decimal(metrics.meanLogLoss)} />
        <Metric label="Brier" value={decimal(metrics.meanBrierScore)} />
        <Metric label="Prob. media" value={probability(metrics.meanModelProbability)} />
        <Metric label="Win rate obs." value={probability(metrics.observedWinRate)} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Gap calibración {signed(metrics.calibrationGap)} · ROI descriptivo {pct(metrics.flatStakeRoiPct)} · CLV medio {metrics.meanClvPp == null ? "—" : `${signed(metrics.meanClvPp, 2)} pp`}
      </p>
    </div>
  );
}

function IntervalRow({ label, interval }: { label: string; interval: MlbP1M3eBootstrapInterval | null }) {
  if (!interval) {
    return <p className="text-xs text-muted-foreground">{label}: sin intervalo disponible.</p>;
  }
  const supported = interval.lower > 0;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[11px] text-muted-foreground">95% CI · {interval.replicatesUsed}/{interval.replicatesRequested} bootstrap</p>
      </div>
      <div className="text-left sm:text-right">
        <p className={supported ? "font-mono text-sm text-green-200" : "font-mono text-sm text-amber-200"}>
          {signed(interval.pointEstimate)} [{signed(interval.lower)}, {signed(interval.upper)}]
        </p>
        <p className="text-[11px] text-muted-foreground">{supported ? "intervalo completo > 0" : "no excluye 0"}</p>
      </div>
    </div>
  );
}

export function MlbOperatingEnvelopeCard({
  report,
  isFetching,
  onRefresh,
}: {
  report: MlbP1M3eReport;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const meta = STATE_META[report.state];
  const rule = report.selectedRule;
  const inference = report.confirmationInference;

  return (
    <Card className={`${meta.className} mt-4`} data-testid="p1-m3e-operating-envelope-card">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="h-5 w-5" />
              <CardTitle className="text-base">Condiciones Élite MLB · Operating Envelope</CardTitle>
              <Badge variant="outline" data-testid="p1-m3e-state">{meta.label}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-sm opacity-90">{meta.detail}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3.5 w-3.5" /> Solo lectura</Badge>
            <Badge variant="outline" className="gap-1"><Clock3 className="h-3.5 w-3.5" /> OOS cronológico</Badge>
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Actualizar
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <CohortSummary report={report} />

        <div className="rounded-xl border border-border/65 bg-background/30 p-4">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-cyan-200" />
            <p className="text-sm font-semibold">Regla pregame congelada</p>
          </div>
          {rule ? (
            <div className="mt-3 flex flex-wrap gap-2" data-testid="p1-m3e-selected-rule">
              {rule.atoms.map((atom, index) => (
                <Badge key={`${rule.ruleKey}-${index}`} variant="outline" className="px-2.5 py-1">
                  {formatMlbP1M3eAtom(atom)}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Todavía no existe una regla candidata congelada.</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Máximo {report.configuration.maximumRuleAtoms} condiciones · {report.configuration.candidateRuleCount} reglas preregistradas · el resultado del partido nunca entra al selector.
          </p>
        </div>

        {report.confirmation && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Confirmación posterior</p>
            <div className="grid gap-2 lg:grid-cols-2">
              <QualitySummary title="Dentro del envelope" metrics={report.confirmation.selected} />
              <QualitySummary title="Fuera del envelope" metrics={report.confirmation.rejected} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Cobertura envelope" value={pct(report.confirmation.coveragePct)} />
              <Metric label="Δ log loss" value={signed(report.confirmation.rejectedMinusSelectedLogLoss)} detail="> 0 favorece envelope" />
              <Metric label="Δ Brier" value={signed(report.confirmation.rejectedMinusSelectedBrier)} detail="> 0 favorece envelope" />
              <Metric label="Fechas confirmación" value={String(report.temporalSplit.confirmationDates)} />
            </div>
          </div>
        )}

        {inference && (
          <div className="space-y-2 rounded-xl border border-border/65 bg-background/30 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">Inferencia de confirmación</p>
              <Badge variant="outline">{inference.dateClusters} clusters por fecha</Badge>
            </div>
            <IntervalRow label="Mejora log loss: fuera − dentro" interval={inference.logLossImprovement} />
            <IntervalRow label="Mejora Brier: fuera − dentro" interval={inference.brierImprovement} />
            <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
              <Badge variant="outline">Calibración {inference.calibrationAccepted ? "PASS" : "FAIL"}</Badge>
              <Badge variant="outline">Cobertura {inference.minimumCoverageAccepted ? "PASS" : "FAIL"}</Badge>
              <Badge variant="outline">Muestra {inference.minimumSampleAccepted ? "PASS" : "FAIL"}</Badge>
            </div>
          </div>
        )}

        {report.blockers.length > 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <div>
                <p className="text-xs font-semibold text-amber-100">Bloqueadores científicos</p>
                <p className="mt-1 text-[11px] text-amber-100/80">{report.blockers.join(" · ")}</p>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.05] p-3 text-xs text-cyan-100">
          <div className="flex items-start gap-2">
            {report.interpretation.modelQualityOperatingEnvelopeSupported
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-300" />
              : <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />}
            <p>
              <strong>Frontera:</strong> esto evalúa calidad probabilística del modelo. No certifica rentabilidad, no cambia probabilidades ni thresholds, no activa apuestas y no permite promoción automática.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
