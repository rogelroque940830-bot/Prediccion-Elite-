import type { MlbPremiumNoUltraMetricSummary, MlbPremiumNoUltraReport } from "@/lib/mlb-premium-no-ultra-prospective";

const STATES = {
  COLLECTING_PROSPECTIVE_EVIDENCE: "Recolectando evidencia",
  CANDIDATE_NOT_CONFIRMED: "Edge no confirmado",
  ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY: "Edge respaldado · investigación",
} as const;
const BOX = "rounded-lg border border-border/60 p-3 text-xs";
const fmt = (value: number | null, digits = 1, suffix = "") => value == null ? "—" : `${value.toFixed(digits)}${suffix}`;

function metrics(m: MlbPremiumNoUltraMetricSummary, calibration = false): string {
  const profit = `${m.flatStakeProfitUnits > 0 ? "+" : ""}${m.flatStakeProfitUnits.toFixed(2)}u`;
  const cal = calibration ? ` · Cal ${m.calibrationGap == null ? "—" : fmt(m.calibrationGap * 100, 1, "%")}` : "";
  return `n=${m.settled} · W-L ${m.wins}-${m.losses} · Hit ${fmt(m.hitRatePct, 1, "%")} · ROI ${fmt(m.flatStakeRoiPct, 1, "%")} · Profit ${profit} · CLV ${fmt(m.meanClvPp, 2, " pp")} · Brier ${fmt(m.brierScore, 4)} · Log ${fmt(m.logLoss, 4)}${cal}`;
}

export function MlbPremiumNoUltraCard({ report, isFetching, onRefresh }: {
  report: MlbPremiumNoUltraReport;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const p = report.preregistration;
  const roi = report.inference.candidateRoiPct;
  const delta = report.inference.candidateMinusControlRoiPp;
  return <section className="mt-4 space-y-3 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.04] p-4" data-testid="premium-no-ultra-prospective-card">
    <div className="flex flex-wrap justify-between gap-2">
      <div><strong>Edge Prospectivo F5 · PREMIUM sin ULTRA</strong><p className="text-sm text-cyan-100">{STATES[report.state]}</p></div>
      {onRefresh && <button type="button" className="rounded-md border px-3 py-1 text-xs" onClick={onRefresh} disabled={isFetching}>Actualizar</button>}
    </div>
    <p className={`${BOX} text-muted-foreground`}>
      FINAL · 1 juego = 1 observación · Corte 08/08/2026 · 13-4 histórico excluido.<br />
      Candidato {report.cohort.candidateSettled}/{p.minimumCandidateSettled} settled, {report.cohort.candidateDates}/{p.minimumCandidateDates} fechas · Control {report.cohort.controlSettled}/{p.minimumControlSettled} settled, {report.cohort.controlDates}/{p.minimumControlDates} fechas
    </p>
    <p className={`${BOX} text-muted-foreground`}><strong>PREMIUM sin ULTRA:</strong> {metrics(report.candidate, true)}</p>
    <p className={`${BOX} text-muted-foreground`}><strong>Control:</strong> {metrics(report.control)}</p>
    {(roi || delta) && <p className={`${BOX} text-muted-foreground`}>
      Bootstrap 95%{roi ? ` · ROI ${fmt(roi.lower, 1, "%")} a ${fmt(roi.upper, 1, "%")}` : ""}{delta ? ` · Δ control ${fmt(delta.lower, 2, " pp")} a ${fmt(delta.upper, 2, " pp")}` : ""}
    </p>}
    {report.blockers.length > 0 && <p className="rounded-lg border border-amber-500/25 p-3 text-xs"><strong>Bloqueadores:</strong> {report.blockers.join(" · ")}</p>}
    <p className="rounded-lg border border-cyan-500/25 p-3 text-xs text-cyan-100"><strong>Regla de dinero:</strong> incluso con “Edge respaldado”, <strong>money gate apagado</strong>; sin cambios de stake, apuestas automáticas ni restauración de ULTRA.</p>
  </section>;
}
