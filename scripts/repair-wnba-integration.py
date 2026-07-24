from pathlib import Path

FRONTEND = Path("frontend/client/src/pages/wnba-predictor.tsx")
ROUTES = Path("server/routes.ts")
WORKFLOW = Path(".github/workflows/integration-p0-frontend.yml")
SELF = Path("scripts/repair-wnba-integration.py")

frontend = FRONTEND.read_text(encoding="utf-8")

old_query = 'const { data: wnbaData, isLoading: wnbaLoading, refetch: refetchWNBA } = useQuery<{ success: boolean; data: any[] }>({' 
new_query = 'const { data: wnbaData, isLoading: wnbaLoading, isError: wnbaError, refetch: refetchWNBA } = useQuery<{ success: boolean; data: any[] }>({' 
if old_query in frontend:
    frontend = frontend.replace(old_query, new_query, 1)
elif new_query not in frontend:
    raise SystemExit("WNBA query declaration not found")

old_query_opts = 'queryKey: ["/api/wnba/all"], staleTime: 30 * 60 * 1000, retry: 1,'
new_query_opts = 'queryKey: ["/api/wnba/all"], staleTime: 30 * 60 * 1000, retry: 0,'
frontend = frontend.replace(old_query_opts, new_query_opts, 1)

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
old_fetch = '''async function nbaFetch(url: string) {
  const res = await fetch(url, { headers: NBA_HEADERS });
  if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
  return res.json();
}'''
new_fetch = '''async function nbaFetch(
  url: string,
  headers: Record<string, string> = NBA_HEADERS,
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

const WNBA_HEADERS: Record<string, string> = {
  ...NBA_HEADERS,
  Referer: "https://www.wnba.com/",
  Origin: "https://www.wnba.com",
};

async function wnbaFetch(url: string) {
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
if old_fetch in routes:
    routes = routes.replace(old_fetch, new_fetch, 1)
elif "async function wnbaFetch(url: string)" not in routes:
    raise SystemExit("nbaFetch helper not found")

wnba_marker = "// WNBA ROUTES (same NBA API with LeagueID=10)"
nhl_marker = "// NHL ROUTES"
start = routes.index(wnba_marker)
end = routes.index(nhl_marker, start)
wnba_section = routes[start:end]
wnba_section = wnba_section.replace("nbaFetch(", "wnbaFetch(")
routes = routes[:start] + wnba_section + routes[end:]
ROUTES.write_text(routes, encoding="utf-8")

workflow = WORKFLOW.read_text(encoding="utf-8")
begin_marker = "  # BEGIN ONE-TIME WNBA REPAIR\n"
end_marker = "  # END ONE-TIME WNBA REPAIR\n"
if begin_marker in workflow and end_marker in workflow:
    begin = workflow.index(begin_marker)
    end = workflow.index(end_marker, begin) + len(end_marker)
    workflow = workflow[:begin] + workflow[end:]
workflow = workflow.replace("permissions:\n  contents: write", "permissions:\n  contents: read", 1)
WORKFLOW.write_text(workflow, encoding="utf-8")

SELF.unlink()
print("WNBA repair applied and temporary workflow hook removed")
