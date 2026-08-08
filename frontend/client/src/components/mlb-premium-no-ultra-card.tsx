import { AlertTriangle, FlaskConical, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MlbPremiumNoUltraReport } from "@/lib/mlb-premium-no-ultra-prospective";

const STATE_META: Record<MlbPremiumNoUltraReport["state"], { label: string; detail: string; className: string }> = {
  COLLECTING_PROSPECTIVE_EVIDENCE: {
    label: "Recolectando evidencia",
    detail: "El contador empezó desde cero después del corte prospectivo. Los 13-4 históricos no cuentan como confirmación.",
    className: "border-cyan-500/35 bg-cyan-500/[0.06] text-cyan-100",
  },
  CANDIDATE_NOT_CONFIRMED: {
    label: "Edge no confirmado",
    detail: "La muestra mínima ya existe, pero uno o más criterios económicos, de calibración o proper scoring todavía fallan.",
    className: "border-orange-500/35 bg-orange-500/[0.06] text-orange-100",
  },
  ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY: {
    label: "Edge respaldado · investigación",
    detail: "Todos los criterios preregistrados pasaron, pero esto todavía NO activa stakes ni apuestas reales.",
    className: "border-green-500/40 bg-green-500/[0.07] text-green-100",
  },
};

function pct(value: number | null, digits = 1): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}
function pp(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)} pp`;
}
function number(value: number | null, digits = 4): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "—";
}
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-border/65 bg-background/35 p-3">
    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="mt-1 text-lg font-bold text-slate-100">{value}</p>
    {detail && <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>}
  </div>;
}

export function MlbPremiumNoUltraCard({
  report,
  isFetching,
  onRefresh,
}: {
  report: MlbPremiumNoUltraReport;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const meta = STATE_META[report.state];
  const candidateMin = report.preregistration.minimumCandidateSettled;
  const candidateDateMin = report.preregistration.minimumCandidateDates;
  const controlMin = report.preregistration.minimumControlSettled;
  const controlDateMin = report.preregistration.minimumControlDates;
  const roiInterval = report.inference.candidateRoiPct;
  const diffInterval = report.inference.candidateMinusControlRoiPp;

  return (
    <Card className={`${meta.className} mt-4`} data-testid="premium-no-ultra-prospective-card">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              <CardTitle className="text-base">Edge Prospectivo F5 · PREMIUM sin ULTRA</CardTitle>
              <Badge variant="outline" data-testid="premium-no-ultra-state">{meta.label}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-sm opacity-90">{meta.detail}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1"><ShieldCheck className="h-3.5 w-3.5" /> FINAL · 1 juego = 1 observación</Badge>
            <Badge variant="outline">Corte 08/08/2026</Badge>
            {onRefresh && <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Actualizar
            </Button>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Candidatos settled" value={`${report.cohort.candidateSettled}/${candidateMin}`} detail={`${report.cohort.candidateGames} juegos detectados`} />
          <Metric label="Fechas candidato" value={`${report.cohort.candidateDates}/${candidateDateMin}`} />
          <Metric label="Control settled" value={`${report.cohort.controlSettled}/${controlMin}`} detail={`${report.cohort.controlGames} juegos`} />
          <Metric label="Fechas control" value={`${report.cohort.controlDates}/${controlDateMin}`} />
        </div>

        <div className="grid gap-2 lg:grid-cols-2">
          <div className="rounded-xl border border-border/65 bg-card/35 p-3">
            <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">PREMIUM sin ULTRA · prospectivo</p><Badge variant="outline">n={report.candidate.settled}</Badge></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="W-L" value={`${report.candidate.wins}-${report.candidate.losses}`} />
              <Metric label="Hit rate" value={pct(report.candidate.hitRatePct)} />
              <Metric label="ROI 1u" value={pct(report.candidate.flatStakeRoiPct)} />
              <Metric label="Profit" value={`${report.candidate.flatStakeProfitUnits > 0 ? "+" : ""}${report.candidate.flatStakeProfitUnits.toFixed(2)}u`} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">CLV medio {pp(report.candidate.meanClvPp)} · Brier {number(report.candidate.brierScore)} · Log loss {number(report.candidate.logLoss)} · Gap calibración {report.candidate.calibrationGap == null ? "—" : pct(report.candidate.calibrationGap * 100)}</p>
          </div>
          <div className="rounded-xl border border-border/65 bg-card/35 p-3">
            <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">Control contemporáneo</p><Badge variant="outline">n={report.control.settled}</Badge></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="W-L" value={`${report.control.wins}-${report.control.losses}`} />
              <Metric label="Hit rate" value={pct(report.control.hitRatePct)} />
              <Metric label="ROI 1u" value={pct(report.control.flatStakeRoiPct)} />
              <Metric label="Profit" value={`${report.control.flatStakeProfitUnits > 0 ? "+" : ""}${report.control.flatStakeProfitUnits.toFixed(2)}u`} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">CLV medio {pp(report.control.meanClvPp)} · Brier {number(report.control.brierScore)} · Log loss {number(report.control.logLoss)}</p>
          </div>
        </div>

        {(roiInterval || diffInterval) && <div className="rounded-xl border border-border/65 bg-background/30 p-3 text-xs">
          <p className="font-semibold">Inferencia registrada · bootstrap por fecha</p>
          {roiInterval && <p className="mt-1 text-muted-foreground">ROI candidato 95%: {pct(roiInterval.lower)} a {pct(roiInterval.upper)} · punto {pct(roiInterval.pointEstimate)}</p>}
          {diffInterval && <p className="mt-1 text-muted-foreground">Δ ROI vs control 95%: {pp(diffInterval.lower)} a {pp(diffInterval.upper)} · punto {pp(diffInterval.pointEstimate)}</p>}
        </div>}

        {report.blockers.length > 0 && <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="text-xs font-semibold">Bloqueadores del edge</p><p className="mt-1 text-[11px] opacity-80">{report.blockers.join(" · ")}</p></div></div>
        </div>}

        <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.05] p-3 text-xs text-cyan-100">
          <div className="flex items-start gap-2"><FlaskConical className="mt-0.5 h-4 w-4 shrink-0" /><p><strong>Regla de dinero:</strong> esta tarjeta monitorea una hipótesis prospectiva congelada. Aunque llegue a “Edge respaldado”, el sistema sigue con <strong>money gate apagado</strong>; no cambia stake, no apuesta y no restaura ULTRA.</p></div>
        </div>
      </CardContent>
    </Card>
  );
}
