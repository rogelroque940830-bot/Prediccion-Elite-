import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  MapPin,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  UserRoundCheck,
  Users,
  EyeOff,
} from "lucide-react";
import { fetchJson } from "@/lib/queryClient";
import { DatePickerFL } from "@/components/date-picker-fl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  filterMlbDailySlateGames,
  formatMlbSlateTime,
  mlbDailySlateLineupLabel,
  mlbDailySlateReadinessLabel,
  mlbDailySlateSafetyValid,
  type MlbDailySlateEnvelope,
  type MlbDailySlateGame,
  type MlbDailySlateView,
} from "@/lib/mlb-daily-slate";

function readinessClass(game: MlbDailySlateGame): string {
  if (game.readiness === "READY_TO_ANALYZE") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (game.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-slate-500/40 bg-slate-500/10 text-slate-300";
}

function pitcherLabel(game: MlbDailySlateGame, side: "away" | "home"): string {
  const pitcher = side === "away" ? game.awayPitcher : game.homePitcher;
  if (!pitcher?.name) return "Pitcher no anunciado";
  return `${pitcher.name}${pitcher.hand ? ` (${pitcher.hand})` : ""}`;
}

function GameCard({
  game,
  selected,
  analyzing,
  safetyValid,
  compact = false,
  onAnalyze,
}: {
  game: MlbDailySlateGame;
  selected: boolean;
  analyzing: boolean;
  safetyValid: boolean;
  compact?: boolean;
  onAnalyze: (game: MlbDailySlateGame) => Promise<void>;
}) {
  const actionable = game.analysisAllowed && safetyValid;
  return (
    <Card
      className={selected ? "border-blue-400/60 bg-blue-500/[0.06]" : "border-border bg-card/70"}
      data-testid={`p1-mlb-game-${game.gamePk}`}
      data-compact={compact ? "true" : "false"}
    >
      <CardContent className={compact ? "space-y-2.5 p-3" : "space-y-4 p-4"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={readinessClass(game)}>
                {mlbDailySlateReadinessLabel(game.readiness)}
              </Badge>
              <Badge variant="outline">{game.analysisStage}</Badge>
              <Badge variant="outline" className={game.source.quality === "AUTHORITATIVE" ? "border-cyan-500/35 text-cyan-200" : "border-red-500/35 text-red-200"}>
                {game.source.quality === "AUTHORITATIVE" ? "MLB oficial" : "Fuente degradada"}
              </Badge>
            </div>
            <h3 className={`mt-2 truncate font-bold text-white ${compact ? "text-base" : "text-lg"}`}>
              {game.awayTeam.name} @ {game.homeTeam.name}
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatMlbSlateTime(game.startTime)} ET</span>
              <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{game.venue || "Estadio no disponible"}</span>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!actionable || analyzing}
            onClick={() => void onAnalyze(game)}
            className={game.analysisStage === "FINAL" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-amber-600 hover:bg-amber-500"}
            data-testid={`button-p1-analyze-${game.gamePk}`}
          >
            {analyzing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-2 h-4 w-4" />}
            {analyzing
              ? "Cargando…"
              : game.analysisStage === "FINAL"
                ? "Analizar partido"
                : game.analysisStage === "PROVISIONAL"
                  ? "Analizar provisional"
                  : "No disponible"}
          </Button>
        </div>

        {compact ? (
          <div className="rounded-lg border border-border bg-background/25 px-3 py-2 text-xs text-muted-foreground">
            <p><span className="text-slate-400">Pitchers:</span> {pitcherLabel(game, "away")} vs {pitcherLabel(game, "home")}</p>
            <p className="mt-1 inline-flex items-center gap-2">
              {game.lineupState === "CONFIRMED" ? <UserRoundCheck className="h-3.5 w-3.5 text-emerald-300" /> : <Users className="h-3.5 w-3.5 text-amber-300" />}
              {mlbDailySlateLineupLabel(game)}
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-border bg-background/30 p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Pitcher visitante</p>
                <p className="mt-1 text-sm font-medium text-white">{pitcherLabel(game, "away")}</p>
              </div>
              <div className="rounded-lg border border-border bg-background/30 p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Pitcher local</p>
                <p className="mt-1 text-sm font-medium text-white">{pitcherLabel(game, "home")}</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/25 p-3 text-sm">
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                {game.lineupState === "CONFIRMED" ? <UserRoundCheck className="h-4 w-4 text-emerald-300" /> : <Users className="h-4 w-4 text-amber-300" />}
                {mlbDailySlateLineupLabel(game)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">gamePk {game.gamePk}</span>
            </div>
          </>
        )}

        {game.blockers.length > 0 && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2">
            {(compact ? game.blockers.slice(0, 1) : game.blockers).map((blocker) => (
              <p key={blocker} className="text-xs text-amber-100/80">• {blocker}</p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MlbDailySlatePanel({
  date,
  selectedGamePk,
  onDateChange,
  onAnalyze,
}: {
  date: string;
  selectedGamePk: string;
  onDateChange: (date: string) => void;
  onAnalyze: (game: MlbDailySlateGame) => Promise<void>;
}) {
  const [view, setView] = useState<Extract<MlbDailySlateView, "ready" | "provisional">>("ready");
  const [analyzingPk, setAnalyzingPk] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const slateQuery = useQuery({
    queryKey: ["mlb-p1-daily-slate", date],
    queryFn: () => fetchJson<MlbDailySlateEnvelope>(`/api/mlb/p1/v1/slate?date=${encodeURIComponent(date)}`),
    enabled: Boolean(date),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const report = slateQuery.data?.data ?? null;
  const games = report?.games ?? [];
  const visibleGames = useMemo(() => filterMlbDailySlateGames(games, view), [games, view]);
  const inactiveGames = useMemo(() => games.filter((game) =>
    game.readiness !== "READY_TO_ANALYZE"
    && game.readiness !== "PROVISIONAL_WAITING_FOR_LINEUPS"
  ), [games]);
  const safetyValid = mlbDailySlateSafetyValid(report);

  const analyze = async (game: MlbDailySlateGame) => {
    if (!game.analysisAllowed || !safetyValid || analyzingPk != null) return;
    setAnalyzingPk(game.gamePk);
    setActionError(null);
    try {
      await onAnalyze(game);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "No se pudo cargar el análisis completo.");
    } finally {
      setAnalyzingPk(null);
    }
  };

  return (
    <Card className="border-blue-500/35 bg-gradient-to-br from-blue-500/[0.08] to-cyan-500/[0.03]" data-testid="p1-mlb-daily-slate" data-priority-first="true">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge className="border-blue-500/40 bg-blue-500/15 text-blue-100">P1 · JORNADA DIARIA</Badge>
              <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M2C.2 · PRIORITY FIRST</Badge>
              <Badge variant="outline" className="border-emerald-500/35 text-emerald-200">MLB oficial</Badge>
              <Badge variant="outline">SHADOW · exposición 0</Badge>
            </div>
            <CardTitle className="mt-3 flex items-center gap-2 text-xl">
              <CalendarDays className="h-5 w-5 text-blue-300" />Partidos de la jornada
            </CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              La pantalla abre en los juegos listos. Los provisionales quedan compactos y los iniciados o no accionables permanecen ocultos por defecto.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DatePickerFL
              value={date}
              onChange={(nextDate) => {
                setView("ready");
                onDateChange(nextDate);
              }}
            />
            <Button type="button" size="sm" variant="outline" onClick={() => void slateQuery.refetch()} disabled={slateQuery.isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${slateQuery.isFetching ? "animate-spin" : ""}`} />Actualizar
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5" data-testid="p1-m2c2-priority-first">
        {slateQuery.error && (
          <div className="flex gap-3 rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <div>
              <p className="font-medium text-red-200">No se pudo verificar la jornada MLB</p>
              <p className="mt-1 text-sm text-muted-foreground">{slateQuery.error instanceof Error ? slateQuery.error.message : "Error desconocido"}</p>
            </div>
          </div>
        )}

        {actionError && (
          <div className="flex gap-3 rounded-lg border border-red-500/35 bg-red-500/[0.06] p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
            <p className="text-sm text-red-100">{actionError}</p>
          </div>
        )}

        {report && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-background/35 p-3"><p className="text-2xl font-bold">{report.summary.total}</p><p className="text-sm text-muted-foreground">Partidos del día</p></div>
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] p-3"><p className="text-2xl font-bold text-emerald-200">{report.summary.ready}</p><p className="text-sm text-muted-foreground">Listos FINAL</p></div>
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3"><p className="text-2xl font-bold text-amber-200">{report.summary.provisional}</p><p className="text-sm text-muted-foreground">Provisionales</p></div>
              <div className={`rounded-lg border p-3 ${safetyValid ? "border-emerald-500/25 bg-emerald-500/[0.04]" : "border-red-500/35 bg-red-500/[0.05]"}`}>
                <ShieldCheck className={`h-5 w-5 ${safetyValid ? "text-emerald-300" : "text-red-300"}`} />
                <p className="mt-2 text-sm font-semibold">{safetyValid ? "Modo seguro activo" : "Seguridad inválida"}</p>
                <p className="text-xs text-muted-foreground">SHADOW · exposición real 0</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2" aria-label="Filtro prioritario de jornada MLB">
              <Button type="button" size="sm" variant={view === "ready" ? "default" : "outline"} onClick={() => setView("ready")} data-testid="p1-m2c2-view-ready">
                <CheckCircle2 className="mr-2 h-4 w-4" />Listos {report.summary.ready}
              </Button>
              <Button type="button" size="sm" variant={view === "provisional" ? "default" : "outline"} onClick={() => setView("provisional")} data-testid="p1-m2c2-view-provisional">
                <Clock3 className="mr-2 h-4 w-4" />Provisionales {report.summary.provisional}
              </Button>
            </div>
          </>
        )}

        {slateQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />Consultando la jornada oficial…
          </div>
        ) : visibleGames.length > 0 ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {visibleGames.map((game) => (
              <GameCard
                key={game.gamePk}
                game={game}
                selected={selectedGamePk === String(game.gamePk)}
                analyzing={analyzingPk === game.gamePk}
                safetyValid={safetyValid}
                compact={view === "provisional"}
                onAnalyze={analyze}
              />
            ))}
          </div>
        ) : report ? (
          <div className="rounded-lg border border-border p-8 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-300" />
            <p className="mt-3 font-medium">No hay partidos en esta categoría</p>
            <p className="text-sm text-muted-foreground">La jornada seguirá abriendo en Listos; consulta Provisionales cuando sea necesario.</p>
          </div>
        ) : null}

        {inactiveGames.length > 0 && (
          <details className="group rounded-lg border border-slate-700/60 bg-slate-950/30" data-testid="p1-m2c2-inactive-games">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
              <div className="flex items-center gap-2">
                <EyeOff className="h-4 w-4 text-slate-400" />
                <div>
                  <p className="text-sm font-semibold text-slate-200">Iniciados, cerrados o no accionables</p>
                  <p className="text-xs text-muted-foreground">Ocultos para no contaminar el flujo pregame.</p>
                </div>
              </div>
              <Badge variant="outline">{inactiveGames.length}</Badge>
            </summary>
            <div className="grid gap-3 border-t border-slate-700/50 p-3 xl:grid-cols-2">
              {inactiveGames.map((game) => (
                <GameCard
                  key={game.gamePk}
                  game={game}
                  selected={false}
                  analyzing={false}
                  safetyValid={safetyValid}
                  compact
                  onAnalyze={analyze}
                />
              ))}
            </div>
          </details>
        )}

        {report && (
          <p className="text-xs text-muted-foreground">
            Actualizado {new Intl.DateTimeFormat("es-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(report.generatedAt))} ET · La jornada no calcula probabilidades ni realiza apuestas.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
