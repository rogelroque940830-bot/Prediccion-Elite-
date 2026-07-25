from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# -----------------------------------------------------------------------------
# Backend: dynamic season + honest goalie status
# -----------------------------------------------------------------------------
routes_path = Path("server/routes.ts")
routes = routes_path.read_text(encoding="utf-8")
start_marker = "  // NHL ROUTES\n"
end_marker = "  // ── PICKS PERSISTENCE"
start = routes.index(start_marker)
end = routes.index(end_marker, start)
prefix, nhl, suffix = routes[:start], routes[start:end], routes[end:]

nhl = replace_once(
    nhl,
    "  // NHL ROUTES\n  // ════════════════════════════════════════════════════════════════════════════\n\n  app.get(\"/api/nhl/all\", async (req, res) => {",
    "  // NHL ROUTES\n  // ════════════════════════════════════════════════════════════════════════════\n\n  function nhlSeasonContext(dateIso: string): { seasonId: string; moneyPuckYear: string } {\n    const parsed = /^\\d{4}-\\d{2}-\\d{2}$/.test(dateIso)\n      ? new Date(`${dateIso}T12:00:00Z`)\n      : new Date();\n    const year = parsed.getUTCFullYear();\n    const month = parsed.getUTCMonth() + 1;\n    // NHL/MoneyPuck season folders use the year in which the season starts.\n    // During the summer offseason we keep the completed season until August.\n    const startYear = month >= 8 ? year : year - 1;\n    return { seasonId: `${startYear}${startYear + 1}`, moneyPuckYear: String(startYear) };\n  }\n\n  app.get(\"/api/nhl/all\", async (req, res) => {",
    "insert dynamic NHL season helper",
)

nhl = replace_once(
    nhl,
    "      const dateParam = (req.query.date as string) || todayISO();\n      const cacheKey = `nhl-all-v9-${dateParam}`;",
    "      const dateParam = (req.query.date as string) || todayISO();\n      const { seasonId: nhlSeasonId, moneyPuckYear: nhlMoneyPuckYear } = nhlSeasonContext(dateParam);\n      const cacheKey = `nhl-all-v10-${nhlSeasonId}-${dateParam}`;",
    "dynamic NHL cache key",
)

replacements = {
    'fetch("https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=20252026")':
        'fetch(`https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${nhlSeasonId}`)',
    'fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv")':
        'fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/teams.csv`)',
    'fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/goalies.csv")':
        'fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/goalies.csv`)',
    'fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/skaters.csv")':
        'fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/skaters.csv`)',
    'fetch(`https://api-web.nhle.com/v1/player/${starterPlayerId}/game-log/20252026/2`)':
        'fetch(`https://api-web.nhle.com/v1/player/${starterPlayerId}/game-log/${nhlSeasonId}/2`)',
    'fetch(`https://api-web.nhle.com/v1/club-stats/${tricode}/20252026/2`)':
        'fetch(`https://api-web.nhle.com/v1/club-stats/${tricode}/${nhlSeasonId}/2`)',
    'fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/20252026`)':
        'fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/${nhlSeasonId}`)',
    'fetch(`https://api-web.nhle.com/v1/club-schedule-season/${hA}/20252026`)':
        'fetch(`https://api-web.nhle.com/v1/club-schedule-season/${hA}/${nhlSeasonId}`)',
}
for old, new in replacements.items():
    if old not in nhl:
        raise RuntimeError(f"missing NHL season replacement: {old}")
    nhl = nhl.replace(old, new)

nhl = replace_once(
    nhl,
    "        const dfGoalieMap: Record<string, { name: string; svPct: number; gaa: number; wins: number; losses: number; otl: number; status: string }> = {};",
    "        const dfGoalieMap: Record<string, { name: string; svPct?: number; gaa?: number; wins: number; losses: number; otl: number; status: string }> = {};",
    "optional DailyFaceoff stats",
)
nhl = nhl.replace(
    "svPct: dg.homeGoalieSavePercentage ? Math.round(dg.homeGoalieSavePercentage * 1000) / 1000 : 0.900,",
    "svPct: Number.isFinite(Number(dg.homeGoalieSavePercentage)) ? Math.round(Number(dg.homeGoalieSavePercentage) * 1000) / 1000 : undefined,",
)
nhl = nhl.replace(
    "gaa: dg.homeGoalieGoalsAgainstAvg ? Math.round(dg.homeGoalieGoalsAgainstAvg * 100) / 100 : 3.00,",
    "gaa: Number.isFinite(Number(dg.homeGoalieGoalsAgainstAvg)) ? Math.round(Number(dg.homeGoalieGoalsAgainstAvg) * 100) / 100 : undefined,",
)
nhl = nhl.replace(
    "svPct: dg.awayGoalieSavePercentage ? Math.round(dg.awayGoalieSavePercentage * 1000) / 1000 : 0.900,",
    "svPct: Number.isFinite(Number(dg.awayGoalieSavePercentage)) ? Math.round(Number(dg.awayGoalieSavePercentage) * 1000) / 1000 : undefined,",
)
nhl = nhl.replace(
    "gaa: dg.awayGoalieGoalsAgainstAvg ? Math.round(dg.awayGoalieGoalsAgainstAvg * 100) / 100 : 3.00,",
    "gaa: Number.isFinite(Number(dg.awayGoalieGoalsAgainstAvg)) ? Math.round(Number(dg.awayGoalieGoalsAgainstAvg) * 100) / 100 : undefined,",
)

nhl = replace_once(
    nhl,
    '''          let starterName = dfGoalie?.name || "";
          let starterSvPct = dfGoalie?.svPct || 0.900;
          let starterGaa = dfGoalie?.gaa || 3.00;
          let starterRecord = dfGoalie ? `${dfGoalie.wins}-${dfGoalie.losses}-${dfGoalie.otl}` : "0-0";
          let starterGP = 0;
          let starterPlayerId: number | null = null;
          let confirmStatus = dfGoalie?.status || "Unknown";''',
    '''          let starterName = dfGoalie?.name || "";
          let starterSvPct: number | undefined = dfGoalie?.svPct;
          let starterGaa: number | undefined = dfGoalie?.gaa;
          let starterRecord = dfGoalie ? `${dfGoalie.wins}-${dfGoalie.losses}-${dfGoalie.otl}` : "";
          let starterGP = 0;
          let starterPlayerId: number | null = null;
          let confirmStatus = dfGoalie?.status || "UNCONFIRMED";''',
    "remove neutral goalie defaults",
)

nhl = replace_once(
    nhl,
    '''          } else if (!dfGoalie && nhlGoalies.length > 0) {
            // Fallback: pick goalie with most GP from NHL data
            const best = nhlGoalies.reduce((a, b) => a.gp > b.gp ? a : b);
            starterName = best.name;
            starterSvPct = best.svPct;
            starterGaa = best.gaa;
            starterRecord = best.record;
            starterGP = best.gp;
            starterPlayerId = best.playerId;
            confirmStatus = "Fallback";
          }''',
    '''          } else if (!dfGoalie && nhlGoalies.length > 0) {
            // NHL goalieComparison contains team leaders/candidates, not a confirmed starter.
            // Keep them only in goalieOptions; never promote the highest-GP goalie automatically.
            confirmStatus = "UNCONFIRMED";
          }''',
    "remove highest-GP goalie fallback",
)

nhl = replace_once(
    nhl,
    '''          goalieMap[abbr] = {
            name: starterName,
            savePct: starterSvPct,
            gaa: starterGaa,
            record: starterRecord,
            gamesPlayed: starterGP,
            recentGAA,
            recentSvPct,
            last5Record,
            confirmStatus,
            gsax,
          };''',
    '''          if (starterName && Number.isFinite(starterSvPct) && Number.isFinite(starterGaa)) {
            const normalizedStatus = String(confirmStatus || "UNCONFIRMED").toUpperCase();
            goalieMap[abbr] = {
              name: starterName,
              savePct: starterSvPct,
              gaa: starterGaa,
              record: starterRecord,
              gamesPlayed: starterGP,
              recentGAA,
              recentSvPct,
              last5Record,
              confirmStatus,
              confirmed: normalizedStatus.includes("CONFIRMED") && !normalizedStatus.includes("UNCONFIRMED"),
              source: "dailyfaceoff",
              gsax,
            };
          }''',
    "only expose usable probable goalie",
)

nhl = replace_once(
    nhl,
    "      res.json({ success: true, games: data, date: dateParam });",
    "      res.json({ success: true, games: data, date: dateParam, seasonId: nhlSeasonId, asOf: new Date().toISOString() });",
    "NHL response metadata",
)

routes = prefix + nhl + suffix

# NHL gamecenter leaders are candidates, not official confirmed starters.
routes = replace_once(
    routes,
    '''      const confirmed = !!(homeStarter && awayStarter);
      const minutesUntilGame = data?.startTimeUTC ? (new Date(data.startTimeUTC).getTime() - Date.now()) / 60000 : null;''',
    '''      // goalieComparison exposes statistical leaders/candidates. It does not prove who starts.
      const confirmed = false;
      const minutesUntilGame = data?.startTimeUTC ? (new Date(data.startTimeUTC).getTime() - Date.now()) / 60000 : null;''',
    "do not confirm gamecenter leaders",
)
routes = replace_once(
    routes,
    '''        away: awayStarter ? { name: name(awayStarter), svPct: awayStarter.savePctg, gaa: awayStarter.goalsAgainstAverage } : null,
      });''',
    '''        away: awayStarter ? { name: name(awayStarter), svPct: awayStarter.savePctg, gaa: awayStarter.goalsAgainstAverage } : null,
        source: "nhl-gamecenter-candidates",
        note: "Goalie comparison lists candidates/leaders; verify the official starter before betting.",
      });''',
    "goalie candidate metadata",
)
routes_path.write_text(routes, encoding="utf-8")


# -----------------------------------------------------------------------------
# Manual route: derive the season from the requested date, not the wall clock.
# -----------------------------------------------------------------------------
manual_path = Path("server/nhl-manual-routes.ts")
manual = manual_path.read_text(encoding="utf-8")
manual = replace_once(
    manual,
    "function seasonContext(): { seasonId: string; moneyPuckYear: string } {\n  const now = new Date();",
    "function seasonContext(targetIso?: string): { seasonId: string; moneyPuckYear: string } {\n  const now = targetIso && /^\\d{4}-\\d{2}-\\d{2}$/.test(targetIso)\n    ? new Date(`${targetIso}T12:00:00Z`)\n    : new Date();",
    "manual route date-aware season",
)
manual = replace_once(
    manual,
    "      const { seasonId, moneyPuckYear } = seasonContext();",
    "      const { seasonId, moneyPuckYear } = seasonContext(date);",
    "manual route season invocation",
)
manual_path.write_text(manual, encoding="utf-8")


# -----------------------------------------------------------------------------
# Frontend: explicit confirmation state and no silent numeric priors.
# -----------------------------------------------------------------------------
front_path = Path("frontend/client/src/pages/nhl-predictor.tsx")
front = front_path.read_text(encoding="utf-8")

front = replace_once(
    front,
    '''  const [homeManualStatus, setHomeManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const [awayManualStatus, setAwayManualStatus] = useState<"idle" | "verified" | "manual">("idle");''',
    '''  const [homeManualStatus, setHomeManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const [awayManualStatus, setAwayManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const [homeGoalieConfirmed, setHomeGoalieConfirmed] = useState(false);
  const [awayGoalieConfirmed, setAwayGoalieConfirmed] = useState(false);''',
    "goalie confirmation state",
)

front = replace_once(
    front,
    '''    setGoalieData(null);
    setH2hLabel("");''',
    '''    setGoalieData(null);
    if (isHome) setHomeGoalieConfirmed(false); else setAwayGoalieConfirmed(false);
    setH2hLabel("");''',
    "clear confirmation on manual team change",
)

front = replace_once(
    front,
    '''    // Home goalie
    const hg = game.homeGoalie;
    if (hg) {
      setHomeGoalieName(hg.name || "");
      setHomeSavePct(String(hg.savePct));
      setHomeGAA(String(hg.gaa));
      setHomeRecord(hg.record);
      if (hg.recentGAA !== undefined) setHomeRecentGAA(String(hg.recentGAA));
      if (hg.recentSvPct !== undefined) setHomeRecentSvPct(String(hg.recentSvPct));
    }''',
    '''    // Home goalie — only populate a named goalie with real numeric stats.
    const hg = game.homeGoalie;
    const homeConfirmed = hg?.confirmed === true;
    setHomeGoalieConfirmed(homeConfirmed);
    if (hg?.name && Number.isFinite(Number(hg.savePct)) && Number.isFinite(Number(hg.gaa))) {
      setHomeGoalieName(hg.name);
      setHomeSavePct(String(hg.savePct));
      setHomeGAA(String(hg.gaa));
      setHomeRecord(hg.record || "");
      if (hg.recentGAA !== undefined) setHomeRecentGAA(String(hg.recentGAA));
      if (hg.recentSvPct !== undefined) setHomeRecentSvPct(String(hg.recentSvPct));
    } else {
      setHomeGoalieName(""); setHomeSavePct(""); setHomeGAA(""); setHomeRecord("");
    }''',
    "safe home goalie autofill",
)

front = replace_once(
    front,
    '''    // Away goalie
    const ag = game.awayGoalie;
    if (ag) {
      setAwayGoalieName(ag.name || "");
      setAwaySavePct(String(ag.savePct));
      setAwayGAA(String(ag.gaa));
      setAwayRecord(ag.record);
      if (ag.recentGAA !== undefined) setAwayRecentGAA(String(ag.recentGAA));
      if (ag.recentSvPct !== undefined) setAwayRecentSvPct(String(ag.recentSvPct));
    }''',
    '''    // Away goalie — only populate a named goalie with real numeric stats.
    const ag = game.awayGoalie;
    const awayConfirmed = ag?.confirmed === true;
    setAwayGoalieConfirmed(awayConfirmed);
    if (ag?.name && Number.isFinite(Number(ag.savePct)) && Number.isFinite(Number(ag.gaa))) {
      setAwayGoalieName(ag.name);
      setAwaySavePct(String(ag.savePct));
      setAwayGAA(String(ag.gaa));
      setAwayRecord(ag.record || "");
      if (ag.recentGAA !== undefined) setAwayRecentGAA(String(ag.recentGAA));
      if (ag.recentSvPct !== undefined) setAwayRecentSvPct(String(ag.recentSvPct));
    } else {
      setAwayGoalieName(""); setAwaySavePct(""); setAwayGAA(""); setAwayRecord("");
    }''',
    "safe away goalie autofill",
)

front = replace_once(
    front,
    '''    const setGoalieName = isHome ? setHomeGoalieName : setAwayGoalieName;

    // Recent form / SOS''',
    '''    const setGoalieName = isHome ? setHomeGoalieName : setAwayGoalieName;
    const goalieConfirmed = isHome ? homeGoalieConfirmed : awayGoalieConfirmed;
    const setGoalieConfirmed = isHome ? setHomeGoalieConfirmed : setAwayGoalieConfirmed;

    // Recent form / SOS''',
    "team card confirmation helpers",
)

front = replace_once(
    front,
    '''                onChange={(e) => setGoalieName(e.target.value)}''',
    '''                onChange={(e) => { setGoalieName(e.target.value); setGoalieConfirmed(false); }}''',
    "clear confirmation when goalie name edited",
)

front = replace_once(
    front,
    '''                        setGoalieName(opt.name);
                        setSavePct(String(opt.svPct));''',
    '''                        setGoalieName(opt.name);
                        setGoalieConfirmed(false);
                        setSavePct(String(opt.svPct));''',
    "clear confirmation when goalie option changed",
)

front = replace_once(
    front,
    '''            <div className="grid grid-cols-2 gap-3">
              {numInput("Save% (ej: 0.910)", savePct, setSavePct, `input-${side}-savepct`, "decimal", "0.910")}''',
    '''            <div className="flex items-center gap-2 rounded-md border border-cyan-500/20 bg-slate-950/30 p-2">
              <Switch
                checked={goalieConfirmed}
                onCheckedChange={setGoalieConfirmed}
                data-testid={`switch-${side}-goalie-confirmed`}
              />
              <div>
                <Label className="text-xs text-cyan-200">Confirmé este portero en una fuente confiable</Label>
                <p className="text-[10px] text-muted-foreground">Sin esta confirmación, cualquier señal BET se degrada a LEAN.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Save% (ej: 0.910)", savePct, setSavePct, `input-${side}-savepct`, "decimal", "0.910")}''',
    "goalie confirmation control",
)

# Required values were validated above; use them directly instead of league-average fallbacks.
required_replacements = {
    "savesPct: parseFloat(homeSavePct) || 0.910": "savesPct: Number(homeSavePct)",
    "gaa: parseFloat(homeGAA) || 2.80": "gaa: Number(homeGAA)",
    "savesPct: parseFloat(awaySavePct) || 0.910": "savesPct: Number(awaySavePct)",
    "gaa: parseFloat(awayGAA) || 2.80": "gaa: Number(awayGAA)",
    "goalsFor: parseFloat(homeGF) || 3.2": "goalsFor: Number(homeGF)",
    "goalsAgainst: parseFloat(homeGA) || 2.9": "goalsAgainst: Number(homeGA)",
    "ppPct: parseFloat(homePP) || 22": "ppPct: Number(homePP)",
    "pkPct: parseFloat(homePK) || 80": "pkPct: Number(homePK)",
    "corsi: parseFloat(homeCorsi) || 51": "corsi: Number(homeCorsi)",
    "shotsFor: parseFloat(homeShotsFor) || 32": "shotsFor: Number(homeShotsFor)",
    "shotsAgainst: parseFloat(homeShotsAgainst) || 29": "shotsAgainst: Number(homeShotsAgainst)",
    "winRate: parseFloat(homeWinRate10) || 0.6": "winRate: Number(homeWinRate10)",
    "daysRest: parseInt(homeDaysRest) || 2": "daysRest: Number(homeDaysRest)",
    "goalsFor: parseFloat(awayGF) || 3.2": "goalsFor: Number(awayGF)",
    "goalsAgainst: parseFloat(awayGA) || 2.9": "goalsAgainst: Number(awayGA)",
    "ppPct: parseFloat(awayPP) || 22": "ppPct: Number(awayPP)",
    "pkPct: parseFloat(awayPK) || 80": "pkPct: Number(awayPK)",
    "corsi: parseFloat(awayCorsi) || 49": "corsi: Number(awayCorsi)",
    "shotsFor: parseFloat(awayShotsFor) || 30": "shotsFor: Number(awayShotsFor)",
    "shotsAgainst: parseFloat(awayShotsAgainst) || 31": "shotsAgainst: Number(awayShotsAgainst)",
    "winRate: parseFloat(awayWinRate10) || 0.5": "winRate: Number(awayWinRate10)",
    "daysRest: parseInt(awayDaysRest) || 2": "daysRest: Number(awayDaysRest)",
}
for old, new in required_replacements.items():
    if old not in front:
        raise RuntimeError(f"missing frontend required-value replacement: {old}")
    front = front.replace(old, new, 1)

front = replace_once(
    front,
    '''    const factorNotes: string[] = [];
    let goalieUnconfirmed = false;
    if (goalieData) {
      const probPre = homeProb;
      const adj = applyConfirmedGoalieAdjustment(
        homeProb, goalieData.home, goalieData.away, goalieData.confirmed
      );
      homeProb = adj.adjustedProb;
      if (!goalieData.confirmed) {
        goalieUnconfirmed = true;
        factorNotes.push("⚠️ Goalie sin confirmar — BET bloqueado");
      } else {
        const delta = (homeProb - probPre) * 100;
        if (Math.abs(delta) >= 0.2) {
          factorNotes.push(`Goalies ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp`);
        } else {
          factorNotes.push("Goalies confirmados (impacto mínimo)");
        }
      }
    }''',
    '''    const factorNotes: string[] = [];
    const goaliesConfirmed = goalieData?.confirmed === true || (homeGoalieConfirmed && awayGoalieConfirmed);
    const goalieUnconfirmed = !goaliesConfirmed;
    if (goalieData?.confirmed) {
      const probPre = homeProb;
      const adj = applyConfirmedGoalieAdjustment(
        homeProb, goalieData.home, goalieData.away, true
      );
      homeProb = adj.adjustedProb;
      const delta = (homeProb - probPre) * 100;
      factorNotes.push(Math.abs(delta) >= 0.2
        ? `Goalies ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp`
        : "Goalies confirmados (impacto mínimo)");
    }
    if (goalieUnconfirmed) factorNotes.push("⚠️ Porteros sin confirmar — todas las señales BET quedan bloqueadas");''',
    "strict goalie confirmation logic",
)

front = replace_once(
    front,
    '''    const puckLineNum = parseFloat(puckLine) || -1.5;
    const puckLineResult = evaluatePuckLine(homeProb, puckLineNum);

    const ouLineNum = parseFloat(ouLine) || 6.0;
    const totalResult = nhlEvaluateTotal(estimatedTotal, ouLineNum);''',
    '''    const puckLineNum = parseFloat(puckLine) || -1.5;
    let puckLineResult = evaluatePuckLine(homeProb, puckLineNum);

    const ouLineNum = parseFloat(ouLine) || 6.0;
    let totalResult = nhlEvaluateTotal(estimatedTotal, ouLineNum);
    if (goalieUnconfirmed) {
      if (puckLineResult.signal === "BET") puckLineResult = { ...puckLineResult, signal: "LEAN" };
      if (totalResult.signal === "BET") totalResult = { ...totalResult, signal: "LEAN" };
    }''',
    "downgrade puck line and total",
)

front = replace_once(
    front,
    "    const safePlay = nhlFindSafePlay(home, away, ctx, homeProb, poisson, ouLineNum);",
    "    const safePlay = goalieUnconfirmed ? null : nhlFindSafePlay(home, away, ctx, homeProb, poisson, ouLineNum);",
    "block safe play without confirmed goalies",
)

front = replace_once(
    front,
    '''    goalieData,
  ]);''',
    '''    goalieData,
    homeGoalieConfirmed, awayGoalieConfirmed,
  ]);''',
    "confirmation dependencies",
)

front = replace_once(
    front,
    '''          {selNHLGame && <NHLGoalieCard gameId={selNHLGame} onData={(d) => setGoalieData({ confirmed: d.confirmed, home: d.home || null, away: d.away || null })} />}''',
    '''          {selNHLGame && <NHLGoalieCard gameId={selNHLGame} onData={(d) => {
            setGoalieData({ confirmed: d.confirmed, home: d.home || null, away: d.away || null });
            if (d.confirmed) { setHomeGoalieConfirmed(true); setAwayGoalieConfirmed(true); }
          }} />}''',
    "propagate official confirmation",
)

front_path.write_text(front, encoding="utf-8")
print("NHL P0 hardening applied")
