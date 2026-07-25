from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one regex match, found {count}")
    return updated


# ---------------------------------------------------------------------------
# server/mlb-ere.ts
# ---------------------------------------------------------------------------
ere_path = Path("server/mlb-ere.ts")
ere = ere_path.read_text(encoding="utf-8")

er = replace_once(
    ere,
    '''  windDirOut?: boolean;\n}''',
    '''  windDirOut?: boolean;\n  gameDate?: string;          // YYYY-MM-DD; all recent windows end before this game\n}''',
    "ERE input gameDate",
)

er = replace_once(
    ere,
    '''  teamId: number;\n  teamName: string;\n  // Composite''',
    '''  teamId: number;\n  teamName: string;\n  dataStatus: "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE";\n  asOfDate: string;\n  windowStart: string;\n  sourceErrors: string[];\n  // Composite''',
    "ERE result integrity fields",
)

er = replace_once(
    ere,
    '''  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand, venue, tempF, windMph, windDirOut } = input;''',
    '''  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand, venue, tempF, windMph, windDirOut, gameDate } = input;\n  const asOfDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(gameDate || "")\n    ? String(gameDate)\n    : new Date().toISOString().slice(0, 10);''',
    "ERE as-of date",
)

er = replace_once(
    ere,
    '''    computeTeamEarlyMetrics(teamId),''',
    '''    computeTeamEarlyMetrics(teamId, asOfDate),''',
    "ERE team metrics as-of",
)

er = replace_once(
    ere,
    '''  const { category, marketSuggestions } = classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);\n  const warnings = collectWarnings(offVars, pitVars, teamMetrics, pitcherData);''',
    '''  const dataIncomplete = teamMetrics.dataStatus === "DATA_INCOMPLETE";\n  const classified = dataIncomplete\n    ? { category: "NEUTRAL" as EreResult["category"], marketSuggestions: [] as string[] }\n    : classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);\n  const { category, marketSuggestions } = classified;\n  const warnings = collectWarnings(offVars, pitVars, teamMetrics, pitcherData);\n  if (teamMetrics.dataStatus === "DATA_INCOMPLETE") {\n    warnings.unshift("DATA_INCOMPLETE: no se validaron linescores suficientes; mercados early bloqueados");\n  } else if (teamMetrics.dataStatus === "PARTIAL") {\n    warnings.unshift(`Cobertura early parcial (${teamMetrics.gamesAnalyzed} juegos); usar solo como contexto`);\n  }''',
    "ERE fail closed classification",
)

er = replace_once(
    ere,
    '''    teamId, teamName,\n    ereScore, ereRaw,''',
    '''    teamId, teamName,\n    dataStatus: teamMetrics.dataStatus,\n    asOfDate: teamMetrics.asOfDate,\n    windowStart: teamMetrics.windowStart,\n    sourceErrors: teamMetrics.sourceErrors,\n    ereScore, ereRaw,''',
    "ERE return integrity fields",
)

new_ere_team_metrics = r'''async function computeTeamEarlyMetrics(teamId: number, asOfDate: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
    ? new Date(`${asOfDate}T12:00:00Z`)
    : new Date();
  // The selected game must never enter its own pre-game sample.
  const end = new Date(parsed);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const windowStart = fmt(start);
  const windowEnd = fmt(end);
  const sourceErrors: string[] = [];

  const baseline = (status: "DATA_INCOMPLETE" | "PARTIAL" = "DATA_INCOMPLETE") => ({
    gamesAnalyzed: 0,
    earlyOff: LEAGUE.RUNS_1_3,
    f5Runs: LEAGUE.F5_RUNS,
    probFirstInn: LEAGUE.YRFI_RATE,
    l7Rpg: LEAGUE.L7_RPG,
    dataStatus: status as "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE",
    asOfDate,
    windowStart,
    sourceErrors,
  });

  if (end.getTime() < start.getTime()) {
    sourceErrors.push("invalid_date_window");
    return baseline();
  }

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${windowStart}&endDate=${windowEnd}&gameType=R`;
  let gamePks: number[] = [];
  const gameTeamMap = new Map<number, { homeId: number; awayId: number }>();
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    if (!r.ok) throw new Error(`schedule_http_${r.status}`);
    const j: any = await r.json();
    for (const dd of j.dates ?? []) {
      for (const g of dd.games ?? []) {
        if (g.status?.detailedState === "Final") {
          gamePks.push(g.gamePk);
          gameTeamMap.set(g.gamePk, {
            homeId: g.teams?.home?.team?.id,
            awayId: g.teams?.away?.team?.id,
          });
        }
      }
    }
    console.log(`[ERE] team ${teamId}: fetched ${gamePks.length} finalized games through ${windowEnd}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sourceErrors.push(`schedule:${msg}`);
    console.error(`[ERE] team ${teamId}: schedule fetch FAILED:`, e);
    return baseline();
  }

  const recent = gamePks.slice(-30);
  if (recent.length === 0) {
    sourceErrors.push("schedule:no_final_games");
    return baseline();
  }

  const linescores = await Promise.all(
    recent.map(async (pk) => {
      try {
        const lr = await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/linescore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        if (!lr.ok) throw new Error(`http_${lr.status}`);
        const data = await lr.json() as any;
        const ids = gameTeamMap.get(pk);
        if (ids) {
          if (data.teams?.home) data.teams.home.__teamId = ids.homeId;
          if (data.teams?.away) data.teams.away.__teamId = ids.awayId;
        }
        return data;
      } catch (e) {
        sourceErrors.push(`linescore:${pk}:${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    })
  );

  let totalEarlyOff = 0, totalF5 = 0, firstInnScored = 0, gamesAnalyzed = 0;
  const l7Runs: number[] = [];

  for (const ls of linescores) {
    if (!ls) continue;
    const isHome = ls.teams?.home?.__teamId === teamId || ls.teams?.home?.team?.id === teamId;
    const isAway = ls.teams?.away?.__teamId === teamId || ls.teams?.away?.team?.id === teamId;
    if (!isHome && !isAway) continue;
    const innings = ls.innings ?? [];
    if (innings.length < 3) continue;

    let earlyOffG = 0, f5G = 0;
    for (let i = 0; i < Math.min(5, innings.length); i++) {
      const inn = innings[i];
      const myRuns = isHome ? (inn.home?.runs ?? 0) : (inn.away?.runs ?? 0);
      if (i < 3) {
        earlyOffG += myRuns;
        if (i === 0 && myRuns > 0) firstInnScored++;
      }
      f5G += myRuns;
    }
    const fullGameRuns = isHome ? (ls.teams?.home?.runs ?? 0) : (ls.teams?.away?.runs ?? 0);
    totalEarlyOff += earlyOffG;
    totalF5 += f5G;
    gamesAnalyzed++;
    l7Runs.push(fullGameRuns);
  }

  if (gamesAnalyzed === 0) {
    sourceErrors.push("linescore:no_valid_games");
    return baseline();
  }

  const last7 = l7Runs.slice(-7);
  const l7Rpg = last7.length > 0 ? last7.reduce((a, b) => a + b, 0) / last7.length : LEAGUE.L7_RPG;
  const dataStatus: "VERIFIED" | "PARTIAL" = gamesAnalyzed >= 10 ? "VERIFIED" : "PARTIAL";

  return {
    gamesAnalyzed,
    earlyOff: Math.round((totalEarlyOff / gamesAnalyzed) * 100) / 100,
    f5Runs: Math.round((totalF5 / gamesAnalyzed) * 100) / 100,
    probFirstInn: Math.round((firstInnScored / gamesAnalyzed) * 100) / 100,
    l7Rpg: Math.round(l7Rpg * 100) / 100,
    dataStatus,
    asOfDate,
    windowStart,
    sourceErrors,
  };
}
'''

er = regex_once(
    ere,
    r'async function computeTeamEarlyMetrics\(teamId: number\) \{.*?\n\}\n\n// ─+\n// HELPER: xwOBA',
    new_ere_team_metrics + '\n// ──────────────────────────────────────────────────────────────────────────\n// HELPER: xwOBA',
    "replace ERE team metrics",
    flags=re.S,
)

er_path.write_text(ere, encoding="utf-8")


# ---------------------------------------------------------------------------
# server/mlb-tesi.ts
# ---------------------------------------------------------------------------
tesi_path = Path("server/mlb-tesi.ts")
tesi = tesi_path.read_text(encoding="utf-8")

tesi = replace_once(
    tesi,
    '''  gamesAnalyzed: number;\n\n  // Team metrics''',
    '''  gamesAnalyzed: number;\n  dataStatus: "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE";\n  asOfDate: string;\n  windowStart: string;\n  sourceErrors: string[];\n\n  // Team metrics''',
    "TESI result integrity fields",
)

tesi = replace_once(
    tesi,
    '''  opposingPitcherHand?: "R" | "L";\n}''',
    '''  opposingPitcherHand?: "R" | "L";\n  gameDate?: string;\n}''',
    "TESI input date",
)

tesi = replace_once(
    tesi,
    '''  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand } = input;\n\n  // ── 1. Team early stats''',
    '''  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand, gameDate } = input;\n  const asOfDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(gameDate || "")\n    ? String(gameDate)\n    : new Date().toISOString().slice(0, 10);\n  const season = Number(asOfDate.slice(0, 4));\n\n  // ── 1. Team early stats''',
    "TESI as-of date",
)

tesi = replace_once(tesi, 'computeTeamEarlyMetrics(teamId);', 'computeTeamEarlyMetrics(teamId, asOfDate);', "TESI metrics call")
tesi = replace_once(tesi, 'computeOpsVsHand(teamId, opposingPitcherHand);', 'computeOpsVsHand(teamId, opposingPitcherHand, season);', "TESI OPS season")
tesi = replace_once(tesi, 'computeLineupTop3(gamePk, teamId);', 'computeLineupTop3(gamePk, teamId, season);', "TESI lineup season")
tesi = replace_once(tesi, 'computePitcherEarlyMetrics(opposingPitcherId);', 'computePitcherEarlyMetrics(opposingPitcherId, season);', "TESI pitcher season")

tesi = replace_once(
    tesi,
    '''  const { signal, recommendation } = classifyTesi({\n    scoreOff, scoreDef, scoreLineup, scorePitcherVuln,\n    probFirstInn: teamMetrics.probFirstInn,\n  });''',
    '''  const { signal, recommendation } = teamMetrics.dataStatus === "VERIFIED"\n    ? classifyTesi({\n        scoreOff, scoreDef, scoreLineup, scorePitcherVuln,\n        probFirstInn: teamMetrics.probFirstInn,\n      })\n    : teamMetrics.dataStatus === "PARTIAL"\n      ? { signal: "PARTIAL_DATA", recommendation: "Muestra early limitada — usar solo como contexto; no autoriza NRFI/YRFI/F5" }\n      : { signal: "DATA_INCOMPLETE", recommendation: "No se validaron linescores suficientes — mercados early bloqueados" };''',
    "TESI fail closed signal",
)

tesi = replace_once(
    tesi,
    '''    gamesAnalyzed: teamMetrics.gamesAnalyzed,\n    earlyOff:''',
    '''    gamesAnalyzed: teamMetrics.gamesAnalyzed,\n    dataStatus: teamMetrics.dataStatus,\n    asOfDate: teamMetrics.asOfDate,\n    windowStart: teamMetrics.windowStart,\n    sourceErrors: teamMetrics.sourceErrors,\n    earlyOff:''',
    "TESI return integrity",
)

new_tesi_team_metrics = r'''async function computeTeamEarlyMetrics(teamId: number, asOfDate: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
    ? new Date(`${asOfDate}T12:00:00Z`)
    : new Date();
  const end = new Date(parsed);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const windowStart = fmt(start);
  const windowEnd = fmt(end);
  const sourceErrors: string[] = [];
  const baseline = () => ({
    gamesAnalyzed: 0,
    earlyOff: LEAGUE_BASELINE_EARLY,
    earlyDef: LEAGUE_BASELINE_EARLY,
    f5Runs: LEAGUE_BASELINE_F5,
    probFirstInn: 0.28,
    dataStatus: "DATA_INCOMPLETE" as const,
    asOfDate,
    windowStart,
    sourceErrors,
  });

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${windowStart}&endDate=${windowEnd}&gameType=R`;
  let j: any;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    if (!r.ok) throw new Error(`schedule_http_${r.status}`);
    j = await r.json();
  } catch (e) {
    sourceErrors.push(`schedule:${e instanceof Error ? e.message : String(e)}`);
    return baseline();
  }

  const gamePks: number[] = [];
  const gameTeamMap = new Map<number, { homeId: number; awayId: number }>();
  for (const dd of j.dates ?? []) {
    for (const g of dd.games ?? []) {
      if (g.status?.detailedState === "Final") {
        gamePks.push(g.gamePk);
        gameTeamMap.set(g.gamePk, {
          homeId: g.teams?.home?.team?.id,
          awayId: g.teams?.away?.team?.id,
        });
      }
    }
  }
  const recent = gamePks.slice(-30);
  if (recent.length === 0) {
    sourceErrors.push("schedule:no_final_games");
    return baseline();
  }

  const linescores = await Promise.all(
    recent.map(async (pk) => {
      try {
        const lr = await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/linescore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        if (!lr.ok) throw new Error(`http_${lr.status}`);
        const data = await lr.json() as any;
        const ids = gameTeamMap.get(pk);
        if (ids && data.teams) {
          if (data.teams.home) data.teams.home.__teamId = ids.homeId;
          if (data.teams.away) data.teams.away.__teamId = ids.awayId;
        }
        return data;
      } catch (e) {
        sourceErrors.push(`linescore:${pk}:${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    })
  );

  let totalEarlyOff = 0, totalEarlyDef = 0, totalF5 = 0;
  let firstInnScored = 0, gamesAnalyzed = 0;
  for (const ls of linescores) {
    if (!ls) continue;
    const isHome = ls.teams?.home?.__teamId === teamId;
    const isAway = ls.teams?.away?.__teamId === teamId;
    if (!isHome && !isAway) continue;
    const innings = ls.innings ?? [];
    if (innings.length < 3) continue;

    let earlyOffG = 0, earlyDefG = 0, f5G = 0;
    for (let i = 0; i < Math.min(5, innings.length); i++) {
      const inn = innings[i];
      const myRuns = isHome ? (inn.home?.runs ?? 0) : (inn.away?.runs ?? 0);
      if (i < 3) {
        const oppRuns = isHome ? (inn.away?.runs ?? 0) : (inn.home?.runs ?? 0);
        earlyOffG += myRuns;
        earlyDefG += oppRuns;
        if (i === 0 && myRuns > 0) firstInnScored++;
      }
      f5G += myRuns;
    }
    totalEarlyOff += earlyOffG;
    totalEarlyDef += earlyDefG;
    totalF5 += f5G;
    gamesAnalyzed++;
  }

  if (gamesAnalyzed === 0) {
    sourceErrors.push("linescore:no_valid_games");
    return baseline();
  }
  const dataStatus: "VERIFIED" | "PARTIAL" = gamesAnalyzed >= 10 ? "VERIFIED" : "PARTIAL";
  return {
    gamesAnalyzed,
    earlyOff: Math.round((totalEarlyOff / gamesAnalyzed) * 100) / 100,
    earlyDef: Math.round((totalEarlyDef / gamesAnalyzed) * 100) / 100,
    f5Runs: Math.round((totalF5 / gamesAnalyzed) * 100) / 100,
    probFirstInn: Math.round((firstInnScored / gamesAnalyzed) * 100) / 100,
    dataStatus,
    asOfDate,
    windowStart,
    sourceErrors,
  };
}
'''

tesi = regex_once(
    tesi,
    r'async function computeTeamEarlyMetrics\(teamId: number\) \{.*?\n\}\n\n// ─+\n// HELPER: OPS',
    new_tesi_team_metrics + '\n// ──────────────────────────────────────────────────────────────────────────\n// HELPER: OPS',
    "replace TESI team metrics",
    flags=re.S,
)

tesi = replace_once(tesi, 'async function computeOpsVsHand(teamId: number, hand: "R" | "L"): Promise<number | undefined> {', 'async function computeOpsVsHand(teamId: number, hand: "R" | "L", season: number): Promise<number | undefined> {', "TESI OPS signature")
tesi = replace_once(tesi, 'season=2026&stats=statSplits', 'season=${season}&stats=statSplits', "TESI OPS dynamic season")
tesi = replace_once(tesi, 'async function computeLineupTop3(gamePk: number, teamId: number)', 'async function computeLineupTop3(gamePk: number, teamId: number, season: number)', "TESI lineup signature")
tesi = replace_once(tesi, 'stats?stats=season&season=2026&group=hitting', 'stats?stats=season&season=${season}&group=hitting', "TESI lineup dynamic season")
tesi = replace_once(tesi, 'async function computePitcherEarlyMetrics(pitcherId: number) {', 'async function computePitcherEarlyMetrics(pitcherId: number, season: number) {', "TESI pitcher signature")
tesi = tesi.replace('season=2026&group=pitching', 'season=${season}&group=pitching')
tesi = tesi.replace('hfSea=2026%7C', 'hfSea=${season}%7C')

tesi_path.write_text(tesi, encoding="utf-8")


# ---------------------------------------------------------------------------
# server/mlb-early-markets.ts
# ---------------------------------------------------------------------------
em_path = Path("server/mlb-early-markets.ts")
em = em_path.read_text(encoding="utf-8")
em = replace_once(
    em,
    '''  warnings: string[];\n  // Recomendación final''',
    '''  warnings: string[];\n  dataIncomplete?: boolean;\n  // Recomendación final''',
    "early markets dataIncomplete type",
)

fail_closed = '''  const dataIncomplete = homeEre.dataStatus === "DATA_INCOMPLETE" || awayEre.dataStatus === "DATA_INCOMPLETE";\n  if (dataIncomplete) {\n    const warning = "DATA_INCOMPLETE: faltan linescores verificados; NRFI/YRFI/F5/Team Totals bloqueados";\n    return {\n      f5ProbHome: 0.5,\n      f5ProbAway: 0.5,\n      f5RecommendedSide: "PASS",\n      f5TotalRunsEstimated: LEAGUE_F5_TOTAL,\n      f5TotalSide: "PASS",\n      probAnyRun1stInn: 0.5,\n      probNoRun1stInn: 0.5,\n      nrfiYrfiRec: "PASS",\n      inning1: { homeProb: 0.5, awayProb: 0.5, side: "PASS" },\n      inning2: { homeProb: 0.5, awayProb: 0.5, side: "PASS" },\n      inning3: { homeProb: 0.5, awayProb: 0.5, side: "PASS" },\n      teamTotalOver15F5: { homeProb: 0.5, awayProb: 0.5, side: "PASS" },\n      teamTotalUnder25F5: { homeProb: 0.5, awayProb: 0.5, side: "PASS" },\n      confidence: "LOW",\n      warnings: [warning, ...homeEre.warnings, ...awayEre.warnings],\n      dataIncomplete: true,\n      finalRecommendation: {\n        market: "PASS",\n        side: "PASS",\n        action: "PASS",\n        reason: "Datos early incompletos — no apostar hasta recuperar las fuentes",\n      },\n      alternativePicks: [],\n    };\n  }\n'''

em = replace_once(
    em,
    '''export function computeEarlyMarkets(input: EarlyMarketsInput): EarlyMarketsResult {\n  const { homeEre, awayEre } = input;\n  const warnings = [...homeEre.warnings, ...awayEre.warnings];''',
    '''export function computeEarlyMarkets(input: EarlyMarketsInput): EarlyMarketsResult {\n  const { homeEre, awayEre } = input;\n''' + fail_closed + '''  const warnings = [...homeEre.warnings, ...awayEre.warnings];''',
    "early markets fail closed",
)
em_path.write_text(em, encoding="utf-8")


# ---------------------------------------------------------------------------
# server/routes.ts
# ---------------------------------------------------------------------------
routes_path = Path("server/routes.ts")
routes = routes_path.read_text(encoding="utf-8")
routes = replace_once(
    routes,
    '''      const currentSeason = new Date().getFullYear();\n      // FASE 1''',
    '''      const currentSeason = new Date().getFullYear();\n      const analysisDateIso = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.body?.gameDate || ""))\n        ? String(req.body.gameDate)\n        : new Date().toISOString().slice(0, 10);\n      // FASE 1''',
    "routes early analysis date",
)
routes = routes.replace('windDirOut: home.windDirOut,\n        }),', 'windDirOut: home.windDirOut, gameDate: analysisDateIso,\n        }),', 1)
routes = routes.replace('windDirOut: away.windDirOut,\n        }),', 'windDirOut: away.windDirOut, gameDate: analysisDateIso,\n        }),', 1)

routes = replace_once(
    routes,
    '''      const windDirOut = String(req.query.windOut || "false").toLowerCase() === "true";\n\n      const data = await computeMlbEre({''',
    '''      const windDirOut = String(req.query.windOut || "false").toLowerCase() === "true";\n      const gameDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.query.date || ""))\n        ? String(req.query.date)\n        : new Date().toISOString().slice(0, 10);\n\n      const data = await computeMlbEre({''',
    "routes ERE date query",
)
routes = replace_once(
    routes,
    '''        windDirOut,\n      });''',
    '''        windDirOut,\n        gameDate,\n      });''',
    "routes ERE date pass",
)

routes = replace_once(
    routes,
    '''      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;\n\n      const data = await computeMlbTesi({''',
    '''      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;\n      const gameDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.query.date || ""))\n        ? String(req.query.date)\n        : new Date().toISOString().slice(0, 10);\n\n      const data = await computeMlbTesi({''',
    "routes TESI date query",
)
routes = replace_once(
    routes,
    '''        opposingPitcherHand,\n      });\n      res.json({ success: true, data });''',
    '''        opposingPitcherHand,\n        gameDate,\n      });\n      res.json({ success: true, data });''',
    "routes TESI date pass",
)
routes_path.write_text(routes, encoding="utf-8")


# ---------------------------------------------------------------------------
# frontend/client/src/components/mlb-tesi-card.tsx
# ---------------------------------------------------------------------------
tc_path = Path("frontend/client/src/components/mlb-tesi-card.tsx")
tc = tc_path.read_text(encoding="utf-8")
tc = replace_once(
    tc,
    '''  gamesAnalyzed: number;\n  earlyOff:''',
    '''  gamesAnalyzed: number;\n  dataStatus: "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE";\n  asOfDate: string;\n  windowStart: string;\n  sourceErrors: string[];\n  earlyOff:''',
    "TESI UI integrity type",
)
tc = replace_once(tc, '''  awayPitcherHand?: "R" | "L";\n}''', '''  awayPitcherHand?: "R" | "L";\n  gameDate?: string;\n}''', "TESI UI date prop")
tc = replace_once(
    tc,
    '''    <div className="space-y-2 p-3 rounded-lg bg-slate-800/40">\n      <div className="flex items-center justify-between">''',
    '''    <div className="space-y-2 p-3 rounded-lg bg-slate-800/40">\n      {data.dataStatus !== "VERIFIED" && (\n        <div className={`rounded border p-2 text-[11px] ${data.dataStatus === "DATA_INCOMPLETE" ? "border-red-500/50 bg-red-500/10 text-red-300" : "border-yellow-500/50 bg-yellow-500/10 text-yellow-300"}`}>\n          {data.dataStatus === "DATA_INCOMPLETE"\n            ? "Datos incompletos: no se autoriza señal NRFI/YRFI/F5."\n            : `Muestra parcial (${data.gamesAnalyzed} juegos): usar solo como contexto.`}\n        </div>\n      )}\n      <div className="flex items-center justify-between">''',
    "TESI UI warning",
)
tc = replace_once(
    tc,
    '''  gamePk, homePitcherId, homePitcherHand, awayPitcherId, awayPitcherHand,\n}: Props) {''',
    '''  gamePk, homePitcherId, homePitcherHand, awayPitcherId, awayPitcherHand, gameDate,\n}: Props) {''',
    "TESI UI destructure date",
)
tc = tc.replace('tesi-home-${homeTeamId}-${gamePk}-${awayPitcherId}-${awayPitcherHand}', 'tesi-home-${homeTeamId}-${gamePk}-${awayPitcherId}-${awayPitcherHand}-${gameDate}')
tc = tc.replace('tesi-away-${awayTeamId}-${gamePk}-${homePitcherId}-${homePitcherHand}', 'tesi-away-${awayTeamId}-${gamePk}-${homePitcherId}-${homePitcherHand}-${gameDate}')
tc = tc.replace('if (awayPitcherHand) qs.set("hand", awayPitcherHand);', 'if (awayPitcherHand) qs.set("hand", awayPitcherHand);\n      if (gameDate) qs.set("date", gameDate);', 1)
tc = tc.replace('if (homePitcherHand) qs.set("hand", homePitcherHand);', 'if (homePitcherHand) qs.set("hand", homePitcherHand);\n      if (gameDate) qs.set("date", gameDate);', 1)
tc = replace_once(
    tc,
    '''  if (homeData && awayData) {\n    const diff = homeData.netTesi - awayData.netTesi;''',
    '''  if (homeData && awayData && homeData.dataStatus === "VERIFIED" && awayData.dataStatus === "VERIFIED") {\n    const diff = homeData.netTesi - awayData.netTesi;''',
    "TESI combined edge verified only",
)
tc_path.write_text(tc, encoding="utf-8")


# ---------------------------------------------------------------------------
# frontend/client/src/components/mlb-ere-card.tsx
# ---------------------------------------------------------------------------
ec_path = Path("frontend/client/src/components/mlb-ere-card.tsx")
ec = ec_path.read_text(encoding="utf-8")
ec = replace_once(
    ec,
    '''  teamName: string;\n  ereScore:''',
    '''  teamName: string;\n  dataStatus: "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE";\n  asOfDate: string;\n  windowStart: string;\n  sourceErrors: string[];\n  ereScore:''',
    "ERE UI integrity type",
)
ec = replace_once(ec, '''  windOut?: boolean;\n}''', '''  windOut?: boolean;\n  gameDate?: string;\n}''', "ERE UI date prop")
ec = replace_once(
    ec,
    '''    <div className="space-y-3 p-3 rounded-lg bg-slate-800/40 border border-slate-700">\n      <div className="flex items-center justify-between">''',
    '''    <div className="space-y-3 p-3 rounded-lg bg-slate-800/40 border border-slate-700">\n      {data.dataStatus !== "VERIFIED" && (\n        <div className={`rounded border p-2 text-[11px] ${data.dataStatus === "DATA_INCOMPLETE" ? "border-red-500/50 bg-red-500/10 text-red-300" : "border-yellow-500/50 bg-yellow-500/10 text-yellow-300"}`}>\n          {data.dataStatus === "DATA_INCOMPLETE"\n            ? "DATA_INCOMPLETE: mercados early bloqueados; los valores neutrales son priors, no estadísticas verificadas."\n            : `Cobertura parcial (${data.asOfDate}; ventana desde ${data.windowStart}).`}\n        </div>\n      )}\n      <div className="flex items-center justify-between">''',
    "ERE UI warning",
)
ec = replace_once(
    ec,
    '''  venue, tempF, windMph, windOut,\n}: Props) {''',
    '''  venue, tempF, windMph, windOut, gameDate,\n}: Props) {''',
    "ERE UI destructure date",
)
ec = ec.replace('${venue}-${tempF}`]', '${venue}-${tempF}-${gameDate}`]')
ec = ec.replace('if (windOut) qs.set("windOut", "true");', 'if (windOut) qs.set("windOut", "true");\n      if (gameDate) qs.set("date", gameDate);', 2)
ec = replace_once(
    ec,
    '''  if (homeData && awayData) {\n    gameComposite = (homeData.ereScore + awayData.ereScore) / 2;''',
    '''  if (homeData && awayData && homeData.dataStatus !== "DATA_INCOMPLETE" && awayData.dataStatus !== "DATA_INCOMPLETE") {\n    gameComposite = (homeData.ereScore + awayData.ereScore) / 2;''',
    "ERE game composite integrity",
)
ec_path.write_text(ec, encoding="utf-8")


# ---------------------------------------------------------------------------
# frontend/client/src/components/mlb-early-markets-card.tsx
# ---------------------------------------------------------------------------
mc_path = Path("frontend/client/src/components/mlb-early-markets-card.tsx")
mc = mc_path.read_text(encoding="utf-8")
mc = replace_once(mc, '''  warnings: string[];\n  // Team Total''', '''  warnings: string[];\n  dataIncomplete?: boolean;\n  // Team Total''', "early UI dataIncomplete type")
mc = replace_once(mc, '''  yrfiOdds?: number;\n}''', '''  yrfiOdds?: number;\n  gameDate?: string;\n}''', "early UI date prop")
mc = replace_once(
    mc,
    '''      props.nrfiOdds, props.yrfiOdds,\n    ],''',
    '''      props.nrfiOdds, props.yrfiOdds, props.gameDate,\n    ],''',
    "early UI date query key",
)
mc = replace_once(
    mc,
    '''        lines: {''',
    '''        gameDate: props.gameDate,\n        lines: {''',
    "early UI request date",
)
mc = replace_once(
    mc,
    '''        {m && (\n          <>''',
    '''        {m?.dataIncomplete && (\n          <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">\n            <div className="font-bold">Datos early incompletos — no apostar</div>\n            <div className="mt-1 text-xs">NRFI/YRFI, F5 e innings quedaron bloqueados hasta recuperar linescores verificados.</div>\n          </div>\n        )}\n\n        {m && !m.dataIncomplete && (\n          <>''',
    "early UI fail closed display",
)
mc_path.write_text(mc, encoding="utf-8")


# ---------------------------------------------------------------------------
# frontend/client/src/pages/mlb-predictor.tsx
# ---------------------------------------------------------------------------
page_path = Path("frontend/client/src/pages/mlb-predictor.tsx")
page = page_path.read_text(encoding="utf-8")
for component in ("MlbTesiCard", "MlbEreCard", "MlbEarlyMarketsCard"):
    if f"<{component}" not in page:
        raise RuntimeError(f"{component} invocation not found")
    if re.search(rf'<{component}\b[^>]*\bgameDate=\{{selectedDate\}}', page, flags=re.S):
        continue
    page, count = re.subn(rf'<{component}\b', f'<{component} gameDate={{selectedDate}}', page, count=1)
    if count != 1:
        raise RuntimeError(f"could not add selectedDate to {component}")
page_path.write_text(page, encoding="utf-8")

print("MLB P0 data-integrity migration applied")
