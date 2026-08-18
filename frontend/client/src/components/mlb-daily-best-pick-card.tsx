import { CircleSlash2, ShieldCheck, Target, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { presentMlbDailyBestPick } from "@/lib/mlb-daily-best-pick";

export function MlbDailyBestPickCard({ value }: { value: unknown }) {
  const display = presentMlbDailyBestPick(value);

  if (display.state === "UNAVAILABLE") {
    return (
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
        data-testid="mlb-daily-best-pick-unavailable"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="h-4 w-4 text-destructive" />
            {display.title}
          </div>
          <Badge variant="destructive">{display.badge}</Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{display.message}</p>
      </div>
    );
  }

  if (display.state === "NO_PLAY") {
    return (
      <div
        className="rounded-lg border-2 border-border bg-background/80 p-4"
        data-testid="mlb-daily-best-pick-no-play"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2 text-base font-extrabold tracking-wide">
            <CircleSlash2 className="h-5 w-5" />
            {display.title}
          </div>
          <Badge variant="secondary">{display.badge}</Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{display.message}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div><div className="text-muted-foreground">A+ READY</div><div className="font-semibold">{display.audit.readyAPlusEvaluations}</div></div>
          <div><div className="text-muted-foreground">Premium READY</div><div className="font-semibold">{display.audit.readyPremiumEvaluations}</div></div>
          <div><div className="text-muted-foreground">Provisionales omitidos</div><div className="font-semibold">{display.audit.provisionalRowsSkipped}</div></div>
          <div><div className="text-muted-foreground">Fuera del cap</div><div className="font-semibold">{display.audit.frozenRouteMatchesOutsideRankedPreprice}</div></div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border-2 border-primary/60 bg-background/90 p-4 shadow-sm"
      data-testid="mlb-daily-best-pick"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-base font-extrabold tracking-wide">
            <Target className="h-5 w-5 text-primary" />
            {display.title}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{display.matchup}</div>
        </div>
        <Badge variant="default">{display.badge}</Badge>
      </div>

      <div className="mt-4 text-xl font-black" data-testid="mlb-daily-best-pick-selection">
        {display.selectedTeam} · {display.marketLabel}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div><div className="text-muted-foreground">Tier</div><div className="font-semibold">{display.tierLabel}</div></div>
        <div><div className="text-muted-foreground">Mercado</div><div className="font-semibold">{display.marketLabel}</div></div>
        <div><div className="text-muted-foreground">Orden pre-price</div><div className="font-semibold">{display.rankLabel}</div></div>
        <div><div className="text-muted-foreground">Lado</div><div className="font-semibold">HOME</div></div>
      </div>

      <div className="mt-3 rounded border border-border/60 bg-muted/20 p-2 text-[11px]">
        <span className="font-semibold">Ruta congelada:</span>{" "}
        <span className="break-all font-mono text-muted-foreground">{display.route}</span>
      </div>

      <div className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>{display.message}</span>
      </div>
    </div>
  );
}
