import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  FileCheck2,
  ListChecks,
  LockKeyhole,
  PlayCircle,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { fetchJson } from "@/lib/queryClient";
import {
  formatOperationalDate,
  type IncidentCenterEnvelope,
  type OperationalIncident,
} from "@/lib/operations-incident-center";
import {
  O3_CONFIRMATION_PHRASE,
  buildOperationalReprocessingIdempotencyKey,
  eligibleOperationalReprocessingIncidents,
  operationalReprocessingAuditLabel,
  operationalReprocessingSafetyValid,
  reprocessingExecutionReady,
  reprocessingPlanExpired,
  type OperationalReprocessingAuditEnvelope,
  type OperationalReprocessingAuditEvent,
  type OperationalReprocessingExecution,
  type OperationalReprocessingExecutionEnvelope,
  type OperationalReprocessingPlan,
  type OperationalReprocessingPlanEnvelope,
  type OperationalReprocessingStatusEnvelope,
} from "@/lib/operations-reprocessing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function randomNonce(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function stateBadgeClass(state: string): string {
  if (["READY", "COMPLETED", "IDEMPOTENT_REPLAY", "EXECUTION_COMPLETED", "SETTLEMENT_APPENDED", "SETTLEMENT_IDEMPOTENT"].includes(state)) {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }
  if (["BLOCKED", "PARTIAL_FAILURE", "EXECUTION_BLOCKED", "EXECUTION_FAILED", "PREVIEW_BLOCKED"].includes(state)) {
    return "border-red-500/40 bg-red-500/10 text-red-200";
  }
  return "border-cyan-500/40 bg-cyan-500/10 text-cyan-100";
}

function IncidentPreviewCard({
  incident,
  selected,
  busy,
  onPreview,
}: {
  incident: OperationalIncident;
  selected: boolean;
  busy: boolean;
  onPreview: (incident: OperationalIncident) => void;
}) {
  return (
    <Card className={selected ? "border-cyan-500/40 bg-cyan-500/[0.04]" : "border-border"}>
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">MLB</Badge>
            <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-emerald-200">AUTHORITATIVE</Badge>
            <Badge variant="outline" className={incident.state === "SETTLEMENT_OVERDUE" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}>
              {incident.state}
            </Badge>
          </div>
          <h3 className="mt-3 text-lg font-semibold">{incident.awayTeam} @ {incident.homeTeam}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatOperationalDate(incident.commenceTime ?? incident.gameDate)} · Juego {incident.gameId}
          </p>
          <p className="mt-2 text-sm">{incident.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">{incident.reasonCode} · Worker: {incident.worker}</p>
        </div>
        <Button
          type="button"
          variant={selected ? "default" : "outline"}
          disabled={busy}
          onClick={() => onPreview(incident)}
        >
          <FileCheck2 className="mr-2 h-4 w-4" />
          {busy && selected ? "Creando vista previa…" : "Crear vista previa"}
        </Button>
      </CardContent>
    </Card>
  );
}

function PlanSummary({ plan }: { plan: OperationalReprocessingPlan }) {
  const expired = reprocessingPlanExpired(plan);
  return (
    <div className="space-y-4">
      <Card className={plan.state === "READY" && !expired ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-red-500/30 bg-red-500/[0.03]"}>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className={stateBadgeClass(expired ? "BLOCKED" : plan.state)}>
                  {expired ? "EXPIRADO" : plan.state}
                </Badge>
                <Badge variant="outline">Un partido</Badge>
                <Badge variant="outline">{plan.targets.length} targets</Badge>
                <Badge variant="outline">{plan.proposals.length} propuestas</Badge>
              </div>
              <CardTitle className="mt-3">{plan.incident.awayTeam} @ {plan.incident.homeTeam}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Plan {plan.planId} · vence {formatOperationalDate(plan.expiresAt)}
              </p>
            </div>
            <div className="text-left md:text-right">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Final oficial</p>
              <p className="text-2xl font-bold">
                {plan.officialEvidence
                  ? `${plan.officialEvidence.awayTeam} ${plan.officialEvidence.finalScore.away} — ${plan.officialEvidence.homeTeam} ${plan.officialEvidence.finalScore.home}`
                  : "No disponible"}
              </p>
              {plan.officialEvidence && <p className="text-xs text-muted-foreground">MLB gamePk {plan.officialEvidence.gamePk}</p>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {plan.blockers.length > 0 && (
            <div className="rounded-lg border border-red-500/35 bg-red-500/[0.06] p-3">
              <p className="font-medium text-red-200">Bloqueadores</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {plan.blockers.map((blocker) => <li key={blocker}>• {blocker}</li>)}
              </ul>
            </div>
          )}
          {plan.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.05] p-3">
              <p className="font-medium text-amber-200">Advertencias</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {plan.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
              </ul>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/40 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Digest del plan</p>
              <p className="mt-2 break-all font-mono text-xs">{plan.planDigest}</p>
            </div>
            <div className="rounded-lg border border-border bg-background/40 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Digest de precondiciones</p>
              <p className="mt-2 break-all font-mono text-xs">{plan.preconditionDigest}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4" />Targets y resultados propuestos</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {plan.targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No existen targets ejecutables en este plan.</p>
          ) : plan.targets.map((target) => {
            const proposal = plan.proposals.find((item) => item.predictionId === target.predictionId);
            return (
              <div key={target.predictionId} className="rounded-lg border border-border p-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{target.marketType}</Badge>
                      <Badge variant="outline">{target.analysisStage}</Badge>
                      {proposal && <Badge variant="outline" className={stateBadgeClass(proposal.result === "WIN" ? "COMPLETED" : proposal.result === "LOSS" ? "BLOCKED" : "READY")}>{proposal.result}</Badge>}
                    </div>
                    <p className="mt-2 font-medium">{target.selection}{target.line == null ? "" : ` ${target.line}`}</p>
                    <p className="text-xs text-muted-foreground">Predicción {target.predictionId} · cuota {target.oddsAmerican}</p>
                  </div>
                  <div className="text-sm md:text-right">
                    <p>Outcome: {proposal?.outcomeValue ?? "—"}</p>
                    <p className="text-muted-foreground">Closing: {proposal?.closingOddsAmerican ?? "sin captura exacta"}</p>
                  </div>
                </div>
                {proposal && <p className="mt-2 text-xs text-muted-foreground">{proposal.notes}</p>}
                <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">payload {target.payloadSha256}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function ExecutionResultCard({ execution }: { execution: OperationalReprocessingExecution }) {
  return (
    <Card className={execution.state === "COMPLETED" || execution.state === "IDEMPOTENT_REPLAY" ? "border-emerald-500/35 bg-emerald-500/[0.04]" : "border-red-500/35 bg-red-500/[0.04]"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Resultado de la ejecución</CardTitle>
          <Badge variant="outline" className={stateBadgeClass(execution.state)}>{execution.state}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><p className="text-muted-foreground">Agregados</p><p className="text-xl font-bold">{execution.appended}</p></div>
          <div><p className="text-muted-foreground">Idempotentes</p><p className="text-xl font-bold">{execution.idempotent}</p></div>
          <div><p className="text-muted-foreground">Verificados</p><p className="text-xl font-bold">{execution.verified}</p></div>
          <div><p className="text-muted-foreground">Fallos</p><p className="text-xl font-bold">{execution.failed.length}</p></div>
        </div>
        {execution.failed.length > 0 && (
          <div className="rounded-lg border border-red-500/35 p-3">
            {execution.failed.map((failure) => <p key={`${failure.predictionId}-${failure.error}`} className="text-red-200">{failure.predictionId}: {failure.error}</p>)}
          </div>
        )}
        <p className="break-all font-mono text-xs text-muted-foreground">Execution {execution.executionId}</p>
      </CardContent>
    </Card>
  );
}

function AuditEventCard({ event }: { event: OperationalReprocessingAuditEvent }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={stateBadgeClass(event.eventType)}>{operationalReprocessingAuditLabel(event.eventType)}</Badge>
              {event.predictionId && <Badge variant="outline">{event.predictionId}</Badge>}
            </div>
            <p className="mt-2 text-sm">{event.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">Plan {event.planId} · Juego {event.gameId}</p>
          </div>
          <p className="text-xs text-muted-foreground">{formatOperationalDate(event.recordedAt)}</p>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <p className="break-all font-mono text-[10px] text-muted-foreground">Digest: {event.eventDigest}</p>
          <p className="break-all font-mono text-[10px] text-muted-foreground">Anterior: {event.previousDigest ?? "GENESIS"}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OperationsReprocessing() {
  const { authenticated, loading: authLoading, requestLogin } = useAuth();
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [plan, setPlan] = useState<OperationalReprocessingPlan | null>(null);
  const [execution, setExecution] = useState<OperationalReprocessingExecution | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const incidentQuery = useQuery({
    queryKey: ["ops-incident-center-o3"],
    queryFn: () => fetchJson<IncidentCenterEnvelope>("/api/ops/v1/incident-center?limit=500"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const statusQuery = useQuery({
    queryKey: ["ops-reprocessing-status"],
    queryFn: () => fetchJson<OperationalReprocessingStatusEnvelope>("/api/ops/v1/reprocessing/status"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const auditQuery = useQuery({
    queryKey: ["ops-reprocessing-audit"],
    queryFn: () => fetchJson<OperationalReprocessingAuditEnvelope>("/api/ops/v1/reprocessing/audit?limit=250"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const incidents = incidentQuery.data?.data.incidents ?? [];
  const eligible = useMemo(
    () => eligibleOperationalReprocessingIncidents(incidents),
    [incidents],
  );
  const status = statusQuery.data?.data ?? null;
  const auditEvents = auditQuery.data?.data ?? [];
  const safetyValid = operationalReprocessingSafetyValid(status?.safety);
  const expired = reprocessingPlanExpired(plan);
  const controlsReady = reprocessingExecutionReady({
    plan,
    confirmation,
    reason,
    idempotencyKey,
  }) && acknowledged;
  const refreshing = incidentQuery.isFetching || statusQuery.isFetching || auditQuery.isFetching;

  const refresh = () => {
    void incidentQuery.refetch();
    void statusQuery.refetch();
    void auditQuery.refetch();
  };

  const createPreview = async (incident: OperationalIncident) => {
    setSelectedIncidentId(incident.id);
    setPreviewing(true);
    setActionError(null);
    setExecution(null);
    setConfirmation("");
    setReason("");
    setAcknowledged(false);
    try {
      const response = await fetchJson<OperationalReprocessingPlanEnvelope>(
        "/api/ops/v1/reprocessing/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ incidentId: incident.id, league: "MLB" }),
        },
      );
      setPlan(response.data);
      setIdempotencyKey(buildOperationalReprocessingIdempotencyKey(response.data.planId, randomNonce()));
      void statusQuery.refetch();
      void auditQuery.refetch();
    } catch (error) {
      setPlan(null);
      setIdempotencyKey("");
      setActionError(error instanceof Error ? error.message : "No se pudo crear la vista previa O3");
    } finally {
      setPreviewing(false);
    }
  };

  const executePlan = async () => {
    if (!plan || !controlsReady || executing) return;
    setExecuting(true);
    setActionError(null);
    try {
      const response = await fetchJson<OperationalReprocessingExecutionEnvelope>(
        "/api/ops/v1/reprocessing/execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            planId: plan.planId,
            planDigest: plan.planDigest,
            idempotencyKey,
            confirmation: confirmation.trim(),
            reason: reason.trim(),
          }),
        },
      );
      setExecution(response.data);
      setAcknowledged(false);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La ejecución O3 fue rechazada");
    } finally {
      setExecuting(false);
    }
  };

  if (authLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Verificando sesión segura…</div>;
  }

  if (!authenticated) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6">
        <Card className="w-full border-cyan-500/25">
          <CardContent className="space-y-4 p-6 text-center">
            <LockKeyhole className="mx-auto h-10 w-10 text-cyan-300" />
            <h1 className="text-2xl font-bold">Reprocesamiento O3 privado</h1>
            <p className="text-muted-foreground">Inicia sesión para consultar incidencias elegibles, crear vistas previas o revisar la auditoría.</p>
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
            <Badge className="border-cyan-500/40 bg-cyan-500/10 text-cyan-100">O3 · PRIVADO</Badge>
            <Badge className="border-violet-500/40 bg-violet-500/10 text-violet-100">CONTROLADO</Badge>
            <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">SHADOW ONLY</Badge>
            <Badge variant="outline">Exposición: 0</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-bold">Reprocesamiento seguro y controlado</h1>
          <p className="mt-1 max-w-4xl text-muted-foreground">
            O3 permite crear una vista previa para un solo partido MLB y, únicamente tras revisión explícita, agregar settlements oficiales append-only. No existe ejecución automática.
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />Actualizar
        </Button>
      </div>

      {(incidentQuery.error || statusQuery.error || auditQuery.error) && (
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="flex gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">O3 no pudo cargar todas sus fuentes privadas</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {incidentQuery.error instanceof Error ? incidentQuery.error.message : statusQuery.error instanceof Error ? statusQuery.error.message : auditQuery.error instanceof Error ? auditQuery.error.message : "Error desconocido"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">La consola falla cerrada y no ejecuta acciones durante esta condición.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {actionError && (
        <Card className="border-red-500/35 bg-red-500/[0.05]">
          <CardContent className="flex gap-3 p-4">
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div><p className="font-medium text-red-200">Acción O3 rechazada</p><p className="mt-1 text-sm text-muted-foreground">{actionError}</p></div>
          </CardContent>
        </Card>
      )}

      {status && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <Card><CardContent className="p-4"><FileCheck2 className="h-5 w-5 text-cyan-300" /><p className="mt-3 text-2xl font-bold">{status.plans}</p><p className="text-xs text-muted-foreground">Planes totales</p></CardContent></Card>
          <Card><CardContent className="p-4"><CheckCircle2 className="h-5 w-5 text-emerald-300" /><p className="mt-3 text-2xl font-bold">{status.readyPlans}</p><p className="text-xs text-muted-foreground">Planes READY</p></CardContent></Card>
          <Card><CardContent className="p-4"><Ban className="h-5 w-5 text-red-300" /><p className="mt-3 text-2xl font-bold">{status.blockedPlans}</p><p className="text-xs text-muted-foreground">Planes bloqueados</p></CardContent></Card>
          <Card><CardContent className="p-4"><PlayCircle className="h-5 w-5 text-violet-300" /><p className="mt-3 text-2xl font-bold">{status.executions}</p><p className="text-xs text-muted-foreground">Ejecuciones</p></CardContent></Card>
          <Card><CardContent className="p-4"><Clock3 className="h-5 w-5 text-amber-300" /><p className="mt-3 text-sm font-semibold">{Math.round(status.planTtlMs / 60_000)} minutos</p><p className="text-xs text-muted-foreground">Vigencia del plan</p></CardContent></Card>
          <Card className={safetyValid ? "border-emerald-500/30" : "border-red-500/35"}><CardContent className="p-4"><ShieldCheck className={`h-5 w-5 ${safetyValid ? "text-emerald-300" : "text-red-300"}`} /><p className="mt-3 text-sm font-semibold">{safetyValid ? "Compuertas válidas" : "Compuerta inválida"}</p><p className="text-xs text-muted-foreground">Admin para ejecutar</p></CardContent></Card>
        </div>
      )}

      <Card className="border-amber-500/25 bg-amber-500/[0.03]">
        <CardContent className="grid gap-4 p-4 md:grid-cols-2">
          <div><p className="font-semibold text-emerald-200">Permitido</p><p className="mt-1 text-sm text-muted-foreground">Crear una vista previa para un juego MLB autoritativo, revisar evidencia y ejecutar manualmente como administrador.</p></div>
          <div><p className="font-semibold text-amber-200">Siempre bloqueado</p><p className="mt-1 text-sm text-muted-foreground">Ejecución automática, lotes multijuego, evidencia limitada, correcciones, UPDATE/DELETE, apuestas o cambios del predictor.</p></div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold">1. Seleccionar incidencia elegible</h2>
            <p className="text-sm text-muted-foreground">Solo aparecen MLB `READY_FOR_SETTLEMENT` o `SETTLEMENT_OVERDUE` con evidencia autoritativa.</p>
          </div>
          {eligible.length ? eligible.map((incident) => (
            <IncidentPreviewCard
              key={incident.id}
              incident={incident}
              selected={selectedIncidentId === incident.id}
              busy={previewing}
              onPreview={(item) => void createPreview(item)}
            />
          )) : (
            <Card><CardContent className="p-8 text-center"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-300" /><p className="mt-3 font-medium">No hay incidencias MLB elegibles</p><p className="text-sm text-muted-foreground">O3 no muestra ni reprocesa partidos fuera de su alcance seguro.</p></CardContent></Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Controles obligatorios</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>• Vista previa separada de la ejecución.</p>
            <p>• Fuente oficial consultada dos veces.</p>
            <p>• Digest y targets sellados.</p>
            <p>• Frase exacta y motivo obligatorio.</p>
            <p>• Idempotencia y detección de drift.</p>
            <p>• Solo eventos append-only con verificación posterior.</p>
            <p>• La ejecución requiere rol administrador.</p>
          </CardContent>
        </Card>
      </div>

      {plan && (
        <div className="space-y-6">
          <div><h2 className="text-xl font-bold">2. Revisar vista previa sellada</h2><p className="text-sm text-muted-foreground">Crear el plan no liquida ninguna predicción.</p></div>
          <PlanSummary plan={plan} />

          <Card className="border-red-500/25 bg-red-500/[0.025]">
            <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2"><PlayCircle className="h-5 w-5" />3. Ejecución administrativa</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3 text-sm">
                Esta acción puede agregar settlements oficiales al ledger append-only. El servidor volverá a consultar MLB y bloqueará cualquier drift. No es reversible mediante O3.
              </div>
              {expired && <p className="text-sm font-medium text-red-200">El plan expiró. Crea una nueva vista previa.</p>}
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="o3-confirmation">Escribe la frase exacta</label>
                  <p className="break-all font-mono text-xs text-cyan-200">{O3_CONFIRMATION_PHRASE}</p>
                  <Input id="o3-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" placeholder="Frase de confirmación" disabled={executing} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="o3-idempotency">Idempotency key</label>
                  <Input id="o3-idempotency" value={idempotencyKey} readOnly className="font-mono text-xs" />
                  <p className="text-xs text-muted-foreground">Se genera una vez por vista previa y evita dobles ejecuciones.</p>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="o3-reason">Motivo operativo</label>
                <textarea
                  id="o3-reason"
                  className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Describe por qué el worker normal no completó el settlement y qué evidencia verificaste."
                  disabled={executing}
                />
                <p className="text-xs text-muted-foreground">{reason.trim().length}/500 · mínimo 10 caracteres</p>
              </div>
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={executing} />
                <span>Revisé el marcador oficial, todos los targets y resultados propuestos; entiendo que O3 agregará eventos de settlement append-only.</span>
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Estado: {plan.state} · {expired ? "expirado" : "vigente"} · Ejecución: solo administrador</p>
                <Button type="button" variant="destructive" disabled={!controlsReady || executing} onClick={() => void executePlan()}>
                  <PlayCircle className="mr-2 h-4 w-4" />{executing ? "Verificando y ejecutando…" : "Ejecutar settlement append-only"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {execution && <ExecutionResultCard execution={execution} />}

      <div className="space-y-4">
        <div><h2 className="flex items-center gap-2 text-xl font-bold"><ScrollText className="h-5 w-5" />Auditoría append-only</h2><p className="text-sm text-muted-foreground">Cada evento incluye el digest anterior para detectar alteraciones.</p></div>
        {auditEvents.length ? auditEvents.map((event) => <AuditEventCard key={event.eventId} event={event} />) : (
          <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Aún no existen eventos O3 para este usuario.</CardContent></Card>
        )}
      </div>

      {(incidentQuery.isLoading || statusQuery.isLoading || auditQuery.isLoading) && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground"><RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin" />Cargando O3 y sus fuentes privadas…</CardContent></Card>
      )}
    </div>
  );
}
