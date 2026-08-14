import assert from "node:assert/strict";
import { MlbC4CertifiedMaterializer } from "../server/mlb-c4-certified-materializer";
import type { MlbP1SlateGame } from "../server/mlb-p1-daily-slate";
import { scoreMlbV16SettlementEvidence } from "../server/mlb-pure-settlement-scorer";

const API_BASE = "https://statsapi.mlb.com/api";
const TARGET_DATE = process.env.MLB_C4_SMOKE_DATE ?? "2026-04-10";

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

async function candidateGames(date: string): Promise<Array<{ game: MlbP1SlateGame; feed: any }>> {
  const schedule = await fetchJson(`${API_BASE}/v1/schedule?sportId=1&gameType=R&date=${encodeURIComponent(date)}`);
  const rawGames = Array.isArray(schedule?.dates)
    ? schedule.dates.flatMap((entry: any) => Array.isArray(entry?.games) ? entry.games : [])
    : [];
  const output: Array<{ game: MlbP1SlateGame; feed: any }> = [];

  for (const raw of rawGames) {
    const gamePk = positiveInt(raw?.gamePk);
    if (!gamePk) continue;
    const abstract = clean(raw?.status?.abstractGameState).toLowerCase();
    if (abstract !== "final") continue;
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
      feed,
      game: {
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
        homeLineupCount: homeOrder.length,
        awayLineupCount: awayOrder.length,
        readiness: "READY_TO_ANALYZE",
        analysisStage: "FINAL",
        analysisAllowed: true,
        blockers: [],
        source: {
          name: "MLB_STATS_API",
          fetchedAt: new Date().toISOString(),
          quality: "AUTHORITATIVE",
        },
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
  for (const candidate of candidates) {
    try {
      const c4 = await materializer.assessGame(candidate.game);
      for (const [name, value] of Object.entries(c4.featureVector)) {
        assert.equal(typeof value, "number", `${name} must be materialized`);
        assert.ok(Number.isFinite(value), `${name} must be finite`);
      }
      const v16 = scoreMlbV16SettlementEvidence(
        candidate.game.gamePk,
        `${TARGET_DATE}T20:00:00.000Z`,
        c4,
      );
      assert.ok(v16.fullGame.homeWinProbability > 0 && v16.fullGame.homeWinProbability < 1);
      assert.ok(v16.first5.homeWinProbability > 0 && v16.first5.homeWinProbability < 1);

      console.log(JSON.stringify({
        proof: "OFFICIAL_MLB_STATS_API_TO_C4_TO_V16",
        mode: "HISTORICAL_PREGAME_NO_MOCK",
        targetDate: TARGET_DATE,
        gamePk: candidate.game.gamePk,
        matchup: `${candidate.game.awayTeam.name} @ ${candidate.game.homeTeam.name}`,
        c4Status: "READY",
        c4BuilderVersion: c4.builderVersion,
        sameDateHistoryAllowed: c4.sameDateHistoryAllowed,
        seasonResetHistory: c4.seasonResetHistory,
        diagnostics: c4.diagnostics,
        featureVector: c4.featureVector,
        v16Status: "SCORED",
        v16ModelVersion: v16.modelVersion,
        fullGameHomeProbability: v16.fullGame.homeWinProbability,
        first5HomeProbability: v16.first5.homeWinProbability,
      }, null, 2));
      return;
    } catch (error) {
      failures.push(`${candidate.game.gamePk}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`No candidate produced certified C4 READY evidence: ${failures.join(" | ")}`);
}

await main();
