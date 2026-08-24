import type { Express } from "express";
import { withCache } from "./route-runtime";

const ESPN_NFL_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

function validIsoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function floridaDate(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CourtEdge/1.0 NFL read-only data adapter",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NFL provider HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export type NflScheduleGame = {
  gameId: string;
  kickoff: string | null;
  name: string;
  shortName: string;
  status: string;
  completed: boolean;
  homeTeam: { id: string; name: string; abbreviation: string };
  awayTeam: { id: string; name: string; abbreviation: string };
};

export function normalizeNflScoreboard(payload: any): NflScheduleGame[] {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const games: NflScheduleGame[] = [];
  for (const event of events) {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
    const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
    const home = competitors.find((entry: any) => entry?.homeAway === "home");
    const away = competitors.find((entry: any) => entry?.homeAway === "away");
    if (!event?.id || !home?.team || !away?.team) continue;
    games.push({
      gameId: String(event.id),
      kickoff: event.date ? String(event.date) : null,
      name: String(event.name ?? `${away.team.displayName} at ${home.team.displayName}`),
      shortName: String(event.shortName ?? `${away.team.abbreviation} @ ${home.team.abbreviation}`),
      status: String(event?.status?.type?.name ?? event?.status?.type?.description ?? "UNKNOWN"),
      completed: Boolean(event?.status?.type?.completed),
      homeTeam: {
        id: String(home.team.id ?? ""),
        name: String(home.team.displayName ?? home.team.name ?? ""),
        abbreviation: String(home.team.abbreviation ?? ""),
      },
      awayTeam: {
        id: String(away.team.id ?? ""),
        name: String(away.team.displayName ?? away.team.name ?? ""),
        abbreviation: String(away.team.abbreviation ?? ""),
      },
    });
  }
  return games;
}

export type NflTeamDirectoryEntry = {
  id: string;
  name: string;
  abbreviation: string;
  location: string;
  nickname: string;
};

export function normalizeNflTeams(payload: any): NflTeamDirectoryEntry[] {
  const wrapped = payload?.sports?.[0]?.leagues?.[0]?.teams;
  const teams = Array.isArray(wrapped) ? wrapped : [];
  return teams
    .map((entry: any) => entry?.team ?? entry)
    .filter((team: any) => team?.id && (team?.displayName || team?.name))
    .map((team: any) => ({
      id: String(team.id),
      name: String(team.displayName ?? team.name),
      abbreviation: String(team.abbreviation ?? ""),
      location: String(team.location ?? ""),
      nickname: String(team.name ?? ""),
    }));
}

/** Read-only NFL schedule/directory plumbing. It does not score the Elite model. */
export function registerNflDataRoutes(app: Express): void {
  app.get("/api/nfl/games", async (req, res) => {
    const date = validIsoDate(req.query.date) ?? floridaDate();
    try {
      const compact = date.replaceAll("-", "");
      const data = await withCache(`nfl-scoreboard-${date}`, async () => {
        const payload = await fetchJson(`${ESPN_NFL_BASE}/scoreboard?dates=${encodeURIComponent(compact)}&limit=100`);
        return normalizeNflScoreboard(payload);
      });
      return res.json({ success: true, data, source: "ESPN NFL scoreboard", date });
    } catch (error) {
      console.error("nfl schedule error", error);
      return res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : "NFL schedule provider unavailable",
        code: "NFL_SCHEDULE_UNAVAILABLE",
      });
    }
  });

  app.get("/api/nfl/context", async (_req, res) => {
    try {
      const data = await withCache("nfl-team-directory-v1", async () => {
        const payload = await fetchJson(`${ESPN_NFL_BASE}/teams?limit=40`);
        return normalizeNflTeams(payload);
      });
      if (data.length < 32) {
        return res.status(502).json({
          success: false,
          error: `NFL team directory incomplete: ${data.length}/32`,
          code: "NFL_CONTEXT_INCOMPLETE",
        });
      }
      return res.json({
        success: true,
        data,
        source: "ESPN NFL team directory",
        modelInputsReady: false,
        note: "Directory/context transport only; Elite feature materialization is guarded separately.",
      });
    } catch (error) {
      console.error("nfl context error", error);
      return res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : "NFL context provider unavailable",
        code: "NFL_CONTEXT_UNAVAILABLE",
      });
    }
  });
}
