import type { MlbPremiumNoUltraMetricSummary, MlbPremiumNoUltraReport } from "@/lib/mlb-premium-no-ultra-prospective";

const STATES = {
  COLLECTING_PROSPECTIVE_EVIDENCE: "Recolectando evidencia",
  CANDIDATE_NOT_CONFIRMED: "Edge no confirmado",
  ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY: "Edge respaldado",
} as const;
const BOX = "border p-2 text-xs";
const fmt = (value: number | null, digits = 1, suffix = "") => value == null ? "—" : `${value.toFixed(digits)}${suffix}`;

function metrics(m: MlbPremiumNoUltraMetricSummary, calibration = false): string {
  const profit = `${m.flatStakeProfitUnits > 0 ? "+" : ""}${m.flatStakeProfitUnits.toFixed(2)}u`;
  const cal = calibration ? ` · Cal ${m.calibrationGap == null ? "—" : fmt(m.calibrationGap * 100, 1, "%")}` : "";
  return `n=${m.settled} · ${m.wins}-${m.losses} · Hit ${fmt(m.hitRatePct, 1, "%")} · ROI ${fmt(m.flatStakeRoiPct, 1, "%")} · P/L ${profit} · CLV ${fmt(m.meanClvPp, 2, " pp")} · Brier ${fmt(m.brierScore, 4)} · Log ${fmt(m.logLoss, 4)}${cal}`;
}

export function MlbPremiumNoUltraCard({ report }: { report: MlbPremiumNoUltraReport }) {
  const p = report.preregistration;
  const roi = report.inference.candidateRoiPct;
  const delta = report.inference.candidateMinusControlRoiPp;
  return <section className="mt-4 space-y-2 rounded-xl border p-3">
    <div><strong>Edge Prospectivo F5 · PREMIUM sin ULTRA</strong><p className="text-sm">{STATES[report.state]}</p></div>
    <p className={BOX}>
      FINAL · 1 juego=1 obs · corte 08/08/2026 · 13-4 excluido.<br />
      Cand. {report.cohort.candidateSettled}/{p.minimumCandidateSettled} settled, {report.cohort.candidateDates}/{p.minimumCandidateDates} fechas · Control {report.cohort.controlSettled}/{p.minimumControlSettled} settled, {report.cohort.controlDates}/{p.minimumControlDates} fechas
    </p>
    <p className={BOX}><strong>PREMIUM sin ULTRA:</strong> {metrics(report.candidate, true)}</p>
    <p className={BOX}><strong>Control:</strong> {metrics(report.control)}</p>
    {(roi || delta) && <p className={BOX}>
      95% bootstrap{roi ? ` · ROI ${fmt(roi.lower, 1, "%")}–${fmt(roi.upper, 1, "%")}` : ""}{delta ? ` · Δ ${fmt(delta.lower, 2, " pp")}–${fmt(delta.upper, 2, " pp")}` : ""}
    </p>}
    {report.blockers.length > 0 && <p className={BOX}><strong>Bloqueos:</strong> {report.blockers.join(" · ")}</p>}
    <p className={BOX}><strong>Regla:</strong> <strong>money gate apagado</strong>; sin stake, apuestas automáticas ni ULTRA.</p>
  </section>;
}
