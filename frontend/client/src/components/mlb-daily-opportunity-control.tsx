import { useState } from "react";
import { Brain, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { MlbDailyBestPickCard } from "@/components/mlb-daily-best-pick-card";
import { apiRequest, ApiError } from "@/lib/queryClient";

type OpportunityAction = "WAIT" | "PLAY_NOW_CANDIDATE" | "NO_PLAY";
type FinalAction = "PLAY" | "WAIT" | "NO_PLAY";

type OpportunityEntry = {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  intrinsicClassification: string;
  eligibleSportingOpportunity: boolean;
  context: {
    thesisKinds: string[];
    thesisStructures: string[];
    supportingComponents: string[];
    fullGameElite: boolean;
    earlyWindowElite: boolean;
    maxAbsoluteNativeRunSignal: number;
  };
  probability: {
    stage: "CONFIRMED_V16" | "PROVISIONAL_V16" | "INTRINSIC_ONLY";
    selectedSide: "HOME" | "AWAY" | null;
    selectedSideProbability: number | null;
    lineupUncertaintyP95: number;
    robustSelectedSideProbability: number | null;
  };
};

type PriceShortlistEntry = {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  selectedSide: "HOME" | "AWAY" | null;
  selectedSideProbability: number | null;
  robustSelectedSideProbability: number | null;
  priceTiming: "READY_IF_PRICE_LAYER_INVOKED" | "DEFER_UNTIL_FINAL_INPUTS";
  selectionBasis: string[];
};

type FinalRecommendation = {
  gamePk: number;
  contextRank: number;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selectedSide: string;
  selectedLine: number | null;
  modelWinProbability: number;
  expectedValuePerUnit: number;
};

type DailyOpportunityResponse = {
  schemaVersion: string;
  status: "OPPORTUNITY_INPUTS_BLOCKED" | "OPPORTUNITY_PRICED_EVALUATED";
  runId: string;
  date: string;
  generatedAt: string;
  slate: {
    total: number;
    finalReady: number;
    provisional: number;
    waitingForPitchers: number;
    startedOrClosed: number;
    dataInsufficient: number;
  };
  blockers?: unknown[];
  dailyBestPick?: unknown;
  dailyOpportunity?: {
    action: OpportunityAction;
    primaryOpportunity: OpportunityEntry | null;
    nonDominatedFrontier: OpportunityEntry[];
    rankedOpportunities: OpportunityEntry[];
    summary: {
      intrinsicEvaluatedGames: number;
      eligibleSportingOpportunities: number;
      provisionalEligibleOpportunities: number;
      finalEligibleOpportunities: number;
      frontierSize: number;
    };
    decisionReason: string;
  };
  priceConsultationShortlist?: {
    entries: PriceShortlistEntry[];
    summary: {
      wholeSlateSportingOpportunitiesEvaluated: number;
      nonDominatedFrontierSize: number;
      shortlistedForPossiblePriceConsultation: number;
      readyFinalCandidates: number;
      deferredProvisionalCandidates: number;
    };
  };
  decision?: {
    action: FinalAction;
    reason: string;
    recommendation: FinalRecommendation | null;
  };
  summary?: {
    wholeSlateSportingOpportunitiesEvaluated: number;
    shortlistedForPossiblePriceConsultation: number;
    deferredProvisionalCandidates: number;
    readyFinalCandidates: number;
    gamesExposedToOddsService: number;
    paidEventOddsCalls: number;
    eliteEvidenceCandidates: number;
  };
  policy?: {
    maximumPriceConsultationCandidates?: number;
    automaticBetPlacement?: boolean;
    realFinancialExposure?: number;
  };
};

function pct(value: number | null | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : "N/D";
}

function ev(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
    : "N/D";
}

function startTimeLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Hora N/D";
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function blockerLabel(blocker: unknown): string {
  if (typeof blocker === "string") return blocker;
  if (blocker && typeof blocker === "object") {
    const row = blocker as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : "";
    const message = typeof row.message === "string" ? row.message : "";
    return [code, message].filter(Boolean).join(": ") || "Bloqueo certificado";
  }
  return "Bloqueo certificado";
}

function decisionText(action: FinalAction | undefined, reason: string | undefined): {
  title: string;
  detail: string;
} {
  if (action === "PLAY") {
    return {
      title: "PLAY · MEJOR OPORTUNIDAD DEL DÍA",
      detail: "La oportunidad sobrevivió contexto deportivo, confirmación de inputs y evaluación económica sin quedar dominada por otro candidato.",
    };
  }
  if (action === "WAIT") {
    if (reason === "PROVISIONAL_FRONTIER_REMAINS") {
      return {
        title: "WAIT · HAY UNA OPORTUNIDAD POSTERIOR COMPETITIVA",
        detail: "Al menos un candidato no dominado todavía usa lineup provisional. No se cruza a cuotas hasta que ese candidato quede FINAL o pierda su lugar.",
      };
    }
    if (reason === "MULTIPLE_NONDOMINATED_PRICE_OPPORTUNITIES") {
      return {
        title: "WAIT · TODAVÍA NO HAY UN GANADOR ÚNICO",
        detail: "Después de precio siguen existiendo varias oportunidades no dominadas. El motor no fuerza una jugada con un peso universal.",
      };
    }
    return {
      title: "WAIT · FALTA CERRAR EVIDENCIA",
      detail: "La mejor decisión ahora es esperar: todavía existe incertidumbre deportiva o económica que puede cambiar la selección final.",
    };
  }
  return {
    title: "NO PLAY · NO HAY OPORTUNIDAD JUGABLE",
    detail: "El slate fue evaluado, pero ninguna oportunidad sobrevivió con suficiente calidad deportiva y económica para recomendar una jugada.",
  };
}

function sideTeam(entry: OpportunityEntry | PriceShortlistEntry): string {
  const selectedSide = "probability" in entry ? entry.probability.selectedSide : entry.selectedSide;
  if (selectedSide === "HOME") return entry.homeTeam;
  if (selectedSide === "AWAY") return entry.awayTeam;
  return "Lado por definir";
}

export function MlbDailyOpportunityControl() {
  const [date, setDate] = useState(todayFL());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DailyOpportunityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest(
        "POST",
        "/api/mlb/unified-v16/daily-opportunity/run-priced",
        { date },
      );
      setResult((await response.json()) as DailyOpportunityResponse);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "No se pudo evaluar la jornada MLB.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const blocked = result?.status === "OPPORTUNITY_INPUTS_BLOCKED";
  const decision = result?.decision;
  const decisionCopy = decisionText(decision?.action, decision?.reason);
  const opportunity = result?.dailyOpportunity;
  const shortlist = result?.priceConsultationShortlist?.entries ?? [];
  const primary = opportunity?.primaryOpportunity ?? null;
  const rankedByPk = new Map((opportunity?.rankedOpportunities ?? []).map((entry) => [entry.gamePk, entry]));
  const recommendation = decision?.recommendation ?? null;
  const statusLabel = !result
    ? "IDLE"
    : blocked
      ? "BLOCKED"
      : decision?.action ?? opportunity?.action ?? "EVALUATED";
  const statusVariant = blocked || decision?.action === "NO_PLAY"
    ? "destructive"
    : decision?.action === "PLAY"
      ? "default"
      : "secondary";

  return (
    <Card className="mx-4 mt-4 border-primary/30 bg-card/95" data-testid="mlb-daily-opportunity-control">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="h-5 w-5 text-primary" />
              MLB Unified V16 · Daily Opportunity
            </CardTitle>
            <p className="mt-1 max-w-4xl text-xs text-muted-foreground">
              Evalúa toda la jornada antes de cuotas. Los juegos con lineup provisional compiten con incertidumbre empírica; solo 1–3 oportunidades pueden cruzar después a precio.
            </p>
          </div>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <DatePickerFL value={date} onChange={(next) => {
            setDate(next);
            setResult(null);
            setError(null);
          }} />
          <Button onClick={execute} disabled={loading} data-testid="button-mlb-daily-opportunity-run">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            {loading ? "Evaluando jornada" : "Ejecutar V16"}
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="space-y-3 rounded-md border border-border/70 p-3 text-sm">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><div className="text-xs text-muted-foreground">Juegos</div><div className="font-semibold">{result.slate.total}</div></div>
              <div><div className="text-xs text-muted-foreground">Final listos</div><div className="font-semibold">{result.slate.finalReady}</div></div>
              <div><div className="text-xs text-muted-foreground">Provisionales</div><div className="font-semibold">{result.slate.provisional}</div></div>
              <div><div className="text-xs text-muted-foreground">Pitchers pendientes</div><div className="font-semibold">{result.slate.waitingForPitchers}</div></div>
            </div>

            {blocked ? (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <div className="font-semibold text-destructive">Evaluación contextual bloqueada</div>
                <div className="text-xs text-muted-foreground">
                  Falta evidencia certificada para comparar de forma justa todos los competidores. No se consultaron cuotas.
                </div>
                {Array.isArray(result.blockers) && result.blockers.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-xs">
                    {result.blockers.map((blocker, index) => (
                      <li key={`${index}-${blockerLabel(blocker)}`}>{blockerLabel(blocker)}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <>
                <div className={`rounded-lg border-2 p-4 ${decision?.action === "PLAY" ? "border-primary/60 bg-primary/10" : decision?.action === "WAIT" ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-background/70"}`} data-testid="mlb-daily-opportunity-decision">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-lg font-extrabold tracking-wide">{decisionCopy.title}</div>
                      <div className="mt-1 max-w-4xl text-xs text-muted-foreground">{decisionCopy.detail}</div>
                    </div>
                    <Badge variant={statusVariant}>{decision?.action ?? opportunity?.action}</Badge>
                  </div>

                  {decision?.action === "PLAY" && recommendation && (
                    <div className="mt-4 rounded-md border border-primary/30 bg-background/70 p-3">
                      <div className="font-bold">{recommendation.awayTeam} @ {recommendation.homeTeam}</div>
                      <div className="mt-1 text-base font-extrabold">
                        {recommendation.marketType} · {recommendation.selectedSide}{recommendation.selectedLine == null ? "" : ` ${recommendation.selectedLine > 0 ? "+" : ""}${recommendation.selectedLine}`}
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <div><div className="text-[11px] text-muted-foreground">Context rank</div><div className="font-semibold">#{recommendation.contextRank}</div></div>
                        <div><div className="text-[11px] text-muted-foreground">Prob. modelo</div><div className="font-semibold">{pct(recommendation.modelWinProbability)}</div></div>
                        <div><div className="text-[11px] text-muted-foreground">EV / unidad</div><div className="font-semibold">{ev(recommendation.expectedValuePerUnit)}</div></div>
                      </div>
                    </div>
                  )}

                  {decision?.action === "WAIT" && primary && (
                    <div className="mt-4 rounded-md border border-amber-500/30 bg-background/70 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-bold">{primary.awayTeam} @ {primary.homeTeam}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Líder actual: {sideTeam(primary)} · {startTimeLabel(primary.startTime)} ET
                          </div>
                        </div>
                        <Badge variant="secondary">{primary.inputStage}</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div><div className="text-[11px] text-muted-foreground">Context rank</div><div className="font-semibold">#{primary.contextRank}</div></div>
                        <div><div className="text-[11px] text-muted-foreground">Prob. estimada</div><div className="font-semibold">{pct(primary.probability.selectedSideProbability)}</div></div>
                        <div><div className="text-[11px] text-muted-foreground">Prob. robusta</div><div className="font-semibold">{pct(primary.probability.robustSelectedSideProbability)}</div></div>
                        <div><div className="text-[11px] text-muted-foreground">Incertidumbre lineup P95</div><div className="font-semibold">{pct(primary.probability.lineupUncertaintyP95)}</div></div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div><div className="text-[11px] text-muted-foreground">Slate analizado</div><div className="font-semibold">{result.summary?.wholeSlateSportingOpportunitiesEvaluated ?? opportunity?.summary.intrinsicEvaluatedGames ?? 0}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Oportunidades válidas</div><div className="font-semibold">{opportunity?.summary.eligibleSportingOpportunities ?? 0}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Shortlist para cuotas</div><div className="font-semibold">{shortlist.length} / 3</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Juegos consultados a precio</div><div className="font-semibold">{result.summary?.gamesExposedToOddsService ?? 0}</div></div>
                </div>

                {shortlist.length > 0 && (
                  <div className="space-y-2" data-testid="mlb-daily-opportunity-shortlist">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide">Top oportunidades · máximo 3 para cuotas</div>
                      <Badge variant="outline">SLATE COMPLETO → 1–3</Badge>
                    </div>
                    {shortlist.map((entry, index) => {
                      const context = rankedByPk.get(entry.gamePk);
                      return (
                        <div key={entry.gamePk} className="rounded-lg border border-border bg-background/70 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="font-semibold">#{index + 1} · {entry.awayTeam} @ {entry.homeTeam}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {startTimeLabel(entry.startTime)} ET · lado: <span className="font-semibold text-foreground">{sideTeam(entry)}</span>
                              </div>
                            </div>
                            <div className="flex gap-1">
                              <Badge variant={entry.inputStage === "FINAL" ? "default" : "secondary"}>{entry.inputStage}</Badge>
                              <Badge variant="outline">Context #{entry.contextRank}</Badge>
                            </div>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <div><div className="text-[11px] text-muted-foreground">Prob. V16</div><div className="font-semibold">{pct(entry.selectedSideProbability)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Prob. robusta</div><div className="font-semibold">{pct(entry.robustSelectedSideProbability)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Estado precio</div><div className="font-semibold">{entry.priceTiming === "READY_IF_PRICE_LAYER_INVOKED" ? "LISTO" : "ESPERA FINAL"}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Señal contextual</div><div className="font-semibold">{context ? context.context.maxAbsoluteNativeRunSignal.toFixed(3) : "N/D"}</div></div>
                          </div>
                          {context && context.context.supportingComponents.length > 0 && (
                            <div className="mt-3 text-xs text-muted-foreground">
                              <span className="font-semibold text-foreground">Contexto particular:</span>{" "}
                              {context.context.supportingComponents.join(" · ")}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide">Ruta certificada MLB</div>
                    <Badge variant="outline">A+ → Premium → PP_HORIZON → Full Modular</Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Esta tarjeta conserva la jerarquía deportiva certificada. La decisión Daily Opportunity de arriba es la que compara toda la jornada y decide PLAY / WAIT / NO PLAY.
                  </div>
                  <MlbDailyBestPickCard value={result.dailyBestPick} />
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
