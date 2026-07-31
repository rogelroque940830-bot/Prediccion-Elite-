import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAppContext } from "@/lib/context";
import { fetchJson } from "@/lib/queryClient";
import {
  buildMlbHistoryFocus,
  classifyMlbHistoryFocus,
  type MlbHistoryFocusPick,
  type MlbHistoryIntegrityItem,
} from "@/lib/mlb-history-focus";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity,
  Archive,
  Clock3,
  Database,
  Eye,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";

type FocusView = "priority" | "waiting" | "verify" | "results";

interface LedgerHistoryView {
  schemaVersion: "mlb-ledger-history-view.v1";
  generatedAt: string;
  source: "immutable-ledger";
  summary: {
    total: number;
    pending: number;
    settled: number;
    wins: number;
    losses: number;
    pushes: number;
    voids: number;
    winRatePct: number;
    totalProfitUnits: number;
    totalStakedUnits: number;
    roiPct: number;
  };
  picks: MlbHistoryFocusPick[];
}

function oddsLabel(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value > 0 ? `+${Math.round(value)}` : String(Math.round(value));
}

function signed(value: number, suffix = ""): string {
  if (!Number.isFinite(value)) return "—";
  const formatted = Math.abs(value) < 0.005 ? "0.00" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
  return `${formatted}${suffix}`;
}

function formatDateTime(raw: string | null, fallback: string): string {
  const date = new Date(raw || fallback);
  if (!Number.isFinite(date.getTime())) return fallback || "Hora no disponible";
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: raw ? "numeric" : undefined,
    minute: raw ? "2-digit" : undefined,
  }).format(date);
}

function whenLabel(pick: MlbHistoryFocusPick): string {
  return formatDateTime(pick.commenceTime, pick.gameDate);
}

function recordedLabel(pick: MlbHistoryFocusPick): string {
  return formatDateTime(pick.recordedAt, pick.gameDate);
}

function signalLabel(signal: string): string {
  const value = String(signal || "").toUpperCase().replace(/_/g, " ");
  return value || "SIN SEÑAL";
}

function normalizedLine(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function selectionAlreadyContainsLine(selection: string, line: number): boolean {
  const token = normalizedLine(line).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(String(selection).trim());
}

function marketSelection(pick: MlbHistoryFocusPick): string {
  const selection = String(pick.selection || "").trim();
  const appendLine = pick.line != null
    && Number.isFinite(Number(pick.line))
    && !selectionAlreadyContainsLine(selection, Number(pick.line));
  const line = appendLine ? ` ${normalizedLine(Number(pick.line))}` : "";
  return `${pick.marketLabel || pick.marketType} · ${selection}${line}`.trim();
}

function priorityBadge(pick: MlbHistoryFocusPick): string {
  return classifyMlbHistoryFocus(pick) === "HIGH" ? "REVISAR AHORA" : "REVISIÓN SECUNDARIA";
}

function priorityReason(pick: MlbHistoryFocusPick): string {
  const parts: string[] = [];
  if (String(pick.analysisStage).toUpperCase() === "FINAL") parts.push("análisis FINAL disponible");
  else parts.push("análisis todavía PROVISIONAL");
  parts.push(`señal ${signalLabel(pick.signal)}`);
  if (pick.edgePp > 0) parts.push(`edge positivo de ${pick.edgePp.toFixed(2)} pp`);
  return `${parts.join(" · ")}.`;
}

function riskText(pick: MlbHistoryFocusPick): string {
  if (String(pick.analysisStage).toUpperCase() !== "FINAL") {
    return "Falta la revisión FINAL. No cierres una decisión hasta confirmar lineups y precio.";
  }
  if (!pick.book) return "La casa de la cuota no está identificada. Confirma el mercado antes de decidir.";
  return "Integridad estructural aprobada. Confirma que la cuota siga disponible; el historial aún no expone la hora original de captura.";
}

function waitingReason(pick: MlbHistoryFocusPick): string {
  if (String(pick.analysisStage).toUpperCase() !== "FINAL") {
    return "La estructura del mercado es válida, pero todavía espera la revisión FINAL del sistema.";
  }
  return "La estructura del mercado es válida, pero no alcanzó prioridad alta con la señal actual.";
}

function resultClass(result: string): string {
  const normalized = String(result).toUpperCase();
  if (normalized === "W" || normalized === "½W") return "border-green-500/35 bg-green-500/10 text-green-300";
  if (normalized === "L" || normalized === "½L") return "border-red-500/35 bg-red-500/10 text-red-300";
  return "border-slate-500/35 bg-slate-500/10 text-slate-300";
}

function SourceLine({ pick }: { pick: MlbHistoryFocusPick }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      Fuente: {pick.book || "no identificada"} · Registrado: {recordedLabel(pick)}
    </p>
  );
}

function FocusPickCard({ pick, waiting = false }: { pick: MlbHistoryFocusPick; waiting?: boolean }) {
  return (
    <Card className={waiting ? "border-amber-500/25 bg-amber-500/[0.04]" : "border-cyan-500/30 bg-cyan-500/[0.05]"}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={waiting
                ? "border-amber-500/35 bg-amber-500/15 text-amber-200"
                : "border-cyan-500/35 bg-cyan-500/15 text-cyan-100"}
              >
                {waiting ? (String(pick.analysisStage).toUpperCase() === "FINAL" ? "REVISAR DESPUÉS" : "ESPERANDO FINAL") : priorityBadge(pick)}
              </Badge>
              <Badge variant="outline" className="text-[10px]">{signalLabel(pick.signal)}</Badge>
              <Badge variant="outline" className="text-[10px]">{pick.analysisStage}</Badge>
              <Badge className="border-green-500/35 bg-green-500/10 text-green-300 text-[10px]">INTEGRIDAD APROBADA</Badge>
            </div>
            <CardTitle className="mt-3 text-base sm:text-lg">
              {pick.awayTeam} <span className="text-muted-foreground font-normal">vs</span> {pick.homeTeam}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" />
              {whenLabel(pick)}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs text-muted-foreground">Mercado</p>
            <p className="font-semibold text-sm">{marketSelection(pick)}</p>
            <p className="mt-1 text-lg font-bold">{oddsLabel(pick.oddsAmerican)}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Modelo</p>
            <p className="font-bold text-sm">{pick.modelProbabilityPct.toFixed(1)}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Mercado</p>
            <p className="font-bold text-sm">{pick.marketImpliedProbabilityPct.toFixed(1)}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Edge</p>
            <p className={pick.edgePp > 0 ? "font-bold text-sm text-green-300" : "font-bold text-sm text-muted-foreground"}>
              {signed(pick.edgePp, " pp")}
            </p>
          </div>
        </div>
        <SourceLine pick={pick} />
        <div className="rounded-lg border border-cyan-500/15 bg-slate-950/35 p-3 text-sm">
          <p className="font-medium text-slate-100">{waiting ? waitingReason(pick) : priorityReason(pick)}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{riskText(pick)}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function IntegrityCard({ item }: { item: MlbHistoryIntegrityItem }) {
  const { pick, audit } = item;
  const rejected = audit.status === "REJECT";
  return (
    <Card className={rejected ? "border-red-500/35 bg-red-500/[0.05]" : "border-orange-500/35 bg-orange-500/[0.05]"}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={rejected
                ? "border-red-500/40 bg-red-500/15 text-red-200"
                : "border-orange-500/40 bg-orange-500/15 text-orange-200"}
              >
                {rejected ? "NO UTILIZAR" : "VERIFICAR DATOS"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">{signalLabel(pick.signal)}</Badge>
              <Badge variant="outline" className="text-[10px]">{pick.analysisStage}</Badge>
            </div>
            <CardTitle className="mt-3 text-base sm:text-lg">
              {pick.awayTeam} <span className="text-muted-foreground font-normal">vs</span> {pick.homeTeam}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" />
              {whenLabel(pick)}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs text-muted-foreground">Mercado observado</p>
            <p className="font-semibold text-sm">{marketSelection(pick)}</p>
            <p className={rejected ? "mt-1 text-lg font-bold text-red-300" : "mt-1 text-lg font-bold text-orange-300"}>
              {oddsLabel(pick.oddsAmerican)}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Modelo</p>
            <p className="font-bold text-sm">{pick.modelProbabilityPct.toFixed(1)}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Mercado guardado</p>
            <p className="font-bold text-sm">{pick.marketImpliedProbabilityPct.toFixed(1)}%</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Mercado recalculado</p>
            <p className="font-bold text-sm">{audit.impliedFromOddsPct == null ? "—" : `${audit.impliedFromOddsPct.toFixed(1)}%`}</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/30 p-2 text-center">
            <p className="text-[10px] text-muted-foreground">Edge recalculado</p>
            <p className="font-bold text-sm">{audit.recomputedEdgePp == null ? "—" : signed(audit.recomputedEdgePp, " pp")}</p>
          </div>
        </div>
        <SourceLine pick={pick} />
        <div className={rejected
          ? "rounded-lg border border-red-500/25 bg-red-950/25 p-3"
          : "rounded-lg border border-orange-500/25 bg-orange-950/20 p-3"}
        >
          <p className="text-sm font-semibold">Problemas detectados</p>
          <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
            {audit.issues.map((entry) => (
              <li key={`${pick.id}-${entry.code}`} className="flex items-start gap-2">
                <span aria-hidden="true">•</span>
                <span>{entry.message}</span>
              </li>
            ))}
          </ul>
          <p className={rejected ? "mt-3 text-xs font-medium text-red-200" : "mt-3 text-xs font-medium text-orange-200"}>
            {rejected
              ? "Este registro queda excluido de Prioridad y Esperando. No debe usarse para una decisión."
              : "Este registro queda fuera de Prioridad hasta revisar la fuente o la calibración."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultCard({ pick }: { pick: MlbHistoryFocusPick }) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={resultClass(pick.result)}>{pick.result}</Badge>
              <Badge variant="outline" className="text-[10px]">{pick.marketLabel}</Badge>
              {pick.clvPp != null && <Badge variant="outline" className="text-[10px]">CLV {signed(pick.clvPp, " pp")}</Badge>}
            </div>
            <p className="mt-2 font-semibold">{pick.awayTeam} vs {pick.homeTeam}</p>
            <p className="text-xs text-muted-foreground">{marketSelection(pick)} · {oddsLabel(pick.oddsAmerican)}</p>
          </div>
          <div className="sm:text-right">
            {pick.finalScore && (
              <p className="text-sm text-muted-foreground">Final: {pick.finalScore.away}–{pick.finalScore.home}</p>
            )}
            <p className={pick.profitUnits >= 0 ? "text-lg font-bold text-green-300" : "text-lg font-bold text-red-300"}>
              {signed(pick.profitUnits, " u")}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <Card className="border-dashed border-border/70 bg-card/30">
      <CardContent className="p-8 text-center">
        <ShieldCheck className="h-8 w-8 mx-auto text-muted-foreground" />
        <p className="mt-3 font-semibold">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export default function MLBHistoryFocused() {
  const { state } = useAppContext();
  const [activeView, setActiveView] = useState<FocusView>("priority");

  const historyQuery = useQuery({
    queryKey: ["mlb-ledger-history-focus"],
    queryFn: async () => {
      const response = await fetchJson<{ success: boolean; data: LedgerHistoryView }>(
        "/api/mlb/ledger/v1/history?limit=10000",
      );
      return response.data;
    },
    staleTime: 15_000,
    refetchOnMount: "always",
  });

  const fallbackPicks: MlbHistoryFocusPick[] = [...state.mlbPicks].reverse().map((pick) => ({
    id: String(pick.id),
    recordedAt: pick.date,
    gameDate: pick.date,
    commenceTime: null,
    gamePk: null,
    homeTeam: pick.team,
    awayTeam: pick.opponent,
    marketType: pick.market,
    marketLabel: pick.market,
    selection: pick.pick,
    line: null,
    oddsAmerican: pick.odds,
    book: null,
    modelProbabilityPct: pick.modelProb,
    marketImpliedProbabilityPct: pick.impliedProb,
    edgePp: pick.edge,
    signal: "LOCAL",
    confidenceLabel: null,
    analysisStage: "LOCAL",
    result: pick.result === "P" ? "PENDING" : pick.result,
    settlementResult: pick.result === "P" ? null : pick.result,
    settledAt: null,
    profitUnits: pick.profit,
    closingOddsAmerican: pick.closingOdds ?? null,
    clvPp: pick.clvPercent ?? null,
    finalScore: null,
    analyticalDuplicate: false,
  }));

  const displayPicks = historyQuery.data?.picks ?? fallbackPicks;
  const focus = useMemo(() => buildMlbHistoryFocus(displayPicks), [displayPicks]);
  const recentWins = focus.results.filter((pick) => ["W", "½W"].includes(String(pick.result).toUpperCase())).length;
  const recentLosses = focus.results.filter((pick) => ["L", "½L"].includes(String(pick.result).toUpperCase())).length;
  const recentProfit = focus.results.reduce((sum, pick) => sum + Number(pick.profitUnits || 0), 0);

  const views: Array<{ key: FocusView; label: string; count: number; icon: typeof Target }> = [
    { key: "priority", label: "Prioridad", count: focus.priority.length, icon: Target },
    { key: "waiting", label: "Esperando", count: focus.waiting.length, icon: Clock3 },
    { key: "verify", label: "Verificar datos", count: focus.verifyTotal, icon: ShieldAlert },
    { key: "results", label: "Resultados", count: focus.results.length, icon: Trophy },
  ];

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1100px] mx-auto">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-cyan-300" />
            <h1 className="text-xl font-display font-bold">MLB · En foco</h1>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Solo muestra oportunidades que aprobaron la compuerta de integridad. Los datos sospechosos quedan separados para verificación.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1.5">
            {historyQuery.data ? <Database className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {historyQuery.data ? "Ledger" : "Respaldo local"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void historyQuery.refetch()} disabled={historyQuery.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${historyQuery.isFetching ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/mlb-history-audit">
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              Abrir auditoría completa
            </Link>
          </Button>
        </div>
      </div>

      {historyQuery.isError && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3 text-sm text-amber-200">
            El ledger no respondió. El respaldo local no entrará en Prioridad sin una fuente de cuota identificada.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="border-cyan-500/25 bg-cyan-500/[0.06]">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Para revisar</p>
            <p className="text-2xl font-bold text-cyan-200">{focus.priority.length}</p>
            <p className="text-[10px] text-muted-foreground">integridad aprobada</p>
          </CardContent>
        </Card>
        <Card className="border-amber-500/25 bg-amber-500/[0.06]">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Esperando</p>
            <p className="text-2xl font-bold text-amber-200">{focus.waiting.length}</p>
            <p className="text-[10px] text-muted-foreground">válidas, pero incompletas</p>
          </CardContent>
        </Card>
        <Card className="border-orange-500/25 bg-orange-500/[0.06]">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Verificar datos</p>
            <p className="text-2xl font-bold text-orange-200">{focus.verifyTotal}</p>
            <p className="text-[10px] text-muted-foreground">fuera de Prioridad</p>
          </CardContent>
        </Card>
        <Card className="border-green-500/20 bg-green-500/[0.05]">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Resultados recientes</p>
            <p className="text-2xl font-bold text-green-200">{recentWins}-{recentLosses}</p>
            <p className={recentProfit >= 0 ? "text-[10px] text-green-300" : "text-[10px] text-red-300"}>{signed(recentProfit, " u")}</p>
          </CardContent>
        </Card>
        <Card className="border-slate-500/20 bg-slate-500/[0.04]">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Solo estudio</p>
            <p className="text-2xl font-bold text-slate-300">{focus.hiddenStudyRecords}</p>
            <p className="text-[10px] text-muted-foreground">ocultos de la vista principal</p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-blue-500/20 bg-blue-500/[0.04]">
        <CardContent className="p-3 text-xs text-muted-foreground flex items-start gap-2">
          <Activity className="h-4 w-4 mt-0.5 text-blue-300 shrink-0" />
          <p>
            La compuerta recalcula probabilidad implícita y edge, rechaza cuotas americanas inválidas y separa edges superiores a 15 pp. El ledger no se modifica. {focus.collapsedRevisions} revisiones o duplicados quedaron colapsados.
          </p>
        </CardContent>
      </Card>

      <Card className="border-amber-500/20 bg-amber-500/[0.035]">
        <CardContent className="p-3 text-xs text-muted-foreground flex items-start gap-2">
          <Clock3 className="h-4 w-4 mt-0.5 text-amber-300 shrink-0" />
          <p>
            La API de historial expone la hora de registro, pero todavía no la hora original de captura del precio. La frescura exacta de la cuota debe confirmarse antes de actuar.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {views.map((view) => {
          const Icon = view.icon;
          const active = activeView === view.key;
          return (
            <Button
              key={view.key}
              type="button"
              variant={active ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveView(view.key)}
              aria-pressed={active}
              className="gap-1.5"
            >
              <Icon className="h-3.5 w-3.5" />
              {view.label}
              <Badge variant="secondary" className="ml-1 h-5 min-w-5 justify-center px-1.5 text-[10px]">{view.count}</Badge>
            </Button>
          );
        })}
      </div>

      <div className="space-y-3">
        {activeView === "priority" && (
          focus.priority.length > 0
            ? focus.priority.map((pick) => <FocusPickCard key={pick.id} pick={pick} />)
            : <EmptyState title="No hay una oportunidad prioritaria aprobada" detail="Los registros sospechosos fueron movidos a Verificar datos en lugar de forzar una jugada." />
        )}

        {activeView === "waiting" && (
          focus.waiting.length > 0
            ? focus.waiting.map((pick) => <FocusPickCard key={pick.id} pick={pick} waiting />)
            : <EmptyState title="No hay partidos válidos esperando confirmación" detail="Los datos con problemas permanecen separados en Verificar datos." />
        )}

        {activeView === "verify" && (
          focus.verify.length > 0
            ? (
              <>
                {focus.verifyTotal > focus.verify.length && (
                  <p className="text-xs text-muted-foreground">
                    Mostrando los {focus.verify.length} casos más urgentes de {focus.verifyTotal}. El resto permanece en la auditoría completa.
                  </p>
                )}
                {focus.verify.map((item) => <IntegrityCard key={item.pick.id} item={item} />)}
              </>
            )
            : <EmptyState title="No hay datos sospechosos en los partidos activos" detail="Las oportunidades visibles aprobaron las comprobaciones estructurales actuales." />
        )}

        {activeView === "results" && (
          focus.results.length > 0
            ? focus.results.map((pick) => <ResultCard key={pick.id} pick={pick} />)
            : <EmptyState title="Todavía no hay resultados recientes" detail="Aparecerán aquí cuando el ledger liquide las decisiones únicas más recientes." />
        )}
      </div>
    </div>
  );
}
