import { useState } from "react";
import { Brain, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { MlbDailyBestPickCard } from "@/components/mlb-daily-best-pick-card";
import { MlbDailyBestPickPriceCard } from "@/components/mlb-daily-best-pick-price-card";
import { apiRequest, ApiError } from "@/lib/queryClient";

type SportingUiStatus =
  | "WAITING_FOR_FINAL_INPUTS"
  | "WAITING_FOR_SPORTING_FINALIZATION"
  | "CERTIFIED_INPUT_ASSEMBLY_BLOCKED"
  | "RUN_COMPLETED";

type SportingSlateLeader = {
  gamePk: number;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  selectedSide: "HOME" | "AWAY" | null;
  selectedSideProbability: number | null;
  robustSelectedSideProbability: number | null;
  probabilityStage: string;
};

type SportingSlateGame = {
  gamePk: number;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  analysisStage: "FINAL" | "PROVISIONAL";
  readiness: string;
  blockers?: string[];
};

type SportingUiResponse = {
  date: string;
  generatedAt: string;
  status: SportingUiStatus;
  slate: {
    total: number;
    finalReady: number;
    provisional: number;
    waitingForPitchers: number;
    startedOrClosed: number;
    dataInsufficient: number;
  };
  games?: SportingSlateGame[];
  blockers?: unknown[];
  result?: {
    dailyBestPick?: unknown;
    dailyBestPickPrice?: unknown;
    sportingSlateLeader?: SportingSlateLeader | null;
    sportingFinalization?: {
      state?: string;
      reason?: string;
      wholeSlateEvaluatedGames?: number;
      provisionalGamesEvaluated?: number;
      finalGamesEvaluated?: number;
      unresolvedProvisionalGamePks?: number[];
      rankedGamePks?: number[];
      policy?: {
        shortlistQualificationRule?: string;
      };
    };
    economicEvaluationSkippedReason?: string;
  };
};

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

function percent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "N/D";
}

function leaderSide(leader: SportingSlateLeader): string {
  if (leader.selectedSide === "HOME") return leader.homeTeam;
  if (leader.selectedSide === "AWAY") return leader.awayTeam;
  return "Pendiente";
}

export function MlbSportingDailyPickControl() {
  const [date, setDate] = useState(todayFL());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SportingUiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest("POST", "/api/mlb/unified-v16/ui-run", { date });
      setResult((await response.json()) as SportingUiResponse);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "No se pudo ejecutar MLB Unified V16.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const completed = result?.status === "RUN_COMPLETED";
  const blocked = result?.status === "CERTIFIED_INPUT_ASSEMBLY_BLOCKED";
  const waiting = result?.status === "WAITING_FOR_FINAL_INPUTS"
    || result?.status === "WAITING_FOR_SPORTING_FINALIZATION";
  const leader = result?.result?.sportingSlateLeader ?? null;
  const finalization = result?.result?.sportingFinalization;
  const economicSkipped = result?.result?.economicEvaluationSkippedReason;
  const slateEvaluated = result ? result.slate.finalReady + result.slate.provisional : null;
  const rankedCompetitors = typeof finalization?.wholeSlateEvaluatedGames === "number"
    ? finalization.wholeSlateEvaluatedGames
    : null;
  const screenedOut = slateEvaluated != null && rankedCompetitors != null
    ? Math.max(0, slateEvaluated - rankedCompetitors)
    : null;
  const rankedGamePks = new Set(finalization?.rankedGamePks ?? []);
  const screenedOutGames = Array.isArray(result?.games) && finalization?.rankedGamePks
    ? result.games.filter((game) => !rankedGamePks.has(game.gamePk))
    : [];
  const statusLabel = !result
    ? "IDLE"
    : completed
      ? "EVALUADO"
      : blocked
        ? "BLOCKED"
        : "WAIT";
  const statusVariant = blocked ? "destructive" : completed ? "default" : "secondary";

  return (
    <Card className="mx-4 mt-4 border-primary/30 bg-card/95" data-testid="mlb-sporting-daily-pick-control">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain className="h-5 w-5 text-primary" />
              MLB Unified V16 · Daily BEST PICK
            </CardTitle>
            <p className="mt-1 max-w-4xl text-xs text-muted-foreground">
              Se evalúa todo el slate pregame elegible antes de cerrar una única jugada deportiva. Solo los juegos que superan
              el filtro preprecio certificado entran al ranking profundo. La autoridad final conserva A+ → Premium → PP_HORIZON → Full Modular;
              la cuota y el EV se evalúan después y nunca borran la selección deportiva.
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
          <Button onClick={execute} disabled={loading} data-testid="button-mlb-daily-best-pick-run">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            {loading ? "Evaluando" : "Ejecutar V16"}
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

            {waiting && leader && (
              <div className="rounded-md border border-primary/35 bg-primary/5 p-3" data-testid="mlb-provisional-slate-leader">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide">Líder provisional del slate</div>
                  <Badge variant="secondary">WAIT · RANK #{leader.contextRank}</Badge>
                </div>
                <div className="text-base font-bold">{leader.awayTeam} @ {leader.homeTeam}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                  <div><div className="text-muted-foreground">Lado provisional</div><div className="font-semibold">{leaderSide(leader)}</div></div>
                  <div><div className="text-muted-foreground">Prob. V16</div><div className="font-semibold">{percent(leader.selectedSideProbability)}</div></div>
                  <div><div className="text-muted-foreground">Prob. robusta</div><div className="font-semibold">{percent(leader.robustSelectedSideProbability)}</div></div>
                  <div><div className="text-muted-foreground">Slate evaluado</div><div className="font-semibold">{slateEvaluated ?? "N/D"}</div></div>
                  <div><div className="text-muted-foreground">Competidores ranking</div><div className="font-semibold">{rankedCompetitors ?? "N/D"}</div></div>
                </div>

                {screenedOut != null && screenedOut > 0 && (
                  <div className="mt-3 rounded-md border border-border/70 bg-background/35 p-3" data-testid="mlb-slate-screened-out-audit">
                    <div className="text-[11px] font-semibold uppercase tracking-wide">Fuera del ranking profundo · {screenedOut}</div>
                    {screenedOutGames.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {screenedOutGames.map((game) => (
                          <div key={game.gamePk} className="rounded border border-border/60 p-2 text-xs" data-testid={`mlb-screened-out-game-${game.gamePk}`}>
                            <div className="font-semibold">{game.awayTeam} @ {game.homeTeam}</div>
                            <div className="mt-1 text-muted-foreground">
                              Motivo: no alcanzó la regla mínima del filtro preprecio — al menos 1 señal nativa de carreras distinta de cero proveniente de un componente certificado. Por definición, este juego quedó con 0 señales independientes clasificatorias en este snapshot.
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {screenedOut} juego{screenedOut === 1 ? " fue evaluado" : "s fueron evaluados"} pero no superó{screenedOut === 1 ? "" : "aron"} la regla mínima del filtro preprecio certificado.
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Regla vigente: ≥1 señal nativa de carreras no-cero de un componente con evidencia certificada. No se fuerza la inclusión de juegos sin señal clasificatoria.
                    </p>
                  </div>
                )}

                <p className="mt-2 text-[11px] text-muted-foreground">
                  Este es el competidor deportivo que impide cerrar todavía el Daily BEST PICK. No es una jugada oficial hasta que los inputs FINAL confirmen la jerarquía certificada. No se consultan cuotas mientras siga en WAIT.
                </p>
              </div>
            )}

            {waiting && !leader && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                El slate fue revisado, pero todavía faltan inputs pregame para cerrar una única selección deportiva.
              </div>
            )}

            {blocked && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <div className="font-semibold text-destructive">Evidencia deportiva bloqueada</div>
                {Array.isArray(result.blockers) && result.blockers.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-xs">
                    {result.blockers.map((blocker, index) => (
                      <li key={`${index}-${blockerLabel(blocker)}`}>{blockerLabel(blocker)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {completed && (
              <div className="space-y-3">
                <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide">Autoridad deportiva diaria</div>
                    <Badge variant="outline">1 PICK MÁXIMO</Badge>
                  </div>
                  <MlbDailyBestPickCard value={result.result?.dailyBestPick} />
                </div>

                {!economicSkipped && (
                  <div className="rounded-md border border-border/70 bg-muted/10 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-wide">Validación de cuota / EV</div>
                      <Badge variant="secondary">NO CAMBIA EL DAILY PICK</Badge>
                    </div>
                    <MlbDailyBestPickPriceCard value={result.result?.dailyBestPickPrice} />
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Si la cuota actual no ofrece EV positivo, la capa económica puede indicar esperar o no apostar a ese precio,
                      pero la selección deportiva de arriba permanece intacta.
                    </p>
                  </div>
                )}

                {economicSkipped && (
                  <div className="rounded-md border border-border/70 bg-muted/10 p-3 text-xs text-muted-foreground">
                    Capa económica no consultada: {economicSkipped === "SPORTING_NO_PLAY"
                      ? "la jerarquía deportiva cerró NO PLAY; una cuota no puede crear una jugada."
                      : "el pick pertenece a una ruta cuya validación automática de precio todavía no está certificada. La selección deportiva permanece intacta."}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
