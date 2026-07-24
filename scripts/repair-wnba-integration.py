from pathlib import Path

FRONTEND = Path("frontend/client/src/pages/wnba-predictor.tsx")
frontend = FRONTEND.read_text(encoding="utf-8")

# 1) Build an always-available team list: verified API teams when present,
# otherwise the static WNBA team names already shipped with the model.
old_team_data = '''  const wnbaTeams = wnbaData?.data ?? [];
'''
new_team_data = '''  const wnbaTeams = wnbaData?.data ?? [];
  const manualTeamOptions = wnbaTeams.length > 0
    ? wnbaTeams.map((team: any) => ({ teamId: String(team.teamId), teamName: team.teamName }))
    : WNBA_TEAMS.map((teamName, index) => ({ teamId: `manual-${index}`, teamName }));
  const hasVerifiedWNBAStats = wnbaTeams.length > 0 && !wnbaError;
'''
if old_team_data not in frontend:
    raise SystemExit("WNBA team data declaration not found")
frontend = frontend.replace(old_team_data, new_team_data, 1)

# 2) If verified API data is unavailable, selecting a team must still work,
# but all statistical fields are cleared so placeholders cannot masquerade as real data.
old_missing_team = '''    const t = wnbaTeams.find(x => x.teamName === teamName);
    if (!t) return;
'''
new_missing_team = '''    const t = wnbaTeams.find(x => x.teamName === teamName);
    if (!t) {
      if (side === "home") {
        setHomeTeam(teamName);
        setHomeNetRtg(""); setHomeOffRtg(""); setHomeDefRtg(""); setHomePace("");
        setHomeDaysRest(""); setHomeWinRate(""); setHomeB2B(false); setHomeStreak("0");
        setHomeRecentPace(""); setHomeRecentPPG("");
        setHomeRecentNetRtg(undefined); setHomeRecentOffRtg(undefined); setHomeRecentDefRtg(undefined);
        setHomeRecentWinRate(undefined); setHomeGamesPlayed(undefined); setHomeTeamId(undefined);
        setHomeInactives([]);
      } else {
        setAwayTeam(teamName);
        setAwayNetRtg(""); setAwayOffRtg(""); setAwayDefRtg(""); setAwayPace("");
        setAwayDaysRest(""); setAwayWinRate(""); setAwayB2B(false); setAwayStreak("0");
        setAwayRecentPace(""); setAwayRecentPPG("");
        setAwayRecentNetRtg(undefined); setAwayRecentOffRtg(undefined); setAwayRecentDefRtg(undefined);
        setAwayRecentWinRate(undefined); setAwayGamesPlayed(undefined); setAwayTeamId(undefined);
        setAwayInactives([]);
      }
      toast({
        title: "Modo manual WNBA",
        description: "Equipo seleccionado. Introduce estadísticas verificadas antes de generar la predicción.",
      });
      return;
    }
'''
if old_missing_team not in frontend:
    raise SystemExit("autoFillWNBA missing-team branch not found")
frontend = frontend.replace(old_missing_team, new_missing_team, 1)

# 3) Start statistical inputs empty. The visible examples remain placeholders only.
state_replacements = {
    'useState("3")': 'useState("")',
    'useState("102")': 'useState("")',
    'useState("99")': 'useState("")',
    'useState("80")': 'useState("")',
    'useState("2")': 'useState("")',
    'useState("0.55")': 'useState("")',
}
for old, new in state_replacements.items():
    count = frontend.count(old)
    if count < 2:
        raise SystemExit(f"Expected two WNBA state defaults for {old}, found {count}")
    frontend = frontend.replace(old, new, 2)

# 4) Keep card selectors usable during API failure and populate them from fallback options.
old_card_select = '''            <Select value={team} onValueChange={(value) => autoFillWNBA(value, side)} disabled={wnbaLoading || wnbaError || wnbaTeams.length === 0}>
'''
new_card_select = '''            <Select value={team} onValueChange={(value) => autoFillWNBA(value, side)} disabled={wnbaLoading}>
'''
if old_card_select not in frontend:
    raise SystemExit("WNBA card selector declaration not found")
frontend = frontend.replace(old_card_select, new_card_select, 1)

old_card_options = '''                {WNBA_TEAMS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
'''
new_card_options = '''                {manualTeamOptions.map((t) => (
                  <SelectItem key={t.teamId} value={t.teamName}>
                    {t.teamName}
                  </SelectItem>
                ))}
'''
if old_card_options not in frontend:
    raise SystemExit("WNBA card selector options not found")
frontend = frontend.replace(old_card_options, new_card_options, 1)

# 5) Block predictions until both teams and the required manual/verified fields are complete.
run_marker = '''  const runPrediction = useCallback(() => {
'''
validation = '''  const runPrediction = useCallback(() => {
    const requiredStats = [
      homeNetRtg, homeOffRtg, homeDefRtg, homePace, homeDaysRest, homeWinRate,
      awayNetRtg, awayOffRtg, awayDefRtg, awayPace, awayDaysRest, awayWinRate,
    ];
    const hasInvalidRequiredStats = requiredStats.some((value) =>
      value.trim() === "" || !Number.isFinite(Number(value))
    );
    if (!homeTeam || !awayTeam || homeTeam === awayTeam || hasInvalidRequiredStats) {
      toast({
        title: "Faltan datos WNBA",
        description: homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : "Selecciona ambos equipos y completa NetRtg, OffRtg, DefRtg, Pace, descanso y Win Rate con datos verificados.",
      });
      return;
    }
'''
if run_marker not in frontend:
    raise SystemExit("runPrediction marker not found")
frontend = frontend.replace(run_marker, validation, 1)

# 6) Replace the conditional/collapsed manual selector and duplicate warnings with
# one always-visible manual section and a single explicit status message.
manual_start_marker = '''          {/* Selector manual fallback */}
'''
manual_start = frontend.index(manual_start_marker)
manual_end = frontend.index('        </CardContent>', manual_start)
manual_block = '''          {/* Selector manual fallback — always available */}
          <div className="rounded-md border border-primary/20 bg-background/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-primary">Selector manual de equipos</span>
              <Badge variant="outline" className={`text-[10px] ${hasVerifiedWNBAStats ? "border-green-500/40 text-green-400" : "border-amber-500/40 text-amber-300"}`}>
                {hasVerifiedWNBAStats ? "Autollenado verificado" : "Entrada manual"}
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Equipo Local</Label>
                <Select value={homeTeam} onValueChange={(v) => autoFillWNBA(v, "home")} disabled={wnbaLoading}>
                  <SelectTrigger className="border-primary/30"><SelectValue placeholder="Local..." /></SelectTrigger>
                  <SelectContent>{manualTeamOptions.map(t => <SelectItem key={t.teamId} value={t.teamName}>{t.teamName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Equipo Visitante</Label>
                <Select value={awayTeam} onValueChange={(v) => autoFillWNBA(v, "away")} disabled={wnbaLoading}>
                  <SelectTrigger className="border-primary/30"><SelectValue placeholder="Visitante..." /></SelectTrigger>
                  <SelectContent>{manualTeamOptions.map(t => <SelectItem key={t.teamId} value={t.teamName}>{t.teamName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            {!hasVerifiedWNBAStats && !wnbaLoading && (
              <p className="text-[11px] text-amber-200/80">
                Autollenado no disponible. Selecciona los equipos y completa manualmente las estadísticas verificadas en las tarjetas inferiores.
              </p>
            )}
          </div>
          {wnbaLoading && <p className="text-xs text-muted-foreground italic"><RefreshCw className="h-3 w-3 inline animate-spin mr-1" /> Cargando stats de equipos...</p>}
          {wnbaError && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-red-300">
              <span>No se pudieron cargar estadísticas WNBA verificadas. El modo manual permanece disponible y los campos no usarán valores predeterminados.</span>
              <Button size="sm" variant="outline" onClick={() => refetchWNBA()} className="h-7 border-red-500/30 text-red-300">
                <RefreshCw className="h-3 w-3 mr-1" /> Reintentar
              </Button>
            </div>
          )}
'''
frontend = frontend[:manual_start] + manual_block + frontend[manual_end:]

FRONTEND.write_text(frontend, encoding="utf-8")
print("WNBA safe manual fallback UI applied")
