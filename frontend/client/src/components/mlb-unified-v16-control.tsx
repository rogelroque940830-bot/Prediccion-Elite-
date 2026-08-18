import { useState } from "react";
import { Brain, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MlbDailyBestPickCard } from "@/components/mlb-daily-best-pick-card";
import { MlbDailyBestPickPriceCard } from "@/components/mlb-daily-best-pick-price-card";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { apiRequest, ApiError } from "@/lib/queryClient";

interface V16UiGame {
  gamePk: number;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  analysisStage: "FINAL" | "PROVISIONAL" | "BLOCKED";
  readiness: string;
  blockers: string[];
}

interface V16RunnerSummary {
  finalGamesScoredByV16: number;
  modelAssessments: number;
  paidLookupEligibleGames: number;
  positiveEvMarkets: number;
  eliteEvidenceCandidates: number;
  eliteEvidenceRowsCaptured: number;
}

interface V16EliteCandidate {
  predictionId: string;
  gamePk: number;
  awayTeam: string;
  homeTeam: string;
  marketType: string;
  selectedSide: string;
  selectedLine: number | null;
  modelWinProbability: number;
  modelPushProbability: number;
  expectedValuePerUnit: number;
  executionEdgePp: number;
  executionNoVigEdgePp: number;
  referenceNoVigEdgePp: number | null;
  referenceAgreement: string;
  executionBookTitle: string;
  executionOddsAmerican: number;
  executionCapturedAt: string;
  intrinsicProjectionScope: string;
  intrinsicThesisKinds: string[];
  supportingComponents: string[];
}

interface V16NoPlayGameAudit {
  gamePk: number;
  sportsPrediction: {
    scoredByV16: boolean;
    fullGameHomeWinProbability: number | null;
    fullGameAwayWinProbability: number | null;
    first5HomeWinProbability: number | null;
    first5AwayWinProbability: number | null;
    first5TieProbability: number | null;
  };
  prePriceRouting: {
    shortlistEvaluated: boolean;
    shortlistQualified: boolean;
    shortlistSelected: boolean;
    certifiedComponentCount: number | null;
    independentSignalCount: number | null;
    intrinsicEvaluated: boolean;
    intrinsicResearchClassification: string | null;
    selectedForMarketDiscovery: boolean;
    intrinsicRank: number | null;
    plannedMarkets: string[];
    paidLookupEligibleNow: boolean;
    paidLookupHoldReason: string | null;
  };
  bettingEconomics: {
    pricedMarkets: number;
    positiveEvMarkets: number;
    noPositiveEvMarkets: number;
    blockedOrUnavailableMarkets: number;
    eliteEvidenceCandidates: number;
    marketClassifications: string[];
    operatingEnvelopeClassifications: string[];
  };
  earliestBlocker: string;
}

interface V16NoPlayAudit {
  schemaVersion: string;
  primaryBlocker: string;
  counts: Record<string, number>;
  blockerCounts: Record<string, number>;
  gameAudits: V16NoPlayGameAudit[];
  policy: {
    diagnosticsOnly: true;
    predictionRemainsPriceIndependent: true;
  };
}

type V16UiStatus =
  | "WAITING_FOR_FINAL_INPUTS"
  | "CERTIFIED_INPUT_ASSEMBLY_BLOCKED"
  | "RUN_COMPLETED";

interface V16UiResponse {
  schemaVersion: string;
  date: string;
  generatedAt: string;
  status: V16UiStatus;
  runnerEndpoint: string;
  slate: {
    total: number;
    finalReady: number;
    provisional: number;
    waitingForPitchers: number;
    startedOrClosed: number;
    dataInsufficient: number;
  };
  games: V16UiGame[];
  blockers?: unknown[];
  nextBoundary: string;
  result?: {
    schemaVersion: string;
    summary: V16RunnerSummary;
    prepriceSummary: Record<string, number>;
    dailyBestPick?: unknown;
    dailyBestPickPrice?: unknown;
    noPlayAudit?: V16NoPlayAudit;
    eliteCandidates: V16EliteCandidate[];
  };
  policy: {
    explicitInvocationRequired: true;
    certifiedServerAssemblyComplete?: boolean;
    pricedRunnerCalled?: boolean;
    paidOddsCalled?: boolean;
    theOddsApiCreditsConsumed?: number;
    browserReceivesProviderSecret: false;
    browserMayForgeCertifiedInputs: false;
    automaticPolling: false;
    finalBetRecommendationProduced?: false;
    stakeCalculated?: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function blockerLabel(blocker: unknown): string {
  if (typeof blocker === "string") return blocker;
  if (blocker && typeof blocker === "object") {
    const candidate = blocker as Record<string, unknown>;
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (code && message) return `${code}: ${message}`;
    if (code) return code;
    if (message) return message;
  }
  try {
    return JSON.stringify(blocker) ?? "Bloqueo certificado no identificado";
  } catch {
    return "Bloqueo certificado no identificado";
  }
}

function noPlayReasonLabel(code: string): string {
  const labels: Record<string, string> = {
    NONE: "No existe bloqueo: hay evidencia Elite capturada.",
    NO_FINAL_INPUTS: "Todavía no había juegos con inputs pregame FINAL.",
    NO_V16_SCORED_FINAL_GAME: "Había juego FINAL, pero V16 no pudo producir su probabilidad deportiva.",
    NO_V16_SCORE: "V16 no produjo probabilidad para este juego FINAL.",
    NO_SHORTLIST_SIGNAL_QUALIFICATION: "V16 sí calculó el juego, pero la ruta previa de señales certificadas no lo calificó para el shortlist.",
    EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP: "V16 sí calculó el juego, pero quedó fuera de la población limitada que llega a market discovery.",
    NO_STRONG_INTRINSIC_THESIS_ON_V16_SCORED_GAMES: "V16 sí calculó el juego, pero la capa intrínseca previa no generó una tesis suficientemente fuerte para consultar precio.",
    NO_STRONG_INTRINSIC_MARKET_THESIS: "La capa intrínseca previa no autorizó ningún mercado para este juego.",
    MIXED_PREPRICE_ROUTING_BLOCKERS: "Los juegos V16 fueron detenidos por más de un bloqueo antes de consultar cuotas.",
    NO_PAID_LOOKUP_ELIGIBILITY: "La ruta deportiva no autorizó todavía la consulta de una cuota ejecutable.",
    NO_FRESH_EXECUTABLE_PRICE: "La tesis deportiva llegó al mercado, pero no hubo una cuota ejecutable y fresca.",
    MARKET_OR_MODEL_BLOCKED: "La evaluación mercado-modelo quedó bloqueada por contrato, disponibilidad o consistencia.",
    NO_POSITIVE_EV: "La predicción llegó a precio, pero la cuota disponible no ofreció EV positivo.",
    POSITIVE_EV_ENVELOPE_BLOCKED: "Hubo EV positivo, pero otra condición del operating envelope bloqueó el candidato.",
    NO_ELITE_EVIDENCE_CANDIDATE: "La cadena llegó al final sin reunir todas las condiciones de candidato Elite.",
  };
  return labels[code] ?? code;
}

function pct(value: number | null | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "N/D";
}

function pp(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp` : "N/D";
}

function americanOdds(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function lineLabel(value: number | null): string {
  if (value === null) return "";
  return value > 0 ? ` +${value}` : ` ${value}`;
}

export function MlbUnifiedV16Control() {
  const [date, setDate] = useState(todayFL());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<V16UiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest("POST", "/api/mlb/unified-v16/ui-run", { date });
      setResult((await response.json()) as V16UiResponse);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "No se pudo ejecutar V16.";
      setError(message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const completed = result?.status === "RUN_COMPLETED";
  const blocked = result?.status === "CERTIFIED_INPUT_ASSEMBLY_BLOCKED";
  const waiting = result?.status === "WAITING_FOR_FINAL_INPUTS";
  const runSummary = result?.result?.summary;
  const dailyBestPick = result?.result?.dailyBestPick;
  const dailyBestPickPrice = result?.result?.dailyBestPickPrice;
  const noPlayAudit = result?.result?.noPlayAudit;
  const auditedGames = noPlayAudit?.gameAudits ?? [];
  const eliteCandidates = result?.result?.eliteCandidates ?? [];

  const statusLabel = !result
    ? "IDLE"
    : completed
      ? "RUN COMPLETED"
      : blocked
        ? "BLOCKED"
        : "PREFLIGHT";

  const statusVariant = blocked ? "destructive" : completed ? "default" : "secondary";

  return (
    <Card className="mx-4 mt-4 border-primary/30 bg-card/95" data-testid="mlb-v16-control">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="h-5 w-5 text-primary" />
              MLB Unified V16
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Ejecución explícita: primero estima el partido con evidencia deportiva pregame y solo después cruza a precio cuando la ruta certificada lo autoriza.
            </p>
          </div>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <DatePickerFL value={date} onChange={(next) => { setDate(next); setResult(null); setError(null); }} />
          <Button onClick={execute} disabled={loading} data-testid="button-mlb-v16-prepare">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            {loading ? "Ejecutando V16" : "Ejecutar V16"}
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

            {waiting && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                V16 está esperando inputs pregame FINAL. El priced runner no fue ejecutado y no se cruzó la frontera de cuotas pagadas.
              </div>
            )}

            {blocked && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <div className="font-semibold text-destructive">Ensamblaje certificado bloqueado</div>
                <div className="text-xs text-muted-foreground">
                  V16 se detuvo antes del priced runner porque falta o es inconsistente evidencia certificada del servidor.
                </div>
                {Array.isArray(result.blockers) && result.blockers.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-xs">
                    {result.blockers.map((blocker, index) => (
                      <li key={`${index}-${blockerLabel(blocker)}`}>{blockerLabel(blocker)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {completed && runSummary && (
              <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">V16 terminó correctamente</div>
                  <Badge variant="outline">EVIDENCIA CERTIFICADA</Badge>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <div><div className="text-[11px] text-muted-foreground">Final evaluados</div><div className="font-semibold">{runSummary.finalGamesScoredByV16}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Evaluaciones modelo</div><div className="font-semibold">{runSummary.modelAssessments}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Lookup elegible</div><div className="font-semibold">{runSummary.paidLookupEligibleGames}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Mercados +EV</div><div className="font-semibold">{runSummary.positiveEvMarkets}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Candidatos Elite</div><div className="font-semibold">{runSummary.eliteEvidenceCandidates}</div></div>
                  <div><div className="text-[11px] text-muted-foreground">Evidencia capturada</div><div className="font-semibold">{runSummary.eliteEvidenceRowsCaptured}</div></div>
                </div>

                <MlbDailyBestPickCard value={dailyBestPick} />
                <MlbDailyBestPickPriceCard value={dailyBestPickPrice} />

                {auditedGames.length > 0 && (
                  <div className="space-y-2" data-testid="mlb-v16-sports-predictions">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide">Predicción deportiva V16</div>
                      <Badge variant="secondary">INDEPENDIENTE DE CUOTA</Badge>
                    </div>
                    {auditedGames.map((audit) => {
                      const game = result.games.find((row) => row.gamePk === audit.gamePk);
                      const homeP = audit.sportsPrediction.fullGameHomeWinProbability;
                      const awayP = audit.sportsPrediction.fullGameAwayWinProbability;
                      const predictedTeam = homeP != null && awayP != null && game
                        ? homeP >= awayP ? game.homeTeam : game.awayTeam
                        : "N/D";
                      return (
                        <div key={audit.gamePk} className="rounded-lg border border-border bg-background/70 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="font-semibold">{game ? `${game.awayTeam} @ ${game.homeTeam}` : `Game ${audit.gamePk}`}</div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                Lado con mayor probabilidad Full Game: <span className="font-semibold text-foreground">{predictedTeam}</span>
                              </div>
                            </div>
                            <Badge variant="outline">V16 SPORTING MODEL</Badge>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <div><div className="text-[11px] text-muted-foreground">Home FG</div><div className="font-semibold">{pct(homeP)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Away FG</div><div className="font-semibold">{pct(awayP)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Home F5</div><div className="font-semibold">{pct(audit.sportsPrediction.first5HomeWinProbability)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Away F5</div><div className="font-semibold">{pct(audit.sportsPrediction.first5AwayWinProbability)}</div></div>
                            <div><div className="text-[11px] text-muted-foreground">Tie F5</div><div className="font-semibold">{pct(audit.sportsPrediction.first5TieProbability)}</div></div>
                          </div>
                          <div className="mt-3 rounded border border-border/60 bg-muted/20 p-2 text-xs">
                            <span className="font-semibold">Ruta pre-precio:</span>{" "}
                            {noPlayReasonLabel(audit.earliestBlocker)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {runSummary.eliteEvidenceCandidates === 0 ? (
                  <div className="rounded-lg border-2 border-border bg-background/70 p-4 text-center" data-testid="mlb-v16-no-play">
                    <div className="text-lg font-extrabold tracking-wide">NO JUGADA</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      V16 no produjo un candidato Elite. Esto no significa automáticamente que el modelo no viera un ganador; el diagnóstico separa predicción deportiva, ruta pre-precio y economía de la cuota.
                    </div>
                    {noPlayAudit && (
                      <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3 text-left text-xs" data-testid="mlb-v16-no-play-reason">
                        <div className="font-semibold">Motivo principal del no-play</div>
                        <div className="mt-1 text-muted-foreground">{noPlayReasonLabel(noPlayAudit.primaryBlocker)}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2" data-testid="mlb-v16-elite-candidates">
                    <div className="text-xs font-semibold uppercase tracking-wide">Candidatos Elite detectados</div>
                    {eliteCandidates.map((candidate) => (
                      <div key={candidate.predictionId} className="rounded-lg border border-primary/40 bg-background/70 p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold">{candidate.awayTeam} @ {candidate.homeTeam}</div>
                            <div className="mt-1 text-sm font-bold">
                              {candidate.marketType} · {candidate.selectedSide}{lineLabel(candidate.selectedLine)} · {americanOdds(candidate.executionOddsAmerican)}
                            </div>
                          </div>
                          <Badge variant="outline">CANDIDATO ELITE</Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div><div className="text-[11px] text-muted-foreground">Prob. modelo</div><div className="font-semibold">{pct(candidate.modelWinProbability)}</div></div>
                          <div><div className="text-[11px] text-muted-foreground">EV / unidad</div><div className="font-semibold">{pct(candidate.expectedValuePerUnit)}</div></div>
                          <div><div className="text-[11px] text-muted-foreground">Edge ejecución</div><div className="font-semibold">{pp(candidate.executionEdgePp)}</div></div>
                          <div><div className="text-[11px] text-muted-foreground">Casa / precio</div><div className="font-semibold">{candidate.executionBookTitle} {americanOdds(candidate.executionOddsAmerican)}</div></div>
                        </div>
                        {(candidate.intrinsicThesisKinds.length > 0 || candidate.supportingComponents.length > 0) && (
                          <div className="mt-3 text-xs text-muted-foreground">
                            <span className="font-semibold text-foreground">Evidencia:</span>{" "}
                            {[...candidate.intrinsicThesisKinds, ...candidate.supportingComponents].join(" · ")}
                          </div>
                        )}
                        <div className="mt-2 text-[11px] text-muted-foreground">
                          Evidencia pregame certificada. No constituye recomendación final, stake ni apuesta automática.
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="text-xs text-muted-foreground">{result.nextBoundary}</div>

            {result.games.length > 0 && (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded border border-border/50 p-2">
                {result.games.map((game) => (
                  <div key={game.gamePk} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate">{game.awayTeam} @ {game.homeTeam}</span>
                    <Badge variant="outline" className="shrink-0">{game.analysisStage}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
