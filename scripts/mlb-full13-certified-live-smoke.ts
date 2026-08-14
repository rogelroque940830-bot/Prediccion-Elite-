import assert from "node:assert/strict";
import { MlbC4CertifiedMaterializer } from "../server/mlb-c4-certified-materializer";
import { classifyMlbFrozenAPlusAndF5 } from "../server/mlb-frozen-a-plus-classifier";
import type { MlbP1SlateGame } from "../server/mlb-p1-daily-slate";

const API_BASE = "https://statsapi.mlb.com/api";
const TARGET_DATE = process.env.MLB_FULL13_SMOKE_DATE ?? "2026-04-10";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function officialBattingOrder(feed: any, side: "home" | "away"): number[] | null {
  const raw = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(positiveInt).filter((id): id is number => id !== null);
  return ids.length === 9 && new Set(ids).size === 9 ? ids : null;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return response.json();
}

async function candidateGames(date: string): Promise<MlbP1SlateGame[]> {
  const schedule = await fetchJson(`${API_BASE}/v1/schedule?sportId=1&gameType=R&date=${encodeURIComponent(date)}`);
  const rawGames = Array.isArray(schedule?.dates)
    ? schedule.dates.flatMap((entry: any) => Array.isArray(entry?.games) ? entry.games : [])
    : [];
  const output: MlbP1SlateGame[] = [];

  for (const raw of rawGames) {
    const gamePk = positiveInt(raw?.gamePk);
    if (!gamePk || clean(raw?.status?.abstractGameState).toLowerCase() !== "final") continue;
    const feed = await fetchJson(`${API_BASE}/v1.1/game/${gamePk}/feed/live`);
    const officialDate = clean(feed?.gameData?.datetime?.officialDate);
    const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
    const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
    const homeStarterId = positiveInt(feed?.gameData?.probablePitchers?.home?.id);
    const awayStarterId = positiveInt(feed?.gameData?.probablePitchers?.away?.id);
    const homeOrder = officialBattingOrder(feed, "home");
    const awayOrder = officialBattingOrder(feed, "away");
    if (officialDate !== date || !homeTeamId || !awayTeamId || !homeStarterId || !awayStarterId || !homeOrder || !awayOrder) continue;

    output.push({
      gamePk,
      startTime: clean(feed?.gameData?.datetime?.dateTime) || null,
      officialDate,
      venue: clean(feed?.gameData?.venue?.name) || null,
      state: "PREGAME",
      detailedState: "Historical pregame proof from official final feed",
      homeTeam: { id: homeTeamId, name: clean(feed?.gameData?.teams?.home?.name) || `Team ${homeTeamId}` },
      awayTeam: { id: awayTeamId, name: clean(feed?.gameData?.teams?.away?.name) || `Team ${awayTeamId}` },
      homePitcher: { id: homeStarterId, name: clean(feed?.gameData?.probablePitchers?.home?.fullName) || `Pitcher ${homeStarterId}`, hand: null, confirmed: true },
      awayPitcher: { id: awayStarterId, name: clean(feed?.gameData?.probablePitchers?.away?.fullName) || `Pitcher ${awayStarterId}`, hand: null, confirmed: true },
      lineupState: "CONFIRMED",
      homeLineupCount: 9,
      awayLineupCount: 9,
      readiness: "READY_TO_ANALYZE",
      analysisStage: "FINAL",
      analysisAllowed: true,
      blockers: [],
      source: {
        name: "MLB_STATS_API",
        fetchedAt: new Date().toISOString(),
        quality: "AUTHORITATIVE",
      },
    });
  }
  return output;
}

async function main(): Promise<void> {
  const materializer = new MlbC4CertifiedMaterializer({
    maxConcurrency: 16,
    timeoutMs: 20_000,
  });
  const candidates = await candidateGames(TARGET_DATE);
  assert.ok(candidates.length > 0, `No official completed target candidates with confirmed lineups on ${TARGET_DATE}`);

  const failures: string[] = [];
  for (const game of candidates) {
    try {
      const full13 = await materializer.assessFull13Game(game);
      assert.equal(Object.keys(full13.featureVector).length, 13);
      for (const [name, value] of Object.entries(full13.featureVector)) {
        assert.equal(typeof value, "number", `${name} must be materialized`);
        assert.ok(Number.isFinite(value), `${name} must be finite`);
      }
      const classifier = classifyMlbFrozenAPlusAndF5(full13.featureVector);
      for (const probability of Object.values(classifier.probabilities)) {
        assert.ok(probability > 0 && probability < 1);
      }

      console.log(JSON.stringify({
        proof: "OFFICIAL_MLB_STATS_API_TO_FULL13_TO_FROZEN_CLASSIFIER",
        mode: "HISTORICAL_PREGAME_NO_MOCK",
        targetDate: TARGET_DATE,
        gamePk: game.gamePk,
        matchup: `${game.awayTeam.name} @ ${game.homeTeam.name}`,
        full13Status: "READY",
        full13BuilderVersion: full13.builderVersion,
        sameDateHistoryAllowed: full13.sameDateHistoryAllowed,
        seasonResetHistory: full13.seasonResetHistory,
        featureVector: full13.featureVector,
        classifierVersion: classifier.version,
        premiumA: classifier.premiumA,
        aPlus: classifier.aPlus,
        f5Consensus: classifier.f5Consensus,
        probabilities: classifier.probabilities,
      }, null, 2));
      return;
    } catch (error) {
      failures.push(`${game.gamePk}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`No candidate produced certified FULL13 READY evidence: ${failures.join(" | ")}`);
}

await main();
