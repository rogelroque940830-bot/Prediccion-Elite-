import { useState } from "react";
import { BadgeDollarSign, Loader2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  formatManualAmericanOdds,
  parseMlbDailyBestPickManualPriceAvailability,
  parseMlbDailyBestPickManualPriceView,
} from "@/lib/mlb-daily-best-pick-manual-price";

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pp(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp`;
}

export function MlbDailyBestPickManualPriceCard(props: {
  continuity: unknown;
  value: unknown;
  loading: boolean;
  error: string | null;
  onSubmit: (oddsAmerican: number) => Promise<void>;
}) {
  const [rawOdds, setRawOdds] = useState("");
  const continuity = parseMlbDailyBestPickManualPriceAvailability(props.continuity);
  if (!continuity || continuity.status !== "AVAILABLE") return null;

  const manual = parseMlbDailyBestPickManualPriceView(props.value);
  const positive = manual?.decision === "MANUAL_PRICE_POSITIVE_EV";

  const submit = async () => {
    const normalized = rawOdds.trim().replace(/^\+/, "");
    if (!/^-?\d+$/.test(normalized)) return;
    await props.onSubmit(Number(normalized));
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3" data-testid="mlb-daily-best-pick-manual-price">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold">
          <ShieldAlert className="h-4 w-4" />
          PRICE CONTINUITY · HARD ROCK MANUAL
        </div>
        <Badge variant="outline">MANUAL PRICE</Badge>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        No hay precio automático ejecutable para este run. Introduce únicamente la cuota actual de Hard Rock del mismo DAILY BEST PICK. El juego, mercado y lado ya están congelados por el servidor y no pueden cambiarse desde este campo.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={rawOdds}
          onChange={(event) => setRawOdds(event.target.value)}
          placeholder="Ej. -115 o +105"
          inputMode="numeric"
          className="w-40"
          aria-label="Cuota Hard Rock manual"
          data-testid="input-mlb-daily-best-pick-manual-price"
        />
        <Button
          type="button"
          variant="outline"
          disabled={props.loading || !rawOdds.trim()}
          onClick={() => void submit()}
          data-testid="button-mlb-daily-best-pick-manual-price"
        >
          {props.loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BadgeDollarSign className="mr-2 h-4 w-4" />}
          {props.loading ? "Calculando" : "Evaluar cuota"}
        </Button>
      </div>

      {props.error && (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {props.error}
        </div>
      )}

      {manual && (
        <div className="mt-3 rounded border border-border/60 bg-background/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold">Hard Rock {formatManualAmericanOdds(manual.execution.oddsAmerican)}</div>
            <Badge variant={positive ? "default" : "secondary"}>
              {positive ? "+EV MANUAL" : "SIN +EV"}
            </Badge>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div><div className="text-muted-foreground">Prob. modelo</div><div className="font-semibold">{pct(manual.economics.modelWinProbability)}</div></div>
            <div><div className="text-muted-foreground">Break-even</div><div className="font-semibold">{pct(manual.economics.currentBreakEvenWinProbability)}</div></div>
            <div><div className="text-muted-foreground">EV / unidad</div><div className="font-semibold">{pct(manual.economics.expectedValuePerUnit)}</div></div>
            <div><div className="text-muted-foreground">Edge ejecución</div><div className="font-semibold">{pp(manual.economics.executionEdgePp)}</div></div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Fuente: cuota introducida por el usuario, no verificada por The Odds API. Este cálculo no produce BET_ELITE, stake ni apuesta automática.
          </p>
        </div>
      )}
    </div>
  );
}
