import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MlbOperatingEnvelopeCard } from "@/components/mlb-operating-envelope-card";
import { MlbPremiumNoUltraCard } from "@/components/mlb-premium-no-ultra-card";
import { MlbRealCohortActivationCard } from "@/components/mlb-real-cohort-activation-card";
import { fetchJson } from "@/lib/queryClient";
import {
  MLB_P1_M3D_ENDPOINT,
  parseMlbP1M3dEconomicReviewEnvelope,
  type MlbP1M3dReport,
} from "@/lib/mlb-interactive-economic-review";
import {
  MLB_P1_M3E_ENDPOINT,
  parseMlbP1M3eEnvelope,
} from "@/lib/mlb-operating-envelope";
import {
  MLB_PREMIUM_NO_ULTRA_ENDPOINT,
  parseMlbPremiumNoUltraEnvelope,
} from "@/lib/mlb-premium-no-ultra-prospective";
import { parseMlbP1M5aActivation } from "@/lib/mlb-real-cohort-activation";
import MlbEconomicReview from "@/pages/mlb-economic-review";

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function activationFromReport(report: MlbP1M3dReport) {
  const raw = record(report)?.activation;
  return parseMlbP1M5aActivation(raw);
}

export default function MlbEconomicReviewActivated() {
  const reviewQuery = useQuery({
    queryKey: ["p1-m3d-interactive-economic-review"],
    queryFn: async () => {
      const raw = await fetchJson<unknown>(MLB_P1_M3D_ENDPOINT);
      return parseMlbP1M3dEconomicReviewEnvelope(raw).data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const operatingEnvelopeQuery = useQuery({
    queryKey: ["p1-m3e-operating-envelope"],
    queryFn: async () => {
      const raw = await fetchJson<unknown>(MLB_P1_M3E_ENDPOINT);
      return parseMlbP1M3eEnvelope(raw).data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const premiumNoUltraQuery = useQuery({
    queryKey: ["p1-premium-no-ultra-prospective"],
    queryFn: async () => {
      const raw = await fetchJson<unknown>(MLB_PREMIUM_NO_ULTRA_ENDPOINT);
      return parseMlbPremiumNoUltraEnvelope(raw).data;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  let activation = null;
  let activationError: string | null = null;
  if (reviewQuery.data) {
    try {
      activation = activationFromReport(reviewQuery.data);
      if (activation.counts.terminalInteractiveDecisions !== reviewQuery.data.sample.uniqueAnalyticalDecisions) {
        throw new Error("P1_M5A_ACTIVATION_TERMINAL_COUNT_DRIFT");
      }
      if (activation.counts.validEconomicDecisions !== reviewQuery.data.sample.economicLayersValid) {
        throw new Error("P1_M5A_ACTIVATION_ECONOMIC_COUNT_DRIFT");
      }
      if (activation.counts.officiallySettledDecisions !== reviewQuery.data.sample.settledDecisions) {
        throw new Error("P1_M5A_ACTIVATION_SETTLEMENT_COUNT_DRIFT");
      }
      if (activation.counts.clvCoveredDecisions !== reviewQuery.data.sample.clvCoveredDecisions) {
        throw new Error("P1_M5A_ACTIVATION_CLV_COUNT_DRIFT");
      }
    } catch (error: unknown) {
      activationError = error instanceof Error ? error.message : "P1_M5A_INVALID_ACTIVATION";
      activation = null;
    }
  }

  const operatingEnvelopeError = operatingEnvelopeQuery.isError
    ? operatingEnvelopeQuery.error instanceof Error
      ? operatingEnvelopeQuery.error.message
      : "P1_M3E_OPERATING_ENVELOPE_UNAVAILABLE"
    : null;

  const premiumNoUltraError = premiumNoUltraQuery.isError
    ? premiumNoUltraQuery.error instanceof Error
      ? premiumNoUltraQuery.error.message
      : "PREMIUM_NO_ULTRA_PROSPECTIVE_UNAVAILABLE"
    : null;

  return (
    <>
      <div className="mx-auto max-w-[1150px] px-4 pt-4 md:px-6 md:pt-6" data-testid="p1-m5a-activation-wrapper">
        {reviewQuery.isLoading && (
          <Card className="border-cyan-500/25 bg-cyan-500/[0.04]">
            <CardContent className="flex items-center gap-3 p-5">
              <RefreshCw className="h-5 w-5 animate-spin text-cyan-300" />
              <div>
                <p className="font-semibold">Verificando activación de la cohorte real</p>
                <p className="text-sm text-muted-foreground">Leyendo el certificado privado P1-M5A del backend.</p>
              </div>
            </CardContent>
          </Card>
        )}

        {activation && <MlbRealCohortActivationCard activation={activation} />}

        {activationError && (
          <Card className="border-red-500/35 bg-red-500/[0.06]" data-testid="p1-m5a-activation-rejected">
            <CardContent className="p-5 text-center">
              <AlertTriangle className="mx-auto h-7 w-7 text-red-300" />
              <p className="mt-2 font-semibold text-red-100">Certificado P1-M5A rechazado</p>
              <p className="mt-1 font-mono text-xs text-red-200/80">{activationError}</p>
              <p className="mt-2 text-xs text-muted-foreground">El panel económico permanece visible, pero no se declara activada la cohorte hasta corregir la inconsistencia.</p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => void reviewQuery.refetch()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reintentar verificación
              </Button>
            </CardContent>
          </Card>
        )}

        {operatingEnvelopeQuery.isLoading && (
          <Card className="mt-4 border-cyan-500/25 bg-cyan-500/[0.04]" data-testid="p1-m3e-loading">
            <CardContent className="flex items-center gap-3 p-5">
              <RefreshCw className="h-5 w-5 animate-spin text-cyan-300" />
              <div><p className="font-semibold">Calculando condiciones élite</p><p className="text-sm text-muted-foreground">Separando discovery y confirmación sobre tu cohorte privada, sin cambiar el predictor.</p></div>
            </CardContent>
          </Card>
        )}

        {operatingEnvelopeQuery.data && (
          <MlbOperatingEnvelopeCard report={operatingEnvelopeQuery.data} isFetching={operatingEnvelopeQuery.isFetching} onRefresh={() => void operatingEnvelopeQuery.refetch()} />
        )}

        {operatingEnvelopeError && (
          <Card className="mt-4 border-red-500/35 bg-red-500/[0.06]" data-testid="p1-m3e-operating-envelope-error">
            <CardContent className="p-5 text-center">
              <AlertTriangle className="mx-auto h-7 w-7 text-red-300" />
              <p className="mt-2 font-semibold text-red-100">Operating Envelope no disponible</p>
              <p className="mt-1 text-xs text-muted-foreground">{operatingEnvelopeError}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">No se muestra una condición élite si el backend no puede demostrar un cohort completo y leakage-free.</p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => void operatingEnvelopeQuery.refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reintentar M3E</Button>
            </CardContent>
          </Card>
        )}

        {premiumNoUltraQuery.isLoading && (
          <Card className="mt-4 border-cyan-500/25 bg-cyan-500/[0.04]" data-testid="premium-no-ultra-loading">
            <CardContent className="flex items-center gap-3 p-5">
              <RefreshCw className="h-5 w-5 animate-spin text-cyan-300" />
              <div><p className="font-semibold">Actualizando edge prospectivo F5</p><p className="text-sm text-muted-foreground">Contando solo juegos FINAL nuevos posteriores al corte del 08/08/2026.</p></div>
            </CardContent>
          </Card>
        )}

        {premiumNoUltraQuery.data && (
          <MlbPremiumNoUltraCard report={premiumNoUltraQuery.data} isFetching={premiumNoUltraQuery.isFetching} onRefresh={() => void premiumNoUltraQuery.refetch()} />
        )}

        {premiumNoUltraError && (
          <Card className="mt-4 border-red-500/35 bg-red-500/[0.06]" data-testid="premium-no-ultra-error">
            <CardContent className="p-5 text-center">
              <AlertTriangle className="mx-auto h-7 w-7 text-red-300" />
              <p className="mt-2 font-semibold text-red-100">Edge prospectivo F5 no disponible</p>
              <p className="mt-1 text-xs text-muted-foreground">{premiumNoUltraError}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">No se infiere ni se activa una ventaja económica si el backend no puede reconstruir la cohorte completa y segura.</p>
              <Button className="mt-3" variant="outline" size="sm" onClick={() => void premiumNoUltraQuery.refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reintentar edge</Button>
            </CardContent>
          </Card>
        )}
      </div>
      <MlbEconomicReview />
    </>
  );
}
