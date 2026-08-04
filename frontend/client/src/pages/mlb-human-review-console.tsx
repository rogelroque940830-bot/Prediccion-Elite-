import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Database,
  FileCheck2,
  Fingerprint,
  LockKeyhole,
  RefreshCw,
  Scale,
  ShieldCheck,
  Target,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { fetchJson, queryClient } from "@/lib/queryClient";
import {
  MLB_S6S_CONSOLE_VERSION,
  S6S_CONCLUSION_LABELS,
  buildS6sProgress,
  evaluateS6sReviewGate,
  isS6sSafetyInvariantValid,
  s6sStateLabel,
  s6sSubgroupLabel,
  shortS6sDigest,
  summarizeS6sIssues,
  validateS6sReviewDraft,
  type S6sReviewConclusion,
  type S6sReviewStage,
} from "@/lib/mlb-human-review-console";

type Severity = "INFO" | "WARNING" | "CRITICAL";

type Issue = {
  code: string;
  severity: Severity;
  message: string;
};

type MetricSummary = {
  observations: number;
  binaryDecisions: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  meanModelProbability: number | null;
  observedWinRate: number | null;
  winRateWilson95: { low: number; high: number } | null;
  brierScore: number | null;
  logLoss: number | null;
  expectedCalibrationError: number | null;
  maximumCalibrationError: number | null;
  flatStakeExposureUnits: number;
  flatStakeProfitUnits: number;
  flatStakeRoiPct: number | null;
  clvAvailable: number;
  clvCoveragePct: number | null;
  meanClvPp: number | null;
  medianClvPp: number | null;
};

type SubgroupReview = {
  key: string;
  sampleSize: number;
  classification: string;
  rationaleCodes: string[];
  metrics: MetricSummary;
};

type CalibrationBucket = {
  label: string;
  minimumProbability: number;
  maximumProbability: number;
  sampleSize: number;
  meanPredictedProbability: number | null;
  observedWinRate: number | null;
  calibrationGap: number | null;
};

type Dossier = {
  schemaVersion: string;
  createdAt: string;
  deploymentCommit: string;
  environment: string;
  sourceS6qGeneratedAt: string;
  sourceS6qEvidenceDigestSha256: string;
  sourceCertificateDigestSha256: string;
  sourceManifestDigestSha256: string;
  sampleRule: string;
  sampleSize: number;
  manifest: unknown[];
  metrics: MetricSummary;
  marketReviews: SubgroupReview[];
  signalReviews: SubgroupReview[];
  calibrationBuckets: CalibrationBucket[];
  provisionalFinalComparison: {
    comparableDecisions: number;
    meanSignedProbabilityChangePp: number | null;
    meanAbsoluteProbabilityChangePp: number | null;
    signalChangedCount: number;
    marketIdentityChangedCount: number;
  };
  concentration: {
    largestMarket: { key: string; sampleSize: number; sharePct: number } | null;
    largestSignal: { key: string; sampleSize: number; sharePct: number } | null;
  };
  exclusionsAndWarnings: Issue[];
  reviewGuardrails: {
    humanInterpretationOnly: true;
    subgroupResultsAreDescriptive: true;
    profitabilityNotEstablishedAutomatically: true;
    candidateMustBeSeparatelyVersioned: true;
    candidateMustRunInShadow: true;
    automaticPromotionAllowed: false;
    automaticModelChangesAllowed: false;
    realFinancialExposure: 0;
  };
  dossierDigestSha256: string;
};

type ReviewDecision = {
  decisionId: string;
  submittedAt: string;
  stage: S6sReviewStage;
  conclusion: S6sReviewConclusion | null;
  rationale: string;
  candidateVersion: string | null;
  previousDecisionDigestSha256: string | null;
  decisionDigestSha256: string;
  constraints: {
    shadowOnly: true;
    automaticPromotionAllowed: false;
    automaticModelChangesAllowed: false;
    realFinancialExposure: 0;
  };
};

type S6qReport = {
  state: string;
  generatedAt: string;
  sample: {
    ownedLedgerRecords: number;
    binaryEligibleDecisions: number;
    targetSize: number;
    independentlyCertifiedAmongFirstFifty: number;
    requiredIndependentCertifications: number;
    certifiedTerminalPredictionIds: number;
  };
  target: {
    certificatePresent: boolean;
    manifestEntries: number;
    wins: number | null;
    losses: number | null;
    clvAvailable: number | null;
    certificateDigestSha256: string | null;
    manifestDigestSha256: string | null;
  };
  readiness: {
    armed: boolean;
    preferredSample50Certified: boolean;
    humanReviewReady: boolean;
    sampleAdequateForHumanReview: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  issues: Issue[];
  safety: Safety;
};

type Safety = {
  mode: "SHADOW";
  realFinancialExposure: 0;
  sportsbookIntegration: false;
  automaticBetPlacement: false;
  productionWrites: false;
  historicalLedgerMutation: false;
  automaticPromotion: false;
  formulasChanged: false;
  probabilitiesChanged: false;
  signalsChanged: false;
  marketsChanged: false;
  thresholdsChanged: false;
  settlementRulesChanged: false;
  stakePolicyChanged: false;
};

type S6rReport = {
  state: string;
  generatedAt: string;
  sourceS6q: {
    available: boolean;
    state: string | null;
    humanReviewReady: boolean;
    conclusionsAllowed: boolean;
    criticalIssues: number;
    evidenceAvailable: boolean;
    evidenceDigestSha256: string | null;
  };
  dossier: {
    present: boolean;
    everObserved: boolean;
    digestSha256: string | null;
    sourceEvidenceDigestSha256: string | null;
    sampleSize: number;
    marketSubgroups: number;
    signalSubgroups: number;
  };
  review: {
    decisions: number;
    latestStage: S6sReviewStage | null;
    latestConclusion: S6sReviewConclusion | null;
    latestSubmittedAt: string | null;
    latestDecisionDigestSha256: string | null;
    journalValid: boolean;
  };
  readiness: {
    dossierReady: boolean;
    humanReviewInProgress: boolean;
    humanReviewCompleted: boolean;
    candidateShadowStudyProposed: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  persistence: {
    dossierAppendOnly: true;
    dossierAnchorAppendOnly: true;
    reviewJournalAppendOnly: true;
    dossierAnchorPresent: boolean;
    dossierDigestAnchored: boolean;
  };
  issues: Issue[];
  safety: Safety;
};

type WorkerStatus<T> = {
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: T | null;
};

type Envelope<T> = { success: boolean; data: T };

const emptySafety: Safety = {
  mode: "SHADOW",
  realFinancialExposure: 0,
  sportsbookIntegration: false,
  automaticBetPlacement: false,
  productionWrites: false,
  historicalLedgerMutation: false,
  automaticPromotion: false,
  formulasChanged: false,
  probabilitiesChanged: false,
  signalsChanged: false,
  marketsChanged: false,
  thresholdsChanged: false,
  settlementRulesChanged: false,
  stakePolicyChanged: false,
};

function pct(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function number(value: number | null | undefined, digits = 3): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function signed(value: number | null | undefined, suffix = ""): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function stateBadgeClass(state: string | null | undefined): string {
  if (state === "ACTION_REQUIRED") return "border-red-500/40 bg-red-500/10 text-red-300";
  if (state?.includes("READY") || state?.includes("COMPLETED") || state?.includes("PROPOSED")) {
    return "border-green-500/40 bg-green-500/10 text-green-300";
  }
  if (state?.includes("PROGRESS") || state?.includes("OBSERVING")) {
    return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
  }
  return "border-amber-500/40 bg-amber-500/10 text-amber-200";
}

function MetricCard({ title, value, detail, icon: Icon }: {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="border-border/70 bg-card/70">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
          <Icon className="h-5 w-5 text-cyan-400" />
        </div>
      </CardContent>
    </Card>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) {
    return (
      <div className="rounded-lg border border-green-500/25 bg-green-500/[0.05] p-4 text-sm text-green-200">
        No hay hallazgos registrados en esta sección.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {issues.map((issue, index) => (
        <div
          key={`${issue.code}-${index}`}
          className={issue.severity === "CRITICAL"
            ? "rounded-lg border border-red-500/30 bg-red-500/[0.06] p-3"
            : issue.severity === "WARNING"
              ? "rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3"
              : "rounded-lg border border-border bg-muted/20 p-3"}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{issue.severity}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{issue.code}</span>
          </div>
          <p className="mt-2 text-sm">{issue.message}</p>
        </div>
      ))}
    </div>
  );
}

function SubgroupTable({ title, rows }: { title: string; rows: SubgroupReview[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {!rows.length ? (
          <p className="text-sm text-muted-foreground">El expediente todavía no contiene este desglose.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Grupo</th>
                  <th className="py-2 pr-3">n</th>
                  <th className="py-2 pr-3">Clasificación</th>
                  <th className="py-2 pr-3">W-L</th>
                  <th className="py-2 pr-3">Brier</th>
                  <th className="py-2 pr-3">ROI plano</th>
                  <th className="py-2">CLV medio</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-border/50 last:border-0">
                    <td className="py-3 pr-3 font-medium">{row.key.replace(/_/g, " ")}</td>
                    <td className="py-3 pr-3 tabular-nums">{row.sampleSize}</td>
                    <td className="py-3 pr-3">
                      <Badge variant="outline">{s6sSubgroupLabel(row.classification)}</Badge>
                    </td>
                    <td className="py-3 pr-3 tabular-nums">{row.metrics.wins}-{row.metrics.losses}</td>
                    <td className="py-3 pr-3 tabular-nums">{number(row.metrics.brierScore)}</td>
                    <td className="py-3 pr-3 tabular-nums">{pct(row.metrics.flatStakeRoiPct)}</td>
                    <td className="py-3 tabular-nums">{signed(row.metrics.meanClvPp, " pp")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MlbHumanReviewConsole() {
  const { loading: authLoading, authenticated, requestLogin } = useAuth();
  const { toast } = useToast();
  const [stage, setStage] = useState<S6sReviewStage>("IN_PROGRESS");
  const [conclusion, setConclusion] = useState<S6sReviewConclusion | null>(null);
  const [rationale, setRationale] = useState("");
  const [candidateVersion, setCandidateVersion] = useState("");

  const s6qQuery = useQuery({
    queryKey: ["s6s", "s6q-status"],
    queryFn: () => fetchJson<Envelope<WorkerStatus<S6qReport>>>(
      "/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/status",
    ),
    enabled: authenticated,
    refetchInterval: 30_000,
  });

  const s6rQuery = useQuery({
    queryKey: ["s6s", "s6r-status"],
    queryFn: () => fetchJson<Envelope<WorkerStatus<S6rReport>>>(
      "/api/mlb/ledger/v1/s6r-human-review-dossier/status",
    ),
    enabled: authenticated,
    refetchInterval: 30_000,
  });

  const s6q = s6qQuery.data?.data.latest ?? null;
  const s6r = s6rQuery.data?.data.latest ?? null;

  const dossierQuery = useQuery({
    queryKey: ["s6s", "dossier"],
    queryFn: () => fetchJson<Envelope<{ latest: S6rReport; dossier: Dossier | null }>>(
      "/api/mlb/ledger/v1/s6r-human-review-dossier/dossier",
    ),
    enabled: authenticated && Boolean(s6r),
    refetchInterval: s6r?.dossier.present ? 30_000 : false,
  });

  const decisionsQuery = useQuery({
    queryKey: ["s6s", "review-decisions"],
    queryFn: () => fetchJson<Envelope<{ decisions: ReviewDecision[] }>>(
      "/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions",
    ),
    enabled: authenticated && Boolean(s6r),
  });

  const dossier = dossierQuery.data?.data.dossier ?? null;
  const decisions = decisionsQuery.data?.data.decisions ?? [];
  const progress = buildS6sProgress(s6q?.sample);
  const s6qIssues = summarizeS6sIssues(s6q?.issues);
  const s6rIssues = summarizeS6sIssues(s6r?.issues);
  const criticalIssues = s6qIssues.CRITICAL + s6rIssues.CRITICAL;
  const safety = s6r?.safety ?? s6q?.safety ?? emptySafety;
  const safetyValid = isS6sSafetyInvariantValid({
    ...safety,
    automaticModelChangesAllowed: s6r?.readiness.automaticModelChangesAllowed
      ?? s6q?.readiness.automaticModelChangesAllowed
      ?? false,
    automaticPromotionAllowed: s6r?.readiness.automaticPromotionAllowed ?? false,
  });

  const gate = evaluateS6sReviewGate({
    authenticated,
    s6rState: s6r?.state,
    dossierReady: s6r?.readiness.dossierReady,
    criticalIssues,
    journalValid: s6r?.review.journalValid,
    automaticModelChangesAllowed: s6r?.readiness.automaticModelChangesAllowed,
    automaticPromotionAllowed: s6r?.readiness.automaticPromotionAllowed,
    realFinancialExposure: safety.realFinancialExposure,
  });

  const draftErrors = useMemo(() => validateS6sReviewDraft({
    stage,
    conclusion,
    rationale,
    candidateVersion,
  }), [candidateVersion, conclusion, rationale, stage]);

  const submitReview = useMutation({
    mutationFn: () => fetchJson<Envelope<unknown>>(
      "/api/mlb/ledger/v1/s6r-human-review-dossier/review-decisions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          conclusion,
          rationale: rationale.trim(),
          candidateVersion: candidateVersion.trim() || null,
        }),
      },
    ),
    onSuccess: async () => {
      setRationale("");
      setCandidateVersion("");
      setConclusion(null);
      await queryClient.invalidateQueries({ queryKey: ["s6s"] });
      toast({
        title: "Decisión registrada",
        description: "La entrada fue añadida al diario append-only de revisión humana.",
      });
    },
    onError: (error) => {
      toast({
        title: "No se pudo registrar",
        description: error instanceof Error ? error.message : "Error desconocido",
        variant: "destructive",
      });
    },
  });

  const refresh = async () => {
    await Promise.all([
      s6qQuery.refetch(),
      s6rQuery.refetch(),
      dossierQuery.refetch(),
      decisionsQuery.refetch(),
    ]);
  };

  if (authLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Verificando sesión segura…</div>;
  }

  if (!authenticated) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center p-6">
        <Card className="w-full border-cyan-500/25 bg-cyan-500/[0.04]">
          <CardHeader>
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-cyan-500/10">
              <LockKeyhole className="h-6 w-6 text-cyan-300" />
            </div>
            <CardTitle>Consola privada de revisión MLB</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Esta pantalla contiene evidencia científica y decisiones humanas append-only. Inicia sesión con la cuenta autorizada para continuar.
            </p>
            <Button onClick={requestLogin}>Iniciar sesión</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const loading = s6qQuery.isLoading || s6rQuery.isLoading;
  const loadError = s6qQuery.error || s6rQuery.error;
  const metrics = dossier?.metrics ?? null;
  const lastUpdated = s6r?.generatedAt ?? s6q?.generatedAt ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6" data-s6s-version={MLB_S6S_CONSOLE_VERSION}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-cyan-500/35 bg-cyan-500/10 text-cyan-200">S6S · PRIVADA</Badge>
            <Badge className="border-green-500/35 bg-green-500/10 text-green-300">SHADOW</Badge>
            <Badge variant="outline">Exposición: 0</Badge>
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Consola de revisión humana MLB</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Lee la evidencia sellada de S6Q/S6R y registra decisiones humanas sin modificar automáticamente el predictor.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Última actualización: {dateTime(lastUpdated)}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {loadError && (
        <Card className="border-red-500/30 bg-red-500/[0.06]">
          <CardContent className="flex gap-3 p-4 text-sm text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{loadError instanceof Error ? loadError.message : "No se pudo cargar la consola."}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card className="border-cyan-500/25 bg-cyan-500/[0.04]">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Target className="h-5 w-5 text-cyan-300" />
                Progreso hacia el expediente
              </CardTitle>
              <Badge className={stateBadgeClass(s6q?.state)}>{s6sStateLabel(s6q?.state)}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <div className="mb-2 flex items-end justify-between gap-3">
                <div>
                  <p className="text-3xl font-semibold tabular-nums">{progress.eligible}/{progress.target}</p>
                  <p className="text-xs text-muted-foreground">decisiones binarias elegibles</p>
                </div>
                <p className="text-sm font-medium text-cyan-200">{progress.remaining === 0 ? "Umbral alcanzado" : `Faltan ${progress.remaining}`}</p>
              </div>
              <Progress value={progress.percent} className="h-2.5" />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span>Certificación independiente</span>
                <span className="tabular-nums">{progress.independent}/{progress.independentRequired}</span>
              </div>
              <Progress value={progress.independentPercent} className="h-2" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                <p className="text-xs text-muted-foreground">Ledger</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{s6q?.sample.ownedLedgerRecords ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                <p className="text-xs text-muted-foreground">W-L sellado</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{s6q?.target.wins ?? "—"}-{s6q?.target.losses ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/40 p-3">
                <p className="text-xs text-muted-foreground">CLV disponible</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">{s6q?.target.clvAvailable ?? "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={safetyValid && criticalIssues === 0
          ? "border-green-500/25 bg-green-500/[0.04]"
          : "border-red-500/30 bg-red-500/[0.06]"}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-5 w-5" />
              Compuerta de seguridad
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3"><span>Modo</span><strong>{safety.mode}</strong></div>
            <div className="flex items-center justify-between gap-3"><span>Exposición financiera</span><strong>{safety.realFinancialExposure}</strong></div>
            <div className="flex items-center justify-between gap-3"><span>Cambios automáticos</span><strong>Deshabilitados</strong></div>
            <div className="flex items-center justify-between gap-3"><span>Promoción automática</span><strong>Deshabilitada</strong></div>
            <div className="flex items-center justify-between gap-3"><span>Problemas críticos</span><strong>{criticalIssues}</strong></div>
            <div className={`rounded-md border p-3 ${safetyValid && criticalIssues === 0
              ? "border-green-500/25 bg-green-500/10 text-green-200"
              : "border-red-500/30 bg-red-500/10 text-red-200"}`}
            >
              {safetyValid && criticalIssues === 0
                ? "Invariantes de seguridad verificadas."
                : "La consola permanece bloqueada por una condición de seguridad."}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge className={stateBadgeClass(s6r?.state)}>S6R: {s6sStateLabel(s6r?.state)}</Badge>
        <Badge variant="outline">Expediente: {s6r?.dossier.present ? "presente" : "pendiente"}</Badge>
        <Badge variant="outline">Diario: {s6r?.review.journalValid === false ? "inválido" : "válido"}</Badge>
        <Badge variant="outline">Decisiones humanas: {s6r?.review.decisions ?? 0}</Badge>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Resumen</TabsTrigger>
          <TabsTrigger value="metrics">Métricas</TabsTrigger>
          <TabsTrigger value="subgroups">Subgrupos</TabsTrigger>
          <TabsTrigger value="integrity">Integridad</TabsTrigger>
          <TabsTrigger value="decision">Decisión humana</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Récord" value={metrics ? `${metrics.wins}-${metrics.losses}` : "—"} detail="Muestra sellada" icon={ClipboardCheck} />
            <MetricCard title="Win rate" value={pct(metrics?.observedWinRate)} detail={metrics?.winRateWilson95 ? `Wilson ${pct(metrics.winRateWilson95.low)}–${pct(metrics.winRateWilson95.high)}` : "Wilson pendiente"} icon={Target} />
            <MetricCard title="Brier Score" value={number(metrics?.brierScore)} detail="Menor es mejor; no prueba rentabilidad" icon={Scale} />
            <MetricCard title="ROI plano" value={pct(metrics?.flatStakeRoiPct)} detail="Informativo · 1 unidad plana" icon={TrendingUp} />
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Estado interpretativo</CardTitle></CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border p-4">
                <p className="text-sm font-medium">Lo permitido</p>
                <p className="mt-2 text-sm text-muted-foreground">Revisar evidencia, documentar una conclusión y proponer un candidato separado exclusivamente en SHADOW.</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-sm font-medium">Lo bloqueado</p>
                <p className="mt-2 text-sm text-muted-foreground">Cambiar automáticamente probabilidades, señales, mercados, thresholds, reglas de settlement o stakes.</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="metrics" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title="Log Loss" value={number(metrics?.logLoss)} detail="Calidad probabilística" icon={BarChart3} />
            <MetricCard title="ECE" value={number(metrics?.expectedCalibrationError)} detail="Error esperado de calibración" icon={Activity} />
            <MetricCard title="MCE" value={number(metrics?.maximumCalibrationError)} detail="Máximo error de calibración" icon={AlertTriangle} />
            <MetricCard title="CLV medio" value={signed(metrics?.meanClvPp, " pp")} detail={`Cobertura ${pct(metrics?.clvCoveragePct)}`} icon={TrendingUp} />
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Bandas de calibración</CardTitle></CardHeader>
            <CardContent>
              {!dossier?.calibrationBuckets.length ? (
                <p className="text-sm text-muted-foreground">Disponibles cuando S6R selle el expediente.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[650px] text-sm">
                    <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr><th className="py-2 pr-3">Banda</th><th className="py-2 pr-3">n</th><th className="py-2 pr-3">Predicha</th><th className="py-2 pr-3">Observada</th><th className="py-2">Brecha</th></tr>
                    </thead>
                    <tbody>
                      {dossier.calibrationBuckets.map((bucket) => (
                        <tr key={bucket.label} className="border-b border-border/50 last:border-0">
                          <td className="py-3 pr-3 font-medium">{bucket.label}</td>
                          <td className="py-3 pr-3 tabular-nums">{bucket.sampleSize}</td>
                          <td className="py-3 pr-3 tabular-nums">{pct(bucket.meanPredictedProbability)}</td>
                          <td className="py-3 pr-3 tabular-nums">{pct(bucket.observedWinRate)}</td>
                          <td className="py-3 tabular-nums">{signed(bucket.calibrationGap == null ? null : bucket.calibrationGap * 100, " pp")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Cambios PROVISIONAL → FINAL</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div><p className="text-xs text-muted-foreground">Comparables</p><p className="mt-1 font-semibold tabular-nums">{dossier?.provisionalFinalComparison.comparableDecisions ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Cambio medio</p><p className="mt-1 font-semibold tabular-nums">{signed(dossier?.provisionalFinalComparison.meanSignedProbabilityChangePp, " pp")}</p></div>
              <div><p className="text-xs text-muted-foreground">Cambio absoluto</p><p className="mt-1 font-semibold tabular-nums">{signed(dossier?.provisionalFinalComparison.meanAbsoluteProbabilityChangePp, " pp")}</p></div>
              <div><p className="text-xs text-muted-foreground">Señal cambió</p><p className="mt-1 font-semibold tabular-nums">{dossier?.provisionalFinalComparison.signalChangedCount ?? "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Mercado cambió</p><p className="mt-1 font-semibold tabular-nums">{dossier?.provisionalFinalComparison.marketIdentityChangedCount ?? "—"}</p></div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="subgroups" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Concentración de la muestra</CardTitle></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">Mercado principal</p>
                <p className="mt-1 font-medium">{dossier?.concentration.largestMarket?.key.replace(/_/g, " ") ?? "—"}</p>
                <p className="mt-1 text-sm text-muted-foreground">{dossier?.concentration.largestMarket ? `${dossier.concentration.largestMarket.sampleSize} casos · ${dossier.concentration.largestMarket.sharePct.toFixed(1)}%` : "Pendiente"}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted-foreground">Señal principal</p>
                <p className="mt-1 font-medium">{dossier?.concentration.largestSignal?.key.replace(/_/g, " ") ?? "—"}</p>
                <p className="mt-1 text-sm text-muted-foreground">{dossier?.concentration.largestSignal ? `${dossier.concentration.largestSignal.sampleSize} casos · ${dossier.concentration.largestSignal.sharePct.toFixed(1)}%` : "Pendiente"}</p>
              </div>
            </CardContent>
          </Card>
          <SubgroupTable title="Por mercado" rows={dossier?.marketReviews ?? []} />
          <SubgroupTable title="Por señal" rows={dossier?.signalReviews ?? []} />
        </TabsContent>

        <TabsContent value="integrity" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Fingerprint className="h-4 w-4" />Identidad del expediente</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Digest S6R</p><p className="mt-1 font-mono">{shortS6sDigest(dossier?.dossierDigestSha256)}</p></div>
                <div><p className="text-xs text-muted-foreground">Evidencia S6Q</p><p className="mt-1 font-mono">{shortS6sDigest(dossier?.sourceS6qEvidenceDigestSha256 ?? s6r?.sourceS6q.evidenceDigestSha256)}</p></div>
                <div><p className="text-xs text-muted-foreground">Certificado</p><p className="mt-1 font-mono">{shortS6sDigest(dossier?.sourceCertificateDigestSha256 ?? s6q?.target.certificateDigestSha256)}</p></div>
                <div><p className="text-xs text-muted-foreground">Manifiesto</p><p className="mt-1 font-mono">{shortS6sDigest(dossier?.sourceManifestDigestSha256 ?? s6q?.target.manifestDigestSha256)}</p></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />Persistencia append-only</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between"><span>Expediente append-only</span><CheckCircle2 className="h-4 w-4 text-green-400" /></div>
                <div className="flex items-center justify-between"><span>Ancla presente</span><strong>{s6r?.persistence.dossierAnchorPresent ? "Sí" : "Pendiente"}</strong></div>
                <div className="flex items-center justify-between"><span>Digest anclado</span><strong>{s6r?.persistence.dossierDigestAnchored ? "Sí" : "Pendiente"}</strong></div>
                <div className="flex items-center justify-between"><span>Diario válido</span><strong>{s6r?.review.journalValid === false ? "No" : "Sí"}</strong></div>
                <div className="flex items-center justify-between"><span>Manifiesto</span><strong>{dossier?.manifest.length ?? 0}/50</strong></div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Hallazgos S6Q y S6R</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div><p className="mb-2 text-sm font-medium">S6Q</p><IssueList issues={s6q?.issues ?? []} /></div>
              <div><p className="mb-2 text-sm font-medium">S6R</p><IssueList issues={s6r?.issues ?? []} /></div>
              {dossier && <div><p className="mb-2 text-sm font-medium">Expediente</p><IssueList issues={dossier.exclusionsAndWarnings} /></div>}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="decision" className="space-y-4">
          <Card className={gate.allowed ? "border-cyan-500/25" : "border-amber-500/25"}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg"><FileCheck2 className="h-5 w-5" />Registrar revisión humana</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {!gate.allowed && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm text-amber-100">
                  La escritura permanece bloqueada hasta que S6R tenga un expediente verificado, cero problemas críticos y todas las invariantes de seguridad válidas.
                  <p className="mt-2 font-mono text-xs text-amber-200/80">{gate.reasons.join(" · ")}</p>
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="s6s-stage">Etapa</Label>
                  <select
                    id="s6s-stage"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={stage}
                    onChange={(event) => {
                      const next = event.target.value as S6sReviewStage;
                      setStage(next);
                      if (next === "IN_PROGRESS") {
                        setConclusion(null);
                        setCandidateVersion("");
                      }
                    }}
                    disabled={!gate.allowed || submitReview.isPending}
                  >
                    <option value="IN_PROGRESS">Revisión en curso</option>
                    <option value="FINAL">Revisión final</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s6s-conclusion">Conclusión</Label>
                  <select
                    id="s6s-conclusion"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={conclusion ?? ""}
                    onChange={(event) => {
                      const value = event.target.value as S6sReviewConclusion | "";
                      setConclusion(value || null);
                      if (value !== "DESIGN_SHADOW_CANDIDATE") setCandidateVersion("");
                    }}
                    disabled={!gate.allowed || stage !== "FINAL" || submitReview.isPending}
                  >
                    <option value="">Selecciona una conclusión</option>
                    {Object.entries(S6S_CONCLUSION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {conclusion === "DESIGN_SHADOW_CANDIDATE" && (
                <div className="space-y-2">
                  <Label htmlFor="s6s-candidate-version">Versión separada del candidato</Label>
                  <Input
                    id="s6s-candidate-version"
                    value={candidateVersion}
                    onChange={(event) => setCandidateVersion(event.target.value)}
                    placeholder="Ejemplo: mlb-shadow-candidate-v2"
                    disabled={!gate.allowed || submitReview.isPending}
                  />
                  <p className="text-xs text-muted-foreground">El nombre no promueve ni activa el candidato; solo registra la propuesta de estudio SHADOW.</p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="s6s-rationale">Justificación</Label>
                <Textarea
                  id="s6s-rationale"
                  rows={7}
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  placeholder="Describe la evidencia revisada, las limitaciones de la muestra y el motivo de la decisión…"
                  disabled={!gate.allowed || submitReview.isPending}
                />
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>{rationale.trim().length}/5000 caracteres</span>
                  <span>Mínimo: 20</span>
                </div>
              </div>
              {draftErrors.length > 0 && rationale.length > 0 && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/[0.05] p-3 text-sm text-red-200">
                  {draftErrors.map((error) => <p key={error}>{error}</p>)}
                </div>
              )}
              <Button
                onClick={() => submitReview.mutate()}
                disabled={!gate.allowed || draftErrors.length > 0 || submitReview.isPending}
              >
                {submitReview.isPending ? "Registrando…" : "Añadir al diario append-only"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Historial de decisiones humanas</CardTitle></CardHeader>
            <CardContent>
              {!decisions.length ? (
                <p className="text-sm text-muted-foreground">Todavía no hay decisiones registradas.</p>
              ) : (
                <div className="space-y-3">
                  {[...decisions].reverse().map((decision) => (
                    <div key={decision.decisionId} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{decision.stage === "FINAL" ? "FINAL" : "EN CURSO"}</Badge>
                        {decision.conclusion && <Badge>{S6S_CONCLUSION_LABELS[decision.conclusion]}</Badge>}
                        <span className="text-xs text-muted-foreground">{dateTime(decision.submittedAt)}</span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm">{decision.rationale}</p>
                      {decision.candidateVersion && <p className="mt-2 text-sm text-cyan-200">Candidato: {decision.candidateVersion}</p>}
                      <p className="mt-3 font-mono text-xs text-muted-foreground">Hash: {shortS6sDigest(decision.decisionDigestSha256)}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
