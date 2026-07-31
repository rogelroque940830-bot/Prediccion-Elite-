import fs from "node:fs";

const path = "frontend/client/src/pages/mlb-predictor.tsx";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  "priority import",
  'import { buildMlbInjuryAuditSnapshot } from "@/lib/mlb-injury-audit";',
  'import { buildMlbInjuryAuditSnapshot } from "@/lib/mlb-injury-audit";\nimport { buildMlbReviewQueue, classifyMlbDecisionReview, type MlbGameQueueView } from "@/lib/mlb-review-priority";',
);

replaceOnce(
  "queue view state",
  '  const [selectedDate, setSelectedDate] = useState<string>(todayFL()); // YYYY-MM-DD Florida',
  '  const [selectedDate, setSelectedDate] = useState<string>(todayFL()); // YYYY-MM-DD Florida\n  const [mlbQueueView, setMlbQueueView] = useState<MlbGameQueueView>("priority");',
);

replaceOnce(
  "queue calculations",
  '  // ── RENDER ─────────────────────────────────────────────────────────────────',
  `  const mlbReviewQueue = buildMlbReviewQueue(mlbGames);\n  const visibleMlbGameEntries = mlbQueueView === "priority"\n    ? mlbReviewQueue.priority\n    : mlbQueueView === "pending"\n      ? mlbReviewQueue.pending\n      : mlbReviewQueue.all;\n  const currentDecisionReview = classifyMlbDecisionReview(result?.pickQualities);\n\n  // ── RENDER ─────────────────────────────────────────────────────────────────`,
);

replaceOnce(
  "date reset",
  '          <DatePickerFL value={selectedDate} onChange={setSelectedDate} />',
  `          <DatePickerFL\n            value={selectedDate}\n            onChange={(date) => {\n              setSelectedDate(date);\n              setSelectedGameId("");\n              setMlbQueueView("priority");\n            }}\n          />`,
);

replaceOnce(
  "game selector",
  `            {mlbGames.length > 0 && (\n              <Select value={selectedGameId} onValueChange={setSelectedGameId}>\n                <SelectTrigger className="flex-1 border-primary/30" data-testid="select-mlb-game">\n                  <SelectValue placeholder="Selecciona un partido" />\n                </SelectTrigger>\n                <SelectContent>\n                  {mlbGames.map((g) => (\n                    <SelectItem key={g.gameId} value={String(g.gameId)}>\n                      {g.awayTeam.name} @ {g.homeTeam.name}\n                      {g.homePitcher ? \` · \${g.awayPitcher?.name ?? "TBD"} vs \${g.homePitcher?.name ?? "TBD"}\` : ""}\n                    </SelectItem>\n                  ))}\n                </SelectContent>\n              </Select>\n            )}`,
  `            {mlbGames.length > 0 && (\n              <div className="flex flex-col gap-2 flex-1 min-w-0">\n                <div className="grid grid-cols-3 gap-1" aria-label="Prioridad de partidos MLB">\n                  <Button\n                    type="button"\n                    size="sm"\n                    variant={mlbQueueView === "priority" ? "default" : "outline"}\n                    onClick={() => setMlbQueueView("priority")}\n                    data-testid="button-mlb-priority"\n                  >\n                    Prioridad {mlbReviewQueue.priority.length}\n                  </Button>\n                  <Button\n                    type="button"\n                    size="sm"\n                    variant={mlbQueueView === "pending" ? "default" : "outline"}\n                    onClick={() => setMlbQueueView("pending")}\n                    data-testid="button-mlb-pending"\n                  >\n                    Pendientes {mlbReviewQueue.pending.length}\n                  </Button>\n                  <Button\n                    type="button"\n                    size="sm"\n                    variant={mlbQueueView === "all" ? "default" : "outline"}\n                    onClick={() => setMlbQueueView("all")}\n                    data-testid="button-mlb-all"\n                  >\n                    Todos {mlbReviewQueue.all.length}\n                  </Button>\n                </div>\n                {visibleMlbGameEntries.length > 0 ? (\n                  <Select value={selectedGameId} onValueChange={setSelectedGameId}>\n                    <SelectTrigger className="w-full border-primary/30" data-testid="select-mlb-game">\n                      <SelectValue placeholder="Selecciona un partido" />\n                    </SelectTrigger>\n                    <SelectContent>\n                      {visibleMlbGameEntries.map(({ game: g, readiness }) => {\n                        const awayPitcher = g.awayPitcher?.name ?? g.awayPitcher?.fullName ?? "TBD";\n                        const homePitcher = g.homePitcher?.name ?? g.homePitcher?.fullName ?? "TBD";\n                        const prefix = readiness === "READY" ? "✓" : readiness === "PENDING" ? "⏳" : "•";\n                        return (\n                          <SelectItem\n                            key={g.gameId}\n                            value={String(g.gameId)}\n                            disabled={readiness === "CLOSED"}\n                          >\n                            {prefix} {g.awayTeam?.name} @ {g.homeTeam?.name} · {awayPitcher} vs {homePitcher}\n                          </SelectItem>\n                        );\n                      })}\n                    </SelectContent>\n                  </Select>\n                ) : (\n                  <div className="rounded-md border border-dashed border-primary/30 px-3 py-2 text-xs text-muted-foreground">\n                    {mlbQueueView === "priority"\n                      ? "Todavía no hay juegos pregame con ambos pitchers identificados. Revisa Pendientes."\n                      : mlbQueueView === "pending"\n                        ? "No hay partidos pendientes de pitcher en esta jornada."\n                        : "No hay partidos disponibles para esta fecha."}\n                  </div>\n                )}\n                <p className="text-[10px] text-muted-foreground">\n                  Prioridad = pregame con ambos pitchers identificados. La oportunidad real se clasifica después de generar la predicción.\n                </p>\n              </div>\n            )}`,
);

replaceOnce(
  "decision banner",
  '          {autoStatus === "success" && <p className="text-xs text-green-400">✅ Pitchers + Stats + Bullpen cargados — solo agrega líneas</p>}',
  `          {autoStatus === "success" && <p className="text-xs text-green-400">✅ Pitchers + Stats + Bullpen cargados — solo agrega líneas</p>}\n          {result && currentDecisionReview.status !== "UNAVAILABLE" && (\n            <div className={\`rounded-md border p-3 \${\n              currentDecisionReview.status === "ACTIONABLE"\n                ? "border-emerald-500/40 bg-emerald-500/10"\n                : currentDecisionReview.status === "REVIEW"\n                  ? "border-amber-500/40 bg-amber-500/10"\n                  : "border-slate-500/40 bg-slate-500/10"\n            }\`}>\n              <div className="flex flex-wrap items-center gap-2">\n                <span className="text-sm font-semibold">{currentDecisionReview.label}</span>\n                {currentDecisionReview.market && (\n                  <Badge variant="outline" className="text-[10px]">{currentDecisionReview.market}</Badge>\n                )}\n              </div>\n              <p className="mt-1 text-xs text-muted-foreground">{currentDecisionReview.detail}</p>\n            </div>\n          )}`,
);

fs.writeFileSync(path, source, "utf8");
