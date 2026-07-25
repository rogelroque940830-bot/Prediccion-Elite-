from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# ERE: PARTIAL is informational only, not market-authorized.
ere_path = Path("server/mlb-ere.ts")
ere = ere_path.read_text(encoding="utf-8")
ere = replace_once(
    ere,
    '''  const dataIncomplete = teamMetrics.dataStatus === "DATA_INCOMPLETE";
  const classified = dataIncomplete
    ? { category: "NEUTRAL" as EreResult["category"], marketSuggestions: [] as string[] }
    : classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);''',
    '''  const dataUnverified = teamMetrics.dataStatus !== "VERIFIED";
  const classified = dataUnverified
    ? { category: "NEUTRAL" as EreResult["category"], marketSuggestions: [] as string[] }
    : classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);''',
    "ERE partial fail-closed",
)
ere_path.write_text(ere, encoding="utf-8")


# Early markets: any non-VERIFIED side blocks all early betting recommendations.
em_path = Path("server/mlb-early-markets.ts")
em = em_path.read_text(encoding="utf-8")
em = replace_once(
    em,
    '''  const dataIncomplete = homeEre.dataStatus === "DATA_INCOMPLETE" || awayEre.dataStatus === "DATA_INCOMPLETE";
  if (dataIncomplete) {
    const warning = "DATA_INCOMPLETE: faltan linescores verificados; NRFI/YRFI/F5/Team Totals bloqueados";''',
    '''  const dataIncomplete = homeEre.dataStatus !== "VERIFIED" || awayEre.dataStatus !== "VERIFIED";
  if (dataIncomplete) {
    const statusLabel = homeEre.dataStatus === "DATA_INCOMPLETE" || awayEre.dataStatus === "DATA_INCOMPLETE"
      ? "DATA_INCOMPLETE"
      : "PARTIAL_DATA";
    const warning = `${statusLabel}: faltan linescores verificados suficientes; NRFI/YRFI/F5/Team Totals bloqueados`;''',
    "early markets partial fail-closed",
)
em_path.write_text(em, encoding="utf-8")


# Routes: derive selected game date from gamePk when the caller does not send date.
routes_path = Path("server/routes.ts")
routes = routes_path.read_text(encoding="utf-8")

helper = '''
async function resolveMlbAnalysisDate(rawDate: unknown, gamePk?: number): Promise<string> {
  const candidate = String(rawDate || "");
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(candidate)) return candidate;

  if (Number.isFinite(gamePk) && Number(gamePk) > 0) {
    try {
      const response = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=${Number(gamePk)}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } },
      );
      if (response.ok) {
        const payload: any = await response.json();
        const resolved = payload?.dates?.[0]?.date;
        if (/^\\d{4}-\\d{2}-\\d{2}$/.test(String(resolved || ""))) {
          return String(resolved);
        }
      }
    } catch (error) {
      console.warn("[MLB] Could not resolve analysis date from gamePk", gamePk, error);
    }
  }

  return new Date().toISOString().slice(0, 10);
}
'''

routes = replace_once(
    routes,
    '''function savePicks(picks: SavedPick[]): void {
  try {
    const dir = path.dirname(PICKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2), "utf-8");
  } catch (e) {
    console.error("savePicks error:", e);
  }
}

export function registerRoutes''',
    '''function savePicks(picks: SavedPick[]): void {
  try {
    const dir = path.dirname(PICKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2), "utf-8");
  } catch (e) {
    console.error("savePicks error:", e);
  }
}
''' + helper + '''
export function registerRoutes''',
    "insert MLB analysis-date resolver",
)

routes = replace_once(
    routes,
    '''      const sharedGamePk = home.gamePk || away.gamePk;
      const currentSeason = new Date().getFullYear();
      const analysisDateIso = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.body?.gameDate || ""))
        ? String(req.body.gameDate)
        : new Date().toISOString().slice(0, 10);''',
    '''      const sharedGamePk = home.gamePk || away.gamePk;
      const analysisDateIso = await resolveMlbAnalysisDate(req.body?.gameDate, sharedGamePk);
      const currentSeason = Number(analysisDateIso.slice(0, 4));''',
    "early endpoint date resolution",
)

routes = replace_once(
    routes,
    '''        const gameDateIso = (req.body?.gameDate as string) || new Date().toISOString().slice(0, 10);''',
    '''        const gameDateIso = analysisDateIso;''',
    "boost date reuse",
)

routes = replace_once(
    routes,
    '''      const gameDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.query.date || ""))
        ? String(req.query.date)
        : new Date().toISOString().slice(0, 10);''',
    '''      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);''',
    "ERE route game date resolution",
)

routes = replace_once(
    routes,
    '''      const gameDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(req.query.date || ""))
        ? String(req.query.date)
        : new Date().toISOString().slice(0, 10);''',
    '''      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);''',
    "TESI route game date resolution",
)

routes_path.write_text(routes, encoding="utf-8")
print("MLB P0 follow-up applied: partial fail-closed + gamePk date resolution")
