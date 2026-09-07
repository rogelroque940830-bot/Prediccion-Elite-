import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EVIDENCE_SCHEMA = "courtedge-mlb-r1b-statcast-target-date-source-probe.v1" as const;
const USER_AGENT = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Statcast-Probe/1.0)";

interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  sha256: string;
  bytes: number;
  firstLine: string;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

function csvSummary(body: string) {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = lines.length ? splitCsvLine(lines[0]).map((v) => v.trim()) : [];
  return {
    rowCountExcludingHeader: Math.max(0, lines.length - 1),
    headers,
    sampleRows: lines.slice(1, 4),
  };
}

async function fetchText(url: string): Promise<FetchResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}:${body.slice(0, 200)}`);
      }
      return {
        url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
        sha256: sha256(body),
        bytes: Buffer.byteLength(body),
        firstLine: body.split(/\r?\n/, 1)[0] ?? "",
      };
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`STATCAST_TARGET_DATE_PROBE_FETCH_FAILED:${url}:${String(lastError)}`);
}

function withoutBody(result: FetchResult) {
  const { body: _body, ...rest } = result;
  return rest;
}

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function parseGameDates(body: string): string[] {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  const idx = headers.indexOf("game_date");
  if (idx < 0) return [];
  return lines.slice(1).map(splitCsvLine).map((row) => row[idx]).filter(Boolean);
}

async function main() {
  const season = 2025;
  const cutoff = "2025-05-31";
  const rawStart = "2025-05-01";
  const rawEnd = "2025-05-03";

  const expectedBase = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";
  const statcastBase = "https://baseballsavant.mlb.com/leaderboard/statcast";

  const expectedFullUrl = queryUrl(expectedBase, {
    type: "pitcher",
    year: String(season),
    min: "q",
    csv: "true",
  });
  const expectedCutoffUrl = queryUrl(expectedBase, {
    type: "pitcher",
    year: String(season),
    min: "q",
    game_date_lt: cutoff,
    csv: "true",
  });
  const expectedMin1FullUrl = queryUrl(expectedBase, {
    type: "pitcher",
    year: String(season),
    min: "1",
    csv: "true",
  });
  const expectedMin1CutoffUrl = queryUrl(expectedBase, {
    type: "pitcher",
    year: String(season),
    min: "1",
    game_date_lt: cutoff,
    csv: "true",
  });

  const qualityFullUrl = queryUrl(statcastBase, {
    type: "pitcher",
    year: String(season),
    min: "q",
    csv: "true",
  });
  const qualityCutoffUrl = queryUrl(statcastBase, {
    type: "pitcher",
    year: String(season),
    min: "q",
    game_date_lt: cutoff,
    csv: "true",
  });

  const rawSearchUrl = queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", {
    all: "true",
    hfGT: "R|",
    hfSea: `${season}|`,
    player_type: "pitcher",
    game_date_gt: rawStart,
    game_date_lt: rawEnd,
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    type: "details",
  });

  const [
    expectedFull,
    expectedCutoff,
    expectedMin1Full,
    expectedMin1Cutoff,
    qualityFull,
    qualityCutoff,
    rawSearch,
  ] = await Promise.all([
    fetchText(expectedFullUrl),
    fetchText(expectedCutoffUrl),
    fetchText(expectedMin1FullUrl),
    fetchText(expectedMin1CutoffUrl),
    fetchText(qualityFullUrl),
    fetchText(qualityCutoffUrl),
    fetchText(rawSearchUrl),
  ]);

  const expectedFullSummary = csvSummary(expectedFull.body);
  const expectedCutoffSummary = csvSummary(expectedCutoff.body);
  const expectedMin1FullSummary = csvSummary(expectedMin1Full.body);
  const expectedMin1CutoffSummary = csvSummary(expectedMin1Cutoff.body);
  const qualityFullSummary = csvSummary(qualityFull.body);
  const qualityCutoffSummary = csvSummary(qualityCutoff.body);
  const rawSummary = csvSummary(rawSearch.body);
  const rawDates = parseGameDates(rawSearch.body).sort();
  const rawHeaders = new Set(rawSummary.headers);

  const evidence = {
    schemaVersion: EVIDENCE_SCHEMA,
    status: "SOURCE_CAPABILITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    userAgent: USER_AGENT,
    scientificBoundary: {
      productionChanged: false,
      weightsChanged: false,
      targetOutcomesReadForModeling: false,
      marketPricesRead: false,
      r1b2Authorized: false,
      statcastQualityParityCertifiedByThisProbe: false,
    },
    probe: {
      season,
      cutoff,
      rawSearchRange: { start: rawStart, end: rawEnd },
    },
    expectedStatisticsQualified: {
      full: { ...withoutBody(expectedFull), ...expectedFullSummary },
      withGameDateLt: { ...withoutBody(expectedCutoff), ...expectedCutoffSummary },
      identicalPayload: expectedFull.body === expectedCutoff.body,
      identicalSha256: expectedFull.sha256 === expectedCutoff.sha256,
      rowCountChanged: expectedFullSummary.rowCountExcludingHeader !== expectedCutoffSummary.rowCountExcludingHeader,
    },
    expectedStatisticsMin1Diagnostic: {
      full: { ...withoutBody(expectedMin1Full), ...expectedMin1FullSummary },
      withGameDateLt: { ...withoutBody(expectedMin1Cutoff), ...expectedMin1CutoffSummary },
      identicalPayload: expectedMin1Full.body === expectedMin1Cutoff.body,
      identicalSha256: expectedMin1Full.sha256 === expectedMin1Cutoff.sha256,
      rowCountChanged: expectedMin1FullSummary.rowCountExcludingHeader !== expectedMin1CutoffSummary.rowCountExcludingHeader,
    },
    statcastLeaderboardQualified: {
      full: { ...withoutBody(qualityFull), ...qualityFullSummary },
      withGameDateLt: { ...withoutBody(qualityCutoff), ...qualityCutoffSummary },
      identicalPayload: qualityFull.body === qualityCutoff.body,
      identicalSha256: qualityFull.sha256 === qualityCutoff.sha256,
      rowCountChanged: qualityFullSummary.rowCountExcludingHeader !== qualityCutoffSummary.rowCountExcludingHeader,
    },
    dateBoundedRawStatcastSearch: {
      response: { ...withoutBody(rawSearch), ...rawSummary },
      minimumObservedGameDate: rawDates[0] ?? null,
      maximumObservedGameDate: rawDates.at(-1) ?? null,
      observedDateCount: new Set(rawDates).size,
      hasGameDate: rawHeaders.has("game_date"),
      hasPitcherId: rawHeaders.has("pitcher"),
      hasEstimatedWobaUsingSpeedAngle: rawHeaders.has("estimated_woba_using_speedangle"),
      hasWobaValue: rawHeaders.has("woba_value"),
      hasWobaDenom: rawHeaders.has("woba_denom"),
      hasLaunchSpeed: rawHeaders.has("launch_speed"),
      hasLaunchAngle: rawHeaders.has("launch_angle"),
      hasXeraColumn: rawSummary.headers.some((h) => h.toLowerCase() === "xera"),
    },
    finding: {
      expectedStatisticsGameDateLtChangesQualifiedPayload: expectedFull.body !== expectedCutoff.body,
      expectedStatisticsGameDateLtChangesMin1Payload: expectedMin1Full.body !== expectedMin1Cutoff.body,
      statcastLeaderboardGameDateLtChangesQualifiedPayload: qualityFull.body !== qualityCutoff.body,
      rawStatcastSearchReturnsDateBoundedRows: rawDates.length > 0,
      rawStatcastSearchContainsExactXeraColumn: rawSummary.headers.some((h) => h.toLowerCase() === "xera"),
    },
    interpretationPolicy: {
      identicalLeaderboardPayloadWithAndWithoutCutoffMeansParameterIsIgnoredOrDoesNotProvideTargetDateCustody: true,
      differingPayloadIsOnlyA_SOURCE_CAPABILITY_SIGNAL_NOT_PARITY_PROOF: true,
      rawSearchAvailabilityDoesNotByItselfProveExpectedStatisticsLeaderboardSemanticParity: true,
      xeraMayNotBeInferredWithoutIndependentExactEquivalenceProof: true,
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const out = outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-target-date-source-probe/evidence.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    finding: evidence.finding,
    output: out,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
