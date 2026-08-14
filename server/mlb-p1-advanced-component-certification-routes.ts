import type { Express, NextFunction, Request, Response as ExpressResponse } from "express";
import {
  getDisciplineSpeedCertifiedSnapshot,
  getDisciplineSpeedForGame,
  type DisciplineSpeedCertifiedSnapshot,
} from "./mlb-discipline-speed";
import {
  getTeamSosCertifiedSnapshot,
  getTeamSos,
  type TeamSosCertifiedSnapshot,
} from "./mlb-sos";
import {
  evaluateBatter,
  evaluatePitcher,
  getStatcastQualityCertifiedSnapshot,
  type StatcastQualityCertifiedSnapshot,
} from "./mlb-statcast-quality";
import {
  getAdvancedContextCertifiedSnapshot,
  type AdvancedContextCertifiedSnapshot,
} from "./mlb-advanced-context-provenance";

const MLB_FEED_BASE = "https://statsapi.mlb.com/api/v1.1/game";
export const MLB_P1_ADVANCED_COMPONENT_ROUTE_SCHEMA = "courtedge-p1-m2b-advanced-component-route.v1" as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<globalThis.Response>;
type DisciplineCertifier = typeof getDisciplineSpeedCertifiedSnapshot;
type DisciplineLegacy = typeof getDisciplineSpeedForGame;
type SosCertifier = typeof getTeamSosCertifiedSnapshot;
type SosLegacy = typeof getTeamSos;
type QualityCertifier = typeof getStatcastQualityCertifiedSnapshot;
type AdvancedContextCertifier = typeof getAdvancedContextCertifiedSnapshot;

export interface AdvancedComponentRouteDependencies {
  fetchImpl?: FetchLike;
  disciplineCertifier?: DisciplineCertifier;
  disciplineLegacy?: DisciplineLegacy;
  sosCertifier?: SosCertifier;
  sosLegacy?: SosLegacy;
  qualityCertifier?: QualityCertifier;
  advancedContextCertifier?: AdvancedContextCertifier;
  now?: () => Date;
}

export interface AdvancedComponentRouteService {
  discipline(gamePk: number): Promise<any>;
  sos(gamePk: number): Promise<any>;
  quality(gamePk: number): Promise<any>;
  advancedContext(gamePk: number): Promise<any>;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function olderIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function degradedProvenance(component: "DISCIPLINE_SPEED" | "SOS", error: unknown, verifiedAt: string) {
  return {
    schemaVersion: MLB_P1_ADVANCED_COMPONENT_ROUTE_SCHEMA,
    status: "DEGRADED" as const,
    component,
    verifiedAt,
    blockers: [`${component}_CERTIFIER_FAILURE:${clean((error as any)?.message || error || "UNKNOWN")}`],
    failureDisposition: "DEGRADE_NOT_CERTIFY" as const,
    safety: {
      modelFormulaChanged: false,
      probabilityChanged: false,
      thresholdChanged: false,
      stakeChanged: false,
      automaticBetPlacement: false,
      automaticPromotionAllowed: false,
    },
  };
}

async function fetchGameFeed(gamePk: number, fetchImpl: FetchLike): Promise<any> {
  const response = await fetchImpl(`${MLB_FEED_BASE}/${gamePk}/feed/live`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`P1_ADVANCED_COMPONENT_GAME_FEED_HTTP_${response.status}`);
  const feed: any = await response.json();
  if (!feed?.gameData?.teams?.home?.id || !feed?.gameData?.teams?.away?.id) {
    throw new Error("P1_ADVANCED_COMPONENT_GAME_IDENTITY_MISSING");
  }
  return feed;
}

function pitcher(feed: any, side: "home" | "away") {
  const team = feed?.gameData?.teams?.[side] ?? {};
  const probable = feed?.gameData?.probablePitchers?.[side] ?? team?.probablePitcher ?? null;
  return {
    id: positiveInt(probable?.id),
    name: clean(probable?.fullName ?? probable?.name),
  };
}

function lineupIds(feed: any, side: "home" | "away"): number[] {
  const raw = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  if (!Array.isArray(raw)) return [];
  return raw.map(positiveInt).filter((id): id is number => id != null);
}

export function createMlbP1AdvancedComponentRouteService(
  dependencies: AdvancedComponentRouteDependencies = {},
): AdvancedComponentRouteService {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const disciplineCertifier = dependencies.disciplineCertifier ?? getDisciplineSpeedCertifiedSnapshot;
  const disciplineLegacy = dependencies.disciplineLegacy ?? getDisciplineSpeedForGame;
  const sosCertifier = dependencies.sosCertifier ?? getTeamSosCertifiedSnapshot;
  const sosLegacy = dependencies.sosLegacy ?? getTeamSos;
  const qualityCertifier = dependencies.qualityCertifier ?? getStatcastQualityCertifiedSnapshot;
  const advancedContextCertifier = dependencies.advancedContextCertifier ?? getAdvancedContextCertifiedSnapshot;
  const now = dependencies.now ?? (() => new Date());

  return {
    async discipline(gamePk: number): Promise<any> {
      const feed = await fetchGameFeed(gamePk, fetchImpl);
      const homePitcher = pitcher(feed, "home");
      const awayPitcher = pitcher(feed, "away");
      const homeBatterIds = lineupIds(feed, "home");
      const awayBatterIds = lineupIds(feed, "away");

      if (!homePitcher.id || !awayPitcher.id) {
        throw new Error("P1_DISCIPLINE_SPEED_PROBABLE_PITCHERS_MISSING");
      }

      try {
        const certified: DisciplineSpeedCertifiedSnapshot = await disciplineCertifier({
          homePitcherId: homePitcher.id,
          homePitcherName: homePitcher.name,
          awayPitcherId: awayPitcher.id,
          awayPitcherName: awayPitcher.name,
          homeBatterIds,
          awayBatterIds,
        });
        return { success: true, ...certified };
      } catch (error) {
        const legacy = await disciplineLegacy(
          homePitcher.id,
          homePitcher.name,
          awayPitcher.id,
          awayPitcher.name,
          homeBatterIds,
          awayBatterIds,
        );
        return {
          success: true,
          ...legacy,
          sourceStatus: "DEGRADED",
          provenance: degradedProvenance("DISCIPLINE_SPEED", error, now().toISOString()),
        };
      }
    },

    async sos(gamePk: number): Promise<any> {
      const feed = await fetchGameFeed(gamePk, fetchImpl);
      const home = feed.gameData.teams.home;
      const away = feed.gameData.teams.away;
      const homeTeamId = positiveInt(home?.id);
      const awayTeamId = positiveInt(away?.id);
      const homeTeamName = clean(home?.name);
      const awayTeamName = clean(away?.name);
      if (!homeTeamId || !awayTeamId) throw new Error("P1_SOS_TEAM_IDENTITY_MISSING");

      try {
        const [homeCertified, awayCertified]: [TeamSosCertifiedSnapshot, TeamSosCertifiedSnapshot] = await Promise.all([
          sosCertifier(homeTeamId, homeTeamName),
          sosCertifier(awayTeamId, awayTeamName),
        ]);
        const generatedAt = olderIso(homeCertified.generatedAt, awayCertified.generatedAt);
        return {
          success: true,
          home: homeCertified.teamSos,
          away: awayCertified.teamSos,
          sourceStatus: "CERTIFIED",
          generatedAt,
          provenance: {
            schemaVersion: MLB_P1_ADVANCED_COMPONENT_ROUTE_SCHEMA,
            status: "CERTIFIED",
            component: "SOS",
            generatedAt,
            home: homeCertified.provenance,
            away: awayCertified.provenance,
            failureDisposition: "DEGRADE_NOT_CERTIFY",
            safety: {
              modelFormulaChanged: false,
              probabilityChanged: false,
              thresholdChanged: false,
              stakeChanged: false,
              automaticBetPlacement: false,
              automaticPromotionAllowed: false,
            },
          },
        };
      } catch (error) {
        const [homeLegacy, awayLegacy] = await Promise.all([
          sosLegacy(homeTeamId, homeTeamName),
          sosLegacy(awayTeamId, awayTeamName),
        ]);
        return {
          success: true,
          home: homeLegacy,
          away: awayLegacy,
          sourceStatus: "DEGRADED",
          provenance: degradedProvenance("SOS", error, now().toISOString()),
        };
      }
    },

    async quality(gamePk: number): Promise<any> {
      const [feed, certified]: [any, StatcastQualityCertifiedSnapshot] = await Promise.all([
        fetchGameFeed(gamePk, fetchImpl),
        qualityCertifier({ fetchImpl }),
      ]);
      const homePitcher = pitcher(feed, "home");
      const awayPitcher = pitcher(feed, "away");
      const homeBatterIds = lineupIds(feed, "home");
      const awayBatterIds = lineupIds(feed, "away");
      return {
        success: true,
        homeSP: evaluatePitcher(homePitcher.id ? certified.pitcherMap[homePitcher.id] : undefined),
        awaySP: evaluatePitcher(awayPitcher.id ? certified.pitcherMap[awayPitcher.id] : undefined),
        homeBatters: homeBatterIds.map((id) => evaluateBatter(certified.batterMap[id])).filter(Boolean),
        awayBatters: awayBatterIds.map((id) => evaluateBatter(certified.batterMap[id])).filter(Boolean),
        sourceStatus: certified.sourceStatus,
        generatedAt: certified.generatedAt,
        provenance: certified.provenance,
      };
    },

    async advancedContext(gamePk: number): Promise<any> {
      const certified: AdvancedContextCertifiedSnapshot = await advancedContextCertifier(gamePk, { fetchImpl });
      return { success: true, ...certified };
    },
  };
}

export function registerMlbP1AdvancedComponentCertificationMiddleware(
  app: Express,
  service: AdvancedComponentRouteService = createMlbP1AdvancedComponentRouteService(),
): void {
  app.use("/api/mlb/quality/:gamePk", async (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.quality(gamePk));
    } catch (error) {
      console.warn("p1 quality certifier unavailable; preserving legacy route", clean((error as any)?.message || error));
      return next();
    }
  });

  app.use("/api/mlb/advanced/:gamePk", async (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.advancedContext(gamePk));
    } catch (error) {
      console.warn("p1 advanced-context certifier unavailable; preserving legacy route", clean((error as any)?.message || error));
      return next();
    }
  });

  app.use("/api/mlb/discipline-speed/:gamePk", async (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.discipline(gamePk));
    } catch (error: any) {
      console.error("p1 discipline-speed certification route error:", error);
      return res.status(500).json({ error: error?.message || "Failed" });
    }
  });

  app.use("/api/mlb/sos/:gamePk", async (req: Request, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.sos(gamePk));
    } catch (error: any) {
      console.error("p1 sos certification route error:", error);
      return res.status(500).json({ error: error?.message || "Failed" });
    }
  });
}
