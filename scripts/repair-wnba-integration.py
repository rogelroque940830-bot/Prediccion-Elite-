from pathlib import Path

FRONTEND = Path("frontend/client/src/pages/wnba-predictor.tsx")
ROUTES = Path("server/routes.ts")

frontend = FRONTEND.read_text(encoding="utf-8")

old_query = 'const { data: wnbaData, isLoading: wnbaLoading, refetch: refetchWNBA } = useQuery<{ success: boolean; data: any[] }>({' 
new_query = 'const { data: wnbaData, isLoading: wnbaLoading, isError: wnbaError, refetch: refetchWNBA } = useQuery<{ success: boolean; data: any[] }>({' 
if old_query in frontend:
    frontend = frontend.replace(old_query, new_query, 1)
elif new_query not in frontend:
    raise SystemExit("WNBA query declaration not found")

frontend = frontend.replace(
    'queryKey: ["/api/wnba/all"], staleTime: 30 * 60 * 1000, retry: 1,',
    'queryKey: ["/api/wnba/all"], staleTime: 30 * 60 * 1000, retry: 0,',
    1,
)

old_select = '<Select value={team} onValueChange={setTeam}>'
new_select = '<Select value={team} onValueChange={(value) => autoFillWNBA(value, side)} disabled={wnbaLoading || wnbaError || wnbaTeams.length === 0}>'
if old_select in frontend:
    frontend = frontend.replace(old_select, new_select, 1)
elif new_select not in frontend:
    raise SystemExit("WNBA team selector not found")

old_loading = '{wnbaLoading && <p className="text-xs text-muted-foreground italic"><RefreshCw className="h-3 w-3 inline animate-spin mr-1" /> Cargando stats de equipos...</p>}'
new_loading = '''{wnbaLoading && <p className="text-xs text-muted-foreground italic"><RefreshCw className="h-3 w-3 inline animate-spin mr-1" /> Cargando stats de equipos...</p>}
          {wnbaError && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-red-300">
              <span>No se pudieron cargar estadísticas WNBA verificadas. No se usarán valores predeterminados como si fueran reales.</span>
              <Button size="sm" variant="outline" onClick={() => refetchWNBA()} className="h-7 border-red-500/30 text-red-300">
                <RefreshCw className="h-3 w-3 mr-1" /> Reintentar
              </Button>
            </div>
          )}'''
if old_loading in frontend:
    frontend = frontend.replace(old_loading, new_loading, 1)
elif "No se pudieron cargar estadísticas WNBA verificadas" not in frontend:
    raise SystemExit("WNBA loading state not found")

FRONTEND.write_text(frontend, encoding="utf-8")

routes = ROUTES.read_text(encoding="utf-8")

old_helper = '''async function wnbaFetch(url: string) {
  const candidates = url.includes("stats.nba.com")
    ? [url.replace("https://stats.nba.com", "https://stats.wnba.com"), url]
    : [url];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await nbaFetch(candidate, WNBA_HEADERS, 12_000);
    } catch (error) {
      lastError = error;
      console.warn(`WNBA stats source failed: ${candidate}`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WNBA stats sources unavailable");
}'''

new_helper = '''async function wnbaFetch(url: string) {
  const candidates: Array<{ url: string; headers: Record<string, string> }> = url.includes("stats.nba.com")
    ? [
        // Reproduce primero la llamada exacta que ya funciona en producción.
        { url, headers: NBA_HEADERS },
        // Host alternativo WNBA con sus propios Origin/Referer.
        { url: url.replace("https://stats.nba.com", "https://stats.wnba.com"), headers: WNBA_HEADERS },
      ]
    : [{ url, headers: url.includes("stats.wnba.com") ? WNBA_HEADERS : NBA_HEADERS }];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await nbaFetch(candidate.url, candidate.headers, 12_000);
    } catch (error) {
      lastError = error;
      console.warn(`WNBA stats source failed: ${candidate.url}`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WNBA stats sources unavailable");
}'''

if old_helper in routes:
    routes = routes.replace(old_helper, new_helper, 1)
elif new_helper not in routes:
    raise SystemExit("Current WNBA fetch helper not found")

wnba_marker = "// WNBA ROUTES (same NBA API with LeagueID=10)"
nhl_marker = "// NHL ROUTES"
start = routes.index(wnba_marker)
end = routes.index(nhl_marker, start)
wnba_section = routes[start:end].replace("nbaFetch(", "wnbaFetch(")
routes = routes[:start] + wnba_section + routes[end:]

ROUTES.write_text(routes, encoding="utf-8")
print("WNBA integration now mirrors production headers before alternate fallback")
