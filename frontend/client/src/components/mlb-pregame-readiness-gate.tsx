import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { fetchJson } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  buildMlbPregameReadinessUrl,
  mlbPregameFieldLabel,
  mlbPregameMarketLabel,
  mlbPregameReasonLabel,
  mlbPregameSafetyValid,
  toMlbPregameGateSnapshot,
  type MlbPregameEvidence,
  type MlbPregameGateSnapshot,
  type MlbPregameLineInputs,
  type MlbPregameMarket,
  type MlbPregameReadinessEnvelope,
} from "@/lib/mlb-pregame-readiness";

const MARKETS: MlbPregameMarket[] = ["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL"];

function gateClasses(status: string | null): string {
  if (status === "READY_FINAL") return "border-emerald-500/45 bg-emerald-500/[0.07]";
  if (status === "READY_PROVISIONAL") return "border-amber-500/45 bg-amber-500/[0.07]";
  if (status === "BLOCKED") return "border-red-500/45 bg-red-500/[0.07]";
  return "border-slate-600/50 bg-slate-900/45";
}

function gateBadgeClasses(status: string | null): string {
  if (status === "READY_FINAL") return "border-emerald-500/50 bg-emerald-500/15 text-emerald-200";
  if (status === "READY_PROVISIONAL") return "border-amber-500/50 bg-amber-500/15 text-amber-200";
  if (status === "BLOCKED") return "border-red-500/50 bg-red-500/15 text-red-200";
  return "border-slate-500/50 text-slate-300";
}

function gateLabel(status: string | null): string {
  if (status === "READY_FINAL") return "LISTO FINAL";
  if (status === "READY_PROVISIONAL") return "LISTO PROVISIONAL";
  if (status === "BLOCKED") return "BLOQUEADO";
  return "PENDIENTE DE VERIFICACIÓN";
}

function evidenceClasses(state: string): string {
  if (state === "FRESH") return "border-emerald-500/35 bg-emerald-500/[0.06] text-emerald-200";
  if (state === "DEGRADED") return "border-amber-500/35 bg-amber-500/[0.06] text-amber-200";
  if (state === "MISSING" || state === "STALE" || state === "CONFLICT") return "border-red-500/35 bg-red-500/[0.06] text-red-200";
  return "border-slate-500/35 bg-slate-500/[0.05] text-slate-300";
}

function evidenceStateLabel(state: string): string {
  if (state === "FRESH") return "FRESCO";
  if (state === "DEGRADED") return "DEGRADADO";
  if (state === "MISSING") return "FALTANTE";
  if (state === "STALE") return "VENCIDO";
  if (state === "CONFLICT") return "CONFLICTO";
  return "SIN CERTIFICAR";
}

function EvidenceRow({ evidence }: { evidence: MlbPregameEvidence }) {
  return (
    <div
      className={`rounded-lg border p-3 ${evidenceClasses(evidence.state)}`}
      data-testid={`p1-m2c-evidence-${evidence.field}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{mlbPregameFieldLabel(evidence.field)}</p>
          <p className="mt-1 truncate text-[10px] opacity-80" title={evidence.sourceStatus}>
            {evidence.sourceStatus || "Sin estado de fuente"}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <Badge variant="outline" className={`text-[9px] ${evidenceClasses(evidence.state)}`}>
            {evidenceStateLabel(evidence.state)}
          </Badge>
          <p className="mt-1 text-[9px] opacity-70">{evidence.required ? "Requerido" : "No requerido"}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] opacity-75">
        <span>{evidence.quality}</span>
        {evidence.ageSeconds != null && <span>Edad {Math.round(evidence.ageSeconds)}s</span>}
        {evidence.maxAgeSeconds > 0 && <span>Máx. {evidence.maxAgeSeconds}s</span>}
      </div>
      {evidence.errors.length > 0 && (
        <div className="mt-2 border-t border-current/15 pt-2">
          {evidence.errors.slice(0, 2).map((error) => (
            <p key={error} className="text-[9px] opacity-85">• {error}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function MlbPregameReadinessGate({
  gamePk,
  date,
  lines,
  onSnapshot,
}: {
  gamePk: string;
  date: string;
  lines: MlbPregameLineInputs;
  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;
}) {
  const [market, setMarket] = useState<MlbPregameMarket>("ML");
  const [verificationNonce, setVerificationNonce] = useState(0);

  const capturedAt = useMemo(() => new Date().toISOString(), [
    gamePk,
    date,
    market,
    verificationNonce,
    lines.mlHome,
    lines.mlAway,
    lines.runLine,
    lines.runLineHomeOdds,
    lines.runLineAwayOdds,
    lines.totalLine,
    lines.overOdds,
    lines.underOdds,
    lines.f5MlHome,
    lines.f5MlAway,
    lines.f5TotalLine,
    lines.f5OddsSource,
  ]);

  const request = useMemo(() => buildMlbPregameReadinessUrl({
    gamePk,
    date,
    market,
    lines,
    capturedAt,
  }), [gamePk, date, market, lines, capturedAt]);

  const readinessQuery = useQuery({
    queryKey: ["mlb-p1-m2b-pregame-readiness", request.url],
    queryFn: () => fetchJson<MlbPregameReadinessEnvelope>(request.url),
    enabled: Boolean(gamePk && date),
    staleTime: 20_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const report = readinessQuery.data?.data ?? null;
  const safetyValid = mlbPregameSafetyValid(report);
  const validReport = report && safetyValid ? report : null;
  const status = validReport?.gate.status ?? null;

  useEffect(() => {
    if (!validReport || String(validReport.game.gamePk) !== gamePk) {
      onSnapshot(null);
      return;
    }
    onSnapshot(toMlbPregameGateSnapshot(validReport));
  }, [gamePk, onSnapshot, validReport]);

  useEffect(() => {
    onSnapshot(null);
  }, [gamePk, date, market, onSnapshot]);

  const evidence = useMemo(() => {
    if (!validReport) return [];
    return [...validReport.evidence].sort((left, right) => Number(right.required) - Number(left.required));
  }, [validReport]);

  const selectedMarketLabel = mlbPregameMarketLabel(market);

  if (!gamePk) {
    return (
      <Card className="border-slate-600/50 bg-slate-900/45" data-testid="p1-m2c-pregame-gate">
        <CardContent className="flex gap-3 p-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
          <div>
            <p className="font-semibold text-slate-200">Compuerta pregame pendiente</p>
            <p className="mt-1 text-sm text-muted-foreground">Selecciona y prepara un partido para verificar la suficiencia real de sus datos antes de generar una predicción.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={gateClasses(status)} data-testid="p1-m2c-pregame-gate">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge className="border-violet-500/40 bg-violet-500/15 text-violet-100">P1-M2C · COMPUERTA PREGAME</Badge>
              <Badge variant="outline" className={gateBadgeClasses(status)} data-testid="p1-m2c-gate-status">
                {gateLabel(status)}
              </Badge>
              <Badge variant="outline">SHADOW · exposición 0</Badge>
            </div>
            <CardTitle className="mt-3 flex items-center gap-2 text-lg">
              {status === "READY_FINAL" ? <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                : status === "READY_PROVISIONAL" ? <Clock3 className="h-5 w-5 text-amber-300" />
                  : status === "BLOCKED" ? <Ban className="h-5 w-5 text-red-300" />
                    : <ShieldCheck className="h-5 w-5 text-slate-300" />}
              Verificación de {selectedMarketLabel}
            </CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              El backend decide la etapa. La pantalla no convierte datos faltantes o sin timestamp en evidencia fresca.
            </p>
          </div>
          <div className="flex min-w-[250px] flex-col gap-2 sm:flex-row lg:flex-col">
            <Select value={market} onValueChange={(value) => setMarket(value as MlbPregameMarket)}>
              <SelectTrigger data-testid="p1-m2c-market-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MARKETS.map((item) => (
                  <SelectItem key={item} value={item}>{mlbPregameMarketLabel(item)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setVerificationNonce((value) => value + 1)}
              disabled={readinessQuery.isFetching}
              data-testid="p1-m2c-refresh"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${readinessQuery.isFetching ? "animate-spin" : ""}`} />
              Verificar ahora
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-[10px]">
          <Badge variant="outline">gamePk {gamePk}</Badge>
          <Badge variant="outline">Cuotas: {request.oddsMode === "manual" ? "captura del formulario" : "fuente automática"}</Badge>
          {validReport && <Badge variant="outline">{validReport.game.awayTeam.name} @ {validReport.game.homeTeam.name}</Badge>}
        </div>

        {readinessQuery.isLoading || readinessQuery.isFetching && !report ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-600/50 py-8 text-sm text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />Verificando fuentes, frescura y suficiencia…
          </div>
        ) : readinessQuery.error || readinessQuery.data?.success === false ? (
          <div className="flex gap-3 rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">No se pudo certificar la compuerta</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {readinessQuery.data?.error || (readinessQuery.error instanceof Error ? readinessQuery.error.message : "Respuesta inválida del backend")}
              </p>
            </div>
          </div>
        ) : report && !safetyValid ? (
          <div className="flex gap-3 rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4">
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">Contrato o seguridad inválidos</p>
              <p className="mt-1 text-sm text-muted-foreground">La predicción permanece bloqueada porque la respuesta no certifica P1-M2B, SHADOW y exposición 0.</p>
            </div>
          </div>
        ) : validReport ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-3"><p className="text-xl font-bold text-emerald-200">{validReport.summary.fresh}</p><p className="text-[10px] text-muted-foreground">Frescos</p></div>
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3"><p className="text-xl font-bold text-amber-200">{validReport.summary.degraded}</p><p className="text-[10px] text-muted-foreground">Degradados</p></div>
              <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-3"><p className="text-xl font-bold text-red-200">{validReport.summary.missing}</p><p className="text-[10px] text-muted-foreground">Faltantes</p></div>
              <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-3"><p className="text-xl font-bold text-red-200">{validReport.summary.stale}</p><p className="text-[10px] text-muted-foreground">Vencidos</p></div>
              <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-3"><p className="text-xl font-bold text-red-200">{validReport.summary.conflict}</p><p className="text-[10px] text-muted-foreground">Conflictos</p></div>
              <div className="rounded-lg border border-slate-500/25 bg-slate-500/[0.04] p-3"><p className="text-xl font-bold text-slate-200">{validReport.summary.unknown}</p><p className="text-[10px] text-muted-foreground">Sin certificar</p></div>
            </div>

            {validReport.gate.blockers.length > 0 && (
              <div className="rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4" data-testid="p1-m2c-blockers">
                <p className="text-sm font-semibold text-red-200">Bloqueos</p>
                {validReport.gate.blockers.map((reason) => (
                  <p key={reason} className="mt-1 text-xs text-red-100/85">• {mlbPregameReasonLabel(reason)}</p>
                ))}
              </div>
            )}

            {validReport.gate.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-4" data-testid="p1-m2c-warnings">
                <p className="text-sm font-semibold text-amber-200">Advertencias que impiden FINAL</p>
                {validReport.gate.warnings.map((reason) => (
                  <p key={reason} className="mt-1 text-xs text-amber-100/85">• {mlbPregameReasonLabel(reason)}</p>
                ))}
              </div>
            )}

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="p1-m2c-evidence-grid">
              {evidence.map((item) => <EvidenceRow key={item.field} evidence={item} />)}
            </div>

            <p className="text-[10px] text-muted-foreground">
              Verificado {new Intl.DateTimeFormat("es-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(validReport.generatedAt))} ET · El selector cambia los requisitos según el mercado.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
