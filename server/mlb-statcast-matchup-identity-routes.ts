import type { Express, NextFunction, Request, Response as ExpressResponse } from "express";
import {
  MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA,
  certifyStatcastMatchupReadiness,
  type StatcastMatchupCertificationReport,
} from "./mlb-statcast-matchup-certifier";
import { getStatcastMatchupCombinedIdentitySafe } from "./mlb-statcast-matchup-vsteam-identity";

const MLB_FEED_BASE = "https://statsapi.mlb.com/api/v1.1/game";

type FetchLike = (input: string, init?: RequestInit) => Promise<globalThis.Response>;
type IdentityEngine = typeof getStatcastMatchupCombinedIdentitySafe;
type Certifier = typeof certifyStatcastMatchupReadiness;

export interface StatcastIdentityRouteService {
  review(gamePk: number): Promise<any>;
}

export interface StatcastIdentityRouteDependencies {
  identityEngine?: IdentityEngine;
  certifier?: Certifier;
  now?: () => Date;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function certificationFailure(error: unknown, verifiedAt: string): StatcastMatchupCertificationReport {
  return {
    sourceStatus: "DEGRADED",
    generatedAt: null,
    provenance: {
      schemaVersion: MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA,
      status: "DEGRADED",
      generatedAt: null,
      verifiedAt,
      certificationScope: "READINESS_COMBINED_RUN_DELTAS_AND_STARTER_ROWS",
      resultFingerprint: "UNAVAILABLE_AFTER_CERTIFIER_FAILURE",
      cacheMaxAgeSeconds: 300,
      cacheHit: false,
      cacheAgeSeconds: 0,
      currentLineupsConfirmed: false,
      visibleCoverageComplete: false,
      currentSeasonPitcherArsenalsReproduced: false,
      bullpenRosterAndStatsComplete: false,
      recentBatterStatsComplete: false,
      starterRowsReproduced: false,
      bullpenDeltasReproduced: false,
      combinedRunDeltasReproduced: false,
      sources: {
        pitcherArsenal: "BASEBALL_SAVANT_CURRENT_SEASON",
        batterPitchTypes: "BASEBALL_SAVANT_CURRENT_AND_PREVIOUS_SEASON",
        bullpenSelection: "MLB_ACTIVE_ROSTER_AND_SEASON_STATS",
        recentBatting: "MLB_STATS_BY_DATE_RANGE",
        directCareerMatchup: "MLB_STATS_VS_PLAYER_TOTAL_WHEN_REQUIRED",
        historyIdentity: "MLB_STATS_VS_TEAM_NUMERIC_IDENTITY_SAFE",
      },
      blockers: [`STATCAST_CERTIFIER_UNEXPECTED_FAILURE:${clean((error as any)?.message || error || "UNKNOWN")}`],
      failureDisposition: "DEGRADE_NOT_CERTIFY",
      safety: {
        modelFormulaChanged: false,
        runDeltaMutatedByCertifier: false,
        probabilityChanged: false,
        economicThresholdChanged: false,
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
      },
    },
  };
}

export function createStatcastIdentityRouteService(
  fetchImpl: FetchLike = fetch,
  dependencies: StatcastIdentityRouteDependencies = {},
): StatcastIdentityRouteService {
  const identityEngine = dependencies.identityEngine ?? getStatcastMatchupCombinedIdentitySafe;
  const certifier = dependencies.certifier ?? certifyStatcastMatchupReadiness;
  const now = dependencies.now ?? (() => new Date());

  return {
    async review(gamePk: number): Promise<any> {
      const requestStartedAt = now().toISOString();
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
      const season = Number.isFinite(parsedDate) ? new Date(parsedDate).getUTCFullYear() : now().getUTCFullYear();

      const result = await identityEngine({
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

      let certification: StatcastMatchupCertificationReport;
      try {
        certification = await certifier({
          gamePk,
          result,
          feed,
          season,
          requestStartedAt,
          fetchImpl,
          now,
        });
      } catch (error) {
        certification = certificationFailure(error, now().toISOString());
      }

      return {
        ...result,
        sourceStatus: certification.sourceStatus,
        ...(certification.generatedAt ? { generatedAt: certification.generatedAt } : {}),
        provenance: certification.provenance,
      };
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
