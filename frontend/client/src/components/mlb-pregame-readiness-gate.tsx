import { useEffect, useMemo, useRef, useState } from "react";
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
  validateMlbPregameModelQuote,
  type MlbPregameEvidence,
  type MlbPregameEvidenceState,
  type MlbPregameGateSnapshot,
  type MlbPregameLineInputs,
  type MlbPregameMarket,
  type MlbPregameReadinessEnvelope,
  type MlbPregameReadinessReport,
} from "@/lib/mlb-pregame-readiness";

const MARKETS: MlbPregameMarket[] = ["ML", "F5_ML", "RUN_LINE", "TOTAL"];
const EVIDENCE_STATES: MlbPregameEvidenceState[] = ["FRESH", "DEGRADED", "MISSING", "STALE", "CONFLICT", "UNKNOWN"];

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

function summarizeEvidence(items: MlbPregameEvidence[]): Record<MlbPregameEvidenceState, number> {
  return EVIDENCE_STATES.reduce((summary, state) => {
    summary[state] = items.filter((item) => item.state === state).length;
    return summary;
  }, { FRESH: 0, DEGRADED: 0, MISSING: 0, STALE: 0, CONFLICT: 0, UNKNOWN: 0 } as Record<MlbPregameEvidenceState, number>);
}

function EvidenceSummary({ items }: { items: MlbPregameEvidence[] }) {
  const summary = summarizeEvidence(items);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" data-testid="p1-m2c1-required-summary">
      <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-2.5"><p className="text-lg font-bold text-emerald-200">{summary.FRESH}</p><p className="text-[10px] text-muted-foreground">Frescos</p></div>
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-2.5"><p className="text-lg font-bold text-amber-200">{summary.DEGRADED}</p><p className="text-[10px] text-muted-foreground">Degradados</p></div>
      <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-2.5"><p className="text-lg font-bold text-red-200">{summary.MISSING}</p><p className="text-[10px] text-muted-foreground">Faltantes</p></div>
      <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-2.5"><p className="text-lg font-bold text-red-200">{summary.STALE}</p><p className="text-[10px] text-muted-foreground">Vencidos</p></div>
      <div className="rounded-lg border border-red-500/25 bg-red-500/[0.04] p-2.5"><p className="text-lg font-bold text-red-200">{summary.CONFLICT}</p><p className="text-[10px] text-muted-foreground">Conflictos</p></div>
      <div className="rounded-lg border border-slate-500/25 bg-slate-500/[0.04] p-2.5"><p className="text-lg font-bold text-slate-200">{summary.UNKNOWN}</p><p className="text-[10px] text-muted-foreground">Sin certificar</p></div>
    </div>
  );
}

function quoteNumber(quote: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!quote) return null;
  for (const key of keys) {
    const parsed = Number(quote[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function americanLabel(value: number | null): string {
  if (value == null) return "—";
  return value > 0 ? `+${Math.round(value)}` : String(Math.round(value));
}

function modelQuoteLabel(market: MlbPregameMarket, lines: MlbPregameLineInputs): string {
  if (market === "ML") return `Local ${lines.mlHome || "—"} · Visitante ${lines.mlAway || "—"}`;
  if (market === "F5_ML") return `Local ${lines.f5MlHome || "—"} · Visitante ${lines.f5MlAway || "—"}`;
  if (market === "RUN_LINE") return `Línea ${lines.runLine || "—"} · Local ${lines.runLineHomeOdds || "—"} · Visitante ${lines.runLineAwayOdds || "—"}`;
  if (market === "TOTAL") return `Total ${lines.totalLine || "—"} · Over ${lines.overOdds || "—"} · Under ${lines.underOdds || "—"}`;
  return "Sin precios F5 Total exactos";
}

function certifiedQuoteLabel(market: MlbPregameMarket, quote: Record<string, unknown> | null): string {
  if (market === "ML" || market === "F5_ML") {
    return `Local ${americanLabel(quoteNumber(quote, "home", "homeOdds"))} · Visitante ${americanLabel(quoteNumber(quote, "away", "awayOdds"))}`;
  }
  if (market === "RUN_LINE") {
    return `Línea ${quoteNumber(quote, "line") ?? "—"} · Local ${americanLabel(quoteNumber(quote, "homeOdds"))} · Visitante ${americanLabel(quoteNumber(quote, "awayOdds"))}`;
  }
  if (market === "TOTAL") {
    return `Total ${quoteNumber(quote, "line") ?? "—"} · Over ${americanLabel(quoteNumber(quote, "overOdds"))} · Under ${americanLabel(quoteNumber(quote, "underOdds"))}`;
  }
  return "No disponible";
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
          <p className="mt-1 text-[9px] opacity-70">{evidence.required ? "Requerido" : "Complementario"}</p>
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
            <p key={error} className="text-[9px] opacity-85">• {mlbPregameReasonLabel(error)}</p>
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
  onApplyCertifiedQuote,
  onSnapshot,
  onExecutionReport,
}: {
  gamePk: string;
  date: string;
  lines: MlbPregameLineInputs;
  onApplyCertifiedQuote: (market: MlbPregameMarket, quote: Record<string, unknown>) => void;
  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;
  onExecutionReport: (report: MlbPregameReadinessReport | null) => void;
}) {
  const [market, setMarket] = useState<MlbPregameMarket>("ML");
  const [verificationNonce, setVerificationNonce] = useState(0);
  const onSnapshotRef = useRef(onSnapshot);
  const onExecutionReportRef = useRef(onExecutionReport);
  const lastDecisionSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    onExecutionReportRef.current = onExecutionReport;
  }, [onExecutionReport]);

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
  const contractReport = report && safetyValid ? report : null;
  const quoteCompatibility = useMemo(
    () => contractReport ? validateMlbPregameModelQuote(contractReport, lines) : null,
    [contractReport, lines],
  );
  const executionReport = contractReport && quoteCompatibility?.matches ? contractReport : null;
  const status = contractReport
    ? quoteCompatibility?.matches ? contractReport.gate.status : "BLOCKED"
    : null;

  useEffect(() => {
    if (!executionReport || String(executionReport.game.gamePk) !== gamePk || !executionReport.gate.analysisAllowed) {
      lastDecisionSignatureRef.current = null;
      onSnapshotRef.current(null);
      onExecutionReportRef.current(null);
      return;
    }

    const snapshot = toMlbPregameGateSnapshot(executionReport);
    const signature = JSON.stringify([
      snapshot.gamePk,
      snapshot.market,
      snapshot.status,
      snapshot.analysisAllowed,
      snapshot.analysisStage,
      snapshot.blockers,
      snapshot.warnings,
    ]);
    if (lastDecisionSignatureRef.current && lastDecisionSignatureRef.current !== signature) {
      onSnapshotRef.current(null);
    }
    lastDecisionSignatureRef.current = signature;
    onSnapshotRef.current(snapshot);
    onExecutionReportRef.current(executionReport);
  }, [executionReport, gamePk]);

  useEffect(() => {
    lastDecisionSignatureRef.current = null;
    onSnapshotRef.current(null);
    onExecutionReportRef.current(null);
  }, [gamePk, date, market]);

  const evidence = useMemo(() => contractReport?.evidence ?? [], [contractReport]);
  const requiredEvidence = useMemo(() => evidence.filter((item) => item.required), [evidence]);
  const complementaryEvidence = useMemo(() => evidence.filter((item) => !item.required), [evidence]);
  const complementarySummary = useMemo(() => summarizeEvidence(complementaryEvidence), [complementaryEvidence]);
  const selectedMarketLabel = mlbPregameMarketLabel(market);
  const modelQuote = modelQuoteLabel(market, lines);
  const certifiedQuote = certifiedQuoteLabel(market, quoteCompatibility?.certifiedQuote ?? null);

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
              <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M2C.1 · FLUJO CONSOLIDADO</Badge>
              <Badge variant="outline" className="border-blue-500/40 text-blue-200">P1-M2C.2 · PRIORITY FIRST</Badge>
              <Badge variant="outline" className={gateBadgeClasses(status)} data-testid="p1-m2c-gate-status">
                {gateLabel(status)}
              </Badge>
              <Badge variant="outline">SHADOW · exposición 0</Badge>
              {contractReport && !quoteCompatibility?.matches && (
                <Badge variant="outline" className="border-red-500/40 text-red-200">
                  Backend {contractReport.gate.status}
                </Badge>
              )}
            </div>
            <CardTitle className="mt-3 flex items-center gap-2 text-lg">
              {status === "READY_FINAL" ? <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                : status === "READY_PROVISIONAL" ? <Clock3 className="h-5 w-5 text-amber-300" />
                  : status === "BLOCKED" ? <Ban className="h-5 w-5 text-red-300" />
                    : <ShieldCheck className="h-5 w-5 text-slate-300" />}
              Verificación de {selectedMarketLabel}
            </CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              El backend decide la etapa y la pantalla confirma que la cuota certificada sea exactamente la que usará el modelo.
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
            <p className="text-[9px] text-muted-foreground">F5 Total se habilitará cuando el formulario capture precios Over/Under específicos de F5.</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-[10px]">
          <Badge variant="outline">gamePk {gamePk}</Badge>
          <Badge variant="outline">Cuotas: {request.oddsMode === "manual" ? "captura manual F5" : "fuente automática"}</Badge>
          {contractReport && (
            <Badge variant="outline">
              {contractReport.game.awayTeam.name ?? "Visitante"} @ {contractReport.game.homeTeam.name ?? "Local"}
            </Badge>
          )}
        </div>

        {readinessQuery.isLoading || readinessQuery.isFetching && !report ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-600/50 py-8 text-sm text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />Verificando fuentes, frescura, suficiencia y cuota…
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
        ) : contractReport ? (
          <>
            {quoteCompatibility && !quoteCompatibility.matches && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/[0.07] p-4" data-testid="p1-m2c-quote-mismatch">
                <div className="flex gap-3">
                  <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-red-200">La cuota del modelo no coincide con la cuota certificada</p>
                    <p className="mt-1 text-xs text-red-100/80">Compara ambos precios y aplica la cotización certificada antes de generar la predicción.</p>
                    <div className="mt-3 grid gap-2 md:grid-cols-2" data-testid="p1-m2c2-quote-comparison">
                      <div className="rounded-md border border-red-500/25 bg-slate-950/35 p-3">
                        <p className="text-xs font-semibold text-slate-300">Cuota introducida</p>
                        <p className="mt-1 text-sm font-mono text-white">{modelQuote}</p>
                      </div>
                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                        <p className="text-xs font-semibold text-emerald-300">Cuota certificada</p>
                        <p className="mt-1 text-sm font-mono text-white">{certifiedQuote}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        {quoteCompatibility.reasons.map((reason) => (
                          <p key={reason} className="text-xs text-red-100/85">• {mlbPregameReasonLabel(reason)}</p>
                        ))}
                      </div>
                      {quoteCompatibility.certifiedQuote && (
                        <Button
                          type="button"
                          size="sm"
                          className="shrink-0 bg-emerald-600 hover:bg-emerald-500"
                          onClick={() => onApplyCertifiedQuote(market, quoteCompatibility.certifiedQuote!)}
                          data-testid="p1-m2c2-use-certified-quote"
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />Usar cuota certificada
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <section className="space-y-3" data-testid="p1-m2c1-required-evidence">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">Evidencia requerida</p>
                  <p className="text-[10px] text-muted-foreground">Estos {requiredEvidence.length} campos determinan FINAL, PROVISIONAL o BLOQUEADO.</p>
                </div>
                <Badge variant="outline">{requiredEvidence.length} requeridos</Badge>
              </div>
              <EvidenceSummary items={requiredEvidence} />
            </section>

            {contractReport.gate.blockers.length > 0 && (
              <div className="rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4" data-testid="p1-m2c-blockers">
                <p className="text-sm font-semibold text-red-200">Bloqueos del backend</p>
                {contractReport.gate.blockers.map((reason) => (
                  <p key={reason} className="mt-1 text-xs text-red-100/85">• {mlbPregameReasonLabel(reason)}</p>
                ))}
              </div>
            )}

            {contractReport.gate.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.06] p-4" data-testid="p1-m2c-warnings">
                <p className="text-sm font-semibold text-amber-200">Advertencias que impiden FINAL</p>
                {contractReport.gate.warnings.map((reason) => (
                  <p key={reason} className="mt-1 text-xs text-amber-100/85">• {mlbPregameReasonLabel(reason)}</p>
                ))}
              </div>
            )}

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="p1-m2c-evidence-grid">
              {requiredEvidence.map((item) => <EvidenceRow key={item.field} evidence={item} />)}
            </div>

            {complementaryEvidence.length > 0 && (
              <details className="group rounded-lg border border-slate-600/45 bg-slate-950/35" data-testid="p1-m2c1-complementary-evidence">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-200">Evidencia complementaria</p>
                    <p className="text-[10px] text-muted-foreground">No altera por sí sola la autorización del mercado seleccionado.</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1 text-[9px]">
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-300">{complementarySummary.FRESH} frescos</Badge>
                    <Badge variant="outline" className="border-amber-500/30 text-amber-300">{complementarySummary.DEGRADED} degradados</Badge>
                    <Badge variant="outline" className="border-slate-500/30 text-slate-300">{complementarySummary.UNKNOWN} sin certificar</Badge>
                    <span className="px-2 py-1 text-slate-400 group-open:hidden">Abrir</span>
                    <span className="hidden px-2 py-1 text-slate-400 group-open:inline">Cerrar</span>
                  </div>
                </summary>
                <div className="grid gap-2 border-t border-slate-700/50 p-4 md:grid-cols-2 xl:grid-cols-3">
                  {complementaryEvidence.map((item) => <EvidenceRow key={item.field} evidence={item} />)}
                </div>
              </details>
            )}

            <p className="text-[10px] text-muted-foreground">
              Verificado {new Intl.DateTimeFormat("es-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(contractReport.generatedAt))} ET · El selector cambia los requisitos según el mercado.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
