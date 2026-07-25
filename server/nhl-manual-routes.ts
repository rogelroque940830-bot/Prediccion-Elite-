import type { Express } from "express";

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { key: string; ts: number; payload: unknown } | null = null;

function seasonContext(): { seasonId: string; moneyPuckYear: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 8 ? year : year - 1;
  return {
    seasonId: `${startYear}${startYear + 1}`,
    moneyPuckYear: String(startYear),
  };
}

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function formatIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchJson(url: string, timeoutMs = 12_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CourtEdge/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/csv,*/*", "User-Agent": "CourtEdge/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseMoneyPuckTeams(csv: string): Record<string, any> {
  const rows = csv.trim().split(/\r?\n/).map((row) => row.split(","));
  const headers = rows[0] || [];
  const index = (name: string) => headers.indexOf(name);
  const result: Record<string, any> = {};

  for (const row of rows.slice(1)) {
    if (row.length < 10) continue;
    const abbr = row[index("team")];
    const situation = row[index("situation")];
    const gamesPlayed = Number(row[index("games_played")]) || 1;
    if (!abbr) continue;
    if (!result[abbr]) result[abbr] = {};

    if (situation === "5on5") {
      const xGoalsFor = Number(row[index("xGoalsFor")]);
      const xGoalsAgainst = Number(row[index("xGoalsAgainst")]);
      const scoreAdjFor = Number(row[index("scoreVenueAdjustedxGoalsFor")]);
      const scoreAdjAgainst = Number(row[index("scoreVenueAdjustedxGoalsAgainst")]);
      const corsiPct = Number(row[index("corsiPercentage")]);
      const shotsOnGoalFor = Number(row[index("shotsOnGoalFor")]);
      const goalsFor = Number(row[index("goalsFor")]);
      const highDangerFor = Number(row[index("highDangerShotsFor")]);
      const highDangerAgainst = Number(row[index("highDangerShotsAgainst")]);

      if (Number.isFinite(xGoalsFor)) result[abbr].xGF = Math.round((xGoalsFor / gamesPlayed) * 100) / 100;
      if (Number.isFinite(xGoalsAgainst)) result[abbr].xGA = Math.round((xGoalsAgainst / gamesPlayed) * 100) / 100;
      if (Number.isFinite(scoreAdjFor) && scoreAdjFor > 0) result[abbr].scoreAdjXGF = Math.round((scoreAdjFor / gamesPlayed) * 100) / 100;
      if (Number.isFinite(scoreAdjAgainst) && scoreAdjAgainst > 0) result[abbr].scoreAdjXGA = Math.round((scoreAdjAgainst / gamesPlayed) * 100) / 100;
      if (Number.isFinite(corsiPct)) result[abbr].cf5v5 = Math.round(corsiPct * 1000) / 10;
      if (Number.isFinite(shotsOnGoalFor) && shotsOnGoalFor > 0 && Number.isFinite(goalsFor)) {
        result[abbr].shPct = Math.round((goalsFor / shotsOnGoalFor) * 1000) / 10;
      }
      if (Number.isFinite(highDangerFor)) result[abbr].hdCF = Math.round((highDangerFor / gamesPlayed) * 100) / 100;
      if (Number.isFinite(highDangerAgainst)) result[abbr].hdCA = Math.round((highDangerAgainst / gamesPlayed) * 100) / 100;
    } else if (situation === "5on4") {
      const goalsFor = Number(row[index("goalsFor")]);
      if (Number.isFinite(goalsFor)) result[abbr].ppGF = Math.round((goalsFor / gamesPlayed) * 100) / 100;
    } else if (situation === "4on5") {
      const goalsAgainst = Number(row[index("goalsAgainst")]);
      if (Number.isFinite(goalsAgainst)) result[abbr].pkGA = Math.round((goalsAgainst / gamesPlayed) * 100) / 100;
    }
  }

  return result;
}

async function buildScheduleContext(targetIso: string): Promise<Record<string, any>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetIso)) return {};
  const target = new Date(`${targetIso}T12:00:00Z`);
  const offsets = [0, -7, -14];
  const payloads = await Promise.all(
    offsets.map(async (offset) => {
      const date = new Date(target);
      date.setUTCDate(date.getUTCDate() + offset);
      return fetchJson(`https://api-web.nhle.com/v1/schedule/${formatIso(date)}`).catch(() => null);
    }),
  );

  const gamesById = new Map<string, any>();
  for (const payload of payloads) {
    for (const day of payload?.gameWeek || []) {
      for (const game of day?.games || []) {
        gamesById.set(String(game.id), game);
      }
    }
  }

  const byTeam: Record<string, Date[]> = {};
  for (const game of gamesById.values()) {
    const rawDate = game.gameDate || game.startTimeUTC?.slice(0, 10);
    if (!rawDate) continue;
    const gameDate = new Date(`${rawDate}T12:00:00Z`);
    if (gameDate >= target) continue;
    for (const abbr of [game.homeTeam?.abbrev, game.awayTeam?.abbrev]) {
      if (!abbr) continue;
      if (!byTeam[abbr]) byTeam[abbr] = [];
      byTeam[abbr].push(gameDate);
    }
  }

  const result: Record<string, any> = {};
  const sevenDaysAgo = new Date(target);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

  for (const [abbr, dates] of Object.entries(byTeam)) {
    dates.sort((a, b) => b.getTime() - a.getTime());
    const last = dates[0];
    const diffDays = Math.round((target.getTime() - last.getTime()) / 86_400_000);
    const daysRest = Math.max(0, diffDays - 1);
    const hasActiveContext = daysRest <= 7;
    result[abbr] = {
      daysRest: hasActiveContext ? daysRest : undefined,
      isB2B: hasActiveContext ? daysRest === 0 : undefined,
      gamesLast7Days: hasActiveContext ? dates.filter((date) => date >= sevenDaysAgo).length : undefined,
    };
  }

  return result;
}

export function registerNhlManualRoutes(app: Express): void {
  app.get("/api/nhl/manual-teams", async (req, res) => {
    try {
      const date = String(req.query.date || new Date().toISOString().slice(0, 10));
      const { seasonId, moneyPuckYear } = seasonContext();
      const key = `nhl-manual:${seasonId}:${date}`;
      const now = Date.now();
      if (cache && cache.key === key && now - cache.ts < CACHE_TTL_MS) {
        return res.json(cache.payload);
      }

      const [standingsJson, summaryJson, moneyPuckCsv, scheduleContext] = await Promise.all([
        fetchJson("https://api-web.nhle.com/v1/standings/now"),
        fetchJson(`https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${seasonId}`).catch(() => ({ data: [] })),
        fetchText(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${moneyPuckYear}/regular/teams.csv`).catch(() => ""),
        buildScheduleContext(date).catch(() => ({})),
      ]);

      const detailByName = new Map<string, any>();
      for (const row of summaryJson?.data || []) {
        detailByName.set(normalizeName(String(row.teamFullName || "")), row);
      }
      const moneyPuck = moneyPuckCsv ? parseMoneyPuckTeams(moneyPuckCsv) : {};

      const data = (standingsJson?.standings || [])
        .map((team: any) => {
          const teamName = String(team.teamName?.default || "");
          const abbr = String(team.teamAbbrev?.default || "");
          const gp = Number(team.gamesPlayed) || 0;
          const l10GP = Number(team.l10GamesPlayed) || 0;
          const detail = detailByName.get(normalizeName(teamName)) || {};
          const advanced = moneyPuck[abbr] || {};
          const context = scheduleContext[abbr] || {};

          return {
            teamName,
            abbr,
            seasonId,
            gamesPlayed: gp,
            goalsFor: gp > 0 ? Math.round((Number(team.goalFor || 0) / gp) * 100) / 100 : undefined,
            goalsAgainst: gp > 0 ? Math.round((Number(team.goalAgainst || 0) / gp) * 100) / 100 : undefined,
            ppPct: Number.isFinite(Number(detail.powerPlayPct)) ? Math.round(Number(detail.powerPlayPct) * 1000) / 10 : undefined,
            pkPct: Number.isFinite(Number(detail.penaltyKillPct)) ? Math.round(Number(detail.penaltyKillPct) * 1000) / 10 : undefined,
            shotsFor: Number.isFinite(Number(detail.shotsForPerGame)) ? Math.round(Number(detail.shotsForPerGame) * 10) / 10 : undefined,
            shotsAgainst: Number.isFinite(Number(detail.shotsAgainstPerGame)) ? Math.round(Number(detail.shotsAgainstPerGame) * 10) / 10 : undefined,
            corsi: Number.isFinite(Number(advanced.cf5v5)) ? Number(advanced.cf5v5) : undefined,
            winRate10: l10GP > 0 ? Math.round((Number(team.l10Wins || 0) / l10GP) * 100) / 100 : undefined,
            streak: team.streakCode === "W" ? Number(team.streakCount || 0) : -Number(team.streakCount || 0),
            recentGF: l10GP > 0 && Number(team.l10GoalsFor) > 0 ? Math.round((Number(team.l10GoalsFor) / l10GP) * 100) / 100 : undefined,
            recentGA: l10GP > 0 && Number(team.l10GoalsAgainst) > 0 ? Math.round((Number(team.l10GoalsAgainst) / l10GP) * 100) / 100 : undefined,
            daysRest: context.daysRest,
            isB2B: context.isB2B,
            gamesLast7Days: context.gamesLast7Days,
            xGF: advanced.xGF,
            xGA: advanced.xGA,
            cf5v5: advanced.cf5v5,
            shPct: advanced.shPct,
            hdCF: advanced.hdCF,
            hdCA: advanced.hdCA,
            ppGF: advanced.ppGF,
            pkGA: advanced.pkGA,
            scoreAdjXGF: advanced.scoreAdjXGF,
            scoreAdjXGA: advanced.scoreAdjXGA,
          };
        })
        .filter((team: any) =>
          team.teamName &&
          team.abbr &&
          Number.isFinite(team.goalsFor) &&
          Number.isFinite(team.goalsAgainst) &&
          Number.isFinite(team.winRate10)
        );

      if (data.length === 0) throw new Error("NHL manual team directory is empty");

      const payload = {
        success: true,
        data,
        source: "direct",
        seasonId,
        asOf: new Date().toISOString(),
      };
      cache = { key, ts: now, payload };
      return res.json(payload);
    } catch (error) {
      console.error("NHL manual teams error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudieron obtener estadísticas verificadas para el selector manual NHL",
      });
    }
  });
}
