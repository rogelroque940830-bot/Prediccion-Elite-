from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    file_path.write_text(text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str, label: str, include_end: bool = False) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    if replacement in text:
        return
    if text.count(start) != 1:
        raise SystemExit(f"{label}: expected exactly one start anchor, found {text.count(start)}")
    start_index = text.index(start)
    tail = text[start_index:]
    if tail.count(end) != 1:
        raise SystemExit(f"{label}: expected exactly one end anchor after start, found {tail.count(end)}")
    end_index = text.index(end, start_index)
    if include_end:
        end_index += len(end)
    file_path.write_text(text[:start_index] + replacement + text[end_index:])


# 1. Legacy compatibility poller becomes explicit opt-in.
replace_once(
    "server/legacy-picks-routes.ts",
    '  const ODDS_API_KEY_BG = requireSecret("ODDS_API_KEY");\n',
    '  const LEGACY_ODDS_BACKGROUND_POLLING = process.env.LEGACY_ODDS_BACKGROUND_POLLING?.trim().toLowerCase() === "true";\n'
    '  const ODDS_API_KEY_BG = LEGACY_ODDS_BACKGROUND_POLLING ? requireSecret("ODDS_API_KEY") : null;\n',
    "legacy provider key gate",
)
replace_once(
    "server/legacy-picks-routes.ts",
    "      const apiSport = SPORT_MAP_BG[sport]; if (!apiSport) return 0;\n",
    "      const apiSport = SPORT_MAP_BG[sport]; if (!apiSport || !ODDS_API_KEY_BG) return 0;\n",
    "legacy poll function gate",
)
replace_between(
    "server/legacy-picks-routes.ts",
    "  // First poll 30 s after boot, then every 15 min\n",
    "  // Auto-refresh CLV for settled picks that don't have it yet\n",
    '''  // Legacy all-sport polling is disabled by default. It is incompatible with a bounded
  // monthly provider quota and duplicates newer decision/checkpoint-specific collectors.
  // On-demand odds routes still record snapshots. Explicit opt-in is available only for
  // environments with a separately budgeted provider plan.
  if (LEGACY_ODDS_BACKGROUND_POLLING) {
    const bootPoll = setTimeout(async () => {
      const a = await pollOddsForSport("mlb");
      const b = await pollOddsForSport("nhl");
      const c = await pollOddsForSport("nba");
      console.log(`[odds-poll boot] mlb=${a} nhl=${b} nba=${c} snapshots`);
    }, 30 * 1000);
    bootPoll.unref();
    const recurringPoll = setInterval(async () => {
      const a = await pollOddsForSport("mlb");
      const b = await pollOddsForSport("nhl");
      const c = await pollOddsForSport("nba");
      if (a + b + c > 0) console.log(`[odds-poll] mlb=${a} nhl=${b} nba=${c} snapshots`);
    }, 2 * 60 * 60 * 1000);
    recurringPoll.unref();
  } else {
    console.log("[odds-poll] legacy background polling disabled; set LEGACY_ODDS_BACKGROUND_POLLING=true for explicit opt-in");
  }

''',
    "legacy timer block",
)

# 2. S5C never causes a provider refresh and does not even request the internal cache
# when no games remain pregame.
replace_between(
    "server/mlb-s5c-shadow-ingestion.ts",
    "      const [schedule, oddsPayload] = await Promise.all([\n",
    "      summary.gamesDiscovered = games.length;\n",
    '''      const schedule = await fetchJson(
        this.fetcher,
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(gameDate)}&hydrate=team,probablePitcher,venue,weather`,
      );
      const games = scheduleGames(schedule);
      summary.gamesDiscovered = games.length;
      const hasPregameGame = games.some((game) => isPregame(game, now.getTime()));
      const oddsPayload = hasPregameGame
        ? await fetchJson(this.fetcher, `${this.selfBaseUrl}/api/odds/mlb/f5?date=${encodeURIComponent(gameDate)}&background=cache-only`)
        : { success: true, games: [], backgroundCacheOnly: true };
      const oddsGames = Array.isArray(oddsPayload?.games) ? oddsPayload.games : [];
''',
    "S5C cache-only acquisition",
    include_end=True,
)

# 3. S5E may consume a recent cache but never refresh the provider itself.
replace_once(
    "server/mlb-s5e-coverage-service.ts",
    '          payload = await fetchJson(this.fetcher, `${this.selfBaseUrl}/api/odds/mlb/f5?date=${encodeURIComponent(record.prediction.game.gameDate)}`);\n',
    '          payload = await fetchJson(this.fetcher, `${this.selfBaseUrl}/api/odds/mlb/f5?date=${encodeURIComponent(record.prediction.game.gameDate)}&background=cache-only`);\n',
    "S5E cache-only acquisition",
)

# 4. Protected F5 route maintains a bounded last-successful cache for background-only reads.
replace_once(
    "server/mlb-f5-odds-routes.ts",
    'const F5_BOOKS = ["fanduel", "betmgm", "draftkings"] as const;\n',
    'const F5_BOOKS = ["fanduel", "betmgm", "draftkings"] as const;\n'
    'const F5_BACKGROUND_CACHE_TTL_MS = 30 * 60 * 1000;\n'
    'const f5BackgroundCache = new Map<string, { data: any; providerFetchedAt: number }>();\n',
    "F5 background cache declarations",
)

replace_between(
    "server/mlb-f5-odds-routes.ts",
    '  const dateParam = String(req.query.date ?? "").trim();\n',
    '    let games = Array.isArray((data as any)?.games) ? (data as any).games : [];\n',
    '''  const dateParam = String(req.query.date ?? "").trim();
  const cacheKey = `${MLB_F5_CACHE_KEY}:${dateParam || "all"}`;
  const backgroundCacheOnly = String(req.query.background ?? "").trim().toLowerCase() === "cache-only";
  try {
    let data: any;
    if (backgroundCacheOnly) {
      const cached = f5BackgroundCache.get(cacheKey);
      if (!cached || Date.now() - cached.providerFetchedAt >= F5_BACKGROUND_CACHE_TTL_MS) {
        return void res.json({
          success: false,
          schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
          games: [],
          source: "n/a",
          code: "BACKGROUND_CACHE_MISS",
          error: "No recent F5 cache is available; background provider refresh is disabled to conserve quota.",
          backgroundCacheOnly: true,
        });
      }
      data = cached.data;
    } else {
      const ODDS_API_KEY = requireSecret("ODDS_API_KEY");
      data = await withCache(cacheKey, async () => {
        const providerFetchedAt = Date.now();
        const eventsResponse = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${ODDS_API_KEY}`);
        const events = await eventsResponse.json();
        if (!Array.isArray(events)) {
          const error: any = new Error(events?.message || "Odds API error");
          error.code = events?.error_code;
          error.noCache = true;
          throw error;
        }

        const eligibleEvents = dateParam
          ? events.filter((event: any) => commenceToFloridaDate(String(event?.commence_time ?? "")) === dateParam)
          : events;
        const queue = [...eligibleEvents];
        const games: any[] = [];
        const eventFailures: Array<{ code: string | null; message: string; status: number | null }> = [];
        const workers = Array.from({ length: 4 }, async () => {
          while (queue.length > 0) {
            const event: any = queue.shift();
            if (!event) break;
            try {
              const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings&oddsFormat=american&bookmakers=${F5_BOOKS.join(",")}`;
              const response = await fetch(url);
              if (!response.ok) {
                const body: any = await response.json().catch(() => null);
                eventFailures.push({
                  code: String(body?.error_code ?? "").trim() || null,
                  message: String(body?.message ?? `Odds API HTTP ${response.status}`),
                  status: response.status,
                });
                continue;
              }
              const providerGame = await response.json();
              games.push(buildMlbF5ConsensusGame(providerGame, new Date().toISOString()));
            } catch (error) {
              eventFailures.push({
                code: null,
                message: error instanceof Error ? error.message : String(error),
                status: null,
              });
            }
          }
        });
        await Promise.all(workers);
        if (eligibleEvents.length > 0 && games.length === 0 && eventFailures.length > 0) {
          const first = eventFailures[0];
          const error: any = new Error(first.message || "F5 event odds provider failure");
          error.code = first.code || "F5_EVENT_ODDS_PROVIDER_FAILURE";
          error.noCache = true;
          throw error;
        }
        return {
          games,
          providerFetchedAt,
          eligibleEventCount: eligibleEvents.length,
          providerFailureCount: eventFailures.length,
          providerErrorCodes: Array.from(new Set(eventFailures.map((failure) => failure.code).filter(Boolean))),
        };
      });
      const providerFetchedAt = Number(data?.providerFetchedAt);
      if (Number.isFinite(providerFetchedAt) && providerFetchedAt > 0) {
        f5BackgroundCache.set(cacheKey, { data, providerFetchedAt });
      }
    }
''',
    "F5 provider/cache-only acquisition",
)

replace_between(
    "server/mlb-f5-odds-routes.ts",
    "    res.json({\n      success: true,\n      schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,\n",
    "  } catch (error: any) {\n",
    '''    res.json({
      success: true,
      schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      games,
      source: sources.join(", ") || "n/a",
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
      backgroundCacheOnly,
      coverageStatus: Number((data as any)?.providerFailureCount || 0) > 0 ? "PARTIAL" : "COMPLETE",
      eligibleEventCount: Number((data as any)?.eligibleEventCount || 0),
      providerFailureCount: Number((data as any)?.providerFailureCount || 0),
      providerErrorCodes: Array.isArray((data as any)?.providerErrorCodes) ? (data as any).providerErrorCodes : [],
      note: "Hard Rock no publica mercados F5. Consenso por mediana de probabilidad implícita de FanDuel/BetMGM/DraftKings; nunca se promedian cuotas americanas directamente.",
    });
''',
    "F5 response observability",
)
