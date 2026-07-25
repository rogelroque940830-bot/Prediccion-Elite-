from pathlib import Path

ROUTES = Path("server/routes.ts")
PREDICTOR = Path("frontend/client/src/pages/nhl-predictor.tsx")

routes = ROUTES.read_text(encoding="utf-8")
import_marker = 'import { registerNbaManualRoutes } from "./nba-manual-routes";\n'
import_line = 'import { registerNhlManualRoutes } from "./nhl-manual-routes";\n'
if import_line not in routes:
    if import_marker not in routes:
        raise SystemExit("NHL routes import marker not found")
    routes = routes.replace(import_marker, import_marker + import_line, 1)

register_marker = '  registerNbaManualRoutes(app);\n'
register_line = '  registerNhlManualRoutes(app);\n'
if register_line not in routes:
    if register_marker not in routes:
        raise SystemExit("NHL register marker not found")
    routes = routes.replace(register_marker, register_marker + register_line, 1)
ROUTES.write_text(routes, encoding="utf-8")

text = PREDICTOR.read_text(encoding="utf-8")

interface_marker = '// ── Helpers (pure) ───────────────────────────────────────────────────────────\n'
manual_interface = '''interface NHLManualTeam {
  teamName: string;
  abbr: string;
  seasonId: string;
  gamesPlayed?: number;
  goalsFor: number;
  goalsAgainst: number;
  ppPct?: number;
  pkPct?: number;
  shotsFor?: number;
  shotsAgainst?: number;
  corsi?: number;
  winRate10: number;
  streak?: number;
  recentGF?: number;
  recentGA?: number;
  daysRest?: number;
  isB2B?: boolean;
  gamesLast7Days?: number;
  xGF?: number;
  xGA?: number;
  cf5v5?: number;
  shPct?: number;
  hdCF?: number;
  hdCA?: number;
  ppGF?: number;
  pkGA?: number;
  scoreAdjXGF?: number;
  scoreAdjXGA?: number;
}

function normalizeNhlTeamName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

'''
if 'interface NHLManualTeam {' not in text:
    if interface_marker not in text:
        raise SystemExit("NHL interface marker not found")
    text = text.replace(interface_marker, manual_interface + interface_marker, 1)

state_replacements = {
    'const [homeSavePct, setHomeSavePct] = useState("0.910");': 'const [homeSavePct, setHomeSavePct] = useState("");',
    'const [homeGAA, setHomeGAA] = useState("2.80");': 'const [homeGAA, setHomeGAA] = useState("");',
    'const [homeRecord, setHomeRecord] = useState("25-10-3");': 'const [homeRecord, setHomeRecord] = useState("");',
    'const [homeGF, setHomeGF] = useState("3.2");': 'const [homeGF, setHomeGF] = useState("");',
    'const [homeGA, setHomeGA] = useState("2.9");': 'const [homeGA, setHomeGA] = useState("");',
    'const [homePP, setHomePP] = useState("22");': 'const [homePP, setHomePP] = useState("");',
    'const [homePK, setHomePK] = useState("80");': 'const [homePK, setHomePK] = useState("");',
    'const [homeCorsi, setHomeCorsi] = useState("51");': 'const [homeCorsi, setHomeCorsi] = useState("");',
    'const [homeShotsFor, setHomeShotsFor] = useState("32");': 'const [homeShotsFor, setHomeShotsFor] = useState("");',
    'const [homeShotsAgainst, setHomeShotsAgainst] = useState("29");': 'const [homeShotsAgainst, setHomeShotsAgainst] = useState("");',
    'const [homeWinRate10, setHomeWinRate10] = useState("0.6");': 'const [homeWinRate10, setHomeWinRate10] = useState("");',
    'const [homeDaysRest, setHomeDaysRest] = useState("2");': 'const [homeDaysRest, setHomeDaysRest] = useState("");',
    'const [awaySavePct, setAwaySavePct] = useState("0.910");': 'const [awaySavePct, setAwaySavePct] = useState("");',
    'const [awayGAA, setAwayGAA] = useState("2.80");': 'const [awayGAA, setAwayGAA] = useState("");',
    'const [awayRecord, setAwayRecord] = useState("20-15-5");': 'const [awayRecord, setAwayRecord] = useState("");',
    'const [awayGF, setAwayGF] = useState("3.2");': 'const [awayGF, setAwayGF] = useState("");',
    'const [awayGA, setAwayGA] = useState("2.9");': 'const [awayGA, setAwayGA] = useState("");',
    'const [awayPP, setAwayPP] = useState("22");': 'const [awayPP, setAwayPP] = useState("");',
    'const [awayPK, setAwayPK] = useState("80");': 'const [awayPK, setAwayPK] = useState("");',
    'const [awayCorsi, setAwayCorsi] = useState("49");': 'const [awayCorsi, setAwayCorsi] = useState("");',
    'const [awayShotsFor, setAwayShotsFor] = useState("30");': 'const [awayShotsFor, setAwayShotsFor] = useState("");',
    'const [awayShotsAgainst, setAwayShotsAgainst] = useState("31");': 'const [awayShotsAgainst, setAwayShotsAgainst] = useState("");',
    'const [awayWinRate10, setAwayWinRate10] = useState("0.5");': 'const [awayWinRate10, setAwayWinRate10] = useState("");',
    'const [awayDaysRest, setAwayDaysRest] = useState("2");': 'const [awayDaysRest, setAwayDaysRest] = useState("");',
}
for old, new in state_replacements.items():
    if old in text:
        text = text.replace(old, new, 1)

status_marker = '  const [sharpDir, setSharpDir] = useState<SharpDirection | null>(null);\n'
status_lines = '''  const [homeManualStatus, setHomeManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const [awayManualStatus, setAwayManualStatus] = useState<"idle" | "verified" | "manual">("idle");
'''
if 'const [homeManualStatus' not in text:
    if status_marker not in text:
        raise SystemExit("NHL status marker not found")
    text = text.replace(status_marker, status_marker + status_lines, 1)

query_line_old = '  const { data: nhlData, isLoading: nhlLoading, refetch: refetchNHL } = useQuery<{ success: boolean; games: any[] }>({\n'
query_line_new = '  const { data: nhlData, isLoading: nhlLoading, refetch: refetchNHL, error: nhlError } = useQuery<{ success: boolean; games: any[] }>({\n'
if query_line_old in text:
    text = text.replace(query_line_old, query_line_new, 1)

manual_query_marker = '  const nhlGames = nhlData?.games ?? [];\n'
manual_query = '''  const nhlGames = nhlData?.games ?? [];

  const {
    data: manualTeamPayload,
    isLoading: manualTeamsLoading,
    error: manualTeamsError,
  } = useQuery<{ success: boolean; data: NHLManualTeam[]; source: string; seasonId: string }>({
    queryKey: ["/api/nhl/manual-teams", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/nhl/manual-teams?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  const manualTeams: NHLManualTeam[] = manualTeamPayload?.data ?? [];
'''
if 'queryKey: ["/api/nhl/manual-teams"' not in text:
    if manual_query_marker not in text:
        raise SystemExit("NHL manual query marker not found")
    text = text.replace(manual_query_marker, manual_query, 1)

apply_marker = '  const autoFillNHL = async (gameId: string) => {\n'
apply_function = '''  const applyManualNHLTeam = (side: "home" | "away", teamName: string) => {
    const isHome = side === "home";
    const setters = {
      team: isHome ? setHomeTeam : setAwayTeam,
      abbr: isHome ? setHomeAbbr : setAwayAbbr,
      gf: isHome ? setHomeGF : setAwayGF,
      ga: isHome ? setHomeGA : setAwayGA,
      pp: isHome ? setHomePP : setAwayPP,
      pk: isHome ? setHomePK : setAwayPK,
      corsi: isHome ? setHomeCorsi : setAwayCorsi,
      shotsFor: isHome ? setHomeShotsFor : setAwayShotsFor,
      shotsAgainst: isHome ? setHomeShotsAgainst : setAwayShotsAgainst,
      streak: isHome ? setHomeStreak : setAwayStreak,
      winRate: isHome ? setHomeWinRate10 : setAwayWinRate10,
      b2b: isHome ? setHomeB2B : setAwayB2B,
      rest: isHome ? setHomeDaysRest : setAwayDaysRest,
      recentGF: isHome ? setHomeRecentGF : setAwayRecentGF,
      recentGA: isHome ? setHomeRecentGA : setAwayRecentGA,
      sos: isHome ? setHomeSOS : setAwaySOS,
      xGF: isHome ? setHomeXGF : setAwayXGF,
      xGA: isHome ? setHomeXGA : setAwayXGA,
      cf5v5: isHome ? setHomeCF5v5 : setAwayCF5v5,
      shPct: isHome ? setHomeSHPct : setAwaySHPct,
      hdCF: isHome ? setHomeHDCF : setAwayHDCF,
      hdCA: isHome ? setHomeHDCA : setAwayHDCA,
      ppGF: isHome ? setHomePPGF : setAwayPPGF,
      pkGA: isHome ? setHomePKGA : setAwayPKGA,
      scoreAdjXGF: isHome ? setHomeScoreAdjXGF : setAwayScoreAdjXGF,
      scoreAdjXGA: isHome ? setHomeScoreAdjXGA : setAwayScoreAdjXGA,
      goalieName: isHome ? setHomeGoalieName : setAwayGoalieName,
      savePct: isHome ? setHomeSavePct : setAwaySavePct,
      gaa: isHome ? setHomeGAA : setAwayGAA,
      goalieRecord: isHome ? setHomeRecord : setAwayRecord,
      recentGAA: isHome ? setHomeRecentGAA : setAwayRecentGAA,
      recentSvPct: isHome ? setHomeRecentSvPct : setAwayRecentSvPct,
      gsax: isHome ? setHomeGSAx : setAwayGSAx,
      goalieOptions: isHome ? setHomeGoalieOptions : setAwayGoalieOptions,
      roster: isHome ? setHomeRoster : setAwayRoster,
      recentOpps: isHome ? setHomeRecentOpps : setAwayRecentOpps,
      status: isHome ? setHomeManualStatus : setAwayManualStatus,
    };

    setters.team(teamName);
    setResult(null);
    setSelNHLGame("");
    setSharpGameKey(null);
    setGoalieData(null);
    setH2hLabel("");
    setH2hHomeWins(0);
    setH2hAwayWins(0);

    setters.abbr("");
    setters.gf(""); setters.ga(""); setters.pp(""); setters.pk(""); setters.corsi("");
    setters.shotsFor(""); setters.shotsAgainst(""); setters.streak("0"); setters.winRate("");
    setters.b2b(false); setters.rest(""); setters.recentGF(""); setters.recentGA(""); setters.sos("");
    setters.xGF(""); setters.xGA(""); setters.cf5v5(""); setters.shPct("");
    setters.hdCF(""); setters.hdCA(""); setters.ppGF(""); setters.pkGA("");
    setters.scoreAdjXGF(""); setters.scoreAdjXGA("");
    setters.goalieName(""); setters.savePct(""); setters.gaa(""); setters.goalieRecord("");
    setters.recentGAA(""); setters.recentSvPct(""); setters.gsax(""); setters.goalieOptions([]);
    setters.roster([]); setters.recentOpps([]);
    if (isHome) {
      setHomeHomeSplitGF(""); setHomeHomeSplitGA(""); setHomeAwaySpGF(""); setHomeAwaySpGA("");
      setHomeHomeSplitRec(""); setHomeAwaySplitRec(""); setHomeMissing(new Set()); setHomeGamesOut({});
    } else {
      setAwayHomeSplitGF(""); setAwayHomeSplitGA(""); setAwayAwaySpGF(""); setAwayAwaySpGA("");
      setAwayHomeSplitRec(""); setAwayAwaySplitRec(""); setAwayMissing(new Set()); setAwayGamesOut({});
    }

    const team = manualTeams.find(
      (row) => normalizeNhlTeamName(row.teamName) === normalizeNhlTeamName(teamName),
    );
    if (!team) {
      setters.status("manual");
      toast({
        title: manualTeamsLoading ? "Cargando estadísticas NHL" : "Entrada manual NHL",
        description: manualTeamsLoading
          ? "Espera a que termine la carga y vuelve a seleccionar el equipo."
          : "No hay estadísticas verificadas disponibles; los campos permanecen vacíos.",
      });
      return;
    }

    setters.abbr(team.abbr);
    setters.gf(team.goalsFor.toFixed(2));
    setters.ga(team.goalsAgainst.toFixed(2));
    setters.pp(team.ppPct !== undefined ? team.ppPct.toFixed(1) : "");
    setters.pk(team.pkPct !== undefined ? team.pkPct.toFixed(1) : "");
    setters.corsi(team.corsi !== undefined ? team.corsi.toFixed(1) : "");
    setters.shotsFor(team.shotsFor !== undefined ? team.shotsFor.toFixed(1) : "");
    setters.shotsAgainst(team.shotsAgainst !== undefined ? team.shotsAgainst.toFixed(1) : "");
    setters.winRate(team.winRate10.toFixed(2));
    setters.streak(team.streak !== undefined ? String(team.streak) : "0");
    setters.rest(team.daysRest !== undefined ? String(team.daysRest) : "");
    setters.b2b(team.isB2B ?? false);
    setters.recentGF(team.recentGF !== undefined ? team.recentGF.toFixed(2) : "");
    setters.recentGA(team.recentGA !== undefined ? team.recentGA.toFixed(2) : "");
    setters.xGF(team.xGF !== undefined ? String(team.xGF) : "");
    setters.xGA(team.xGA !== undefined ? String(team.xGA) : "");
    setters.cf5v5(team.cf5v5 !== undefined ? String(team.cf5v5) : "");
    setters.shPct(team.shPct !== undefined ? String(team.shPct) : "");
    setters.hdCF(team.hdCF !== undefined ? String(team.hdCF) : "");
    setters.hdCA(team.hdCA !== undefined ? String(team.hdCA) : "");
    setters.ppGF(team.ppGF !== undefined ? String(team.ppGF) : "");
    setters.pkGA(team.pkGA !== undefined ? String(team.pkGA) : "");
    setters.scoreAdjXGF(team.scoreAdjXGF !== undefined ? String(team.scoreAdjXGF) : "");
    setters.scoreAdjXGA(team.scoreAdjXGA !== undefined ? String(team.scoreAdjXGA) : "");
    setters.status("verified");

    toast({
      title: `✅ ${teamName} cargado`,
      description: team.daysRest === undefined
        ? "Stats de equipo verificadas. Descanso y portero pendientes porque no hay partido activo."
        : "Stats y descanso cargados. Confirma o introduce el portero probable.",
    });
  };

'''
if 'const applyManualNHLTeam =' not in text:
    if apply_marker not in text:
        raise SystemExit("NHL apply marker not found")
    text = text.replace(apply_marker, apply_function + apply_marker, 1)

select_old = '<Select value={team} onValueChange={setTeam}>'
select_new = '<Select value={team} onValueChange={(value) => applyManualNHLTeam(side, value)}>'
if select_old in text:
    text = text.replace(select_old, select_new, 1)

selector_close = '''            </Select>
          </div>

          {/* PORTERO section */}
'''
selector_status = '''            </Select>
            {team && (
              <p className={`mt-1 text-[11px] ${(isHome ? homeManualStatus : awayManualStatus) === "verified" ? "text-green-400" : "text-amber-400"}`}>
                {(isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? "Autollenado verificado · fuente directa"
                  : manualTeamsLoading
                    ? "Cargando estadísticas verificadas…"
                    : "Entrada manual · no usar valores sin verificar"}
              </p>
            )}
            {team && (isHome ? homeManualStatus : awayManualStatus) === "verified" && !daysRest.trim() && (
              <p className="mt-1 text-[11px] text-amber-400">Descanso pendiente · no hay partido activo en la fecha seleccionada.</p>
            )}
            {team && (isHome ? homeManualStatus : awayManualStatus) === "verified" && !goalieName.trim() && (
              <p className="mt-1 text-[11px] text-cyan-400">Portero pendiente · debe confirmarse antes de generar una predicción.</p>
            )}
          </div>

          {/* PORTERO section */}
'''
if 'Portero pendiente · debe confirmarse' not in text:
    if selector_close not in text:
        raise SystemExit("NHL selector close marker not found")
    text = text.replace(selector_close, selector_status, 1)

prediction_marker = '  const runPrediction = useCallback(() => {\n'
validation = '''  const runPrediction = useCallback(() => {
    const requiredNumeric = [
      { label: "SV% Portero Local", value: homeSavePct },
      { label: "GAA Portero Local", value: homeGAA },
      { label: "GF Local", value: homeGF },
      { label: "GA Local", value: homeGA },
      { label: "PP% Local", value: homePP },
      { label: "PK% Local", value: homePK },
      { label: "Corsi Local", value: homeCorsi },
      { label: "Tiros Local", value: homeShotsFor },
      { label: "Tiros contra Local", value: homeShotsAgainst },
      { label: "Win Rate Local", value: homeWinRate10 },
      { label: "Descanso Local", value: homeDaysRest },
      { label: "SV% Portero Visitante", value: awaySavePct },
      { label: "GAA Portero Visitante", value: awayGAA },
      { label: "GF Visitante", value: awayGF },
      { label: "GA Visitante", value: awayGA },
      { label: "PP% Visitante", value: awayPP },
      { label: "PK% Visitante", value: awayPK },
      { label: "Corsi Visitante", value: awayCorsi },
      { label: "Tiros Visitante", value: awayShotsFor },
      { label: "Tiros contra Visitante", value: awayShotsAgainst },
      { label: "Win Rate Visitante", value: awayWinRate10 },
      { label: "Descanso Visitante", value: awayDaysRest },
    ];
    const missing = requiredNumeric
      .filter(({ value }) => value.trim() === "" || !Number.isFinite(Number(value)))
      .map(({ label }) => label);
    if (!homeGoalieName.trim()) missing.unshift("Portero Local");
    if (!awayGoalieName.trim()) missing.push("Portero Visitante");

    const invalidRanges: string[] = [];
    const homeSv = Number(homeSavePct);
    const awaySv = Number(awaySavePct);
    const homeWr = Number(homeWinRate10);
    const awayWr = Number(awayWinRate10);
    if (homeSavePct.trim() && (homeSv < 0.8 || homeSv > 1)) invalidRanges.push("SV% Local fuera de rango");
    if (awaySavePct.trim() && (awaySv < 0.8 || awaySv > 1)) invalidRanges.push("SV% Visitante fuera de rango");
    if (homeWinRate10.trim() && (homeWr < 0 || homeWr > 1)) invalidRanges.push("Win Rate Local fuera de rango");
    if (awayWinRate10.trim() && (awayWr < 0 || awayWr > 1)) invalidRanges.push("Win Rate Visitante fuera de rango");

    if (!homeTeam || !awayTeam || homeTeam === awayTeam || missing.length > 0 || invalidRanges.length > 0) {
      const description = !homeTeam || !awayTeam
        ? "Selecciona el equipo Local y el Visitante."
        : homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : missing.length > 0
            ? `Faltan: ${missing.join(", ")}.`
            : invalidRanges.join(", ");
      toast({ title: "Faltan datos NHL", description });
      return;
    }
'''
if 'const requiredNumeric = [' not in text:
    if prediction_marker not in text:
        raise SystemExit("NHL prediction marker not found")
    text = text.replace(prediction_marker, validation, 1)

info_marker = '''          <p className="text-xs text-muted-foreground">
            Se llena: Portero (nombre, SV%, GAA), GF/GA, Forma reciente (L10), SOS, Racha. Tú: Corsi, Líneas.
            <span className="text-amber-400"> Si el portero no es correcto, puedes editar el nombre y stats manualmente.</span>
          </p>
'''
info_new = '''          {nhlError && manualTeams.length > 0 && (
            <p className="text-xs text-amber-400">
              ⚠️ No hay partidos NHL disponibles para esta fecha o el calendario no respondió. El selector manual sigue disponible con estadísticas verificadas.
            </p>
          )}
          {!nhlError && nhlData?.success && nhlGames.length === 0 && (
            <p className="text-xs text-amber-400">
              ℹ️ No hay partidos NHL programados para esta fecha. Puedes usar el selector manual con estadísticas verificadas.
            </p>
          )}
          {manualTeamsError && !manualTeamsLoading && (
            <p className="text-xs text-red-400">
              ⚠️ No se pudieron cargar las estadísticas verificadas NHL. Los campos permanecerán vacíos.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Selector manual:</span> GF/GA · PP/PK · Corsi · tiros · forma L10 · analytics disponibles.
            <span className="text-amber-400"> Tú agregas: portero confirmado · descanso si no hay partido activo · líneas.</span>
          </p>
'''
if 'Selector manual:</span> GF/GA' not in text:
    if info_marker not in text:
        raise SystemExit("NHL info marker not found")
    text = text.replace(info_marker, info_new, 1)

PREDICTOR.write_text(text, encoding="utf-8")
