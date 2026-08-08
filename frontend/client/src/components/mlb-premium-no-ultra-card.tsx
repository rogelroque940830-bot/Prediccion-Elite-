import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { MlbPremiumNoUltraReport, MlbPremiumNoUltraMetricSummary } from "@/lib/mlb-premium-no-ultra-prospective";

const STATE_META = {
  COLLECTING_PROSPECTIVE_EVIDENCE: ["Recolectando evidencia", "Contador nuevo; 13-4 histórico excluido."],
  CANDIDATE_NOT_CONFIRMED: ["Edge no confirmado", "Algún criterio preregistrado todavía falla."],
  ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY: ["Edge respaldado · investigación", "Criterios aprobados; sigue siendo no operativo."],
} as const;

function fmt(value: number | null, digits = 1, suffix = ""): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function units(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}

function Summary({ label, metric, calibration = false }: {
  label: string;
  metric: MlbPremiumNoUltraMetricSummary;
  calibration?: boolean;
}) {
  return <div className="rounded-lg border border-border/60 p-3 text-xs">
    <div className="flex flex-wrap justify-between gap-2"><strong>{label}</strong><span>n={metric.settled}</span></div>
    <p className="mt-2 text-muted-foreground">
      W-L {metric.wins}-{metric.losses} · Hit {fmt(metric.hitRatePct, 1, "%")} · ROI {fmt(metric.flatStakeRoiPct, 1, "%")} · Profit {units(metric.flatStakeProfitUnits)}
    </p>
    <p className="mt-1 text-muted-foreground">
      CLV {fmt(metric.meanClvPp, 2, " pp")} · Brier {fmt(metric.brierScore, 4)} · Log loss {fmt(metric.logLoss, 4)}{calibration ? ` · Cal ${metric.calibrationGap == null ? "—" : fmt(metric.calibrationGap * 100, 1, "%")}` : ""}
    </p>
  </div>;
}

export function MlbPremiumNoUltraCard({ report, isFetching, onRefresh }: {
  report: MlbPremiumNoUltraReport;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const [stateLabel, stateDetail] = STATE_META[report.state];
  const p = report.preregistration;
  const roi = report.inference.candidateRoiPct;
  const delta = report.inference.candidateMinusControlRoiPp;

  return <Card className="mt-4 border-cyan-500/30 bg-cyan-500/[0.04]" data-testid="premium-no-ultra-prospective-card">
    <CardContent className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">Edge Prospectivo F5 · PREMIUM sin ULTRA</p>
          <p className="text-sm text-cyan-100" data-testid="premium-no-ultra-state">{stateLabel}</p>
          <p className="text-xs text-muted-foreground">{stateDetail}</p>
        </div>
        {onRefresh && <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>Actualizar</Button>}
      </div>

      <p className="rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
        FINAL · 1 juego = 1 observación · Corte 08/08/2026<br />
        Candidato: {report.cohort.candidateSettled}/{p.minimumCandidateSettled} settled · {report.cohort.candidateDates}/{p.minimumCandidateDates} fechas · Control: {report.cohort.controlSettled}/{p.minimumControlSettled} settled · {report.cohort.controlDates}/{p.minimumControlDates} fechas
      </p>

      <div className="grid gap-2 lg:grid-cols-2">
        <Summary label="PREMIUM sin ULTRA" metric={report.candidate} calibration />
        <Summary label="Control contemporáneo" metric={report.control} />
      </div>

      {(roi || delta) && <p className="rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
        Bootstrap 95% por fecha{roi ? ` · ROI ${fmt(roi.lower, 1, "%")} a ${fmt(roi.upper, 1, "%")}` : ""}{delta ? ` · Δ vs control ${fmt(delta.lower, 2, " pp")} a ${fmt(delta.upper, 2, " pp")}` : ""}
      </p>}

      {report.blockers.length > 0 && <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3 text-xs">
        <strong>Bloqueadores:</strong> {report.blockers.join(" · ")}
      </p>}

      <p className="rounded-lg border border-cyan-500/25 p-3 text-xs text-cyan-100">
        <strong>Regla de dinero:</strong> incluso con “Edge respaldado”, el <strong>money gate apagado</strong>; sin cambios de stake, apuestas automáticas ni restauración de ULTRA.
      </p>
    </CardContent>
  </Card>;
}
