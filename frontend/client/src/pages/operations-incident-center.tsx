import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Database,
  History,
  ListFilter,
  LockKeyhole,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  TimerReset,
  Webhook,
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
import {
  filterOperationalSlaEvents,
  operationalSlaSafetyValid,
  slaDurationLabel,
  slaEventTypeLabel,
  type OperationalSlaAlertEnvelope,
  type OperationalSlaAlertEvent,
  type OperationalSlaFilters,
  type OperationalSlaSeverity,
} from "@/lib/operations-sla-alerts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const LEAGUES: Array<OperationalLeague | "ALL"> = ["ALL", "MLB", "WNBA", "NBA", "NHL"];
const ALERT_LEAGUES: Array<OperationalLeague | "SYSTEM" | "ALL"> = ["ALL", "MLB", "WNBA", "NBA", "NHL", "SYSTEM"];
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
const ALERT_SEVERITIES: Array<OperationalSlaSeverity | "ALL"> = ["ALL", "CRITICAL", "WARNING"];
type View = "alerts" | "incidents" | "workers" | "coverage";

function severityClass(severity: OperationalIncidentSeverity | OperationalSlaSeverity): string {
  if (severity === "CRITICAL") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (severity === "WARNING") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-cyan-500/35 bg-cyan-500/10 text-cyan-100";
}

function stateCardClass(incident: OperationalIncident): string {
  if (incident.severity === "CRITICAL") return "border-red-500/30 bg-red-500/[0.04]";
  if (incident.severity === "WARNING") return "border-amber-500/25 bg-amber-500/[0.03]";
  return "border-border bg-card";
}

function alertCardClass(event: OperationalSlaAlertEvent): string {
  if (event.eventType === "RESOLVED") return "border-emerald-500/25 bg-emerald-500/[0.03]";
  if (event.severity === "CRITICAL") return "border-red-500/35 bg-red-500/[0.05]";
  return "border-amber-500/30 bg-amber-500/[0.04]";
}

function eventTypeClass(event: OperationalSlaAlertEvent): string {
  if (event.eventType === "RESOLVED") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (event.eventType === "ESCALATED") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (event.eventType === "REMINDER") return "border-violet-500/40 bg-violet-500/10 text-violet-200";
  return "border-cyan-500/40 bg-cyan-500/10 text-cyan-100";
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

function alertTitle(event: OperationalSlaAlertEvent): string {
  if (event.homeTeam && event.awayTeam) return `${event.awayTeam} @ ${event.homeTeam}`;
  if (event.workerId) return event.workerId;
  return event.alertKey;
}

function AlertCard({ event }: { event: OperationalSlaAlertEvent }) {
  return (
    <Card className={alertCardClass(event)} data-testid={`sla-alert-${event.eventId}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={severityClass(event.severity)}>{event.severity}</Badge>
              <Badge variant="outline" className={eventTypeClass(event)}>{slaEventTypeLabel(event.eventType)}</Badge>
              <Badge variant="outline">{event.league}</Badge>
              <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10">{event.sourceType}</Badge>
              {event.evidenceConfidence === "LIMITED" && (
                <Badge variant="outline" className="border-violet-500/35 bg-violet-500/10 text-violet-200">Evidencia limitada</Badge>
              )}
            </div>
            <CardTitle className="mt-3 text-lg">{alertTitle(event)}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Evento: {formatOperationalDate(event.emittedAt)}
              {event.commenceTime ? ` · Juego: ${formatOperationalDate(event.commenceTime)}` : ""}
            </p>
          </div>
          <div className="text-left md:text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Violación del SLA</p>
            <p className={`text-lg font-semibold ${event.severity === "CRITICAL" ? "text-red-200" : "text-amber-200"}`}>
              {slaDurationLabel(event.sla.breachedByMinutes)}
            </p>
            <p className="text-xs text-muted-foreground">{event.sla.policyCode}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Alerta</p>
            <p className="mt-1 text-sm">{event.summary}</p>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">{event.reasonCode}</p>
          </div>
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Siguiente acción segura</p>
            <p className="mt-1 text-sm">{event.nextAction}</p>
          </div>
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <span>Estado: {event.state}</span>
          <span>Objetivo: {slaDurationLabel(event.sla.targetMinutes)}</span>
          <span>Observado: {slaDurationLabel(event.sla.observedMinutes)}</span>
          <span>Deadline: {formatOperationalDate(event.sla.deadlineAt)}</span>
          <span>Webhook: {event.delivered.webhook ? "Entregado" : event.delivered.webhookError ? "Falló" : "No configurado"}</span>
          <span>Clave: {event.alertKey}</span>
          {event.gameId && <span>Juego: {event.gameId}</span>}
          {event.workerId && <span>Worker: {event.workerId}</span>}
        </div>
      </CardContent>
    </Card>
  );
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
                <Badge variant="outline" className="border-violet-500/35 bg-violet-500/10 text-violet-200">Evidencia limitada</Badge>
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
  const [view, setView] = useState<View>("alerts");
  const [filters, setFilters] = useState<IncidentFilters>({
    league: "ALL",
    state: "ALL",
    severity: "ALL",
    search: "",
  });
  const [alertFilters, setAlertFilters] = useState<OperationalSlaFilters>({
    mode: "ACTIVE",
    league: "ALL",
    severity: "ALL",
    search: "",
  });

  const incidentQuery = useQuery({
    queryKey: ["ops-incident-center"],
    queryFn: () => fetchJson<IncidentCenterEnvelope>("/api/ops/v1/incident-center?limit=500"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const slaQuery = useQuery({
    queryKey: ["ops-sla-alerts"],
    queryFn: () => fetchJson<OperationalSlaAlertEnvelope>("/api/ops/v1/sla-alerts?limit=500"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const report = incidentQuery.data?.data ?? null;
  const slaEvents = slaQuery.data?.data ?? [];
  const slaStatus = slaQuery.data?.status ?? null;
  const incidents = useMemo(
    () => filterOperationalIncidents(report?.incidents ?? [], filters),
    [filters, report?.incidents],
  );
  const visibleAlerts = useMemo(
    () => filterOperationalSlaEvents(slaEvents, alertFilters),
    [alertFilters, slaEvents],
  );
  const o1SafetyValid = operationalSafetyValid(report?.safety);
  const o2SafetyValid = operationalSlaSafetyValid(slaStatus?.safety);
  const refreshing = incidentQuery.isFetching || slaQuery.isFetching;

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
              Inicia sesión para consultar alertas SLA, incidencias, workers y cobertura operativa.
            </p>
            <Button onClick={requestLogin}>Iniciar sesión</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const refresh = () => {
    void incidentQuery.refetch();
    void slaQuery.refetch();
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge className="border-cyan-500/40 bg-cyan-500/10 text-cyan-100">O2 · PRIVADO</Badge>
            <Badge className="border-violet-500/40 bg-violet-500/10 text-violet-100">ALERTAS + SLA</Badge>
            <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">OBSERVE ONLY</Badge>
            <Badge variant="outline">Exposición: 0</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-bold">Centro de Operaciones e Incidencias</h1>
          <p className="mt-1 text-muted-foreground">
            O2 transforma las incidencias de O1 en alertas automáticas, escalamiento, recordatorios y resolución append-only.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Incidencias: {formatOperationalDate(report?.generatedAt ?? null)} · SLA: {formatOperationalDate(slaStatus?.lastSuccessAt ?? null)}
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {incidentQuery.error && (
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="flex gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">No se pudo cargar la API de incidencias O1</p>
              <p className="text-sm text-muted-foreground">{incidentQuery.error instanceof Error ? incidentQuery.error.message : "Error desconocido"}</p>
              <p className="mt-1 text-xs text-muted-foreground">No se inventan estados cuando la fuente O1 no está disponible.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {slaQuery.error && (
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="flex gap-3 p-4">
            <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">No se pudo cargar la API de alertas O2</p>
              <p className="text-sm text-muted-foreground">{slaQuery.error instanceof Error ? slaQuery.error.message : "Error desconocido"}</p>
              <p className="mt-1 text-xs text-muted-foreground">La consola permanece de solo lectura y no genera alertas localmente.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {(report || slaStatus) && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Card><CardContent className="p-4"><BellRing className="h-5 w-5 text-violet-300" /><p className="mt-3 text-2xl font-bold">{slaStatus?.active ?? 0}</p><p className="text-xs text-muted-foreground">Alertas activas</p></CardContent></Card>
            <Card><CardContent className="p-4"><AlertTriangle className="h-5 w-5 text-red-300" /><p className="mt-3 text-2xl font-bold">{slaStatus?.activeCritical ?? 0}</p><p className="text-xs text-muted-foreground">Alertas críticas</p></CardContent></Card>
            <Card><CardContent className="p-4"><Clock3 className="h-5 w-5 text-amber-300" /><p className="mt-3 text-2xl font-bold">{slaStatus?.activeWarnings ?? 0}</p><p className="text-xs text-muted-foreground">Alertas WARNING</p></CardContent></Card>
            <Card><CardContent className="p-4"><Activity className="h-5 w-5 text-cyan-300" /><p className="mt-3 text-2xl font-bold">{report?.summary.unresolved ?? 0}</p><p className="text-xs text-muted-foreground">Incidencias O1</p></CardContent></Card>
            <Card><CardContent className="p-4"><Radio className="h-5 w-5 text-emerald-300" /><p className="mt-3 text-sm font-semibold">{slaStatus?.lastError ? "Worker con error" : slaStatus?.lastSuccessAt ? "Worker activo" : "Esperando ciclo"}</p><p className="text-xs text-muted-foreground">Último éxito: {formatOperationalDate(slaStatus?.lastSuccessAt ?? null)}</p></CardContent></Card>
            <Card className={o1SafetyValid && o2SafetyValid ? "border-emerald-500/25" : "border-red-500/35"}><CardContent className="p-4"><ShieldCheck className={`h-5 w-5 ${o1SafetyValid && o2SafetyValid ? "text-emerald-300" : "text-red-300"}`} /><p className="mt-3 text-sm font-semibold">{o1SafetyValid && o2SafetyValid ? "Seguridad verificada" : "Compuerta inválida"}</p><p className="text-xs text-muted-foreground">Solo lectura · sin reintentos</p></CardContent></Card>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-border pb-3">
            {([
              ["alerts", "Alertas SLA", BellRing],
              ["incidents", "Incidencias O1", ListFilter],
              ["workers", "Workers", Server],
              ["coverage", "Cobertura", Database],
            ] as const).map(([value, label, Icon]) => (
              <Button key={value} size="sm" variant={view === value ? "default" : "outline"} onClick={() => setView(value)}>
                <Icon className="mr-2 h-4 w-4" />{label}
              </Button>
            ))}
          </div>

          {view === "alerts" && (
            <div className="space-y-4">
              <Card className="border-violet-500/20">
                <CardContent className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-5">
                  <div><p className="text-xs uppercase tracking-wide text-muted-foreground">Último ciclo</p><p className="mt-1 text-sm font-medium">{formatOperationalDate(slaStatus?.lastRunAt ?? null)}</p></div>
                  <div><p className="text-xs uppercase tracking-wide text-muted-foreground">Candidatos</p><p className="mt-1 text-sm font-medium">{slaStatus?.lastCandidateCount ?? 0}</p></div>
                  <div><p className="text-xs uppercase tracking-wide text-muted-foreground">Eventos emitidos</p><p className="mt-1 text-sm font-medium">{slaStatus?.lastEmittedCount ?? 0}</p></div>
                  <div><p className="text-xs uppercase tracking-wide text-muted-foreground">SLA limitado suprimido</p><p className="mt-1 text-sm font-medium">{slaStatus?.lastSuppressedLimitedEvidence ?? 0}</p></div>
                  <div><p className="text-xs uppercase tracking-wide text-muted-foreground">Webhook</p><p className="mt-1 flex items-center gap-2 text-sm font-medium"><Webhook className="h-4 w-4" />{slaStatus?.webhookConfigured ? "Configurado" : "No configurado"}</p></div>
                </CardContent>
              </Card>

              {slaStatus?.lastError && (
                <Card className="border-red-500/35 bg-red-500/[0.05]"><CardContent className="p-4"><p className="font-medium text-red-200">Último error del worker O2</p><p className="mt-1 text-sm text-muted-foreground">{slaStatus.lastError}</p></CardContent></Card>
              )}

              <Card>
                <CardContent className="grid gap-3 p-4 md:grid-cols-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" value={alertFilters.search} placeholder="Buscar equipo, worker o política" onChange={(event) => setAlertFilters((current) => ({ ...current, search: event.target.value }))} />
                  </div>
                  <select className={selectClass()} value={alertFilters.mode} onChange={(event) => setAlertFilters((current) => ({ ...current, mode: event.target.value as OperationalSlaFilters["mode"] }))}>
                    <option value="ACTIVE">Alertas activas</option>
                    <option value="HISTORY">Historial append-only</option>
                  </select>
                  <select className={selectClass()} value={alertFilters.league} onChange={(event) => setAlertFilters((current) => ({ ...current, league: event.target.value as OperationalSlaFilters["league"] }))}>
                    {ALERT_LEAGUES.map((league) => <option key={league} value={league}>{league === "ALL" ? "Todas las ligas" : league}</option>)}
                  </select>
                  <select className={selectClass()} value={alertFilters.severity} onChange={(event) => setAlertFilters((current) => ({ ...current, severity: event.target.value as OperationalSlaFilters["severity"] }))}>
                    {ALERT_SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity === "ALL" ? "Todas las severidades" : severity}</option>)}
                  </select>
                </CardContent>
              </Card>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">Mostrando {visibleAlerts.length} eventos · {alertFilters.mode === "ACTIVE" ? "último estado de cada ciclo" : "historial completo"}</p>
                {(alertFilters.mode !== "ACTIVE" || alertFilters.league !== "ALL" || alertFilters.severity !== "ALL" || alertFilters.search) && (
                  <Button variant="ghost" size="sm" onClick={() => setAlertFilters({ mode: "ACTIVE", league: "ALL", severity: "ALL", search: "" })}>Limpiar filtros</Button>
                )}
              </div>

              {visibleAlerts.length ? visibleAlerts.map((event) => <AlertCard key={event.eventId} event={event} />) : (
                <Card><CardContent className="p-8 text-center"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-300" /><p className="mt-3 font-medium">No hay alertas con estos filtros</p><p className="text-sm text-muted-foreground">O2 no fabrica alertas cuando no existe una violación verificable.</p></CardContent></Card>
              )}

              <Card>
                <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><TimerReset className="h-4 w-4" />Política SLA activa</CardTitle></CardHeader>
                <CardContent className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                  <div><p className="text-muted-foreground">Captura FINAL WARNING</p><p className="font-medium">{slaStatus?.policy.finalCaptureWarningMinutes ?? 45} min antes</p></div>
                  <div><p className="text-muted-foreground">Captura FINAL CRITICAL</p><p className="font-medium">{slaStatus?.policy.finalCaptureCriticalMinutes ?? 10} min antes</p></div>
                  <div><p className="text-muted-foreground">Settlement CRITICAL</p><p className="font-medium">+{slaDurationLabel(slaStatus?.policy.settlementCriticalAfterMinutes ?? 360)}</p></div>
                  <div><p className="text-muted-foreground">Evidencia LIMITED</p><p className="font-medium">Alertas temporales bloqueadas</p></div>
                </CardContent>
              </Card>
            </div>
          )}

          {view === "incidents" && report && (
            <div className="space-y-4">
              <Card>
                <CardContent className="grid gap-3 p-4 md:grid-cols-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" value={filters.search} placeholder="Buscar equipo, worker o motivo" onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} />
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

          {view === "workers" && report && (
            <div className="grid gap-3 xl:grid-cols-2">
              {report.workers.map((worker) => <WorkerCard key={worker.id} worker={worker} />)}
            </div>
          )}

          {view === "coverage" && report && (
            <div className="grid gap-3 lg:grid-cols-2">
              {(Object.entries(report.coverage) as Array<[OperationalLeague, (typeof report.coverage)[OperationalLeague]]>).map(([league, coverage]) => (
                <Card key={league}>
                  <CardHeader className="pb-3"><div className="flex items-center justify-between"><CardTitle>{league}</CardTitle><Badge variant="outline" className={coverage.evidenceConfidence === "AUTHORITATIVE" ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200" : "border-violet-500/35 bg-violet-500/10 text-violet-200"}>{coverage.evidenceConfidence}</Badge></div></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p><span className="text-muted-foreground">Fuente:</span> {coverage.source}</p>
                    <p><span className="text-muted-foreground">Settlement automático observado:</span> {coverage.settlementAutomationObserved ? "Sí" : "No"}</p>
                    <p className="text-muted-foreground">{coverage.note}</p>
                    {coverage.evidenceConfidence === "LIMITED" && <p className="text-violet-200">O2 suprime alertas temporales para evitar falsos vencimientos.</p>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
            <CardContent className="grid gap-3 p-4 md:grid-cols-2">
              <div><p className="text-sm font-semibold text-emerald-200">Permitido en O2</p><p className="mt-1 text-sm text-muted-foreground">Leer alertas, SLA, escalamiento, recordatorios, resolución y evidencia correspondiente.</p></div>
              <div><p className="text-sm font-semibold text-amber-200">Bloqueado en O2</p><p className="mt-1 text-sm text-muted-foreground">Reintentar settlement, modificar ledger, inventar resultados, apostar o cambiar el predictor.</p></div>
            </CardContent>
          </Card>
        </>
      )}

      {(incidentQuery.isLoading || slaQuery.isLoading) && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin" />Cargando operaciones y alertas SLA…</CardContent></Card>
      )}
    </div>
  );
}
