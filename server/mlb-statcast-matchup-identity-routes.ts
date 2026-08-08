import type { Express, NextFunction, Request, Response as ExpressResponse } from "express";
import { getStatcastMatchupCombinedIdentitySafe } from "./mlb-statcast-matchup-vsteam-identity";

const MLB_FEED_BASE = "https://statsapi.mlb.com/api/v1.1/game";

type FetchLike = (input: string, init?: RequestInit) => Promise<globalThis.Response>;

export interface StatcastIdentityRouteService {
  review(gamePk: number): Promise<any>;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function createStatcastIdentityRouteService(fetchImpl: FetchLike = fetch): StatcastIdentityRouteService {
  return {
    async review(gamePk: number): Promise<any> {
      const response = await fetchImpl(`${MLB_FEED_BASE}/${gamePk}/feed/live`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`STATCAST_IDENTITY_GAME_FEED_HTTP_${response.status}`);
      const feed: any = await response.json();
      const home = feed?.gameData?.teams?.home;
      const away = feed?.gameData?.teams?.away;
      const homeTeamId = positiveInt(home?.id);
      const awayTeamId = positiveInt(away?.id);
      if (!homeTeamId || !awayTeamId) throw new Error("STATCAST_IDENTITY_TEAM_IDS_MISSING");

      const homeProbable = feed?.gameData?.probablePitchers?.home ?? home?.probablePitcher ?? null;
      const awayProbable = feed?.gameData?.probablePitchers?.away ?? away?.probablePitcher ?? null;
      const gameDate = clean(feed?.gameData?.datetime?.officialDate ?? feed?.gameData?.datetime?.dateTime);
      const parsedDate = Date.parse(gameDate);
      const season = Number.isFinite(parsedDate) ? new Date(parsedDate).getUTCFullYear() : new Date().getUTCFullYear();

      return getStatcastMatchupCombinedIdentitySafe({
        gamePk,
        homeTeamId,
        awayTeamId,
        homePitcherId: positiveInt(homeProbable?.id) ?? 0,
        homePitcherName: clean(homeProbable?.fullName ?? homeProbable?.name),
        awayPitcherId: positiveInt(awayProbable?.id) ?? 0,
        awayPitcherName: clean(awayProbable?.fullName ?? awayProbable?.name),
        homeTeamAbbrev: clean(home?.abbreviation),
        awayTeamAbbrev: clean(away?.abbreviation),
        season,
        fetchImpl,
      });
    },
  };
}

export function registerMlbStatcastMatchupIdentityMiddleware(
  app: Express,
  service: StatcastIdentityRouteService = createStatcastIdentityRouteService(),
): void {
  // Compatibility interception: keep the historical app.get registration in
  // mlb-core-routes for route-contract stability, but serve GET through the
  // identity-safe correction before that legacy handler is reached.
  app.use("/api/mlb/statcast-matchup/:gamePk", async (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.review(gamePk));
    } catch (error: any) {
      console.error("statcast-matchup identity-safe error:", error);
      return res.status(500).json({ error: error?.message || "Failed" });
    }
  });
}
