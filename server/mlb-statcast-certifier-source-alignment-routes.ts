import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";
import {
  createStatcastIdentityRouteService,
  type StatcastIdentityRouteDependencies,
  type StatcastIdentityRouteService,
} from "./mlb-statcast-matchup-identity-routes";
import { buildSavantPitchArsenalUrl } from "./mlb-statcast-savant-source";

const SAVANT_HOST = "baseballsavant.mlb.com";
const SAVANT_PITCH_ARSENAL_PATH = "/leaderboard/pitch-arsenal-stats";

type FetchInput = string | URL | globalThis.Request;
type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<globalThis.Response>;

export const MLB_STATCAST_CERTIFIER_SOURCE_ALIGNMENT_SCHEMA = "courtedge-p1-m2b-statcast-certifier-source-alignment.v1" as const;

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function inputUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function rewrittenRequestInput(input: FetchInput, rewrittenUrl: string): FetchInput {
  if (typeof globalThis.Request !== "undefined" && input instanceof globalThis.Request) {
    return new globalThis.Request(rewrittenUrl, input);
  }
  return rewrittenUrl;
}

export function rewriteStatcastCertifierSavantUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (url.hostname !== SAVANT_HOST || url.pathname !== SAVANT_PITCH_ARSENAL_PATH) {
    return rawUrl;
  }

  const role = url.searchParams.get("type");
  if (role !== "batter" && role !== "pitcher") return rawUrl;

  const year = Number(url.searchParams.get("year"));
  if (!Number.isInteger(year) || year < 2008 || year > 2100) {
    throw new Error("STATCAST_CERTIFIER_SAVANT_YEAR_INVALID");
  }

  return buildSavantPitchArsenalUrl({
    role,
    year,
    coverage: role === "batter" ? "INCLUSIVE" : "QUALIFIED",
  });
}

export function createStatcastCertifierSourceAlignedFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const rawUrl = inputUrl(input);
    const rewrittenUrl = rewriteStatcastCertifierSavantUrl(rawUrl);
    const nextInput = rewrittenUrl === rawUrl ? input : rewrittenRequestInput(input, rewrittenUrl);
    return baseFetch(nextInput, init);
  };
}

export function createStatcastCertifierSourceAlignedRouteService(
  baseFetch: FetchLike = fetch,
  dependencies: StatcastIdentityRouteDependencies = {},
): StatcastIdentityRouteService {
  return createStatcastIdentityRouteService(
    createStatcastCertifierSourceAlignedFetch(baseFetch),
    dependencies,
  );
}

export function registerMlbStatcastCertifierSourceAlignmentMiddleware(
  app: Express,
  service: StatcastIdentityRouteService = createStatcastCertifierSourceAlignedRouteService(),
): void {
  app.use("/api/mlb/statcast-matchup/:gamePk", async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (req.method !== "GET") return next();
    const gamePk = positiveInt(req.params.gamePk);
    if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
    try {
      return res.json(await service.review(gamePk));
    } catch (error: any) {
      console.error("statcast-matchup source-aligned certification error:", error);
      return res.status(500).json({ error: error?.message || "Failed" });
    }
  });
}
