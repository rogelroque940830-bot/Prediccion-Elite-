import fs from "node:fs/promises";

const pitcherId = Number(process.env.PITCHER_ID || 605280);
const season = Number(process.env.SEASON || 2026);
const inningCodes = ["i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09"];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge-Source-Audit/1.0)" };

async function fetchJson(url) {
  const response = await fetch(url, { headers: UA });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

function statOf(payload) {
  return payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
}

function inningRows(payload) {
  return (payload?.stats?.[0]?.splits ?? []).map((row) => ({
    splitCode: row?.split?.code ?? null,
    splitDescription: row?.split?.description ?? null,
    inningsPitched: row?.stat?.inningsPitched ?? null,
    earnedRuns: row?.stat?.earnedRuns ?? null,
    gamesPlayed: row?.stat?.gamesPlayed ?? null,
    gamesStarted: row?.stat?.gamesStarted ?? null,
  }));
}

const seasonUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=${season}&group=pitching`;
const gameLogUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`;
const combinedUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=${season}&group=pitching&sitCodes=${inningCodes.join(",")}`;

const [seasonPayload, gameLogPayload, combinedPayload] = await Promise.all([
  fetchJson(seasonUrl),
  fetchJson(gameLogUrl),
  fetchJson(combinedUrl),
]);

const seasonStat = statOf(seasonPayload);
const gameLogSplits = gameLogPayload?.stats?.[0]?.splits ?? [];
const starts = gameLogSplits.filter((row) => Number(row?.stat?.gamesStarted || 0) >= 1);

const individual = {};
for (const code of inningCodes) {
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=${season}&group=pitching&sitCodes=${code}`;
  const payload = await fetchJson(url);
  individual[code] = inningRows(payload);
}

const individualUsable = Object.entries(individual).filter(([, rows]) =>
  rows.some((row) => Number.parseFloat(String(row.inningsPitched ?? "0")) > 0),
).map(([code]) => code);

const combinedRows = inningRows(combinedPayload);
const combinedUsable = combinedRows.filter((row) => Number.parseFloat(String(row.inningsPitched ?? "0")) > 0);

const report = {
  schema: "courtedge-mlb-ere-pitcher-source-audit.v1",
  auditedAt: new Date().toISOString(),
  pitcherId,
  season,
  seasonSummary: {
    inningsPitched: seasonStat?.inningsPitched ?? null,
    era: seasonStat?.era ?? null,
    whip: seasonStat?.whip ?? null,
    wins: seasonStat?.wins ?? null,
    losses: seasonStat?.losses ?? null,
    gamesStarted: seasonStat?.gamesStarted ?? null,
  },
  gameLog: {
    rows: gameLogSplits.length,
    starts: starts.length,
    latestStarts: starts.slice(-5).map((row) => ({
      date: row?.date ?? null,
      gamePk: row?.game?.gamePk ?? null,
      ip: row?.stat?.inningsPitched ?? null,
      er: row?.stat?.earnedRuns ?? null,
      gs: row?.stat?.gamesStarted ?? null,
    })),
  },
  combinedSitCodes: {
    requested: inningCodes,
    rows: combinedRows,
    usableRows: combinedUsable.length,
  },
  individualSitCodes: {
    usableCodes: individualUsable,
    rows: individual,
  },
  diagnosis: {
    seasonDataExists: Number.parseFloat(String(seasonStat?.inningsPitched ?? "0")) >= 30,
    starterHistoryExists: starts.length >= 5,
    combinedCoverageCount: combinedUsable.length,
    individualCoverageCount: individualUsable.length,
    combinedQueryLosesCoverage: individualUsable.length > combinedUsable.length,
  },
};

await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile("artifacts/mlb-ere-pitcher-source-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (!report.diagnosis.seasonDataExists || !report.diagnosis.starterHistoryExists) {
  throw new Error("Clay Holmes control case does not expose sufficient official 2026 season/start history; source audit cannot continue.");
}
