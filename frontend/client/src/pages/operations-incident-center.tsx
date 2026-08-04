import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  ListFilter,
  LockKeyhole,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { fetchJson } from "@/lib/queryClient";
import {
  filterOperationalIncidents,
  formatOperationalDate,
  incidentStateLabel,
  operationalAgeLabel,
  operationalSafetyValid,
  workerStateLabel,
  type IncidentCenterEnvelope,
  type IncidentFilters,
  type OperationalIncident,
  type OperationalIncidentSeverity,
  type OperationalIncidentState,
  type OperationalLeague,
  type OperationalWorkerSnapshot,
} from "@/lib/operations-incident-center";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const LEAGUES: Array<OperationalLeague | "ALL"> = ["ALL", "MLB", "WNBA", "NBA", "NHL"];
const STATES: Array<OperationalIncidentState | "ALL"> = [
  "ALL",
  "WAITING_FOR_PREGAME_DATA",
  "WAITING_FOR_FINAL_CAPTURE",
  "GAME_IN_PROGRESS",
  "WAITING_FOR_OFFICIAL_FINAL",
  "READY_FOR_SETTLEMENT",
  "SETTLEMENT_OVERDUE",
  "DATA_QUALITY_REVIEW",
  "CORRECTION_REQUIRED",
];
const SEVERITIES: Array<OperationalIncidentSeverity | "ALL"> = ["ALL", "CRITICAL", "WARNING", "INFO"];
type View = "incidents" | "workers" | "coverage";

function severityClass(severity: OperationalIncidentSeverity): string {
  if (severity === "CRITICAL") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (severity === "WARNING") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-cyan-500/35 bg-cyan-500/10 text-cyan-100";
}

function stateCardClass(incident: OperationalIncident): string {
  if (incident.severity === "CRITICAL") return "border-red-500/30 bg-red-500/[0.04]";
  if (incident.severity === "WARNING") return "border-amber-500/25 bg-amber-500/[0.03]";
  return "border-border bg-card";
}

function workerClass(worker: OperationalWorkerSnapshot): string {
  if (worker.state === "ERROR") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (worker.state === "STALE" || worker.state === "UNINSTRUMENTED") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
  if (worker.state === "HEALTHY") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  return "border-slate-500/35 bg-slate-500/10 text-slate-200";
}

function selectClass(): string {
  return "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";
}

function detailSummary(details: Record<string, unknown>): string[] {
  return Object.entries(details)
    .filter(([, value]) => value != null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .slice(0, 5)
    .map(([key, value]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
      const display = Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${label}: ${display}`;
    });
}

function IncidentCard({ incident }: { incident: OperationalIncident }) {
  const details = detailSummary(incident.details);
  return (
    <Card className={stateCardClass(incident)} data-testid={`incident-${incident.id}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={severityClass(incident.severity)}>{incident.severity}</Badge>
              <Badge variant="outline">{incident.league}</Badge>
              <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10">
                {incidentStateLabel(incident.state)}
              </Badge>
              {incident.evidenceConfidence === "LIMITED" && (
                <Badge variant="outline" className="border-violet-500/35 bg-violet-500/10 text-violet-200">
                  Evidencia limitada
                </Badge>
              )}
            </div>
            <CardTitle className="mt-3 text-lg">
              {incident.awayTeam} <span className="text-muted-foreground">@</span> {incident.homeTeam}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatOperationalDate(incident.commenceTime ?? incident.gameDate)} · {operationalAgeLabel(incident.ageMinutes)}
            </p>
          </div>
          <div className="text-left md:text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Worker responsable</p>
            <p className="text-sm font-medium">{incident.worker}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Qué ocurre</p>
            <p className="mt-1 text-sm">{incident.message}</p>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">{incident.reasonCode}</p>
          </div>
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Siguiente acción segura</p>
            <p className="mt-1 text-sm">{incident.nextAction}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Fuente: {incident.source}</span>
          <span>Juego: {incident.gameId}</span>
          {details.map((detail) => <span key={detail}>{detail}</span>)}
        </div>
      </CardContent>
    </Card>
  );
}

function WorkerCard({ worker }: { worker: OperationalWorkerSnapshot }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{worker.league}</Badge>
              <Badge variant="outline" className={workerClass(worker)}>{workerStateLabel(worker.state)}</Badge>
            </div>
            <h3 className="mt-3 font-semibold">{worker.label}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{worker.message}</p>
          </div>
          <div className="text-sm text-muted-foreground sm:text-right">
            <p>Último éxito: {formatOperationalDate(worker.lastSuccessAt)}</p>
            <p>Retraso: {operationalAgeLabel(worker.lagMinutes)}</p>
            {worker.lastError && <p className="mt-1 max-w-md text-red-300">{worker.lastError}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OperationsIncidentCenter() {
  const { authenticated, loading: authLoading, requestLogin } = useAuth();
  const [view, setView] = useState<View>("incidents");
  const [filters, setFilters] = useState<IncidentFilters>({
    league: "ALL",
    state: "ALL",
    severity: "ALL",
    search: "",
  });

  const query = useQuery({
    queryKey: ["ops-incident-center"],
    queryFn: () => fetchJson<IncidentCenterEnvelope>("/api/ops/v1/incident-center?limit=500"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const report = query.data?.data ?? null;
  const incidents = useMemo(
    () => filterOperationalIncidents(report?.incidents ?? [], filters),
    [filters, report?.incidents],
  );
  const safetyValid = operationalSafetyValid(report?.safety);

  if (authLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Verificando sesión segura…</div>;
  }

  if (!authenticated) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6">
        <Card className="w-full border-cyan-500/25">
          <CardContent className="space-y-4 p-6 text-center">
            <LockKeyhole className="mx-auto h-10 w-10 text-cyan-300" />
            <h1 className="text-2xl font-bold">Centro de Operaciones privado</h1>
            <p className="text-muted-foreground">
              Inicia sesión para consultar incidencias, estado de workers y cobertura operativa.
            </p>
            <Button onClick={requestLogin}>Iniciar sesión</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge className="border-cyan-500/40 bg-cyan-500/10 text-cyan-100">O1 · PRIVADO</Badge>
            <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">OBSERVE ONLY</Badge>
            <Badge variant="outline">Exposición: 0</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-bold">Centro de Operaciones e Incidencias</h1>
          <p className="mt-1 text-muted-foreground">
            Distingue juegos activos, datos pendientes, settlement vencido y problemas reales sin modificar el historial.
          </p>
          {report && (
            <p className="mt-2 text-xs text-muted-foreground">
              Última actualización: {formatOperationalDate(report.generatedAt)}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {query.error && (
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="flex gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">No se pudo cargar la API de operaciones</p>
              <p className="text-sm text-muted-foreground">
                {query.error instanceof Error ? query.error.message : "Error desconocido"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                El frontend puede estar desplegado antes que el backend O1; no se inventan estados durante esa ventana.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Card><CardContent className="p-4"><Activity className="h-5 w-5 text-cyan-300" /><p className="mt-3 text-2xl font-bold">{report.summary.unresolved}</p><p className="text-xs text-muted-foreground">Incidencias abiertas</p></CardContent></Card>
            <Card><CardContent className="p-4"><AlertTriangle className="h-5 w-5 text-red-300" /><p className="mt-3 text-2xl font-bold">{report.summary.critical}</p><p className="text-xs text-muted-foreground">Críticas</p></CardContent></Card>
            <Card><CardContent className="p-4"><Clock3 className="h-5 w-5 text-amber-300" /><p className="mt-3 text-2xl font-bold">{report.summary.warnings}</p><p className="text-xs text-muted-foreground">Advertencias</p></CardContent></Card>
            <Card><CardContent className="p-4"><Server className="h-5 w-5 text-violet-300" /><p className="mt-3 text-2xl font-bold">{report.workers.filter((worker) => worker.state === "HEALTHY").length}/{report.workers.length}</p><p className="text-xs text-muted-foreground">Workers saludables</p></CardContent></Card>
            <Card className={safetyValid ? "border-emerald-500/25" : "border-red-500/35"}><CardContent className="p-4"><ShieldCheck className={`h-5 w-5 ${safetyValid ? "text-emerald-300" : "text-red-300"}`} /><p className="mt-3 text-sm font-semibold">{safetyValid ? "Seguridad verificada" : "Compuerta inválida"}</p><p className="text-xs text-muted-foreground">Solo lectura · sin reintentos</p></CardContent></Card>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-border pb-3">
            {([
              ["incidents", "Incidencias", ListFilter],
              ["workers", "Workers", Server],
              ["coverage", "Cobertura", Database],
            ] as const).map(([value, label, Icon]) => (
              <Button key={value} size="sm" variant={view === value ? "default" : "outline"} onClick={() => setView(value)}>
                <Icon className="mr-2 h-4 w-4" />{label}
              </Button>
            ))}
          </div>

          {view === "incidents" && (
            <div className="space-y-4">
              <Card>
                <CardContent className="grid gap-3 p-4 md:grid-cols-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      className="pl-9"
                      value={filters.search}
                      placeholder="Buscar equipo, worker o motivo"
                      onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                    />
                  </div>
                  <select className={selectClass()} value={filters.league} onChange={(event) => setFilters((current) => ({ ...current, league: event.target.value as IncidentFilters["league"] }))}>
                    {LEAGUES.map((league) => <option key={league} value={league}>{league === "ALL" ? "Todas las ligas" : league}</option>)}
                  </select>
                  <select className={selectClass()} value={filters.state} onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value as IncidentFilters["state"] }))}>
                    {STATES.map((state) => <option key={state} value={state}>{state === "ALL" ? "Todos los estados" : incidentStateLabel(state)}</option>)}
                  </select>
                  <select className={selectClass()} value={filters.severity} onChange={(event) => setFilters((current) => ({ ...current, severity: event.target.value as IncidentFilters["severity"] }))}>
                    {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity === "ALL" ? "Todas las severidades" : severity}</option>)}
                  </select>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">Mostrando {incidents.length} de {report.incidents.length} incidencias</p>
                {(filters.league !== "ALL" || filters.state !== "ALL" || filters.severity !== "ALL" || filters.search) && (
                  <Button variant="ghost" size="sm" onClick={() => setFilters({ league: "ALL", state: "ALL", severity: "ALL", search: "" })}>Limpiar filtros</Button>
                )}
              </div>

              {incidents.length ? incidents.map((incident) => <IncidentCard key={incident.id} incident={incident} />) : (
                <Card><CardContent className="p-8 text-center"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-300" /><p className="mt-3 font-medium">No hay incidencias con estos filtros</p><p className="text-sm text-muted-foreground">Esto no elimina datos; solo cambia la vista actual.</p></CardContent></Card>
              )}
            </div>
          )}

          {view === "workers" && (
            <div className="grid gap-3 xl:grid-cols-2">
              {report.workers.map((worker) => <WorkerCard key={worker.id} worker={worker} />)}
            </div>
          )}

          {view === "coverage" && (
            <div className="grid gap-3 lg:grid-cols-2">
              {(Object.entries(report.coverage) as Array<[OperationalLeague, (typeof report.coverage)[OperationalLeague]]>).map(([league, coverage]) => (
                <Card key={league}>
                  <CardHeader className="pb-3"><div className="flex items-center justify-between"><CardTitle>{league}</CardTitle><Badge variant="outline" className={coverage.evidenceConfidence === "AUTHORITATIVE" ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200" : "border-violet-500/35 bg-violet-500/10 text-violet-200"}>{coverage.evidenceConfidence}</Badge></div></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p><span className="text-muted-foreground">Fuente:</span> {coverage.source}</p>
                    <p><span className="text-muted-foreground">Settlement automático observado:</span> {coverage.settlementAutomationObserved ? "Sí" : "No"}</p>
                    <p className="text-muted-foreground">{coverage.note}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
            <CardContent className="grid gap-3 p-4 md:grid-cols-2">
              <div><p className="text-sm font-semibold text-emerald-200">Permitido en O1</p><p className="mt-1 text-sm text-muted-foreground">Leer estados, identificar el motivo y abrir la evidencia correspondiente.</p></div>
              <div><p className="text-sm font-semibold text-amber-200">Bloqueado en O1</p><p className="mt-1 text-sm text-muted-foreground">Reintentar settlement, modificar ledger, inventar resultados o cambiar el predictor.</p></div>
            </CardContent>
          </Card>
        </>
      )}

      {query.isLoading && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin" />Cargando incidencias operativas…</CardContent></Card>
      )}
    </div>
  );
}
