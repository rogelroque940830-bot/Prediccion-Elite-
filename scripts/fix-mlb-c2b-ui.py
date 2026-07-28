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
    '''            homeProbabilityDeltaPp: injuryProbDelta,
            totalRunsDelta: injuryTotalDelta,
            dataQuality: injuryDataQuality,
            hasAppliedAdjustment: hasInjuries,
''',
    '''            homeProbabilityDeltaPp: result.factorBreakdown?.injuryHomeProbabilityDeltaPp ?? 0,
            totalRunsDelta: result.factorBreakdown?.injuryTotalRunsDelta ?? 0,
            dataQuality: result.factorBreakdown?.injuryDataQuality ?? "DEGRADED",
            hasAppliedAdjustment: result.factorBreakdown?.injuryHasAppliedAdjustment ?? false,
''',
    "snapshot effect values",
)
text = replace_once(
    text,
    '''        baseTotal,
        finalTotal: estimatedTotal,
        notes: factorNotes,
''',
    '''        baseTotal,
        finalTotal: estimatedTotal,
        injuryHomeProbabilityDeltaPp: injuryProbDelta,
        injuryTotalRunsDelta: injuryTotalDelta,
        injuryDataQuality,
        injuryHasAppliedAdjustment: hasInjuries,
        notes: factorNotes,
''',
    "result factor breakdown effect",
)
predictor.write_text(text, encoding="utf-8")

history = Path("frontend/client/src/pages/mlb-history.tsx")
ui = history.read_text(encoding="utf-8")
ui = replace_once(
    ui,
    '''                {[
                  ["Autoaplicadas", injuryOutcomes.cohorts.AUTO_APPLIED],
                  ["Retenidas", injuryOutcomes.cohorts.RETAINED],
                  ["Sin autoajuste", injuryOutcomes.cohorts.NO_AUTO_ADJUSTMENT],
                  ["Cobertura parcial", injuryOutcomes.cohorts.PARTIAL_COVERAGE],
                ].map(([label, raw]) => {
                  const cohort = raw as InjuryOutcomeMetricSummary;
                  return (
                    <div key={String(label)} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
                      <p className="font-semibold text-violet-200">{label}</p>
''',
    '''                {([
                  { label: "Autoaplicadas", cohort: injuryOutcomes.cohorts.AUTO_APPLIED },
                  { label: "Retenidas", cohort: injuryOutcomes.cohorts.RETAINED },
                  { label: "Sin autoajuste", cohort: injuryOutcomes.cohorts.NO_AUTO_ADJUSTMENT },
                  { label: "Cobertura parcial", cohort: injuryOutcomes.cohorts.PARTIAL_COVERAGE },
                ] as Array<{ label: string; cohort: InjuryOutcomeMetricSummary }>).map(({ label, cohort }) => {
                  return (
                    <div key={label} className="rounded-lg border border-slate-700 bg-slate-950/30 p-2.5 text-xs">
                      <p className="font-semibold text-violet-200">{label}</p>
''',
    "history cohort typing",
)
history.write_text(ui, encoding="utf-8")
