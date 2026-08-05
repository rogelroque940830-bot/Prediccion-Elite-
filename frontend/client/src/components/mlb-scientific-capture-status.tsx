import { AlertTriangle, CheckCircle2, Database, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { MlbP1M3cUiState } from "@/lib/mlb-scientific-capture";

function recordedAtLabel(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("es-US", {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(parsed));
}

export function MlbScientificCaptureStatus({ state }: { state: MlbP1M3cUiState }) {
  if (state.status === "IDLE") return null;

  if (state.status === "CAPTURING") {
    return (
      <Card className="border-cyan-500/35 bg-cyan-500/[0.06]" data-testid="p1-m3c-capture-status">
        <CardContent className="flex items-start gap-3 p-4">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-cyan-300" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-cyan-100">Registrando evaluación científica SHADOW</p>
              <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M3C</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Se está enviando el mercado certificado, la cuota exacta, la probabilidad y los filtros al ledger inmutable.
            </p>
            <p className="mt-2 truncate font-mono text-[10px] text-cyan-300/75" title={state.clientEvaluationId}>
              {state.clientEvaluationId}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (state.status === "REJECTED") {
    return (
      <Card className="border-red-500/40 bg-red-500/[0.07]" data-testid="p1-m3c-capture-status">
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-red-100">Evaluación científica RECHAZADA</p>
              <Badge variant="outline" className="border-red-500/45 text-red-200">FAIL-CLOSED</Badge>
            </div>
            <p className="mt-1 text-sm text-red-100/85">{state.message}</p>
            {state.code && <p className="mt-2 font-mono text-[10px] text-red-300/80">{state.code}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">
              El resultado visual permanece disponible, pero esta ejecución no cuenta en ROI, CLV ni calibración hasta pasar el contrato P1-M3A.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const appended = state.status === "APPENDED";
  return (
    <Card
      className={appended
        ? "border-emerald-500/40 bg-emerald-500/[0.07]"
        : "border-blue-500/40 bg-blue-500/[0.07]"}
      data-testid="p1-m3c-capture-status"
    >
      <CardContent className="flex items-start gap-3 p-4">
        {appended
          ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
          : <Database className="mt-0.5 h-5 w-5 shrink-0 text-blue-300" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={appended ? "font-semibold text-emerald-100" : "font-semibold text-blue-100"}>
              Evaluación {appended ? "REGISTRADA" : "IDEMPOTENTE"}
            </p>
            <Badge variant="outline" className={appended
              ? "border-emerald-500/45 text-emerald-200"
              : "border-blue-500/45 text-blue-200"}>
              {state.revisionDecision}
            </Badge>
            <Badge variant="outline" className="border-slate-500/40 text-slate-300">
              SHADOW · exposición 0
            </Badge>
          </div>
          <div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
            <p><span className="text-slate-300">Prediction ID:</span> <span className="font-mono">{state.predictionId}</span></p>
            <p><span className="text-slate-300">Registrada:</span> {recordedAtLabel(state.recordedAt)}</p>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Sin apuesta automática, sin sportsbook y sin exposición financiera real.
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
