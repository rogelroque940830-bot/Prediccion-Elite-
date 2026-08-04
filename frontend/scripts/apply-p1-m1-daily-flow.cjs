const fs = require("node:fs");

const path = "frontend/client/src/pages/mlb-predictor.tsx";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

if (source.includes('from "@/lib/mlb-daily-flow"')) {
  console.log("P1-M1 integration already applied.");
  process.exit(0);
}

replaceOnce(
  "daily flow import",
  'import { buildMlbReviewQueue, classifyMlbDecisionReview, type MlbGameQueueView } from "@/lib/mlb-review-priority";',
  'import { buildMlbReviewQueue, classifyMlbDecisionReview, type MlbGameQueueView } from "@/lib/mlb-review-priority";\nimport { P1_M1_RELEASE, mlbDailyCanPrepare, mlbDailyGameTimeLabel, mlbDailyPitcherName, mlbDailyReadinessDetail, mlbDailyReadinessLabel, summarizeMlbDailySlate } from "@/lib/mlb-daily-flow";',
);

replaceOnce(
  "automatic daily query",
  "    enabled: false,\n    staleTime: 30 * 60 * 1000,",
  "    enabled: Boolean(selectedDate),\n    staleTime: 10 * 60 * 1000,",
);

replaceOnce(
  "autofill reset",
  '  const handleMLBAutoFill = async (gameId: string) => {\n    setAutoStatus("loading");',
  `  const handleMLBAutoFill = async (gameId: string) => {
    setAutoStatus("loading");
    // P1-M1: fail closed between games. No factor from the previous matchup may remain visible or enter a new calculation.
    setResult(null);
    setLineupMatchup(null);
    setArchetypeMatchup(null);
    setBullpenStatus(null);
    setParkPitcher(null);
    setStatcastQuality(null);
    setSos(null);
    setDiscSpeed(null);
    setPitcherVsTeam(null);
    setWindPark(null);
    setCatcherFraming(null);
    setRookiePitcher(null);
    setPitcherForm(null);
    setTeamFatigue(null);
    setPitcherRecent(null);
    setStatcastMatchup(null);
    setUmpireData(null);
    setAdvancedData(null);
    setSharpDir(null);
    setMlbCtxAdj({ homeProbAdjPp: 0, totalAdj: 0 });
    setContextTri({ home: null, away: null });`,
);

replaceOnce(
  "daily slate derived state",
  "  const currentDecisionReview = classifyMlbDecisionReview(result?.pickQualities);\n\n  // ── RENDER",
  `  const currentDecisionReview = classifyMlbDecisionReview(result?.pickQualities);
  const mlbDailySummary = summarizeMlbDailySlate(mlbReviewQueue);
  const selectedDailyEntry = mlbReviewQueue.all.find((entry) => String(entry.game.gameId) === selectedGameId) ?? null;

  // ── RENDER`,
);

replaceOnce(
  "daily slate cards",
  `          <DatePickerFL
            value={selectedDate}
            onChange={(date) => {
              setSelectedDate(date);
              setSelectedGameId("");
              setMlbQueueView("priority");
            }}
          />
          <div className="flex flex-col sm:flex-row gap-3">`,
  `          <DatePickerFL
            value={selectedDate}
            onChange={(date) => {
              setSelectedDate(date);
              setSelectedGameId("");
              setMlbQueueView("priority");
              setAutoStatus("idle");
              setResult(null);
            }}
          />

          <div
            className="rounded-xl border border-cyan-500/25 bg-slate-950/45 p-3 space-y-3"
            data-testid="p1-mlb-daily-slate"
            data-p1-release={P1_M1_RELEASE}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-bold text-cyan-200">P1 · Jornada MLB</p>
                <p className="text-[11px] text-muted-foreground">La jornada se carga automáticamente. Selecciona un partido para preparar todos los datos existentes del predictor.</p>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                <Badge variant="outline">Total {mlbDailySummary.total}</Badge>
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">Listos {mlbDailySummary.ready}</Badge>
                <Badge variant="outline" className="border-amber-500/40 text-amber-300">Pitchers pendientes {mlbDailySummary.waitingPitchers}</Badge>
                <Badge variant="outline" className="border-slate-500/40 text-slate-400">Cerrados {mlbDailySummary.closed}</Badge>
              </div>
            </div>

            {mlbLoading && mlbGames.length === 0 ? (
              <div className="rounded-lg border border-dashed border-cyan-500/30 p-5 text-center text-sm text-muted-foreground">
                <RefreshCw className="mx-auto mb-2 h-4 w-4 animate-spin text-cyan-300" />
                Cargando la jornada seleccionada…
              </div>
            ) : mlbReviewQueue.all.length > 0 ? (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {mlbReviewQueue.all.map(({ game, readiness }) => {
                  const gameId = String(game.gameId);
                  const selected = selectedGameId === gameId;
                  const awayName = game.awayTeam?.name || "Visitante";
                  const homeName = game.homeTeam?.name || "Local";
                  const awayPitcher = mlbDailyPitcherName(game.awayPitcher);
                  const homePitcher = mlbDailyPitcherName(game.homePitcher);
                  const canPrepare = mlbDailyCanPrepare(readiness);
                  return (
                    <div
                      key={gameId}
                      className={
                        selected
                          ? "rounded-lg border border-cyan-400/60 bg-cyan-500/10 p-3"
                          : readiness === "READY"
                            ? "rounded-lg border border-emerald-500/25 bg-emerald-500/[0.035] p-3"
                            : readiness === "PENDING"
                              ? "rounded-lg border border-amber-500/25 bg-amber-500/[0.035] p-3"
                              : "rounded-lg border border-slate-700/50 bg-slate-900/35 p-3 opacity-65"
                      }
                      data-testid={\`p1-mlb-game-\${gameId}\`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">{awayName} @ {homeName}</p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">{mlbDailyGameTimeLabel((game as any).commenceTime || game.gameDate || game.gameTime)}</p>
                        </div>
                        <Badge
                          variant="outline"
                          className={
                            readiness === "READY"
                              ? "shrink-0 border-emerald-500/40 text-[9px] text-emerald-300"
                              : readiness === "PENDING"
                                ? "shrink-0 border-amber-500/40 text-[9px] text-amber-300"
                                : "shrink-0 border-slate-500/40 text-[9px] text-slate-400"
                          }
                        >
                          {mlbDailyReadinessLabel(readiness)}
                        </Badge>
                      </div>
                      <div className="mt-2 space-y-1 rounded bg-slate-950/35 p-2 text-[10px]">
                        <p><span className="text-slate-500">Visitante:</span> <span className={awayPitcher === "TBD" ? "text-amber-300" : "text-slate-200"}>{awayPitcher}</span></p>
                        <p><span className="text-slate-500">Local:</span> <span className={homePitcher === "TBD" ? "text-amber-300" : "text-slate-200"}>{homePitcher}</span></p>
                      </div>
                      <p className="mt-2 min-h-8 text-[10px] leading-4 text-muted-foreground">{mlbDailyReadinessDetail(readiness)}</p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2 w-full"
                        variant={selected ? "default" : "outline"}
                        disabled={!canPrepare || autoStatus === "loading"}
                        onClick={() => {
                          setSelectedGameId(gameId);
                          void handleMLBAutoFill(gameId);
                        }}
                        data-testid={\`p1-prepare-\${gameId}\`}
                      >
                        {autoStatus === "loading" && selected ? <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Zap className="mr-2 h-3.5 w-3.5" />}
                        {readiness === "READY" ? "Preparar análisis" : "Cargar datos disponibles"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-600/50 p-5 text-center text-sm text-muted-foreground">
                No hay partidos MLB disponibles para esta fecha.
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-3">`,
);

replaceOnce(
  "preparation gate",
  '          {autoStatus === "success" && <p className="text-xs text-green-400">✅ Pitchers + Stats + Bullpen cargados — solo agrega líneas</p>}\n          {result && currentDecisionReview.status !== "UNAVAILABLE" && (',
  `          {autoStatus === "success" && <p className="text-xs text-green-400">✅ Pitchers + Stats + Bullpen cargados — solo agrega líneas</p>}
          {selectedDailyEntry && (
            <div className="rounded-lg border border-blue-500/30 bg-blue-500/[0.045] p-3" data-testid="p1-preparation-gate">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={selectedDailyEntry.readiness === "READY" ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"}>
                  {mlbDailyReadinessLabel(selectedDailyEntry.readiness)}
                </Badge>
                <Badge variant="outline" className={autoStatus === "success" ? "border-cyan-500/40 text-cyan-300" : "border-slate-500/40 text-slate-400"}>
                  Datos base: {autoStatus === "success" ? "CARGADOS" : autoStatus === "loading" ? "CONSULTANDO" : "PENDIENTES"}
                </Badge>
                <Badge variant="outline" className={lineupMatchup?.homeLineup?.confirmed && lineupMatchup?.awayLineup?.confirmed ? "border-emerald-500/40 text-emerald-300" : lineupMatchup ? "border-amber-500/40 text-amber-300" : "border-slate-500/40 text-slate-400"}>
                  Lineups: {lineupMatchup?.homeLineup?.confirmed && lineupMatchup?.awayLineup?.confirmed ? "CONFIRMADOS" : lineupMatchup ? "PROYECTADOS" : "PENDIENTES"}
                </Badge>
                <Badge variant="outline" className={f5OddsSource ? "border-cyan-500/40 text-cyan-300" : "border-amber-500/40 text-amber-300"}>
                  F5: {f5OddsSource === "manual" ? "HARD ROCK MANUAL" : f5OddsSource === "consenso" ? "CONSENSO" : "SIN PRECIO"}
                </Badge>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Flujo P1: datos del partido → verificar cuotas Hard Rock → cargar/confirmar F5 → generar predicción. Preparar el juego no genera, guarda ni apuesta automáticamente.
              </p>
            </div>
          )}
          {result && currentDecisionReview.status !== "UNAVAILABLE" && (`,
);

fs.writeFileSync(path, source);
console.log("Applied P1-M1 integration.");
