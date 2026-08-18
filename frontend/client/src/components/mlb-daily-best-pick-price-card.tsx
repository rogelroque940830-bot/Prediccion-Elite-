import { BadgeDollarSign, CircleOff, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { presentMlbDailyBestPickPrice } from "@/lib/mlb-daily-best-pick-price";

function badgeVariant(state: ReturnType<typeof presentMlbDailyBestPickPrice>["state"]): "default" | "secondary" | "destructive" | "outline" {
  if (state === "ELITE_EVIDENCE_CANDIDATE") return "default";
  if (state === "UNAVAILABLE" || state === "PRICE_EVIDENCE_UNAVAILABLE" || state === "UPSTREAM_BLOCKED") return "destructive";
  if (state === "NOT_APPLICABLE") return "secondary";
  return "outline";
}

export function MlbDailyBestPickPriceCard({ value }: { value: unknown }) {
  const display = presentMlbDailyBestPickPrice(value);
  const elite = display.state === "ELITE_EVIDENCE_CANDIDATE";
  const unavailable = display.state === "UNAVAILABLE" || display.state === "PRICE_EVIDENCE_UNAVAILABLE";
  const Icon = elite ? ShieldCheck : unavailable ? ShieldAlert : display.state === "NOT_APPLICABLE" ? CircleOff : BadgeDollarSign;

  return (
    <div
      className="rounded-lg border border-border/70 bg-muted/15 p-3"
      data-testid="mlb-daily-best-pick-price"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Icon className="h-4 w-4" />
          {display.title}
        </div>
        <Badge variant={badgeVariant(display.state)}>{display.badge}</Badge>
      </div>

      {(display.executionLabel || display.modelProbabilityLabel || display.evLabel || display.edgeLabel) && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div>
            <div className="text-muted-foreground">Precio ejecutable</div>
            <div className="font-semibold">{display.executionLabel ?? "N/D"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Prob. modelo</div>
            <div className="font-semibold">{display.modelProbabilityLabel ?? "N/D"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">EV / unidad</div>
            <div className="font-semibold">{display.evLabel ?? "N/D"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Edge ejecución</div>
            <div className="font-semibold">{display.edgeLabel ?? "N/D"}</div>
          </div>
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">{display.message}</p>

      {display.blockers.length > 0 && (
        <div className="mt-2 rounded border border-border/60 bg-background/50 p-2 text-[11px]">
          <span className="font-semibold">Blockers:</span>{" "}
          <span className="text-muted-foreground">{display.blockers.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
