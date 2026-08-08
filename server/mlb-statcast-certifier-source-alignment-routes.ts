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
type BatterCoverage = "INCLUSIVE" | "QUALIFIED";

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

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function savantRowKey(values: string[], indices: { playerId: number; pitchType: number; team: number }): string {
  return `${values[indices.playerId] ?? ""}\u0000${values[indices.pitchType] ?? ""}\u0000${values[indices.team] ?? ""}`;
}

export function maskInclusiveBatterCsvForQualifiedTeamProxy(inclusiveCsv: string, qualifiedCsv: string): string {
  const inclusiveLines = inclusiveCsv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  const qualifiedLines = qualifiedCsv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (inclusiveLines.length < 2 || qualifiedLines.length < 2) {
    throw new Error("STATCAST_CERTIFIER_SAVANT_CSV_EMPTY");
  }

  const inclusiveHeaders = splitCsvLine(inclusiveLines[0]);
  const qualifiedHeaders = splitCsvLine(qualifiedLines[0]);
  const required = ["player_id", "pitch_type", "team_name_alt"] as const;
  const inclusiveIndex = Object.fromEntries(inclusiveHeaders.map((header, index) => [header, index])) as Record<string, number>;
  const qualifiedIndex = Object.fromEntries(qualifiedHeaders.map((header, index) => [header, index])) as Record<string, number>;
  for (const header of required) {
    if (inclusiveIndex[header] == null || qualifiedIndex[header] == null) {
      throw new Error(`STATCAST_CERTIFIER_SAVANT_CSV_HEADER_MISSING:${header}`);
    }
  }

  const inclusiveKeyIndex = {
    playerId: inclusiveIndex.player_id,
    pitchType: inclusiveIndex.pitch_type,
    team: inclusiveIndex.team_name_alt,
  };
  const qualifiedKeyIndex = {
    playerId: qualifiedIndex.player_id,
    pitchType: qualifiedIndex.pitch_type,
    team: qualifiedIndex.team_name_alt,
  };
  const qualifiedKeys = new Set(
    qualifiedLines.slice(1).map((line) => savantRowKey(splitCsvLine(line), qualifiedKeyIndex)),
  );

  const masked = inclusiveLines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    if (!qualifiedKeys.has(savantRowKey(values, inclusiveKeyIndex))) {
      values[inclusiveIndex.team_name_alt] = "";
    }
    return values.map(csvField).join(",");
  });
  return [inclusiveHeaders.map(csvField).join(","), ...masked].join("\n") + "\n";
}

function parseSavantRequest(rawUrl: string): { role: "batter" | "pitcher"; year: number } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== SAVANT_HOST || url.pathname !== SAVANT_PITCH_ARSENAL_PATH) return null;
  const role = url.searchParams.get("type");
  if (role !== "batter" && role !== "pitcher") return null;
  const year = Number(url.searchParams.get("year"));
  if (!Number.isInteger(year) || year < 2008 || year > 2100) {
    throw new Error("STATCAST_CERTIFIER_SAVANT_YEAR_INVALID");
  }
  return { role, year };
}

export function rewriteStatcastCertifierSavantUrl(rawUrl: string, batterCoverage: BatterCoverage = "INCLUSIVE"): string {
  const request = parseSavantRequest(rawUrl);
  if (!request) return rawUrl;
  const { role, year } = request;
  return buildSavantPitchArsenalUrl({
    role,
    year,
    coverage: role === "batter" ? batterCoverage : "QUALIFIED",
  });
}

export function createStatcastCertifierSourceAlignedFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const rawUrl = inputUrl(input);
    const request = parseSavantRequest(rawUrl);
    if (!request) return baseFetch(input, init);

    if (request.role === "pitcher") {
      const rewrittenUrl = rewriteStatcastCertifierSavantUrl(rawUrl);
      return baseFetch(rewrittenRequestInput(input, rewrittenUrl), init);
    }

    const inclusiveUrl = rewriteStatcastCertifierSavantUrl(rawUrl, "INCLUSIVE");
    const qualifiedUrl = rewriteStatcastCertifierSavantUrl(rawUrl, "QUALIFIED");
    const [inclusiveResponse, qualifiedResponse] = await Promise.all([
      baseFetch(rewrittenRequestInput(input, inclusiveUrl), init),
      baseFetch(rewrittenRequestInput(input, qualifiedUrl), init),
    ]);
    if (!inclusiveResponse.ok) return inclusiveResponse;
    if (!qualifiedResponse.ok) return qualifiedResponse;

    const [inclusiveCsv, qualifiedCsv] = await Promise.all([
      inclusiveResponse.text(),
      qualifiedResponse.text(),
    ]);
    const maskedCsv = maskInclusiveBatterCsvForQualifiedTeamProxy(inclusiveCsv, qualifiedCsv);
    return new globalThis.Response(maskedCsv, {
      status: inclusiveResponse.status,
      statusText: inclusiveResponse.statusText,
      headers: {
        "content-type": inclusiveResponse.headers.get("content-type") || "text/csv; charset=utf-8",
      },
    });
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
