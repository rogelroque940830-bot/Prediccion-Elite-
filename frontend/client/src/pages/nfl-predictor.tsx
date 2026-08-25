import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ChevronDown,
  Clock3,
  PlayCircle,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { apiUrl } from "@/lib/queryClient";

type NflIntegrationState = "BLOCKED" | "CORE_READY" | "FULL_READY";
type NflCardState = "NFL_ELITE" | "NO_ELITE" | "BLOCKED";
type FeatureMap = Record<string, number | null>;

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

type NflPregameMaterialization = {
  cutoffUtc: string;
  processedCompletedGames: number;
  features: FeatureMap;
  provenance: {
    mode: "PREGAME_ONLY";
    sameGameObservationUsed: false;
    targetGamedayUpdatesAllowed: false;
    marketDataUsedAsFeature: false;
    homeDepthSource: string;
    awayDepthSource: string;
  };
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
  referenceHomeWinProbability?: number | null;
  eliteRoute: "R5H8_CORE" | "LATE_DOWN" | null;
  materialization?: NflPregameMaterialization | null;
  lateDownFeatures?: FeatureMap | null;
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

type NflScheduleGame = {
  gameId: string;
  kickoff: string | null;
  name: string;
  shortName: string;
  status: string;
  completed: boolean;
  homeTeam: { id: string; name: string; abbreviation: string };
  awayTeam: { id: string; name: string; abbreviation: string };
};

type NflScheduleResponse = {
  success: boolean;
  data: NflScheduleGame[];
  source: string;
  date: string;
  error?: string;
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  code: string;
  error?: string;
};

type ManualGame = {
  key: string;
  date: string;
  awayCode: string;
  homeCode: string;
  awayName: string;
  homeName: string;
  kickoff: string | null;
  status: string;
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

async function fetchSchedule(date: string): Promise<NflScheduleResponse> {
  const response = await fetch(apiUrl(`/api/nfl/games?date=${encodeURIComponent(date)}`), { credentials: "include" });
  const body = await response.json().catch(() => null) as NflScheduleResponse | null;
  if (response.status === 401 || response.status === 403) throw new Error("Autenticación requerida para consultar la cartelera NFL.");
  if (!body || !response.ok || body.success !== true) throw new Error(body?.error || `No se pudo cargar la cartelera NFL (${response.status}).`);
  return body;
}

function normalizeTeam(value: string): string {
  const team = String(value ?? "").trim().toUpperCase();
  const aliases: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA", JAC: "JAX", WSH: "WAS" };
  return aliases[team] ?? team;
}

function gameKey(date: string, away: string, home: string): string {
  return `${date}|${normalizeTeam(away)}|${normalizeTeam(home)}`;
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function points(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(1);
}

function cpoe(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(2)}`;
}

function gameDate(value: string): string {
  try {
    return new Date(`${value}T12:00:00`).toLocaleDateString("es-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return value;
  }
}

function kickoffLabel(value: string | null): string {
  if (!value) return "Hora por confirmar";
  try {
    return new Date(value).toLocaleTimeString("es-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
  } catch {
    return "Hora por confirmar";
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
  if (card.state === "NFL_ELITE") return "El partido superó uno de los filtros Elite certificados de NFL.";
  if (card.state === "BLOCKED") return "Falta evidencia pregame certificada. El Predictor se abstiene en lugar de completar datos por su cuenta.";
  return "El modelo puede favorecer un lado, pero el partido no superó el filtro Elite. No se recomienda jugada NFL.";
}

function StatRow({ label, away, home }: { label: string; away: string; home: string }) {
  return (
    <div className="grid grid-cols-[1fr_88px_88px] gap-2 border-t border-border/50 py-2 text-sm first:border-t-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-right font-medium tabular-nums">{away}</div>
      <div className="text-right font-medium tabular-nums">{home}</div>
    </div>
  );
}

export default function NFLPredictor() {
  const [selectedDateOverride, setSelectedDateOverride] = useState<string | null>(null);
  const [selectedGameKey, setSelectedGameKey] = useState<string | null>(null);
  const [analysisKey, setAnalysisKey] = useState<string | null>(null);

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
  const eliteCards = useMemo(() => (snapshot?.cards ?? []).filter((card) => card.state === "NFL_ELITE"), [snapshot]);
  const orderedCards = useMemo(
    () => [...(snapshot?.cards ?? [])].sort((a, b) => a.gameday.localeCompare(b.gameday) || a.gameId.localeCompare(b.gameId)),
    [snapshot],
  );

  const defaultDate = orderedCards[0]?.gameday ?? todayFL();
  const selectedDate = selectedDateOverride ?? defaultDate;

  const scheduleQuery = useQuery<NflScheduleResponse>({
    queryKey: ["nfl-schedule-by-date", selectedDate],
    queryFn: () => fetchSchedule(selectedDate),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const manualGames = useMemo<ManualGame[]>(() => {
    const games = new Map<string, ManualGame>();
    for (const game of scheduleQuery.data?.data ?? []) {
      const away = normalizeTeam(game.awayTeam.abbreviation);
      const home = normalizeTeam(game.homeTeam.abbreviation);
      const key = gameKey(selectedDate, away, home);
      games.set(key, {
        key,
        date: selectedDate,
        awayCode: away,
        homeCode: home,
        awayName: game.awayTeam.name || away,
        homeName: game.homeTeam.name || home,
        kickoff: game.kickoff,
        status: game.status,
      });
    }
    for (const card of (snapshot?.cards ?? []).filter((row) => row.gameday === selectedDate)) {
      const key = gameKey(card.gameday, card.awayTeam, card.homeTeam);
      if (!games.has(key)) {
        games.set(key, {
          key,
          date: card.gameday,
          awayCode: normalizeTeam(card.awayTeam),
          homeCode: normalizeTeam(card.homeTeam),
          awayName: normalizeTeam(card.awayTeam),
          homeName: normalizeTeam(card.homeTeam),
          kickoff: null,
          status: "SCHEDULED",
        });
      }
    }
    return Array.from(games.values()).sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? "") || a.key.localeCompare(b.key));
  }, [scheduleQuery.data, selectedDate, snapshot]);

  const effectiveGameKey = selectedGameKey && manualGames.some((game) => game.key === selectedGameKey)
    ? selectedGameKey
    : manualGames[0]?.key ?? null;
  const selectedManualGame = manualGames.find((game) => game.key === effectiveGameKey) ?? null;
  const selectedModelCard = (snapshot?.cards ?? []).find((card) => gameKey(card.gameday, card.awayTeam, card.homeTeam) === effectiveGameKey) ?? null;
  const analysisRequested = Boolean(effectiveGameKey && analysisKey === effectiveGameKey);

  const refresh = async () => {
    const next = await statusQuery.refetch();
    if (next.data?.data?.state && next.data.data.state !== "BLOCKED") await cardsQuery.refetch();
    await scheduleQuery.refetch();
  };

  const openModelCard = (card: NflEliteCard) => {
    const key = gameKey(card.gameday, card.awayTeam, card.homeTeam);
    setSelectedDateOverride(card.gameday);
    setSelectedGameKey(key);
    setAnalysisKey(key);
  };

  const loading = statusQuery.isFetching || cardsQuery.isFetching || scheduleQuery.isFetching;
  const features = selectedModelCard?.materialization?.features ?? null;
  const lateDown = selectedModelCard?.lateDownFeatures ?? null;

  const teamStats = features ? [
    { label: "Puntos anotados", away: points(features.away_points_for), home: points(features.home_points_for) },
    { label: "Puntos permitidos", away: points(features.away_points_against), home: points(features.home_points_against) },
    { label: "EPA ofensivo", away: decimal(features.away_off_epa), home: decimal(features.home_off_epa) },
    { label: "EPA defensivo", away: decimal(features.away_def_epa), home: decimal(features.home_def_epa) },
    { label: "Tasa de éxito ofensiva", away: pct(features.away_off_success), home: pct(features.home_off_success) },
    { label: "Tasa de éxito defensiva", away: pct(features.away_def_success), home: pct(features.home_def_success) },
    { label: "EPA de pase", away: decimal(features.away_pass_epa), home: decimal(features.home_pass_epa) },
    { label: "EPA defensa de pase", away: decimal(features.away_def_pass_epa), home: decimal(features.home_def_pass_epa) },
    { label: "EPA de carrera", away: decimal(features.away_rush_epa), home: decimal(features.home_rush_epa) },
    { label: "EPA defensa de carrera", away: decimal(features.away_def_rush_epa), home: decimal(features.home_def_rush_epa) },
    { label: "Sack rate ofensivo", away: pct(features.away_sack_rate), home: pct(features.home_sack_rate) },
    { label: "Sack rate defensivo", away: pct(features.away_def_sack_rate), home: pct(features.home_def_sack_rate) },
    { label: "Pases explosivos", away: pct(features.away_explosive_pass), home: pct(features.home_explosive_pass) },
    { label: "Carreras explosivas", away: pct(features.away_explosive_rush), home: pct(features.home_explosive_rush) },
  ] : [];

  const qbStats = features ? [
    { label: "QB EPA", away: decimal(features.away_r5b2_hi_epa), home: decimal(features.home_r5b2_hi_epa) },
    { label: "QB CPOE", away: cpoe(features.away_r5b2_hi_cpoe), home: cpoe(features.home_r5b2_hi_cpoe) },
    { label: "QB sack rate", away: pct(features.away_r5b2_hi_sack_rate), home: pct(features.home_r5b2_hi_sack_rate) },
    { label: "Incertidumbre QB", away: decimal(features.away_r5b2_hi_uncertainty), home: decimal(features.home_r5b2_hi_uncertainty) },
    { label: "Ajuste rival ofensivo", away: decimal(features.away_oa_off), home: decimal(features.home_oa_off) },
    { label: "Ajuste rival defensivo", away: decimal(features.away_oa_def), home: decimal(features.home_oa_def) },
  ] : [];

  const lateDownStats = lateDown ? [
    { label: "Conversión en late downs", away: pct(lateDown.away_off_late_down_conversion), home: pct(lateDown.home_off_late_down_conversion) },
    { label: "Late downs permitidos", away: pct(lateDown.away_def_late_down_conversion_allowed), home: pct(lateDown.home_def_late_down_conversion_allowed) },
  ] : [];

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1280px] mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-green-400" />
            <h1 className="text-xl font-display font-bold">NFL Predictor</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Selecciona fecha y partido manualmente para revisar estadísticas pregame, predicción y decisión Elite. El escáner automático de mejores jugadas continúa funcionando en paralelo.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Actualizar datos
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
              <p className="text-sm text-muted-foreground mt-1">No se publicará ninguna selección mientras falte una verificación necesaria del motor o de los datos pregame.</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {snapshot ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays className="h-4 w-4" /> Semana activa</div><p className="text-2xl font-bold mt-1">{snapshot.activeWeek ?? "—"}</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Activity className="h-4 w-4" /> Partidos analizados</div><p className="text-2xl font-bold mt-1">{snapshot.cards.length}</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Star className="h-4 w-4" /> Jugadas Elite</div><p className="text-2xl font-bold text-green-400 mt-1">{eliteCards.length}</p></CardContent></Card>
            <Card><CardContent className="p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" /> Estado</div><p className="text-lg font-bold mt-2">{snapshot.state === "READY" ? "LISTO" : snapshot.state === "NO_GAMES" ? "SIN JUEGOS" : "BLOQUEADO"}</p></CardContent></Card>
          </div>

          <Card className={eliteCards.length > 0 ? "border-green-500/30 bg-green-500/[0.03]" : undefined}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4 text-green-400" /> Mejores jugadas NFL</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">Solo aparecen aquí los partidos que cruzaron el filtro Elite del deporte.</p>
                </div>
                <Badge variant="outline">Semana {snapshot.activeWeek ?? "—"}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              {eliteCards.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-5 text-center">
                  <p className="font-semibold">NO NFL ELITE por ahora</p>
                  <p className="text-sm text-muted-foreground mt-1">Ningún partido de la ventana actual supera los requisitos. El Predictor no fuerza una jugada.</p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {eliteCards.map((card) => (
                    <button key={card.gameId} type="button" onClick={() => openModelCard(card)} className="rounded-lg border border-green-500/30 bg-background/70 p-4 text-left transition hover:border-green-400/60 hover:bg-green-500/[0.04]">
                      <div className="flex items-start justify-between gap-3">
                        <div><p className="text-xs text-muted-foreground">{gameDate(card.gameday)} · Semana {card.week}</p><p className="font-semibold mt-1">{card.awayTeam} @ {card.homeTeam}</p></div>
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30">NFL ELITE</Badge>
                      </div>
                      <div className="mt-4 flex items-end justify-between gap-3">
                        <div><p className="text-xs text-muted-foreground">Selección</p><p className="text-2xl font-bold text-green-400">{card.predictedTeam ?? "—"}</p></div>
                        <div className="text-right"><p className="text-xs text-muted-foreground">Prob. modelo</p><p className="text-lg font-semibold">{pct(card.predictedSideProbability)}</p></div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><PlayCircle className="h-4 w-4" /> Analizar partido manualmente</CardTitle>
              <p className="text-xs text-muted-foreground">Escoge la fecha y luego el matchup. Las estadísticas son las que recibe el motor pregame certificado; no se editan manualmente.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[220px_1fr_auto] md:items-end">
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Fecha</p>
                  <DatePickerFL value={selectedDate} onChange={(next) => { setSelectedDateOverride(next); setSelectedGameKey(null); setAnalysisKey(null); }} />
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Partido</p>
                  <Select value={effectiveGameKey ?? undefined} onValueChange={(value) => { setSelectedGameKey(value); setAnalysisKey(null); }} disabled={manualGames.length === 0}>
                    <SelectTrigger><SelectValue placeholder={scheduleQuery.isFetching ? "Cargando partidos…" : "Selecciona un partido"} /></SelectTrigger>
                    <SelectContent>
                      {manualGames.map((game) => <SelectItem key={game.key} value={game.key}>{game.awayCode} @ {game.homeCode} · {kickoffLabel(game.kickoff)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => effectiveGameKey && setAnalysisKey(effectiveGameKey)} disabled={!effectiveGameKey || loading} className="min-w-[150px]">
                  <Search className="mr-2 h-4 w-4" /> Analizar partido
                </Button>
              </div>

              {scheduleQuery.isError ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                  La fuente de cartelera por fecha no respondió. Si la fecha pertenece a la semana activa, el Predictor seguirá mostrando los juegos ya materializados.
                </div>
              ) : manualGames.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No hay partidos NFL en la fecha seleccionada.</div>
              ) : null}

              {analysisRequested && selectedManualGame ? (
                selectedModelCard ? (
                  <div className="space-y-4">
                    <Card className={selectedModelCard.state === "NFL_ELITE" ? "border-green-500/40 bg-green-500/[0.03]" : selectedModelCard.state === "BLOCKED" ? "border-red-500/40" : "border-border"}>
                      <CardContent className="p-5 space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs text-muted-foreground">{gameDate(selectedModelCard.gameday)} · Semana {selectedModelCard.week} · {kickoffLabel(selectedManualGame.kickoff)}</p>
                            <h2 className="text-xl font-bold mt-1">{selectedManualGame.awayName} @ {selectedManualGame.homeName}</h2>
                          </div>
                          {cardBadge(selectedModelCard.state)}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Equipo favorecido</p><p className="text-xl font-bold mt-1">{selectedModelCard.predictedTeam ?? "—"}</p></div>
                          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Probabilidad del modelo</p><p className="text-xl font-bold mt-1">{pct(selectedModelCard.predictedSideProbability)}</p></div>
                          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Decisión final NFL</p><p className={`text-lg font-bold mt-1 ${selectedModelCard.state === "NFL_ELITE" ? "text-green-400" : selectedModelCard.state === "BLOCKED" ? "text-red-400" : ""}`}>{verdictTitle(selectedModelCard)}</p></div>
                        </div>
                        <div className={`rounded-lg border p-4 ${selectedModelCard.state === "NFL_ELITE" ? "border-green-500/30 bg-green-500/[0.04]" : "border-border bg-muted/10"}`}>
                          <p className="font-semibold">{verdictTitle(selectedModelCard)}</p>
                          <p className="text-sm text-muted-foreground mt-1">{verdictDescription(selectedModelCard)}</p>
                          {selectedModelCard.eliteRoute && <p className="text-xs mt-2">Ruta de selección: <span className="font-semibold">{routeLabel(selectedModelCard.eliteRoute)}</span></p>}
                        </div>
                      </CardContent>
                    </Card>

                    {features ? (
                      <div className="grid gap-4 lg:grid-cols-2">
                        <Card>
                          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Estadísticas pregame del equipo</CardTitle></CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-[1fr_88px_88px] gap-2 pb-2 text-xs font-semibold text-muted-foreground"><div>Métrica</div><div className="text-right">{selectedModelCard.awayTeam}</div><div className="text-right">{selectedModelCard.homeTeam}</div></div>
                            {teamStats.map((row) => <StatRow key={row.label} {...row} />)}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" /> QB, ajustes y late downs</CardTitle></CardHeader>
                          <CardContent>
                            <div className="grid grid-cols-[1fr_88px_88px] gap-2 pb-2 text-xs font-semibold text-muted-foreground"><div>Métrica</div><div className="text-right">{selectedModelCard.awayTeam}</div><div className="text-right">{selectedModelCard.homeTeam}</div></div>
                            {qbStats.map((row) => <StatRow key={row.label} {...row} />)}
                            {lateDownStats.map((row) => <StatRow key={row.label} {...row} />)}
                            <div className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
                              Corte de datos: {selectedModelCard.materialization?.cutoffUtc ? new Date(selectedModelCard.materialization.cutoffUtc).toLocaleString() : "—"}. Solo información conocida antes del partido.
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    ) : (
                      <Card><CardContent className="p-4 text-sm text-muted-foreground">Las estadísticas pregame no están disponibles porque esta tarjeta quedó bloqueada antes de materializar los features.</CardContent></Card>
                    )}

                    {selectedModelCard.reasons.length > 0 && (
                      <Card className="border-amber-500/20"><CardContent className="p-4 text-sm text-muted-foreground">{selectedModelCard.reasons.map((reason) => <p key={reason}>• {reason}</p>)}</CardContent></Card>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
                    <div className="flex gap-3">
                      <Clock3 className="h-5 w-5 shrink-0 text-amber-400" />
                      <div>
                        <p className="font-semibold">Partido localizado, pero todavía fuera de la ventana certificada del modelo</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          {selectedManualGame.awayCode} @ {selectedManualGame.homeCode} está en la cartelera del {gameDate(selectedManualGame.date)}, pero el motor NFL solo publica una predicción cuando esa semana entra en la ventana operacional. No se usan datos futuros para adelantar una predicción.
                        </p>
                      </div>
                    </div>
                  </div>
                )
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Search className="h-4 w-4" /> Cartelera de la semana</CardTitle>
              <p className="text-xs text-muted-foreground">También puedes tocar cualquier juego de la semana activa para abrirlo directamente en el análisis manual.</p>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {orderedCards.map((card) => (
                <button key={card.gameId} type="button" onClick={() => openModelCard(card)} className="rounded-lg border border-border p-3 text-left transition hover:border-primary/40 hover:bg-muted/20">
                  <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{card.awayTeam} @ {card.homeTeam}</p><p className="text-xs text-muted-foreground">{gameDate(card.gameday)}</p></div>{cardBadge(card.state)}</div>
                  <p className="mt-2 text-xs text-muted-foreground">Favorece: <span className="font-medium text-foreground">{card.predictedTeam ?? "—"}</span> · {pct(card.predictedSideProbability)}</p>
                </button>
              ))}
            </CardContent>
          </Card>

          {integration ? (
            <details className="group rounded-lg border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-semibold">
                <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Detalles técnicos del motor NFL</span>
                <span className="flex items-center gap-2">{technicalStateBadge(integration.state)}<ChevronDown className="h-4 w-4 transition group-open:rotate-180" /></span>
              </summary>
              <div className="border-t border-border p-4 text-sm space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div><p className="text-xs text-muted-foreground">Motor Core</p><p className="font-semibold">{integration.coreReady ? "Verificado" : "Pendiente"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Motor Late Down</p><p className="font-semibold">{integration.lateDownEnabled ? "Activo" : "Desactivado"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Evidencia histórica</p><p className="font-semibold">{integration.r5h18CertifiedEvidence.combined.games} selecciones</p></div>
                  <div><p className="text-xs text-muted-foreground">Accuracy histórica conjunta</p><p className="font-semibold">{pct(integration.r5h18CertifiedEvidence.combined.accuracy)}</p></div>
                </div>
                <p className="text-xs text-muted-foreground">La accuracy histórica no es la probabilidad de un partido individual. Las cuotas no son features del modelo y el sistema no realiza apuestas automáticamente.</p>
                {integration.reasons.length > 0 && <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">{integration.reasons.map((reason) => <p key={reason}>• {reason}</p>)}</div>}
              </div>
            </details>
          ) : null}

          <p className="text-xs text-muted-foreground text-center">Última materialización: {new Date(snapshot.generatedAt).toLocaleString()}. Los resultados pueden cambiar cuando entra nueva información pregame válida.</p>
        </>
      ) : integration && integration.state !== "BLOCKED" && !cardsQuery.isError ? (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">Cargando NFL Predictor…</CardContent></Card>
      ) : null}
    </div>
  );
}
