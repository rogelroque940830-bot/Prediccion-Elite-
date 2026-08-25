import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldCheck, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiUrl } from "@/lib/queryClient";

type NflIntegrationState = "BLOCKED" | "CORE_READY" | "FULL_READY";
type NflCardState = "NFL_ELITE" | "NO_ELITE" | "BLOCKED";

type NflEliteStatus = {
  state: NflIntegrationState;
  coreReady: boolean;
  lateDownEnabled: boolean;
  productionPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
  r5h18CertifiedEvidence: {
    protectedCore: { games: number; wins: number; losses: number; accuracy: number };
    lateDownThresholdOnly: { games: number; wins: number; losses: number; accuracy: number };
    combined: { games: number; wins: number; losses: number; accuracy: number };
  };
  reasons: string[];
};

type NflEliteCard = {
  gameId: string;
  week: number;
  gameday: string;
  homeTeam: string;
  awayTeam: string;
  state: NflCardState;
  predictedTeam: string | null;
  predictedSideProbability: number | null;
  eliteRoute: "R5H8_CORE" | "LATE_DOWN" | null;
  reasons: string[];
};

type NflEliteSnapshot = {
  state: "READY" | "NO_GAMES" | "BLOCKED";
  generatedAt: string;
  activeWeek: number | null;
  scheduleGames: number;
  completedGames: number;
  upcomingGames: number;
  cards: NflEliteCard[];
  reasons: string[];
  lateDown: {
    enabled: boolean;
    processedCompletedGames: number;
    artifactPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
  };
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  code: string;
  error?: string;
};

async function fetchEnvelope<T>(path: string): Promise<ApiEnvelope<T>> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (response.status === 401 || response.status === 403) {
    throw new Error(body?.error || "Autenticación requerida para consultar NFL Elite.");
  }
  if (!body) throw new Error(`Respuesta NFL inválida (HTTP ${response.status}).`);
  if (!response.ok && body.data === null) {
    throw new Error(body.error || `NFL Elite no pudo completar la consulta (${body.code || `HTTP ${response.status}`}).`);
  }
  return body;
}

function stateBadge(state: NflIntegrationState) {
  if (state === "FULL_READY") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">FULL READY</Badge>;
  if (state === "CORE_READY") return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">CORE READY</Badge>;
  return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">BLOCKED</Badge>;
}

function cardBadge(state: NflCardState) {
  if (state === "NFL_ELITE") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">NFL ELITE</Badge>;
  if (state === "BLOCKED") return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">BLOCKED</Badge>;
  return <Badge variant="outline">NO ELITE</Badge>;
}

export default function NFLPredictor() {
  const statusQuery = useQuery<ApiEnvelope<NflEliteStatus>>({
    queryKey: ["nfl-elite-status"],
    queryFn: () => fetchEnvelope<NflEliteStatus>("/api/nfl/elite/status"),
    staleTime: 60_000,
    retry: false,
  });

  const integration = statusQuery.data?.data ?? null;
  const cardsQuery = useQuery<ApiEnvelope<NflEliteSnapshot>>({
    queryKey: ["nfl-elite-cards"],
    queryFn: () => fetchEnvelope<NflEliteSnapshot>("/api/nfl/elite/cards"),
    enabled: Boolean(integration && integration.state !== "BLOCKED"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const snapshot = cardsQuery.data?.data ?? null;
  const eliteCards = useMemo(
    () => (snapshot?.cards ?? []).filter((card) => card.state === "NFL_ELITE"),
    [snapshot],
  );

  const refresh = async () => {
    const next = await statusQuery.refetch();
    if (next.data?.data?.state && next.data.data.state !== "BLOCKED") await cardsQuery.refetch();
  };

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1200px] mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-green-400" />
            <h1 className="text-xl font-display font-bold">NFL Predictor Elite</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            R5H8 Core + R5H21 Late Down. Solo datos deportivos pregame; las cuotas no son features del modelo.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={statusQuery.isFetching || cardsQuery.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${(statusQuery.isFetching || cardsQuery.isFetching) ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {statusQuery.isError ? (
        <Card className="border-red-500/30">
          <CardContent className="p-4 flex gap-3 text-sm text-red-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>{statusQuery.error instanceof Error ? statusQuery.error.message : "No se pudo leer el estado NFL Elite."}</span>
          </CardContent>
        </Card>
      ) : integration ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between gap-3">
              <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Estado de integración</span>
              {stateBadge(integration.state)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><p className="text-muted-foreground text-xs">R5H8 Core</p><p className="font-semibold">{integration.coreReady ? "Verificado" : "Pendiente"}</p></div>
              <div><p className="text-muted-foreground text-xs">Late Down</p><p className="font-semibold">{integration.lateDownEnabled ? "Activo" : "Desactivado"}</p></div>
              <div><p className="text-muted-foreground text-xs">Evidencia histórica certificada</p><p className="font-semibold">{integration.r5h18CertifiedEvidence.combined.games} selecciones</p></div>
              <div><p className="text-muted-foreground text-xs">Política</p><p className="font-semibold">Threshold-only</p></div>
            </div>
            {integration.reasons.length > 0 && (
              <div className="rounded-md border border-border p-3 text-muted-foreground">
                {integration.reasons.map((reason) => <p key={reason}>• {reason}</p>)}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">Cargando estado NFL Elite…</CardContent></Card>
      )}

      {integration?.state === "BLOCKED" ? (
        <Card className="border-amber-500/30">
          <CardContent className="p-4 text-sm">
            NFL permanece bloqueado de forma segura. No se publicará ninguna selección hasta que los gates de despliegue estén activados.
          </CardContent>
        </Card>
      ) : cardsQuery.isError ? (
        <Card className="border-red-500/30">
          <CardContent className="p-4 flex gap-3 text-sm text-red-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>{cardsQuery.error instanceof Error ? cardsQuery.error.message : "No se pudieron cargar las tarjetas NFL."}</span>
          </CardContent>
        </Card>
      ) : snapshot ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Semana activa</p><p className="text-xl font-bold">{snapshot.activeWeek ?? "—"}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Juegos próximos</p><p className="text-xl font-bold">{snapshot.upcomingGames}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Elite encontrados</p><p className="text-xl font-bold text-green-400">{eliteCards.length}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Estado</p><p className="text-xl font-bold">{snapshot.state}</p></CardContent></Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cartelera NFL Elite</CardTitle>
              <p className="text-xs text-muted-foreground">
                Estado generado {new Date(snapshot.generatedAt).toLocaleString()}. Puede cambiar con nueva información pregame válida antes del corte.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {snapshot.cards.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hay partidos NFL elegibles en la ventana operacional actual.</p>
              ) : snapshot.cards.map((card) => (
                <div key={card.gameId} className="rounded-lg border border-border p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{card.awayTeam} @ {card.homeTeam}</p>
                      <p className="text-xs text-muted-foreground">Semana {card.week} · {card.gameday}</p>
                    </div>
                    {cardBadge(card.state)}
                  </div>
                  {card.state === "NFL_ELITE" && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                      <div><span className="text-muted-foreground">Selección: </span><span className="font-semibold text-green-400">{card.predictedTeam ?? "—"}</span></div>
                      <div><span className="text-muted-foreground">Ruta: </span><span className="font-semibold">{card.eliteRoute === "LATE_DOWN" ? "Late Down" : "R5H8 Core"}</span></div>
                      <div><span className="text-muted-foreground">Prob. referencia actual: </span><span className="font-semibold">{card.predictedSideProbability === null ? "—" : `${(card.predictedSideProbability * 100).toFixed(1)}%`}</span></div>
                    </div>
                  )}
                  {card.reasons.length > 0 && <p className="text-xs text-red-300">{card.reasons.join(" · ")}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : integration ? (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">Cargando cartelera NFL…</CardContent></Card>
      ) : null}
    </div>
  );
}
