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

interface V16UiResponse {
  schemaVersion: string;
  date: string;
  generatedAt: string;
  status: "CERTIFIED_INPUT_ASSEMBLY_REQUIRED" | "WAITING_FOR_FINAL_INPUTS";
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
  nextBoundary: string;
  policy: {
    explicitInvocationRequired: true;
    paidOddsCalled: false;
    browserReceivesProviderSecret: false;
    browserMayForgeCertifiedInputs: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export function MlbUnifiedV16Control() {
  const [date, setDate] = useState(todayFL());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<V16UiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prepare = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest("POST", "/api/mlb/unified-v16/ui-run", { date });
      setResult((await response.json()) as V16UiResponse);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "No se pudo preparar V16.";
      setError(message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const readyForAssembler = result?.status === "CERTIFIED_INPUT_ASSEMBLY_REQUIRED";

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
              Entrada explícita del nuevo runner. La verificación de jornada no consume cuotas.
            </p>
          </div>
          <Badge variant={readyForAssembler ? "default" : "secondary"}>
            {readyForAssembler ? "FINAL INPUTS READY" : result ? "PREFLIGHT" : "IDLE"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <DatePickerFL value={date} onChange={(next) => { setDate(next); setResult(null); setError(null); }} />
          <Button onClick={prepare} disabled={loading} data-testid="button-mlb-v16-prepare">
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            Preparar V16
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

            <div className="text-xs text-muted-foreground">
              {readyForAssembler
                ? "La jornada ya tiene juegos FINAL. El siguiente límite técnico es ensamblar en servidor los inputs certificados antes de cruzar a Step 8."
                : "V16 queda en espera de inputs pregame FINAL. No se compraron cuotas."}
            </div>

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
