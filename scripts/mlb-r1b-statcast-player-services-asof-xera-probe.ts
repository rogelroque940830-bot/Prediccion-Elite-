import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-player-services-asof-xera-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-PlayerServices-xERA/1.0)";
const BASE = "https://baseballsavant.mlb.com";

const SUBJECTS = [
  { playerId: 657277, name: "Logan Webb", season: 2025 },
  { playerId: 694973, name: "Paul Skenes", season: 2025 },
] as const;
const CUTS = ["", "2025-05-31", "2025-07-31", "2025-09-28"] as const;

type Probe = {
  id: string;
  endpoint: string;
  url: string;
  playerId: number;
  playerName: string;
  season: number;
  requestedGameDate: string | null;
  status: number | null;
  ok: boolean;
  contentType: string | null;
  bodyBytes: number;
  bodySha256: string | null;
  jsonParsed: boolean;
  topLevelType: string | null;
  topLevelKeys: string[];
  interestingPaths: Array<{ path: string; value: unknown }>;
  error: string | null;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function interestingKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["xera", "era", "xwoba", "woba", "gamedate", "date", "season", "pa", "bf", "innings", "ip"].includes(k)
    || k.includes("xera")
    || k.includes("xwoba")
    || k.includes("gamedate")
    || k === "era";
}

function collectInteresting(value: unknown, prefix = "$", out: Array<{ path: string; value: unknown }> = [], depth = 0): Array<{ path: string; value: unknown }> {
  if (out.length >= 120 || depth > 8 || value == null) return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 12) && out.length < 120; i++) collectInteresting(value[i], `${prefix}[${i}]`, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${prefix}.${key}`;
      if (interestingKey(key) && (child == null || ["string", "number", "boolean"].includes(typeof child))) {
        out.push({ path: childPath, value: child });
      }
      collectInteresting(child, childPath, out, depth + 1);
      if (out.length >= 120) break;
    }
  }
  return out;
}

function buildStatcastPitchingUrl(playerId: number, season: number, gameDate: string, tab: string): string {
  const u = new URL("/player-services/statcast-pitching", BASE);
  u.searchParams.set("playerId", String(playerId));
  u.searchParams.set("position", "1");
  u.searchParams.set("teamId", "");
  u.searchParams.set("gameDate", gameDate);
  u.searchParams.set("season", String(season));
  u.searchParams.set("type", "details");
  u.searchParams.set("tab", tab);
  return u.toString();
}

function buildPitchesBreakdownUrl(playerId: number, season: number, gameDate: string): string {
  const u = new URL("/player-services/statcast-pitches-breakdown", BASE);
  u.searchParams.set("playerId", String(playerId));
  u.searchParams.set("position", "1");
  u.searchParams.set("pitchBreakdown", "pitches");
  u.searchParams.set("timeFrame", "yearly");
  u.searchParams.set("season", String(season));
  u.searchParams.set("updatePitches", "true");
  if (gameDate) u.searchParams.set("gameDate", gameDate);
  return u.toString();
}

function buildRollingThumbUrl(playerId: number, playerType: string | null): string {
  const u = new URL("/player-services/rolling-thumb", BASE);
  u.searchParams.set("playerId", String(playerId));
  if (playerType != null) u.searchParams.set("playerType", playerType);
  return u.toString();
}

async function fetchProbe(input: Omit<Probe, "status" | "ok" | "contentType" | "bodyBytes" | "bodySha256" | "jsonParsed" | "topLevelType" | "topLevelKeys" | "interestingPaths" | "error">): Promise<Probe> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(input.url, {
        headers: { Accept: "application/json,text/plain;q=0.9,*/*;q=0.8", "User-Agent": UA, Referer: `${BASE}/` },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.text();
      let parsed: unknown = null;
      let jsonParsed = false;
      try { parsed = JSON.parse(body); jsonParsed = true; } catch { /* diagnostic */ }
      const topLevelKeys = jsonParsed && parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed as Record<string, unknown>).sort()
        : [];
      return {
        ...input,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        bodyBytes: Buffer.byteLength(body),
        bodySha256: sha256(body),
        jsonParsed,
        topLevelType: jsonParsed ? (Array.isArray(parsed) ? "array" : typeof parsed) : null,
        topLevelKeys,
        interestingPaths: jsonParsed ? collectInteresting(parsed) : [],
        error: response.ok ? null : `HTTP_${response.status}:${body.slice(0, 180)}`,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  return {
    ...input,
    status: null,
    ok: false,
    contentType: null,
    bodyBytes: 0,
    bodySha256: null,
    jsonParsed: false,
    topLevelType: null,
    topLevelKeys: [],
    interestingPaths: [],
    error: String(lastError),
  };
}

function compareByDate(probes: readonly Probe[], endpointPrefix: string, playerId: number) {
  const rows = probes.filter((p) => p.endpoint.startsWith(endpointPrefix) && p.playerId === playerId && p.bodySha256);
  const baseline = rows.find((p) => p.requestedGameDate == null);
  return {
    endpointPrefix,
    playerId,
    availableRows: rows.length,
    baselineSha256: baseline?.bodySha256 ?? null,
    dateVariants: rows.filter((p) => p.requestedGameDate != null).map((p) => ({
      gameDate: p.requestedGameDate,
      sha256: p.bodySha256,
      differsFromBlank: baseline?.bodySha256 != null ? p.bodySha256 !== baseline.bodySha256 : null,
      xeraPaths: p.interestingPaths.filter((x) => x.path.toLowerCase().includes("xera")),
      eraPaths: p.interestingPaths.filter((x) => /(^|\.)era$/i.test(x.path)),
      xwobaPaths: p.interestingPaths.filter((x) => x.path.toLowerCase().includes("xwoba")),
      datePaths: p.interestingPaths.filter((x) => x.path.toLowerCase().includes("date")).slice(0, 12),
    })),
  };
}

async function main() {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outputPath = outArg?.slice("--out=".length) || "artifacts/mlb-r1b-statcast-player-services-asof-xera-probe/evidence.json";
  const requests: Array<Promise<Probe>> = [];

  for (const subject of SUBJECTS) {
    for (const tab of ["pitches", "statcast", "breakdowns"] as const) {
      for (const gameDate of CUTS) {
        requests.push(fetchProbe({
          id: `statcast-pitching:${subject.playerId}:${tab}:${gameDate || "blank"}`,
          endpoint: `statcast-pitching:${tab}`,
          url: buildStatcastPitchingUrl(subject.playerId, subject.season, gameDate, tab),
          playerId: subject.playerId,
          playerName: subject.name,
          season: subject.season,
          requestedGameDate: gameDate || null,
        }));
      }
    }
    for (const gameDate of CUTS) {
      requests.push(fetchProbe({
        id: `pitches-breakdown:${subject.playerId}:${gameDate || "blank"}`,
        endpoint: "statcast-pitches-breakdown",
        url: buildPitchesBreakdownUrl(subject.playerId, subject.season, gameDate),
        playerId: subject.playerId,
        playerName: subject.name,
        season: subject.season,
        requestedGameDate: gameDate || null,
      }));
    }
    for (const playerType of [null, "Y", "N", "P"] as const) {
      requests.push(fetchProbe({
        id: `rolling-thumb:${subject.playerId}:${playerType ?? "blank"}`,
        endpoint: `rolling-thumb:${playerType ?? "blank"}`,
        url: buildRollingThumbUrl(subject.playerId, playerType),
        playerId: subject.playerId,
        playerName: subject.name,
        season: subject.season,
        requestedGameDate: null,
      }));
    }
  }

  const probes = await Promise.all(requests);
  const successfulJson = probes.filter((p) => p.ok && p.jsonParsed);
  if (successfulJson.length === 0) throw new Error("PLAYER_SERVICES_PROBE_NO_JSON_RESPONSES");

  const comparisons = SUBJECTS.flatMap((subject) => [
    ...["statcast-pitching:pitches", "statcast-pitching:statcast", "statcast-pitching:breakdowns"].map((endpoint) => compareByDate(probes, endpoint, subject.playerId)),
    compareByDate(probes, "statcast-pitches-breakdown", subject.playerId),
  ]);

  const xeraExposures = probes.flatMap((p) => p.interestingPaths
    .filter((item) => item.path.toLowerCase().includes("xera"))
    .map((item) => ({ probeId: p.id, playerId: p.playerId, requestedGameDate: p.requestedGameDate, path: item.path, value: item.value })));
  const xwobaExposures = probes.flatMap((p) => p.interestingPaths
    .filter((item) => item.path.toLowerCase().includes("xwoba"))
    .map((item) => ({ probeId: p.id, playerId: p.playerId, requestedGameDate: p.requestedGameDate, path: item.path, value: item.value })));

  const dateSensitiveComparisons = comparisons.filter((c) => c.dateVariants.some((v) => v.differsFromBlank === true));
  const dateSensitiveWithXera = dateSensitiveComparisons.filter((c) => c.dateVariants.some((v) => v.xeraPaths.length > 0));

  const evidence = {
    schemaVersion: SCHEMA,
    status: "PLAYER_SERVICES_ASOF_XERA_SOURCE_DISCOVERY_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    discoveryBasis: {
      officialDomain: BASE,
      endpointDiscovery: [
        "Public Baseball Savant player pages expose rolling charts and season Statcast data.",
        "Public client implementations identify /player-services/rolling-thumb, /player-services/statcast-pitching, and /player-services/statcast-pitches-breakdown as Savant-backed services.",
      ],
      authorityPolicy: "Only response behavior from the baseballsavant.mlb.com primary domain is eligible to advance source custody. Third-party code is endpoint-discovery evidence only.",
    },
    subjects: SUBJECTS,
    cuts: CUTS,
    probes,
    comparisons,
    summary: {
      totalProbes: probes.length,
      successfulJsonResponses: successfulJson.length,
      xeraExposureCount: xeraExposures.length,
      xwobaExposureCount: xwobaExposures.length,
      dateSensitiveComparisonCount: dateSensitiveComparisons.length,
      dateSensitiveComparisonWithXeraCount: dateSensitiveWithXera.length,
      xeraExposures,
      xwobaExposureExamples: xwobaExposures.slice(0, 30),
    },
    scientificConclusion: {
      primaryDomainEndpointEvidenceCollected: true,
      directAsOfXeraCandidateObserved: dateSensitiveWithXera.length > 0,
      directAsOfXeraCustodyProven: false,
      familyPromotionAuthorized: false,
      nextGate: dateSensitiveWithXera.length > 0
        ? "VALIDATE_DATE_SEMANTICS_AGAINST KNOWN PRE/POST GAME CUTOFFS, CROSS-PLAYER COVERAGE, AND EXACT EXPECTED_STATISTICS VALUES BEFORE CLAIMING AS-OF CUSTODY"
        : "NO TESTED PLAYER-SERVICES ROUTE BOTH CHANGED WITH GAME_DATE AND EXPOSED xERA; CONTINUE PRIMARY-DOMAIN ENDPOINT/ARCHIVAL DISCOVERY WITHOUT EMPIRICAL RECONSTRUCTION",
    },
    interpretationPolicy: {
      parameterPresenceAloneDoesNotProveServerSideFiltering: true,
      changedPayloadAloneDoesNotProveAsOfSemantics: true,
      thirdPartyEndpointDiscoveryIsNotDataAuthority: true,
      noEmpiricalXeraFitAuthorized: true,
      finalSeasonMappingRetroactiveUseForbidden: true,
    },
    scientificBoundary: {
      researchOnly: true,
      productionChanged: false,
      weightsChanged: false,
      routingChanged: false,
      stakingChanged: false,
      betEliteChanged: false,
      marketPricesRead: false,
      targetOutcomeReadForModeling: false,
      automaticBetPlacementAllowed: false,
      realFinancialExposure: 0,
      r1b2Authorized: false,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    summary: evidence.summary,
    scientificConclusion: evidence.scientificConclusion,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
