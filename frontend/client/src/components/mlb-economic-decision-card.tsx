import {
  AlertTriangle,
  BadgeDollarSign,
  CircleDollarSign,
  Gauge,
  ShieldAlert,
  ShieldCheck,
  Target,
  TimerReset,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatMlbAmericanOdds,
  formatMlbPercent,
  formatMlbSigned,
  type MlbEconomicActionability,
  type MlbEconomicAdapterResult,
  type MlbEconomicSignal,
} from "@/lib/mlb-economic-decision";

const REASON_LABELS: Record<string, string> = {
  GATE_STATUS_STAGE_MISMATCH: "La etapa no coincide con la compuerta certificada.",
  READINESS_HAS_BLOCKERS: "La verificación pregame mantiene bloqueadores activos.",
  CERTIFIED_QUOTE_MISMATCH: "La cuota usada no coincide con la cuota certificada.",
  CERTIFIED_LINE_MISMATCH: "La línea usada no coincide con la línea certificada.",
  MARKET_QUOTE_STALE: "La cuota certificada quedó vencida.",
  BILATERAL_PRICE_REQUIRED: "Falta el precio del lado contrario para calcular no-vig.",
  MODEL_PROBABILITY_INVALID: "La probabilidad del modelo no es válida.",
  CURRENT_ODDS_INVALID: "La cuota actual no es una cuota americana válida.",
  NO_POSITIVE_EXPECTED_VALUE: "El valor esperado no es positivo al precio actual.",
  EDGE_BELOW_LEAN_FLOOR: "El edge no supera el mínimo requerido para LEAN.",
  BET_CONFIDENCE_BELOW_FLOOR: "El edge supera 8 pp, pero la probabilidad no alcanza 70%.",
  PRICE_WORSE_THAN_MINIMUM: "El precio actual es peor que el mínimo aceptable.",
  PROVISIONAL_REQUIRES_FINAL_CONFIRMATION: "Esperar confirmación FINAL antes de considerar acción.",
  SOURCE_SIGNAL_CEILING_APPLIED: "La señal original limita una recomendación económica más agresiva.",
  SOURCE_INFO_CONTROL_ONLY: "La señal INFO se conserva únicamente como control científico.",
};

function signalStyle(signal: MlbEconomicSignal): string {
  if (signal === "BET") return "border-emerald-500/55 bg-emerald-500/15 text-emerald-200";
  if (signal === "LEAN") return "border-amber-500/55 bg-amber-500/15 text-amber-200";
  return "border-slate-500/55 bg-slate-500/10 text-slate-300";
}

function actionabilityStyle(value: MlbEconomicActionability): string {
  if (value === "ACTIONABLE_FINAL") return "border-emerald-400/60 text-emerald-200";
  if (value === "WAIT_FOR_FINAL") return "border-amber-400/60 text-amber-200";
  if (value === "BLOCKED") return "border-red-400/60 text-red-200";
  return "border-slate-500/50 text-slate-300";
}

function actionabilityLabel(value: MlbEconomicActionability): string {
  if (value === "ACTIONABLE_FINAL") return "FINAL ACCIONABLE";
  if (value === "WAIT_FOR_FINAL") return "ESPERAR FINAL";
  if (value === "BLOCKED") return "BLOQUEADO";
  return "SOLO OBSERVAR";
}

function marketLabel(value: string): string {
  if (value === "F5_ML") return "F5 Moneyline";
  if (value === "RUN_LINE") return "Run Line";
  if (value === "TOTAL") return "Total O/U";
  if (value === "F5_TOTAL") return "F5 Total";
  return "Moneyline";
}

function metric(label: string, value: string, hint?: string) {
  return (
    <div className="rounded-lg border border-slate-700/55 bg-slate-950/45 p-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-base font-bold text-white">{value}</p>
      {hint && <p className="mt-0.5 text-[9px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function MlbEconomicDecisionCard({ decision }: { decision: MlbEconomicAdapterResult }) {
  const raw = decision.economicDecision;
  const effective = decision.effectiveDecision;
  const activeMinimum = raw.minimumPrices.active;
  const currentMeetsActive = effective.decision === "BET"
    ? raw.currentPrice.meetsBetMinimum
    : effective.decision === "LEAN"
      ? raw.currentPrice.meetsLeanMinimum
      : false;
  const reasons = Array.from(new Set(effective.reasons));
  const isActionable = effective.actionability === "ACTIONABLE_FINAL";
  const waitFinal = effective.actionability === "WAIT_FOR_FINAL";
  const blocked = effective.actionability === "BLOCKED";

  return (
    <Card
      className={isActionable
        ? "border-2 border-emerald-500/55 bg-gradient-to-br from-emerald-500/10 via-slate-950/70 to-cyan-500/5"
        : waitFinal
          ? "border-2 border-amber-500/45 bg-gradient-to-br from-amber-500/10 to-slate-950/70"
          : blocked
            ? "border-2 border-red-500/45 bg-red-500/[0.06]"
            : "border border-slate-600/55 bg-slate-950/55"}
      data-testid="p1-m4c-economic-decision-card"
      data-economic-decision={effective.decision}
      data-economic-actionability={effective.actionability}
    >
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-base text-white">
                <BadgeDollarSign className="h-5 w-5 text-cyan-300" />
                Decisión económica certificada
              </CardTitle>
              <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M4C</Badge>
              <Badge variant="outline" className="border-slate-500/40 text-slate-300">SHADOW · exposición 0</Badge>
            </div>
            <p className="mt-2 truncate text-lg font-bold text-white" title={decision.source.selection}>
              {decision.source.selection}
            </p>
            <p className="text-xs text-slate-400">
              {marketLabel(decision.source.market)} · {raw.stage} · cuota certificada {formatMlbAmericanOdds(raw.currentPrice.oddsAmerican)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <Badge className={`border px-3 py-1 text-sm ${signalStyle(effective.decision)}`}>
              {effective.decision}
            </Badge>
            <Badge variant="outline" className={`px-3 py-1 ${actionabilityStyle(effective.actionability)}`}>
              {actionabilityLabel(effective.actionability)}
            </Badge>
          </div>
        </div>

        {isActionable && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-3 text-sm text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              El mercado está FINAL, el precio conserva el mínimo BET y el contrato permite una exposición analítica de
              <strong> {effective.analyticalUnits.toFixed(2)} unidades SHADOW</strong>. Esto no coloca una apuesta.
            </p>
          </div>
        )}
        {waitFinal && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-100">
            <TimerReset className="mt-0.5 h-4 w-4 shrink-0" />
            <p>La señal se conserva para medición, pero el stake es 0. Espera la confirmación FINAL y una nueva certificación de precio.</p>
          </div>
        )}
        {blocked && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/35 bg-red-500/10 p-3 text-sm text-red-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>La integridad o el precio impiden considerar esta salida. No usarla como recomendación.</p>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {metric("Cuota actual", formatMlbAmericanOdds(raw.currentPrice.oddsAmerican), currentMeetsActive ? "Cumple el mínimo activo" : "No cumple o no aplica")}
          {metric("Cuota justa", formatMlbAmericanOdds(raw.fairPrice?.american ?? null), "Break-even del modelo")}
          {metric("Precio mínimo", formatMlbAmericanOdds(activeMinimum?.oddsAmerican ?? null), activeMinimum ? `Edge > ${activeMinimum.requiredEdgePp.toFixed(0)} pp` : "Sin señal activa")}
          {metric("Stake SHADOW", `${effective.analyticalUnits.toFixed(2)} u`, `Máximo ${raw.stake.maximumUnits.toFixed(2)} u`)}
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {metric("Modelo", formatMlbPercent(decision.source.modelProbability), "Probabilidad seleccionada")}
          {metric("Implícita", formatMlbPercent(decision.source.marketImpliedProbability), "Incluye vig")}
          {metric("No-vig", formatMlbPercent(decision.source.noVigProbability), "Mercado bilateral")}
          {metric("Edge", `${formatMlbSigned(raw.economics.edgePp, 2)} pp`, raw.economics.noVigEdgePp == null ? undefined : `No-vig ${formatMlbSigned(raw.economics.noVigEdgePp, 2)} pp`)}
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="flex items-start gap-2 rounded-lg border border-slate-700/55 bg-slate-900/45 p-3">
            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            <div>
              <p className="text-[9px] uppercase tracking-wider text-slate-500">EV por unidad</p>
              <p className={`font-mono text-lg font-bold ${(raw.economics.expectedValuePerUnit ?? 0) > 0 ? "text-emerald-300" : "text-red-300"}`}>
                {formatMlbSigned(raw.economics.expectedValuePerUnit, 4)}
              </p>
              <p className="text-[9px] text-slate-500">Estimación, no ganancia garantizada</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-slate-700/55 bg-slate-900/45 p-3">
            <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div>
              <p className="text-[9px] uppercase tracking-wider text-slate-500">Kelly diagnóstico</p>
              <p className="font-mono text-lg font-bold text-cyan-200">{formatMlbPercent(raw.economics.quarterKellyFraction, 2)}</p>
              <p className="text-[9px] text-slate-500">Quarter-Kelly antes del cap</p>
            </div>
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-slate-700/55 bg-slate-900/45 p-3">
            <Target className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <p className="text-[9px] uppercase tracking-wider text-slate-500">Señal original → efectiva</p>
              <p className="font-mono text-sm font-bold text-white">{decision.source.sourceSignal} → {effective.decision}</p>
              <p className="text-[9px] text-slate-500">{decision.signalCompatibility.relation.replaceAll("_", " ")}</p>
            </div>
          </div>
        </div>

        {effective.sourceSignalCeilingApplied && (
          <div className="flex items-start gap-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.07] p-3 text-xs text-violet-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            La capa económica detectó una salida más agresiva, pero respetó la señal original y la redujo automáticamente.
          </div>
        )}

        {reasons.length > 0 && (
          <div className="rounded-lg border border-slate-700/55 bg-slate-950/50 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
              Razones y condiciones de invalidación
            </p>
            <div className="grid gap-1.5 md:grid-cols-2">
              {reasons.slice(0, 8).map((reason) => (
                <p key={reason} className="text-[11px] text-slate-400">
                  <span className="mr-1 font-mono text-amber-300">•</span>
                  {REASON_LABELS[reason] ?? reason.replaceAll("_", " ")}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-slate-700/45 pt-3 text-[10px] text-slate-500">
          <CircleDollarSign className="h-3.5 w-3.5" />
          La tarjeta muestra disciplina de precio y evidencia SHADOW. No conecta con sportsbook ni ejecuta apuestas.
        </div>
      </CardContent>
    </Card>
  );
}
