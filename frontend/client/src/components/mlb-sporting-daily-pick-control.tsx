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
  | "CERTIFIED_INPUT_ASSEMBLY_BLOCKED"
  | "RUN_COMPLETED";

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
  blockers?: unknown[];
  result?: {
    dailyBestPick?: unknown;
    dailyBestPickPrice?: unknown;
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
  const waiting = result?.status === "WAITING_FOR_FINAL_INPUTS";
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
              La jugada diaria sale de la jerarquía deportiva certificada A+ → Premium → PP_HORIZON → Full Modular.
              La cuota y el EV se evalúan después como una capa económica separada y nunca borran la selección deportiva.
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

            {waiting && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                Todavía no hay inputs pregame FINAL suficientes para cerrar la selección deportiva.
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

                <div className="rounded-md border border-border/70 bg-muted/10 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide">Validación de cuota / EV</div>
                    <Badge variant="secondary">NO CAMBIA EL DAILY PICK</Badge>
                  </div>
                  <MlbDailyBestPickPriceCard value={result.result?.dailyBestPickPrice} />
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Si la cuota actual no ofrece EV positivo, la capa económica puede indicar esperar o no apostar a ese precio,
                    pero la selección deportiva de arriba permanece intacta para conservar la lógica y cobertura históricas de las rutas certificadas.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
