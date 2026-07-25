from pathlib import Path

ROUTES = Path("server/routes.ts")
PREDICTOR = Path("frontend/client/src/pages/predictor.tsx")

routes = ROUTES.read_text(encoding="utf-8")

import_marker = 'import { computeMLBContextual } from "./mlb-contextual";\n'
import_line = 'import { registerNbaManualRoutes } from "./nba-manual-routes";\n'
if import_line not in routes:
    if import_marker not in routes:
        raise SystemExit("routes import marker not found")
    routes = routes.replace(import_marker, import_marker + import_line, 1)

register_marker = 'export function registerRoutes(httpServer: Server, app: Express): void {\n'
register_line = '  registerNbaManualRoutes(app);\n\n'
if register_line not in routes:
    if register_marker not in routes:
        raise SystemExit("registerRoutes marker not found")
    routes = routes.replace(register_marker, register_marker + register_line, 1)

ROUTES.write_text(routes, encoding="utf-8")

frontend = PREDICTOR.read_text(encoding="utf-8")
frontend = frontend.replace(
    'import { useState, useCallback } from "react";',
    'import { useState, useCallback } from "react";',
    1,
)

interface_marker = '''interface NBAGame {
  gameId: string;
  gameTimeUTC: string;
  homeTeam: { id: number; name: string; tricode: string };
  awayTeam: { id: number; name: string; tricode: string };
  homeStats: NBATeamStats | null;
  awayStats: NBATeamStats | null;
}
'''
manual_interface = interface_marker + '''
interface NBAManualTeam extends NBATeamStats {
  teamId: number;
  teamName: string;
}
'''
if 'interface NBAManualTeam extends NBATeamStats' not in frontend:
    if interface_marker not in frontend:
        raise SystemExit("NBAGame interface marker not found")
    frontend = frontend.replace(interface_marker, manual_interface, 1)

initial_replacements = {
    'const [homeNetRtg, setHomeNetRtg] = useState("5.0");': 'const [homeNetRtg, setHomeNetRtg] = useState("");',
    'const [homeOffRtg, setHomeOffRtg] = useState("115.0");': 'const [homeOffRtg, setHomeOffRtg] = useState("");',
    'const [homeDefRtg, setHomeDefRtg] = useState("110.0");': 'const [homeDefRtg, setHomeDefRtg] = useState("");',
    'const [homePace, setHomePace] = useState("100.0");': 'const [homePace, setHomePace] = useState("");',
    'const [homeDaysRest, setHomeDaysRest] = useState("2");': 'const [homeDaysRest, setHomeDaysRest] = useState("");',
    'const [homeWinRate, setHomeWinRate] = useState("0.60");': 'const [homeWinRate, setHomeWinRate] = useState("");',
    'const [awayNetRtg, setAwayNetRtg] = useState("2.0");': 'const [awayNetRtg, setAwayNetRtg] = useState("");',
    'const [awayOffRtg, setAwayOffRtg] = useState("112.0");': 'const [awayOffRtg, setAwayOffRtg] = useState("");',
    'const [awayDefRtg, setAwayDefRtg] = useState("110.0");': 'const [awayDefRtg, setAwayDefRtg] = useState("");',
    'const [awayPace, setAwayPace] = useState("98.0");': 'const [awayPace, setAwayPace] = useState("");',
    'const [awayDaysRest, setAwayDaysRest] = useState("1");': 'const [awayDaysRest, setAwayDaysRest] = useState("");',
    'const [awayWinRate, setAwayWinRate] = useState("0.50");': 'const [awayWinRate, setAwayWinRate] = useState("");',
}
for old, new in initial_replacements.items():
    if old in frontend:
        frontend = frontend.replace(old, new, 1)
    elif new not in frontend:
        raise SystemExit(f"initial state marker not found: {old}")

status_marker = '  const [autoFillStatus, setAutoFillStatus] = useState<"idle"|"loading"|"success"|"error">("idle");\n'
status_addition = status_marker + '  const [homeManualStatus, setHomeManualStatus] = useState<"idle"|"verified"|"manual">("idle");\n  const [awayManualStatus, setAwayManualStatus] = useState<"idle"|"verified"|"manual">("idle");\n'
if 'const [homeManualStatus' not in frontend:
    if status_marker not in frontend:
        raise SystemExit("manual status marker not found")
    frontend = frontend.replace(status_marker, status_addition, 1)

query_marker = '''  const todayGames: NBAGame[] = nbaData?.games ?? [];

  const handleAutoFill = async (gameId: string) => {
'''
query_block = '''  const todayGames: NBAGame[] = nbaData?.games ?? [];

  const { data: manualTeamPayload, isLoading: manualTeamsLoading } = useQuery<{ success: boolean; data: NBAManualTeam[]; source: string }>({
    queryKey: ["/api/nba/manual-teams", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/nba/manual-teams?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  const manualTeams: NBAManualTeam[] = manualTeamPayload?.data ?? [];

  const applyManualTeam = (side: "home" | "away", teamName: string) => {
    const isHome = side === "home";
    const setTeam = isHome ? setHomeTeam : setAwayTeam;
    const setStatus = isHome ? setHomeManualStatus : setAwayManualStatus;
    setTeam(teamName);
    setResult(null);

    const team = manualTeams.find((row) => row.teamName === teamName);
    const setters = isHome
      ? {
          net: setHomeNetRtg, off: setHomeOffRtg, def: setHomeDefRtg, pace: setHomePace,
          rest: setHomeDaysRest, win: setHomeWinRate, b2b: setHomeB2B, streak: setHomeStreak,
          games7: setHomeGamesLast7, recentPace: setHomeRecentPace, recentPPG: setHomeRecentPPG,
          oppDef: setHomeOppDefRtg, oppOff: setHomeOppOffRtg,
        }
      : {
          net: setAwayNetRtg, off: setAwayOffRtg, def: setAwayDefRtg, pace: setAwayPace,
          rest: setAwayDaysRest, win: setAwayWinRate, b2b: setAwayB2B, streak: setAwayStreak,
          games7: setAwayGamesLast7, recentPace: setAwayRecentPace, recentPPG: setAwayRecentPPG,
          oppDef: setAwayOppDefRtg, oppOff: setAwayOppOffRtg,
        };

    if (!team) {
      setters.net(""); setters.off(""); setters.def(""); setters.pace("");
      setters.rest(""); setters.win(""); setters.b2b(false); setters.streak("0");
      setters.games7(0); setters.recentPace(""); setters.recentPPG("");
      setters.oppDef(""); setters.oppOff("");
      setStatus("manual");
      toast({
        title: manualTeamsLoading ? "Cargando estadísticas NBA" : "Entrada manual NBA",
        description: manualTeamsLoading
          ? "Espera a que termine la carga y vuelve a seleccionar el equipo."
          : "No hay estadísticas verificadas disponibles; los campos permanecen vacíos.",
      });
      return;
    }

    setters.net(team.netRtg.toFixed(1));
    setters.off(team.offRtg.toFixed(1));
    setters.def(team.defRtg.toFixed(1));
    setters.pace(team.pace.toFixed(1));
    setters.win(team.winPct.toFixed(2));
    setters.rest(team.daysRest !== undefined ? String(team.daysRest) : "");
    setters.b2b(team.isB2B ?? false);
    setters.streak(team.streak !== undefined ? String(team.streak) : "0");
    setters.games7(team.gamesLast7Days ?? 0);
    setters.recentPace(team.pace5 !== undefined ? team.pace5.toFixed(1) : "");
    setters.recentPPG(team.ppg5 !== undefined ? team.ppg5.toFixed(1) : "");
    setters.oppDef(team.oppAvgDefRtg !== undefined ? team.oppAvgDefRtg.toFixed(1) : "");
    setters.oppOff(team.oppAvgOffRtg !== undefined ? team.oppAvgOffRtg.toFixed(1) : "");
    (window as any)[isHome ? "__homeSOS" : "__awaySOS"] = {
      label: team.sosLabel,
      netRtg: team.oppAvgNetRtg,
      opps: team.opponents,
    };
    setStatus("verified");
    toast({
      title: `✅ ${teamName} cargado`,
      description: team.daysRest === undefined
        ? "Stats de temporada verificadas. Descanso pendiente porque no hay juego activo en la fecha seleccionada."
        : "Stats y contexto reciente cargados.",
    });
  };

  const handleAutoFill = async (gameId: string) => {
'''
if 'const { data: manualTeamPayload' not in frontend:
    if query_marker not in frontend:
        raise SystemExit("manual query insertion marker not found")
    frontend = frontend.replace(query_marker, query_block, 1)

validation_marker = '''  const runPrediction = useCallback(() => {
    const homeAdj = parseFloat(homeInjury) || 0;
'''
validation_block = '''  const runPrediction = useCallback(() => {
    const requiredStats = [
      { label: "NetRtg Local", value: homeNetRtg },
      { label: "OffRtg Local", value: homeOffRtg },
      { label: "DefRtg Local", value: homeDefRtg },
      { label: "Pace Local", value: homePace },
      { label: "Descanso Local", value: homeDaysRest },
      { label: "Win Rate Local", value: homeWinRate },
      { label: "NetRtg Visitante", value: awayNetRtg },
      { label: "OffRtg Visitante", value: awayOffRtg },
      { label: "DefRtg Visitante", value: awayDefRtg },
      { label: "Pace Visitante", value: awayPace },
      { label: "Descanso Visitante", value: awayDaysRest },
      { label: "Win Rate Visitante", value: awayWinRate },
    ];
    const missingStats = requiredStats
      .filter(({ value }) => value.trim() === "" || !Number.isFinite(Number(value)))
      .map(({ label }) => label);
    if (!homeTeam || !awayTeam || homeTeam === awayTeam || missingStats.length > 0) {
      const description = !homeTeam || !awayTeam
        ? "Selecciona el equipo Local y el Visitante."
        : homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : `Faltan: ${missingStats.join(", ")}.`;
      toast({ title: "Faltan datos NBA", description });
      return;
    }

    const homeAdj = parseFloat(homeInjury) || 0;
'''
if 'title: "Faltan datos NBA"' not in frontend:
    if validation_marker not in frontend:
        raise SystemExit("prediction validation marker not found")
    frontend = frontend.replace(validation_marker, validation_block, 1)

select_old = '''            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger data-testid={`select-${side}-team`} className="mt-1">
                <SelectValue placeholder="Seleccionar equipo" />
              </SelectTrigger>
              <SelectContent>
                {NBA_TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
'''
select_new = '''            <Select value={team} onValueChange={(value) => applyManualTeam(side, value)}>
              <SelectTrigger data-testid={`select-${side}-team`} className="mt-1">
                <SelectValue placeholder="Seleccionar equipo" />
              </SelectTrigger>
              <SelectContent>
                {NBA_TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            {team && (
              <p className={`mt-1 text-[11px] ${
                (isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? "text-green-400"
                  : "text-amber-400"
              }`}>
                {(isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? `Autollenado verificado · ${manualTeamPayload?.source === "production-readonly-fallback" ? "respaldo de solo lectura" : "fuente directa"}`
                  : manualTeamsLoading
                    ? "Cargando estadísticas verificadas…"
                    : "Entrada manual · no usar valores sin verificar"}
              </p>
            )}
'''
if 'onValueChange={(value) => applyManualTeam(side, value)}' not in frontend:
    if select_old not in frontend:
        raise SystemExit("manual team select marker not found")
    frontend = frontend.replace(select_old, select_new, 1)

PREDICTOR.write_text(frontend, encoding="utf-8")
print("NBA manual verified autofill applied")
