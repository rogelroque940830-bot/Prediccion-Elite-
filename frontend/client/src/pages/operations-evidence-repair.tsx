import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ClipboardSearch,
  Clock3,
  DatabaseZap,
  FileCheck2,
  FileWarning,
  Link2,
  ListChecks,
  LockKeyhole,
  PlayCircle,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { fetchJson } from "@/lib/queryClient";
import {
  formatOperationalDate,
  type IncidentCenterEnvelope,
  type OperationalIncident,
} from "@/lib/operations-incident-center";
import {
  O31_CONFIRMATION_PHRASE,
  buildO31IdempotencyKey,
  eligibleO31Incidents,
  o31AuditLabel,
  o31ExecutionReady,
  o31Expired,
  o31ManualFields,
  o31PlanRequestReady,
  o31SafetyValid,
  type O31AuditEnvelope,
  type O31AuditEvent,
  type O31Execution,
  type O31ExecutionEnvelope,
  type O31Inspection,
  type O31InspectionEnvelope,
  type O31Issue,
  type O31ManualPatch,
  type O31Plan,
  type O31PlanEnvelope,
  type O31RecordSnapshot,
  type O31RepairField,
  type O31RepairSource,
  type O31StatusEnvelope,
} from "@/lib/operations-evidence-repair";
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

function currentLocalDateTime(): string {
  const date = new Date();
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function safeIso(localValue: string): string {
  const parsed = Date.parse(localValue);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : localValue;
}

function displayValue(value: unknown): string {
  if (value == null || value === "") return "No disponible";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function badgeClass(state: string): string {
  if (["READY", "COMPLETED", "IDEMPOTENT_REPLAY", "INSPECTION_CREATED", "PLAN_CREATED", "EXECUTION_COMPLETED", "SUPERSEDING_PREDICTION_APPENDED", "SUPERSEDING_PREDICTION_IDEMPOTENT"].includes(state)) {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }
  if (["BLOCKED", "PARTIAL_FAILURE", "INSPECTION_BLOCKED", "PLAN_BLOCKED", "EXECUTION_FAILED", "EXECUTION_BLOCKED"].includes(state)) {
    return "border-red-500/40 bg-red-500/10 text-red-200";
  }
  return "border-cyan-500/40 bg-cyan-500/10 text-cyan-100";
}

function issueModeLabel(mode: O31Issue["repairMode"]): string {
  if (mode === "AUTO_FROM_OFFICIAL") return "MLB oficial";
  if (mode === "MANUAL_EVIDENCE_REQUIRED") return "Evidencia manual";
  return "No reparable aquí";
}

function fieldLabel(field: O31RepairField | string): string {
  const labels: Record<string, string> = {
    gamePk: "MLB gamePk",
    gameDate: "Fecha del juego",
    homeTeam: "Equipo local",
    awayTeam: "Equipo visitante",
    marketType: "Tipo de mercado",
    selection: "Selección",
    oddsAmerican: "Cuota americana",
    analysisStage: "Etapa del análisis",
    supersession: "Cadena de supersesión",
  };
  return labels[field] ?? field;
}

function IncidentCard({
  incident,
  selected,
  busy,
  onInspect,
}: {
  incident: OperationalIncident;
  selected: boolean;
  busy: boolean;
  onInspect: (incident: OperationalIncident) => void;
}) {
  return (
    <Card className={selected ? "border-cyan-500/40 bg-cyan-500/[0.04]" : "border-border"}>
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">MLB</Badge>
            <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-200">DATA QUALITY</Badge>
            <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-emerald-200">AUTHORITATIVE</Badge>
          </div>
          <h3 className="mt-3 text-lg font-semibold">{incident.awayTeam} @ {incident.homeTeam}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatOperationalDate(incident.commenceTime ?? incident.gameDate)} · Juego {incident.gameId}
          </p>
          <p className="mt-2 text-sm">{incident.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">{incident.reasonCode} · Worker: {incident.worker}</p>
        </div>
        <Button type="button" variant={selected ? "default" : "outline"} disabled={busy} onClick={() => onInspect(incident)}>
          <ClipboardSearch className="mr-2 h-4 w-4" />
          {busy && selected ? "Consultando evidencia…" : "Inspeccionar evidencia"}
        </Button>
      </CardContent>
    </Card>
  );
}

function OfficialEvidenceCard({ inspection }: { inspection: O31Inspection }) {
  const evidence = inspection.officialEvidence;
  return (
    <Card className={evidence?.final ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-red-500/30 bg-red-500/[0.03]"}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base"><DatabaseZap className="h-4 w-4" />Evidencia oficial MLB</CardTitle>
          <Badge variant="outline" className={evidence?.final ? badgeClass("READY") : badgeClass("BLOCKED")}>{evidence?.detailedState ?? "NO DISPONIBLE"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {evidence ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-muted-foreground">Juego</p><p className="font-medium">{evidence.awayTeam} @ {evidence.homeTeam}</p></div>
              <div><p className="text-muted-foreground">gamePk</p><p className="font-medium">{evidence.gamePk}</p></div>
              <div><p className="text-muted-foreground">Fecha oficial</p><p className="font-medium">{evidence.gameDate}</p></div>
              <div><p className="text-muted-foreground">Marcador final</p><p className="font-medium">{evidence.finalScore ? `${evidence.awayTeam} ${evidence.finalScore.away} — ${evidence.homeTeam} ${evidence.finalScore.home}` : "No disponible"}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">Fuente: MLB Stats API · consultada {formatOperationalDate(evidence.fetchedAt)}</p>
          </>
        ) : <p className="text-red-200">No se pudo identificar evidencia oficial inequívoca para este juego.</p>}
      </CardContent>
    </Card>
  );
}

function IssueCard({ issue }: { issue: O31Issue }) {
  return (
    <div className="rounded-lg border border-red-500/25 bg-red-500/[0.035] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="border-red-500/40 bg-red-500/10 text-red-200">{issue.code}</Badge>
          <Badge variant="outline">{fieldLabel(issue.field)}</Badge>
        </div>
        <Badge variant="outline" className={issue.repairMode === "AUTO_FROM_OFFICIAL" ? "border-cyan-500/35 bg-cyan-500/10 text-cyan-100" : issue.repairMode === "MANUAL_EVIDENCE_REQUIRED" ? "border-amber-500/35 bg-amber-500/10 text-amber-200" : "border-red-500/35 bg-red-500/10 text-red-200"}>
          {issueModeLabel(issue.repairMode)}
        </Badge>
      </div>
      <p className="mt-2 text-sm">{issue.message}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 text-xs">
        <div className="rounded border border-border p-2"><p className="text-muted-foreground">Valor actual</p><p className="mt-1 break-all font-mono">{displayValue(issue.currentValue)}</p></div>
        <div className="rounded border border-border p-2"><p className="text-muted-foreground">Valor oficial</p><p className="mt-1 break-all font-mono">{displayValue(issue.officialValue)}</p></div>
      </div>
    </div>
  );
}

function RecordInspectionCard({ record }: { record: O31RecordSnapshot }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{record.market.type || "SIN MERCADO"}</Badge>
              <Badge variant="outline">{record.analysisStage}</Badge>
              <Badge variant="outline" className={record.issues.length ? badgeClass("BLOCKED") : badgeClass("READY")}>{record.issues.length} problemas</Badge>
            </div>
            <CardTitle className="mt-3 text-base">{record.market.selection || "Selección no disponible"}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Predicción {record.predictionId}</p>
          </div>
          <div className="text-sm md:text-right">
            <p>Cuota: {record.market.oddsAmerican}</p>
            <p className="text-muted-foreground">Book: {record.market.book ?? "No disponible"}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {record.issues.map((issue) => <IssueCard key={`${issue.predictionId}-${issue.code}-${issue.field}`} issue={issue} />)}
        <p className="break-all font-mono text-[10px] text-muted-foreground">payload {record.payloadSha256}</p>
        {record.supersedesId && <p className="break-all font-mono text-[10px] text-muted-foreground">supersedes {record.supersedesId}</p>}
      </CardContent>
    </Card>
  );
}

function ManualFieldInput({
  field,
  value,
  onChange,
}: {
  field: O31RepairField;
  value: string | number | undefined;
  onChange: (value: string | number | undefined) => void;
}) {
  if (field === "marketType") {
    return (
      <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={String(value ?? "")} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">Selecciona mercado</option>
        {["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL", "TEAM_TOTAL", "TT_OVER_15_F5", "TT_UNDER_25_F5", "INNING_1_ML", "NRFI", "YRFI", "OTHER"].map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  const numeric = field === "oddsAmerican" || field === "gamePk";
  return (
    <Input
      type={numeric ? "number" : field === "gameDate" ? "date" : "text"}
      value={value == null ? "" : String(value)}
      onChange={(event) => {
        if (!numeric) onChange(event.target.value || undefined);
        else onChange(event.target.value === "" ? undefined : Number(event.target.value));
      }}
      placeholder={field === "oddsAmerican" ? "Ej. -115" : `Completa ${fieldLabel(field).toLowerCase()}`}
      autoComplete="off"
    />
  );
}

function RepairPlanCard({ plan }: { plan: O31Plan }) {
  const expired = o31Expired(plan);
  return (
    <Card className={plan.state === "READY" && !expired ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-red-500/30 bg-red-500/[0.03]"}>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={badgeClass(expired ? "BLOCKED" : plan.state)}>{expired ? "EXPIRADO" : plan.state}</Badge>
              <Badge variant="outline">{plan.targets.length} targets</Badge>
              <Badge variant="outline">Un partido</Badge>
            </div>
            <CardTitle className="mt-3">Plan de reparación sellado</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{plan.planId} · vence {formatOperationalDate(plan.expiresAt)}</p>
          </div>
          {plan.officialEvidence && <div className="text-left md:text-right"><p className="text-xs uppercase tracking-wide text-muted-foreground">Final MLB</p><p className="text-xl font-bold">{plan.officialEvidence.awayTeam} {plan.officialEvidence.finalScore?.away ?? "—"} — {plan.officialEvidence.homeTeam} {plan.officialEvidence.finalScore?.home ?? "—"}</p></div>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan.blockers.length > 0 && <div className="rounded-lg border border-red-500/35 bg-red-500/[0.05] p-3"><p className="font-medium text-red-200">Bloqueadores</p>{plan.blockers.map((item) => <p key={item} className="mt-1 text-sm text-muted-foreground">• {item}</p>)}</div>}
        {plan.warnings.length > 0 && <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.05] p-3"><p className="font-medium text-amber-200">Advertencias</p>{plan.warnings.map((item) => <p key={item} className="mt-1 text-sm text-muted-foreground">• {item}</p>)}</div>}
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border p-3"><p className="text-xs uppercase tracking-wide text-muted-foreground">Digest del plan</p><p className="mt-2 break-all font-mono text-xs">{plan.planDigest}</p></div>
          <div className="rounded-lg border border-border p-3"><p className="text-xs uppercase tracking-wide text-muted-foreground">Digest de precondiciones</p><p className="mt-2 break-all font-mono text-xs">{plan.preconditionDigest}</p></div>
        </div>
        <div className="space-y-2">
          {plan.targets.map((target) => (
            <div key={target.predictionId} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{target.predictionId}</p><div className="flex flex-wrap gap-2">{target.repairedFields.map((field) => <Badge key={field} variant="outline">{fieldLabel(field)}</Badge>)}</div></div>
              <p className="mt-2 text-xs text-muted-foreground">Se agregará una nueva versión; la predicción original permanecerá intacta.</p>
              <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">nuevo payload {target.proposedPayloadSha256}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ExecutionCard({ execution }: { execution: O31Execution }) {
  const success = execution.state === "COMPLETED" || execution.state === "IDEMPOTENT_REPLAY";
  return (
    <Card className={success ? "border-emerald-500/35 bg-emerald-500/[0.04]" : "border-red-500/35 bg-red-500/[0.04]"}>
      <CardHeader className="pb-3"><div className="flex items-center justify-between gap-3"><CardTitle>Resultado de O3.1</CardTitle><Badge variant="outline" className={badgeClass(execution.state)}>{execution.state}</Badge></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><p className="text-muted-foreground">Agregadas</p><p className="text-xl font-bold">{execution.appended}</p></div>
          <div><p className="text-muted-foreground">Idempotentes</p><p className="text-xl font-bold">{execution.idempotent}</p></div>
          <div><p className="text-muted-foreground">Verificadas</p><p className="text-xl font-bold">{execution.verified}</p></div>
          <div><p className="text-muted-foreground">Fallos</p><p className="text-xl font-bold">{execution.failed.length}</p></div>
        </div>
        {execution.failed.map((failure) => <p key={`${failure.predictionId}-${failure.error}`} className="text-red-200">{failure.predictionId}: {failure.error}</p>)}
        <p className="break-all font-mono text-xs text-muted-foreground">Execution {execution.executionId}</p>
      </CardContent>
    </Card>
  );
}

function AuditCard({ event }: { event: O31AuditEvent }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div><div className="flex flex-wrap gap-2"><Badge variant="outline" className={badgeClass(event.eventType)}>{o31AuditLabel(event.eventType)}</Badge>{event.predictionId && <Badge variant="outline">{event.predictionId}</Badge>}</div><p className="mt-2 text-sm">{event.message}</p><p className="mt-1 text-xs text-muted-foreground">Inspección {event.inspectionId ?? "—"} · Plan {event.planId ?? "—"}</p></div>
          <p className="text-xs text-muted-foreground">{formatOperationalDate(event.recordedAt)}</p>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2"><p className="break-all font-mono text-[10px] text-muted-foreground">Digest: {event.eventDigest}</p><p className="break-all font-mono text-[10px] text-muted-foreground">Anterior: {event.previousDigest ?? "GENESIS"}</p></div>
      </CardContent>
    </Card>
  );
}

export default function OperationsEvidenceRepair() {
  const { authenticated, loading: authLoading, requestLogin } = useAuth();
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<O31Inspection | null>(null);
  const [patches, setPatches] = useState<O31ManualPatch[]>([]);
  const [source, setSource] = useState<O31RepairSource>({ sourceName: "", evidenceReference: "", capturedAt: currentLocalDateTime(), note: "" });
  const [plan, setPlan] = useState<O31Plan | null>(null);
  const [execution, setExecution] = useState<O31Execution | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const incidentQuery = useQuery({
    queryKey: ["ops-incident-center-o31"],
    queryFn: () => fetchJson<IncidentCenterEnvelope>("/api/ops/v1/incident-center?limit=500"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const statusQuery = useQuery({
    queryKey: ["ops-evidence-repair-status"],
    queryFn: () => fetchJson<O31StatusEnvelope>("/api/ops/v1/evidence-repair/status"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  const auditQuery = useQuery({
    queryKey: ["ops-evidence-repair-audit"],
    queryFn: () => fetchJson<O31AuditEnvelope>("/api/ops/v1/evidence-repair/audit?limit=250"),
    enabled: authenticated,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  const incidents = incidentQuery.data?.data.incidents ?? [];
  const eligible = useMemo(() => eligibleO31Incidents(incidents), [incidents]);
  const status = statusQuery.data?.data ?? null;
  const auditEvents = auditQuery.data?.data ?? [];
  const safetyValid = o31SafetyValid(status?.safety);
  const manualFields = useMemo(() => o31ManualFields(inspection), [inspection]);
  const planReady = o31PlanRequestReady({ inspection, patches, source: { ...source, capturedAt: safeIso(source.capturedAt) } });
  const executeReady = o31ExecutionReady({ plan, confirmation, reason, idempotencyKey, acknowledged });
  const refreshing = incidentQuery.isFetching || statusQuery.isFetching || auditQuery.isFetching;

  const refresh = () => { void incidentQuery.refetch(); void statusQuery.refetch(); void auditQuery.refetch(); };

  const updatePatch = (predictionId: string, field: O31RepairField, value: string | number | undefined) => {
    setPatches((current) => {
      const existing = current.find((patch) => patch.predictionId === predictionId) ?? { predictionId };
      const next = { ...existing, [field]: value };
      return [...current.filter((patch) => patch.predictionId !== predictionId), next];
    });
  };

  const inspectIncident = async (incident: OperationalIncident) => {
    setSelectedIncidentId(incident.id);
    setInspecting(true);
    setActionError(null);
    setInspection(null);
    setPatches([]);
    setPlan(null);
    setExecution(null);
    setConfirmation("");
    setReason("");
    setAcknowledged(false);
    try {
      const response = await fetchJson<O31InspectionEnvelope>("/api/ops/v1/evidence-repair/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId: incident.id }),
      });
      setInspection(response.data);
      const seeded = response.data.records.map((record) => ({ predictionId: record.predictionId }));
      setPatches(seeded);
      void statusQuery.refetch();
      void auditQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo crear la inspección O3.1");
    } finally {
      setInspecting(false);
    }
  };

  const createPlan = async () => {
    if (!inspection || !planReady || planning) return;
    setPlanning(true);
    setActionError(null);
    setPlan(null);
    setExecution(null);
    try {
      const response = await fetchJson<O31PlanEnvelope>("/api/ops/v1/evidence-repair/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inspectionId: inspection.inspectionId,
          inspectionDigest: inspection.inspectionDigest,
          patches,
          repairSource: { ...source, capturedAt: safeIso(source.capturedAt) },
        }),
      });
      setPlan(response.data);
      setIdempotencyKey(buildO31IdempotencyKey(response.data.planId, randomNonce()));
      void statusQuery.refetch();
      void auditQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo crear el plan sellado O3.1");
    } finally {
      setPlanning(false);
    }
  };

  const executePlan = async () => {
    if (!plan || !executeReady || executing) return;
    setExecuting(true);
    setActionError(null);
    try {
      const response = await fetchJson<O31ExecutionEnvelope>("/api/ops/v1/evidence-repair/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, planDigest: plan.planDigest, idempotencyKey, confirmation: confirmation.trim(), reason: reason.trim() }),
      });
      setExecution(response.data);
      setAcknowledged(false);
      refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La ejecución O3.1 fue rechazada");
    } finally {
      setExecuting(false);
    }
  };

  if (authLoading) return <div className="p-6 text-sm text-muted-foreground">Verificando sesión segura…</div>;
  if (!authenticated) {
    return <div className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6"><Card className="w-full border-cyan-500/25"><CardContent className="space-y-4 p-6 text-center"><LockKeyhole className="mx-auto h-10 w-10 text-cyan-300" /><h1 className="text-2xl font-bold">Evidencia MLB privada</h1><p className="text-muted-foreground">Inicia sesión para inspeccionar incidencias de calidad y revisar reparaciones append-only.</p><Button onClick={requestLogin}>Iniciar sesión</Button></CardContent></Card></div>;
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap gap-2"><Badge className="border-cyan-500/40 bg-cyan-500/10 text-cyan-100">O3.1 · PRIVADO</Badge><Badge className="border-violet-500/40 bg-violet-500/10 text-violet-100">EVIDENCIA</Badge><Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">SHADOW ONLY</Badge><Badge variant="outline">Exposición: 0</Badge></div>
          <h1 className="mt-3 text-3xl font-bold">Inspector y reparación segura de evidencia MLB</h1>
          <p className="mt-1 max-w-4xl text-muted-foreground">O3.1 identifica el campo defectuoso, compara con MLB oficial y crea una nueva versión append-only. La predicción original nunca se sobrescribe y esta pantalla no ejecuta settlements.</p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={refreshing}><RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />Actualizar</Button>
      </div>

      {(incidentQuery.error || statusQuery.error || auditQuery.error) && <Card className="border-red-500/35 bg-red-500/[0.05]"><CardContent className="flex gap-3 p-4"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" /><div><p className="font-medium text-red-200">O3.1 no pudo cargar todas sus fuentes privadas</p><p className="mt-1 text-sm text-muted-foreground">{incidentQuery.error instanceof Error ? incidentQuery.error.message : statusQuery.error instanceof Error ? statusQuery.error.message : auditQuery.error instanceof Error ? auditQuery.error.message : "Error desconocido"}</p><p className="mt-1 text-xs text-muted-foreground">La consola falla cerrada y no realiza ninguna acción.</p></div></CardContent></Card>}
      {actionError && <Card className="border-red-500/35 bg-red-500/[0.05]"><CardContent className="flex gap-3 p-4"><Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" /><div><p className="font-medium text-red-200">Acción O3.1 rechazada</p><p className="mt-1 text-sm text-muted-foreground">{actionError}</p></div></CardContent></Card>}

      {status && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Card><CardContent className="p-4"><ClipboardSearch className="h-5 w-5 text-cyan-300" /><p className="mt-3 text-2xl font-bold">{status.inspections}</p><p className="text-xs text-muted-foreground">Inspecciones</p></CardContent></Card>
        <Card><CardContent className="p-4"><FileCheck2 className="h-5 w-5 text-violet-300" /><p className="mt-3 text-2xl font-bold">{status.plans}</p><p className="text-xs text-muted-foreground">Planes</p></CardContent></Card>
        <Card><CardContent className="p-4"><CheckCircle2 className="h-5 w-5 text-emerald-300" /><p className="mt-3 text-2xl font-bold">{status.readyPlans}</p><p className="text-xs text-muted-foreground">Planes READY</p></CardContent></Card>
        <Card><CardContent className="p-4"><PlayCircle className="h-5 w-5 text-amber-300" /><p className="mt-3 text-2xl font-bold">{status.executions}</p><p className="text-xs text-muted-foreground">Ejecuciones</p></CardContent></Card>
        <Card><CardContent className="p-4"><Clock3 className="h-5 w-5 text-amber-300" /><p className="mt-3 text-sm font-semibold">{Math.round(status.ttlMs / 60_000)} minutos</p><p className="text-xs text-muted-foreground">Vigencia</p></CardContent></Card>
        <Card className={safetyValid ? "border-emerald-500/30" : "border-red-500/35"}><CardContent className="p-4"><ShieldCheck className={`h-5 w-5 ${safetyValid ? "text-emerald-300" : "text-red-300"}`} /><p className="mt-3 text-sm font-semibold">{safetyValid ? "Compuertas válidas" : "Compuerta inválida"}</p><p className="text-xs text-muted-foreground">Admin para ejecutar</p></CardContent></Card>
      </div>}

      <Card className="border-amber-500/25 bg-amber-500/[0.03]"><CardContent className="grid gap-4 p-4 md:grid-cols-2"><div><p className="font-semibold text-emerald-200">Permitido</p><p className="mt-1 text-sm text-muted-foreground">Inspeccionar un juego, consultar MLB, documentar evidencia manual y agregar una versión superseding revisada.</p></div><div><p className="font-semibold text-amber-200">Siempre bloqueado</p><p className="mt-1 text-sm text-muted-foreground">Reparación automática, sobrescribir historia, ejecutar settlement, apostar o cambiar modelo, probabilidades, señal o stake.</p></div></CardContent></Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <div className="space-y-4"><div><h2 className="text-xl font-bold">1. Seleccionar incidencia de calidad</h2><p className="text-sm text-muted-foreground">Solo aparecen MLB `DATA_QUALITY_REVIEW` con evidencia autoritativa.</p></div>{eligible.length ? eligible.map((incident) => <IncidentCard key={incident.id} incident={incident} selected={selectedIncidentId === incident.id} busy={inspecting} onInspect={(item) => void inspectIncident(item)} />) : <Card><CardContent className="p-8 text-center"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-300" /><p className="mt-3 font-medium">No hay incidencias MLB de calidad elegibles</p><p className="text-sm text-muted-foreground">O3.1 no fabrica ni amplía incidencias fuera de su alcance.</p></CardContent></Card>}</div>
        <Card className="h-fit"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Controles obligatorios</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p>• Inspección explícita; nunca al cargar.</p><p>• Comparación con MLB Stats API.</p><p>• Evidencia manual para cuotas y mercado.</p><p>• Plan sellado y vigencia de 10 minutos.</p><p>• Frase, motivo e idempotencia.</p><p>• Nueva versión con `supersedesId`.</p><p>• Ejecución solo para administrador.</p></CardContent></Card>
      </div>

      {inspection && <div className="space-y-6">
        <div><h2 className="text-xl font-bold">2. Revisar inspección sellada</h2><p className="text-sm text-muted-foreground">La inspección consulta evidencia, pero no repara ni liquida nada.</p></div>
        <OfficialEvidenceCard inspection={inspection} />
        {(inspection.blockers.length > 0 || inspection.warnings.length > 0) && <Card className="border-red-500/30 bg-red-500/[0.03]"><CardContent className="p-4">{inspection.blockers.map((item) => <p key={item} className="text-sm text-red-200">• {item}</p>)}{inspection.warnings.map((item) => <p key={item} className="mt-1 text-sm text-amber-200">• {item}</p>)}</CardContent></Card>}
        <div className="space-y-3">{inspection.records.map((record) => <RecordInspectionCard key={record.predictionId} record={record} />)}</div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Wrench className="h-4 w-4" />Campos con evidencia manual</CardTitle></CardHeader><CardContent className="space-y-4">{manualFields.length ? manualFields.map(({ predictionId, field }) => { const patch = patches.find((item) => item.predictionId === predictionId); return <div key={`${predictionId}-${field}`} className="space-y-2"><label className="text-sm font-medium">{fieldLabel(field)} · {predictionId}</label><ManualFieldInput field={field} value={patch?.[field]} onChange={(value) => updatePatch(predictionId, field, value)} /></div>; }) : <p className="text-sm text-muted-foreground">No hay campos manuales; los defectos reparables provienen de MLB oficial.</p>}</CardContent></Card>
          <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" />Fuente de la evidencia manual</CardTitle></CardHeader><CardContent className="space-y-4"><div><label className="text-sm font-medium">Nombre de la fuente</label><Input className="mt-2" value={source.sourceName} onChange={(event) => setSource((current) => ({ ...current, sourceName: event.target.value }))} placeholder="Ej. captura de Hard Rock" /></div><div><label className="text-sm font-medium">Referencia verificable</label><Input className="mt-2" value={source.evidenceReference} onChange={(event) => setSource((current) => ({ ...current, evidenceReference: event.target.value }))} placeholder="Ej. nombre del archivo o referencia interna" /></div><div><label className="text-sm font-medium">Momento de captura</label><Input className="mt-2" type="datetime-local" value={source.capturedAt} onChange={(event) => setSource((current) => ({ ...current, capturedAt: event.target.value }))} /></div><div><label className="text-sm font-medium">Nota de evidencia</label><textarea className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" maxLength={1000} value={source.note} onChange={(event) => setSource((current) => ({ ...current, note: event.target.value }))} placeholder="Explica qué dato demuestra la evidencia y por qué corresponde a esta predicción." /><p className="mt-1 text-xs text-muted-foreground">{source.note.trim().length}/1000 · mínimo 10</p></div></CardContent></Card>
        </div>
        <Card className="border-cyan-500/25"><CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between"><div><p className="font-semibold">Crear plan de reparación sellado</p><p className="text-sm text-muted-foreground">No agrega ninguna versión hasta la ejecución administrativa posterior.</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">inspection {inspection.inspectionDigest}</p></div><Button disabled={!planReady || planning} onClick={() => void createPlan()}><FileCheck2 className="mr-2 h-4 w-4" />{planning ? "Sellando plan…" : "Crear plan sellado"}</Button></CardContent></Card>
      </div>}

      {plan && <div className="space-y-6"><div><h2 className="text-xl font-bold">3. Revisar y ejecutar reparación append-only</h2><p className="text-sm text-muted-foreground">El plan no cambia datos por sí solo. Revisa cada campo antes de ejecutar.</p></div><RepairPlanCard plan={plan} />
        <Card className="border-red-500/25 bg-red-500/[0.025]"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2"><PlayCircle className="h-5 w-5" />Ejecución administrativa</CardTitle></CardHeader><CardContent className="space-y-4"><div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3 text-sm">Esta acción agrega nuevas predicciones superseding verificadas. No borra ni sobrescribe las originales y no ejecuta settlements.</div>{o31Expired(plan) && <p className="text-sm font-medium text-red-200">El plan expiró. Repite la inspección y crea uno nuevo.</p>}<div className="grid gap-4 lg:grid-cols-2"><div className="space-y-2"><label className="text-sm font-medium">Escribe la frase exacta</label><p className="break-all font-mono text-xs text-cyan-200">{O31_CONFIRMATION_PHRASE}</p><Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" placeholder="Frase de confirmación" disabled={executing} /></div><div className="space-y-2"><label className="text-sm font-medium">Idempotency key</label><Input value={idempotencyKey} readOnly className="font-mono text-xs" /><p className="text-xs text-muted-foreground">Evita dobles ejecuciones del mismo plan.</p></div></div><div><label className="text-sm font-medium">Motivo operativo</label><textarea className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe qué evidencia revisaste y por qué la nueva versión es correcta." disabled={executing} /><p className="mt-1 text-xs text-muted-foreground">{reason.trim().length}/500 · mínimo 10</p></div><label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={executing} /><span>Revisé la fuente oficial, la evidencia manual, cada campo reparado y confirmo que se agregará una nueva versión sin modificar el registro original.</span></label><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">El servidor vuelve a validar identidad, digest, vigencia e idempotencia.</p><Button variant="destructive" disabled={!executeReady || executing} onClick={() => void executePlan()}><Wrench className="mr-2 h-4 w-4" />{executing ? "Ejecutando…" : "Agregar versión superseding"}</Button></div></CardContent></Card>
      </div>}

      {execution && <ExecutionCard execution={execution} />}

      <div className="space-y-4"><div><h2 className="flex items-center gap-2 text-xl font-bold"><ScrollText className="h-5 w-5" />Auditoría append-only</h2><p className="text-sm text-muted-foreground">Cada inspección, plan y supersesión queda enlazado por digest.</p></div>{auditEvents.length ? auditEvents.map((event) => <AuditCard key={event.eventId} event={event} />) : <Card><CardContent className="p-8 text-center"><ListChecks className="mx-auto h-9 w-9 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Aún no existen eventos O3.1 para este usuario.</p></CardContent></Card>}</div>

      <Card className="border-emerald-500/20 bg-emerald-500/[0.03]"><CardContent className="grid gap-3 p-4 md:grid-cols-2"><div><p className="flex items-center gap-2 text-sm font-semibold text-emerald-200"><CheckCircle2 className="h-4 w-4" />Resultado esperado</p><p className="mt-1 text-sm text-muted-foreground">La nueva versión válida reemplaza operativamente a la defectuosa, mientras ambas permanecen en el historial.</p></div><div><p className="flex items-center gap-2 text-sm font-semibold text-amber-200"><FileWarning className="h-4 w-4" />Paso siguiente</p><p className="mt-1 text-sm text-muted-foreground">Cuando O1 reclasifique el juego como listo o vencido, aparecerá en Reprocesamiento O3.</p></div></CardContent></Card>
    </div>
  );
}
