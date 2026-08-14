import { useState } from "react";
import { Brain, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
              Ejecución explícita: primero verifica la jornada y, si existen juegos FINAL, continúa al ensamblaje certificado y al runner V16.
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

                {runSummary.eliteEvidenceCandidates > 0 ? (
                  <div className="rounded-md border border-primary/30 bg-background/50 p-3 text-xs">
                    <span className="font-semibold">Hay evidencia candidata Elite.</span> Esta salida todavía no es una recomendación final ni calcula stake; sirve para la evaluación prospectiva certificada.
                  </div>
                ) : (
                  <div className="rounded-md border border-border/60 bg-background/50 p-3 text-xs">
                    <span className="font-semibold">Sin candidato Elite en esta ejecución.</span> El sistema analizó los juegos FINAL y no produjo evidencia suficiente para elevar una jugada.
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
