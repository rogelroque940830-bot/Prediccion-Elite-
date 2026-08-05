import fs from "node:fs";

const branchFiles = {
  app: "frontend/client/src/App.tsx",
  slate: "frontend/client/src/components/mlb-daily-slate-panel.tsx",
  gate: "frontend/client/src/components/mlb-pregame-readiness-gate.tsx",
  readiness: "frontend/client/src/lib/mlb-pregame-readiness.ts",
  readinessTest: "frontend/client/src/lib/mlb-pregame-readiness.test.ts",
  predictor: "frontend/client/src/pages/mlb-predictor.tsx",
};

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(needle, replacement);
}

function replaceFrom(source, startNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`${label}: start marker missing`);
  if (source.indexOf(startNeedle, start + 1) >= 0) throw new Error(`${label}: start marker not unique`);
  return source.slice(0, start) + replacement;
}

function replaceBetween(source, startNeedle, endNeedle, replacement, label) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0 || end <= start) throw new Error(`${label}: markers missing or reordered`);
  if (source.indexOf(startNeedle, start + 1) >= 0) throw new Error(`${label}: start marker not unique`);
  return source.slice(0, start) + replacement + source.slice(end);
}

let app = fs.readFileSync(branchFiles.app, "utf8");
app = replaceOnce(
  app,
  'const FRONTEND_RELEASE = "p1-m2c1-mlb-visual-consolidation-2026-08-05";\nconst PREVIOUS_OPERATIONAL_RELEASES = "p1-m2c-mlb-pregame-readiness-ui-2026-08-05 o2-automatic-alerts-sla-2026-08-04 o3-controlled-reprocessing-2026-08-04 o31-mlb-evidence-repair-2026-08-04 p1-m1-mlb-daily-slate-2026-08-04";',
  'const FRONTEND_RELEASE = "p1-m2c2-mlb-priority-first-2026-08-05";\nconst PREVIOUS_OPERATIONAL_RELEASES = "p1-m2c1-mlb-visual-consolidation-2026-08-05 p1-m2c-mlb-pregame-readiness-ui-2026-08-05 o2-automatic-alerts-sla-2026-08-04 o3-controlled-reprocessing-2026-08-04 o31-mlb-evidence-repair-2026-08-04 p1-m1-mlb-daily-slate-2026-08-04";',
  "frontend release",
);
fs.writeFileSync(branchFiles.app, app);

let slate = fs.readFileSync(branchFiles.slate, "utf8");
slate = replaceOnce(slate, "  Users,\n", "  EyeOff,\n", "slate icon");
const gameCard = `function GameCard({
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
      data-testid={\`p1-mlb-game-\${game.gamePk}\`}
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
            <h3 className={\`mt-2 truncate font-bold text-white \${compact ? "text-base" : "text-lg"}\`}>
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
            data-testid={\`button-p1-analyze-\${game.gamePk}\`}
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

`;
slate = replaceBetween(slate, "function GameCard({", "export function MlbDailySlatePanel", gameCard, "slate game card");
const panel = `export function MlbDailySlatePanel({
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
    queryFn: () => fetchJson<MlbDailySlateEnvelope>(\`/api/mlb/p1/v1/slate?date=\${encodeURIComponent(date)}\`),
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
              <RefreshCw className={\`mr-2 h-4 w-4 \${slateQuery.isFetching ? "animate-spin" : ""}\`} />Actualizar
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
              <div className={\`rounded-lg border p-3 \${safetyValid ? "border-emerald-500/25 bg-emerald-500/[0.04]" : "border-red-500/35 bg-red-500/[0.05]"}\`}>
                <ShieldCheck className={\`h-5 w-5 \${safetyValid ? "text-emerald-300" : "text-red-300"}\`} />
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
`;
slate = replaceFrom(slate, "export function MlbDailySlatePanel", panel, "slate panel");
fs.writeFileSync(branchFiles.slate, slate);

let readiness = fs.readFileSync(branchFiles.readiness, "utf8");
readiness = replaceOnce(
  readiness,
  "export function mlbPregameSafetyValid(report: MlbPregameReadinessReport | null | undefined): boolean {",
  `export function buildMlbPregameCertifiedLinePatch(
  market: MlbPregameMarket,
  certifiedQuote: Record<string, unknown> | null,
): Partial<MlbPregameLineInputs> | null {
  if (!certifiedQuote) return null;
  const first = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = finite(certifiedQuote[key]);
      if (value != null) return value;
    }
    return null;
  };
  const text = (value: number): string => String(value);

  if (market === "ML") {
    const home = first("home", "homeOdds");
    const away = first("away", "awayOdds");
    return home != null && away != null ? { mlHome: text(home), mlAway: text(away) } : null;
  }
  if (market === "F5_ML") {
    const home = first("home", "homeOdds");
    const away = first("away", "awayOdds");
    return home != null && away != null
      ? { f5MlHome: text(home), f5MlAway: text(away), f5OddsSource: "consenso" }
      : null;
  }
  if (market === "RUN_LINE") {
    const line = first("line");
    const homeOdds = first("homeOdds");
    const awayOdds = first("awayOdds");
    return line != null && homeOdds != null && awayOdds != null
      ? { runLine: text(line), runLineHomeOdds: text(homeOdds), runLineAwayOdds: text(awayOdds) }
      : null;
  }
  if (market === "TOTAL") {
    const line = first("line");
    const overOdds = first("overOdds");
    const underOdds = first("underOdds");
    return line != null && overOdds != null && underOdds != null
      ? { totalLine: text(line), overOdds: text(overOdds), underOdds: text(underOdds) }
      : null;
  }
  return null;
}

export function mlbPregameSafetyValid(report: MlbPregameReadinessReport | null | undefined): boolean {`,
  "certified line patch helper",
);
fs.writeFileSync(branchFiles.readiness, readiness);

let readinessTest = fs.readFileSync(branchFiles.readinessTest, "utf8");
readinessTest = replaceOnce(
  readinessTest,
  "  buildMlbPregameManualOddsParams,\n",
  "  buildMlbPregameCertifiedLinePatch,\n  buildMlbPregameManualOddsParams,\n",
  "test import",
);
readinessTest += `

test("P1-M2C.2 maps each certified quote only into its matching model fields", () => {
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("ML", { home: -150, away: 130 }), {
    mlHome: "-150",
    mlAway: "130",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("F5_ML", { homeOdds: -125, awayOdds: 110 }), {
    f5MlHome: "-125",
    f5MlAway: "110",
    f5OddsSource: "consenso",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("RUN_LINE", { line: -1.5, homeOdds: 145, awayOdds: -165 }), {
    runLine: "-1.5",
    runLineHomeOdds: "145",
    runLineAwayOdds: "-165",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("TOTAL", { line: 8.5, overOdds: -105, underOdds: -115 }), {
    totalLine: "8.5",
    overOdds: "-105",
    underOdds: "-115",
  });
});

test("P1-M2C.2 refuses incomplete or unsupported certified quotes", () => {
  assert.equal(buildMlbPregameCertifiedLinePatch("ML", { home: -150 }), null);
  assert.equal(buildMlbPregameCertifiedLinePatch("TOTAL", { line: 8.5, overOdds: -110 }), null);
  assert.equal(buildMlbPregameCertifiedLinePatch("F5_TOTAL", { line: 4.5, overOdds: -110, underOdds: -110 }), null);
});
`;
fs.writeFileSync(branchFiles.readinessTest, readinessTest);

let gate = fs.readFileSync(branchFiles.gate, "utf8");
gate = replaceOnce(
  gate,
  "function EvidenceRow({ evidence }: { evidence: MlbPregameEvidence }) {",
  `function quoteNumber(quote: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!quote) return null;
  for (const key of keys) {
    const parsed = Number(quote[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function americanLabel(value: number | null): string {
  if (value == null) return "—";
  return value > 0 ? \`+\${Math.round(value)}\` : String(Math.round(value));
}

function modelQuoteLabel(market: MlbPregameMarket, lines: MlbPregameLineInputs): string {
  if (market === "ML") return \`Local \${lines.mlHome || "—"} · Visitante \${lines.mlAway || "—"}\`;
  if (market === "F5_ML") return \`Local \${lines.f5MlHome || "—"} · Visitante \${lines.f5MlAway || "—"}\`;
  if (market === "RUN_LINE") return \`Línea \${lines.runLine || "—"} · Local \${lines.runLineHomeOdds || "—"} · Visitante \${lines.runLineAwayOdds || "—"}\`;
  if (market === "TOTAL") return \`Total \${lines.totalLine || "—"} · Over \${lines.overOdds || "—"} · Under \${lines.underOdds || "—"}\`;
  return "Sin precios F5 Total exactos";
}

function certifiedQuoteLabel(market: MlbPregameMarket, quote: Record<string, unknown> | null): string {
  if (market === "ML" || market === "F5_ML") {
    return \`Local \${americanLabel(quoteNumber(quote, "home", "homeOdds"))} · Visitante \${americanLabel(quoteNumber(quote, "away", "awayOdds"))}\`;
  }
  if (market === "RUN_LINE") {
    return \`Línea \${quoteNumber(quote, "line") ?? "—"} · Local \${americanLabel(quoteNumber(quote, "homeOdds"))} · Visitante \${americanLabel(quoteNumber(quote, "awayOdds"))}\`;
  }
  if (market === "TOTAL") {
    return \`Total \${quoteNumber(quote, "line") ?? "—"} · Over \${americanLabel(quoteNumber(quote, "overOdds"))} · Under \${americanLabel(quoteNumber(quote, "underOdds"))}\`;
  }
  return "No disponible";
}

function EvidenceRow({ evidence }: { evidence: MlbPregameEvidence }) {`,
  "gate quote labels",
);
gate = replaceOnce(
  gate,
  `  lines,
  onSnapshot,
}: {
  gamePk: string;
  date: string;
  lines: MlbPregameLineInputs;
  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;
}) {`,
  `  lines,
  onApplyCertifiedQuote,
  onSnapshot,
}: {
  gamePk: string;
  date: string;
  lines: MlbPregameLineInputs;
  onApplyCertifiedQuote: (market: MlbPregameMarket, quote: Record<string, unknown>) => void;
  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;
}) {`,
  "gate props",
);
gate = replaceOnce(
  gate,
  "  const selectedMarketLabel = mlbPregameMarketLabel(market);\n",
  `  const selectedMarketLabel = mlbPregameMarketLabel(market);
  const modelQuote = modelQuoteLabel(market, lines);
  const certifiedQuote = certifiedQuoteLabel(market, quoteCompatibility?.certifiedQuote ?? null);
`,
  "gate quote memos",
);
gate = replaceOnce(
  gate,
  '<Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M2C.1 · FLUJO CONSOLIDADO</Badge>',
  '<Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M2C.1 · FLUJO CONSOLIDADO</Badge>\n              <Badge variant="outline" className="border-blue-500/40 text-blue-200">P1-M2C.2 · PRIORITY FIRST</Badge>',
  "gate release badge",
);
gate = replaceOnce(
  gate,
  `            {quoteCompatibility && !quoteCompatibility.matches && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/[0.07] p-4" data-testid="p1-m2c-quote-mismatch">
                <div className="flex gap-3">
                  <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                  <div>
                    <p className="text-sm font-semibold text-red-200">La cuota del modelo no coincide con la cuota certificada</p>
                    <p className="mt-1 text-xs text-red-100/80">Carga las cuotas reales del partido o corrige el formulario antes de generar la predicción.</p>
                    {quoteCompatibility.reasons.map((reason) => (
                      <p key={reason} className="mt-1 text-xs text-red-100/85">• {mlbPregameReasonLabel(reason)}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}`,
  `            {quoteCompatibility && !quoteCompatibility.matches && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/[0.07] p-4" data-testid="p1-m2c-quote-mismatch">
                <div className="flex gap-3">
                  <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-red-200">La cuota del modelo no coincide con la cuota certificada</p>
                    <p className="mt-1 text-xs text-red-100/80">Compara ambos precios y aplica la cotización certificada antes de generar la predicción.</p>
                    <div className="mt-3 grid gap-2 md:grid-cols-2" data-testid="p1-m2c2-quote-comparison">
                      <div className="rounded-md border border-red-500/25 bg-slate-950/35 p-3">
                        <p className="text-xs font-semibold text-slate-300">Cuota introducida</p>
                        <p className="mt-1 text-sm font-mono text-white">{modelQuote}</p>
                      </div>
                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                        <p className="text-xs font-semibold text-emerald-300">Cuota certificada</p>
                        <p className="mt-1 text-sm font-mono text-white">{certifiedQuote}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        {quoteCompatibility.reasons.map((reason) => (
                          <p key={reason} className="text-xs text-red-100/85">• {mlbPregameReasonLabel(reason)}</p>
                        ))}
                      </div>
                      {quoteCompatibility.certifiedQuote && (
                        <Button
                          type="button"
                          size="sm"
                          className="shrink-0 bg-emerald-600 hover:bg-emerald-500"
                          onClick={() => onApplyCertifiedQuote(market, quoteCompatibility.certifiedQuote!)}
                          data-testid="p1-m2c2-use-certified-quote"
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />Usar cuota certificada
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}`,
  "gate mismatch comparison",
);
fs.writeFileSync(branchFiles.gate, gate);

let predictor = fs.readFileSync(branchFiles.predictor, "utf8");
predictor = replaceOnce(
  predictor,
  'import { type MlbPregameGateSnapshot } from "@/lib/mlb-pregame-readiness";',
  'import { buildMlbPregameCertifiedLinePatch, type MlbPregameGateSnapshot, type MlbPregameMarket } from "@/lib/mlb-pregame-readiness";',
  "predictor readiness import",
);
predictor = replaceOnce(
  predictor,
  `  }, [f5MlHome, f5MlAway, f5OddsSource]);

  // ── H2H / SPLITS / SOS ───────────────────────────────────────────────────`,
  `  }, [f5MlHome, f5MlAway, f5OddsSource]);

  const applyCertifiedQuote = useCallback((market: MlbPregameMarket, quote: Record<string, unknown>) => {
    const patch = buildMlbPregameCertifiedLinePatch(market, quote);
    if (!patch) {
      toast({ title: "Cuota certificada incompleta", description: "La respuesta no contiene todos los precios necesarios para este mercado.", variant: "destructive" });
      return;
    }
    if (patch.mlHome != null) setMlOdds(patch.mlHome);
    if (patch.mlAway != null) setMlOddsAway(patch.mlAway);
    if (patch.runLine != null) setRunLine(patch.runLine);
    if (patch.runLineHomeOdds != null) setRlOdds(patch.runLineHomeOdds);
    if (patch.runLineAwayOdds != null) setRlOddsAway(patch.runLineAwayOdds);
    if (patch.totalLine != null) setOuLine(patch.totalLine);
    if (patch.overOdds != null) setOverOdds(patch.overOdds);
    if (patch.underOdds != null) setUnderOdds(patch.underOdds);
    if (patch.f5MlHome != null && patch.f5MlAway != null) {
      setF5MlHome(patch.f5MlHome);
      setF5MlAway(patch.f5MlAway);
      f5ConsensoSnapshot.current = { home: patch.f5MlHome, away: patch.f5MlAway };
      setF5OddsSource("consenso");
    }
    setPregameGate(null);
    setResult(null);
    toast({ title: "Cuota certificada aplicada", description: "La compuerta volverá a verificar el mismo precio que usará el modelo." });
  }, [toast]);

  // ── H2H / SPLITS / SOS ───────────────────────────────────────────────────`,
  "predictor certified quote callback",
);
predictor = replaceOnce(
  predictor,
  `          }}
          onSnapshot={(snapshot) => {`,
  `          }}
          onApplyCertifiedQuote={applyCertifiedQuote}
          onSnapshot={(snapshot) => {`,
  "predictor gate callback",
);
fs.writeFileSync(branchFiles.predictor, predictor);

for (const [path, markers] of Object.entries({
  [branchFiles.app]: ["p1-m2c2-mlb-priority-first-2026-08-05", "p1-m2c1-mlb-visual-consolidation-2026-08-05"],
  [branchFiles.slate]: ["P1-M2C.2 · PRIORITY FIRST", "p1-m2c2-priority-first", "p1-m2c2-inactive-games", "Modo seguro activo"],
  [branchFiles.gate]: ["P1-M2C.2 · PRIORITY FIRST", "p1-m2c2-quote-comparison", "p1-m2c2-use-certified-quote", "Usar cuota certificada"],
  [branchFiles.readiness]: ["buildMlbPregameCertifiedLinePatch"],
  [branchFiles.readinessTest]: ["P1-M2C.2 maps each certified quote", "P1-M2C.2 refuses incomplete"],
  [branchFiles.predictor]: ["onApplyCertifiedQuote={applyCertifiedQuote}", "buildMlbPregameCertifiedLinePatch"],
})) {
  const source = fs.readFileSync(path, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${path}: missing marker ${marker}`);
  }
}

console.log("P1-M2C.2 Priority First patch applied.");
