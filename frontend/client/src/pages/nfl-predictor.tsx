import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Target,
  Trophy,
} from "lucide-react";
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

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function gameDate(value: string): string {
  try {
    return new Date(`${value}T12:00:00`).toLocaleDateString("es-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return value;
  }
}

function routeLabel(route: NflEliteCard["eliteRoute"]): string {
  if (route === "R5H8_CORE") return "Motor Core";
  if (route === "LATE_DOWN") return "Motor Late Down";
  return "—";
}

function technicalStateBadge(state: NflIntegrationState) {
  if (state === "FULL_READY") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">OPERATIVO</Badge>;
  if (state === "CORE_READY") return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">CORE READY</Badge>;
  return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">BLOQUEADO</Badge>;
}

function cardBadge(state: NflCardState) {
  if (state === "NFL_ELITE") return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">ELITE</Badge>;
  if (state === "BLOCKED") return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">BLOQUEADO</Badge>;
  return <Badge variant="outline">NO BET</Badge>;
}

function verdictTitle(card: NflEliteCard): string {
  if (card.state === "NFL_ELITE") return card.predictedTeam ? `JUGADA ELITE: ${card.predictedTeam}` : "JUGADA ELITE";
  if (card.state === "BLOCKED") return "ANÁLISIS BLOQUEADO";
  return "NO BET";
}

function verdictDescription(card: NflEliteCard): string {
  if (card.state === "NFL_ELITE") {
    return "El partido superó uno de los filtros Elite certificados de NFL.";
  }
  if (card.state === "BLOCKED") {
    return "Falta evidencia pregame certificada. El Predictor se abstiene en lugar de completar datos por su cuenta.";
  }
  return "El modelo puede favorecer un lado, pero el partido no superó el filtro Elite. No se recomienda jugada NFL.";
}

export default function NFLPredictor() {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

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
  const orderedCards = useMemo(
    () => [...(snapshot?.cards ?? [])].sort((a, b) => {
      const rank = (state: NflCardState) => state === "NFL_ELITE" ? 0 : state === "NO_ELITE" ? 1 : 2;
      return rank(a.state) - rank(b.state) || a.gameday.localeCompare(b.gameday) || a.gameId.localeCompare(b.gameId);
    }),
    [snapshot],
  );

  const selectedCard = useMemo(() => {
    if (!orderedCards.length) return null;
    return orderedCards.find((card) => card.gameId === selectedGameId) ?? eliteCards[0] ?? orderedCards[0];
  }, [eliteCards, orderedCards, selectedGameId]);

  const refresh = async () => {
    const next = await statusQuery.refetch();
    if (next.data?.data?.state && next.data.data.state !== "BLOCKED") await cardsQuery.refetch();
  };

  const loading = statusQuery.isFetching || cardsQuery.isFetching;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1280px] mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-green-400" />
            <h1 className="text-xl font-display font-bold">NFL Predictor</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            El Predictor analiza automáticamente toda la cartelera y te muestra qué partidos califican como jugada NFL Elite.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Actualizar análisis
        </Button>
      </div>

      {statusQuery.isError ? (
        <Card className="border-red-500/30">
          <CardContent className="p-4 flex gap-3 text-sm text-red-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>{statusQuery.error instanceof Error ? statusQuery.error.message : "No se pudo leer el estado NFL."}</span>
          </CardContent>
        </Card>
      ) : null}

      {integration?.state === "BLOCKED" ? (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="p-5 flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
            <div>
              <p className="font-semibold text-red-300">NFL Predictor bloqueado de forma segura</p>
              <p className="text-sm text-muted-foreground mt-1">
                No se publicará ninguna selección mientras falte una verificación necesaria del motor o de los datos pregame.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {integration && integration.state !== "BLOCKED" && cardsQuery.isError ? (
        <Card className="border-red-500/30">
          <CardContent className="p-4 flex gap-3 text-sm text-red-300">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span>{cardsQuery.error instanceof Error ? cardsQuery.error.message : "No se pudo cargar la cartelera NFL."}</span>
          </CardContent>
        </Card>
      ) : null}

      {snapshot ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays className="h-4 w-4" /> Semana</div>
                <p className="text-2xl font-bold mt-1">{snapshot.activeWeek ?? "—"}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Activity className="h-4 w-4" /> Partidos analizados</div>
                <p className="text-2xl font-bold mt-1">{snapshot.cards.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Star className="h-4 w-4" /> Jugadas Elite</div>
                <p className="text-2xl font-bold text-green-400 mt-1">{eliteCards.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" /> Estado</div>
                <p className="text-lg font-bold mt-2">{snapshot.state === "READY" ? "LISTO" : snapshot.state === "NO_GAMES" ? "SIN JUEGOS" : "BLOQUEADO"}</p>
              </CardContent>
            </Card>
          </div>

          <Card className={eliteCards.length > 0 ? "border-green-500/30 bg-green-500/[0.03]" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Target className="h-4 w-4 text-green-400" />
                    Mejores jugadas NFL
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    Solo aparecen aquí los partidos que cruzaron el filtro Elite del deporte.
                  </p>
                </div>
                <Badge variant="outline">Semana {snapshot.activeWeek ?? "—"}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {eliteCards.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-5 text-center">
                  <p className="font-semibold">NO NFL ELITE por ahora</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Ningún partido de la ventana actual supera los requisitos. El Predictor no fuerza una jugada.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {eliteCards.map((card) => (
                    <button
                      key={card.gameId}
                      type="button"
                      onClick={() => setSelectedGameId(card.gameId)}
                      className="rounded-lg border border-green-500/30 bg-background/70 p-4 text-left transition hover:border-green-400/60 hover:bg-green-500/[0.04]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-muted-foreground">{gameDate(card.gameday)} · Semana {card.week}</p>
                          <p className="font-semibold mt-1">{card.awayTeam} @ {card.homeTeam}</p>
                        </div>
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30">NFL ELITE</Badge>
                      </div>
                      <div className="mt-4 flex items-end justify-between gap-3">
                        <div>
                          <p className="text-xs text-muted-foreground">Selección</p>
                          <p className="text-2xl font-bold text-green-400">{card.predictedTeam ?? "—"}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Prob. modelo</p>
                          <p className="text-lg font-semibold">{pct(card.predictedSideProbability)}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Search className="h-4 w-4" />
                  Cartelera de la semana
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Selecciona un partido para ver la predicción y su decisión Elite.
                </p>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[560px] overflow-y-auto pr-2">
                {orderedCards.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No hay partidos NFL elegibles en la ventana operacional actual.</p>
                ) : orderedCards.map((card) => {
                  const active = selectedCard?.gameId === card.gameId;
                  return (
                    <button
                      key={card.gameId}
                      type="button"
                      onClick={() => setSelectedGameId(card.gameId)}
                      className={`w-full rounded-lg border p-3 text-left transition ${active ? "border-primary/70 bg-primary/5" : "border-border hover:border-primary/30 hover:bg-muted/20"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{card.awayTeam} @ {card.homeTeam}</p>
                          <p className="text-xs text-muted-foreground">{gameDate(card.gameday)}</p>
                        </div>
                        {cardBadge(card.state)}
                      </div>
                    </button>
                  );
                })}
              </CardContent>
            </Card>

            <Card className={selectedCard?.state === "NFL_ELITE" ? "border-green-500/30" : selectedCard?.state === "BLOCKED" ? "border-red-500/30" : undefined}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Análisis del partido</p>
                    <CardTitle className="text-xl mt-1">
                      {selectedCard ? `${selectedCard.awayTeam} @ ${selectedCard.homeTeam}` : "Selecciona un partido"}
                    </CardTitle>
                    {selectedCard && <p className="text-xs text-muted-foreground mt-1">Semana {selectedCard.week} · {gameDate(selectedCard.gameday)}</p>}
                  </div>
                  {selectedCard ? cardBadge(selectedCard.state) : null}
                </div>
              </CardHeader>
              <CardContent>
                {selectedCard ? (
                  <div className="space-y-5">
                    <div className={`rounded-xl border p-5 ${selectedCard.state === "NFL_ELITE" ? "border-green-500/30 bg-green-500/[0.04]" : selectedCard.state === "BLOCKED" ? "border-red-500/30 bg-red-500/[0.04]" : "border-border bg-muted/10"}`}>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Recomendación NFL</p>
                      <p className={`text-2xl font-bold mt-1 ${selectedCard.state === "NFL_ELITE" ? "text-green-400" : selectedCard.state === "BLOCKED" ? "text-red-300" : ""}`}>
                        {verdictTitle(selectedCard)}
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">{verdictDescription(selectedCard)}</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-border p-4">
                        <p className="text-xs text-muted-foreground">El modelo favorece</p>
                        <p className="text-xl font-bold mt-1">{selectedCard.predictedTeam ?? "—"}</p>
                      </div>
                      <div className="rounded-lg border border-border p-4">
                        <p className="text-xs text-muted-foreground">Probabilidad del modelo</p>
                        <p className="text-xl font-bold mt-1">{pct(selectedCard.predictedSideProbability)}</p>
                      </div>
                    </div>

                    {selectedCard.state === "NFL_ELITE" ? (
                      <div className="rounded-lg border border-green-500/20 p-4">
                        <p className="text-xs text-muted-foreground">Qué filtro lo seleccionó</p>
                        <p className="font-semibold mt-1">{routeLabel(selectedCard.eliteRoute)}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          La ruta identifica por qué el partido cruzó el gate NFL. No cambia la selección ni convierte la tasa histórica en probabilidad de este juego.
                        </p>
                      </div>
                    ) : null}

                    {selectedCard.reasons.length > 0 ? (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/[0.03] p-4">
                        <p className="text-xs font-semibold text-red-300">Motivo del bloqueo</p>
                        <p className="text-sm text-muted-foreground mt-1">{selectedCard.reasons.join(" · ")}</p>
                      </div>
                    ) : null}

                    <div className="text-xs text-muted-foreground border-t border-border pt-3">
                      Snapshot pregame generado {new Date(snapshot.generatedAt).toLocaleString()}. La evaluación puede cambiar si entra nueva información válida antes del corte.
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Selecciona un partido de la cartelera para ver su análisis.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {integration ? (
            <details className="group rounded-lg border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-semibold text-sm">Detalles técnicos del motor NFL</p>
                  <p className="text-xs text-muted-foreground mt-1">Custodia, filtros internos y evidencia histórica certificada.</p>
                </div>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition group-open:rotate-180" />
              </summary>
              <div className="border-t border-border p-4 space-y-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {technicalStateBadge(integration.state)}
                  <Badge variant="outline">Core {integration.coreReady ? "verificado" : "pendiente"}</Badge>
                  <Badge variant="outline">Late Down {integration.lateDownEnabled ? "activo" : "apagado"}</Badge>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Core histórico</p>
                    <p className="font-semibold mt-1">{integration.r5h18CertifiedEvidence.protectedCore.wins}-{integration.r5h18CertifiedEvidence.protectedCore.losses}</p>
                    <p className="text-xs text-muted-foreground">{pct(integration.r5h18CertifiedEvidence.protectedCore.accuracy)} · {integration.r5h18CertifiedEvidence.protectedCore.games} selecciones</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Late Down histórico</p>
                    <p className="font-semibold mt-1">{integration.r5h18CertifiedEvidence.lateDownThresholdOnly.wins}-{integration.r5h18CertifiedEvidence.lateDownThresholdOnly.losses}</p>
                    <p className="text-xs text-muted-foreground">{pct(integration.r5h18CertifiedEvidence.lateDownThresholdOnly.accuracy)} · {integration.r5h18CertifiedEvidence.lateDownThresholdOnly.games} selecciones</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Combinado histórico</p>
                    <p className="font-semibold mt-1">{integration.r5h18CertifiedEvidence.combined.wins}-{integration.r5h18CertifiedEvidence.combined.losses}</p>
                    <p className="text-xs text-muted-foreground">{pct(integration.r5h18CertifiedEvidence.combined.accuracy)} · {integration.r5h18CertifiedEvidence.combined.games} selecciones</p>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground space-y-1">
                  <p>• Política de producción: threshold-only, sin ranking futuro de la temporada.</p>
                  <p>• Las cuotas no son features del modelo NFL.</p>
                  <p>• Si faltan datos pregame requeridos, el partido queda bloqueado.</p>
                  <p>• La precisión histórica es evidencia del sistema; no es la probabilidad individual del juego actual.</p>
                </div>
              </div>
            </details>
          ) : null}
        </>
      ) : integration && integration.state !== "BLOCKED" ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-3">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Cargando cartelera y análisis NFL…
          </CardContent>
        </Card>
      ) : !statusQuery.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-3">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Cargando NFL Predictor…
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
