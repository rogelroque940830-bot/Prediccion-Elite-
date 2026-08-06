import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Fingerprint,
  FlaskConical,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  MlbP1M5aActivation,
  MlbP1M5aActivationState,
  MlbP1M5aNextAction,
} from "@/lib/mlb-real-cohort-activation";

const STATE_META: Record<MlbP1M5aActivationState, {
  label: string;
  detail: string;
  className: string;
}> = {
  WAITING_FOR_REAL_CAPTURE: {
    label: "Esperando primera predicción real",
    detail: "Todavía no existe una captura interactiva terminal en tu cohorte privada.",
    className: "border-slate-500/40 bg-slate-500/[0.06] text-slate-100",
  },
  CAPTURE_REGISTERED: {
    label: "Captura real registrada",
    detail: "La captura existe, pero todavía no tiene una capa económica P1-M4B válida.",
    className: "border-amber-500/40 bg-amber-500/[0.06] text-amber-100",
  },
  ECONOMIC_DECISION_REGISTERED: {
    label: "Decisión económica registrada",
    detail: "La captura y la decisión económica son válidas. Falta la liquidación oficial de esa misma decisión.",
    className: "border-cyan-500/40 bg-cyan-500/[0.06] text-cyan-100",
  },
  END_TO_END_CERTIFIED: {
    label: "Cohorte real certificada de extremo a extremo",
    detail: "Una misma decisión completó captura, economía P1-M4 y liquidación oficial sin defectos de identidad.",
    className: "border-green-500/40 bg-green-500/[0.07] text-green-100",
  },
  BLOCKED_INTEGRITY: {
    label: "Certificación bloqueada por integridad",
    detail: "Existe una rama, duplicado, registro malformado o cobertura terminal que debe resolverse antes de certificar.",
    className: "border-red-500/40 bg-red-500/[0.07] text-red-100",
  },
};

const NEXT_ACTION_LABELS: Record<MlbP1M5aNextAction, string> = {
  GENERATE_FIRST_REAL_PREDICTION: "Genera la primera predicción MLB real elegible.",
  GENERATE_VALID_ECONOMIC_CAPTURE: "Genera una captura que complete correctamente la decisión económica P1-M4.",
  WAIT_FOR_OFFICIAL_SETTLEMENT: "Espera la liquidación oficial del mismo partido y mercado.",
  REVIEW_CERTIFIED_COHORT: "Revisa descriptivamente la cohorte; la certificación no demuestra rentabilidad.",
  RESOLVE_COHORT_INTEGRITY: "Resuelve los conflictos de identidad o ciclo antes de interpretar la muestra.",
};

const CHECKLIST: Array<{
  key: keyof MlbP1M5aActivation["checklist"];
  label: string;
  optional?: boolean;
}> = [
  { key: "authenticatedOwnerScope", label: "Sesión autenticada y registros del propietario" },
  { key: "interactiveCaptureObserved", label: "Captura creada mediante Generar Predicción" },
  { key: "terminalDecisionObserved", label: "Decisión terminal sin revisión posterior pendiente" },
  { key: "validEconomicLayerObserved", label: "Capa económica P1-M4B válida" },
  { key: "officialSettlementObserved", label: "Liquidación oficial disponible" },
  { key: "sameDecisionEndToEndObserved", label: "Captura, economía y settlement pertenecen a la misma decisión" },
  { key: "lifecycleIntegrityHealthy", label: "Ciclo sin ramas ni registros malformados" },
  { key: "analyticalIdentityProtected", label: "Identidad analítica sin duplicados" },
  { key: "finalCaptureObserved", label: "Existe al menos una captura FINAL", optional: true },
  { key: "clvEvidenceObserved", label: "Cuota de cierre comparable disponible", optional: true },
];

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function ChecklistItem({
  passed,
  label,
  optional,
}: {
  passed: boolean;
  label: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/55 bg-background/30 p-2.5">
      <div className={passed
        ? "mt-0.5 rounded-full bg-green-500/15 p-1 text-green-300"
        : optional
          ? "mt-0.5 rounded-full bg-slate-500/15 p-1 text-slate-400"
          : "mt-0.5 rounded-full bg-amber-500/15 p-1 text-amber-300"}
      >
        {passed ? <Check className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-200">{label}</p>
        {optional && <p className="mt-0.5 text-[10px] text-muted-foreground">Informativo; no bloquea la activación técnica.</p>}
      </div>
    </div>
  );
}

export function MlbRealCohortActivationCard({ activation }: { activation: MlbP1M5aActivation }) {
  const stateMeta = STATE_META[activation.state];
  const certificate = activation.certificate;

  return (
    <Card className={stateMeta.className} data-testid="p1-m5a-real-cohort-activation">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {activation.certified
                ? <CheckCircle2 className="h-5 w-5 text-green-300" />
                : activation.state === "BLOCKED_INTEGRITY"
                  ? <AlertTriangle className="h-5 w-5 text-red-300" />
                  : <Clock3 className="h-5 w-5 text-current" />}
              <CardTitle className="text-base md:text-lg">Activación de la cohorte interactiva real</CardTitle>
              <Badge variant="outline">P1-M5A</Badge>
            </div>
            <p className="mt-2 font-semibold">{stateMeta.label}</p>
            <p className="mt-1 text-sm text-current/75">{stateMeta.detail}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> SHADOW · exposición 0
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <LockKeyhole className="h-3.5 w-3.5" /> Solo lectura
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-xl border border-current/15 bg-background/25 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-current/65">Siguiente acción</p>
          <p className="mt-1 text-sm font-medium">{NEXT_ACTION_LABELS[activation.nextAction]}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Decisiones terminales</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.terminalInteractiveDecisions}</p>
          </div>
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Economía válida</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.validEconomicDecisions}</p>
          </div>
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Liquidadas oficialmente</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.officiallySettledDecisions}</p>
          </div>
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">End-to-end elegibles</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.endToEndEligibleDecisions}</p>
          </div>
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Capturas FINAL</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.finalInteractiveDecisions}</p>
          </div>
          <div className="rounded-xl border border-border/55 bg-background/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Con CLV</p>
            <p className="mt-1 text-xl font-bold">{activation.counts.clvCoveredDecisions}</p>
          </div>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-current/70">
            <Fingerprint className="h-4 w-4" /> Checklist certificado por el backend
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            {CHECKLIST.map((item) => (
              <ChecklistItem
                key={item.key}
                passed={activation.checklist[item.key]}
                label={item.label}
                optional={item.optional}
              />
            ))}
          </div>
        </div>

        {activation.blockingReasons.length > 0 && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-red-200">
              <AlertTriangle className="h-4 w-4" /> Razones de bloqueo o espera
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {activation.blockingReasons.map((reason) => (
                <Badge key={reason} variant="outline" className="border-red-500/35 text-red-100">
                  {reason.replaceAll("_", " ")}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {certificate && (
          <div className="rounded-xl border border-green-500/30 bg-green-500/[0.06] p-4" data-testid="p1-m5a-certificate">
            <div className="flex flex-wrap items-center gap-2">
              <FlaskConical className="h-5 w-5 text-green-300" />
              <p className="font-semibold text-green-100">Primer circuito real certificado</p>
              <Badge variant="outline" className="border-green-500/40 text-green-200">{certificate.result}</Badge>
              <Badge variant="outline" className="border-green-500/40 text-green-200">{certificate.stage}</Badge>
            </div>
            <p className="mt-3 text-sm font-semibold">{certificate.matchup}</p>
            <p className="mt-1 text-sm text-green-100/80">
              {certificate.market} · {certificate.selection}
              {certificate.effectiveDecision ? ` · ${certificate.effectiveDecision}` : ""}
              {certificate.actionability ? ` · ${certificate.actionability}` : ""}
            </p>
            <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
              <p>Registrada: {formatDate(certificate.recordedAt)}</p>
              <p>Liquidada: {formatDate(certificate.settledAt)}</p>
              <p className="font-mono">Prediction ID: {certificate.predictionId}</p>
              <p>CLV: {certificate.clvObserved ? "disponible" : "pendiente/no comparable"}</p>
            </div>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <p>
            Esta certificación prueba que el circuito técnico con datos reales funciona. No prueba rentabilidad, no autoriza dinero real y no cambia automáticamente el modelo.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
