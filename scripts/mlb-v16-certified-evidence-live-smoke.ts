import assert from "node:assert/strict";
import { MlbC4CertifiedMaterializer } from "../server/mlb-c4-certified-materializer";
import { getBullpenStatus, resetMlbBullpenCachesForTests } from "../server/mlb-bullpen";
import { buildMlbP1DailySlate } from "../server/mlb-p1-daily-slate";
import { MlbV15BullpenD1Materializer } from "../server/mlb-v15-bullpen-d1-materializer";

function easternDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function main(): Promise<void> {
  const now = new Date();
  const targetDate = process.env.MLB_V16_LIVE_SMOKE_DATE ?? easternDate(now);
  const slate = await buildMlbP1DailySlate({ date: targetDate, now });
  const ready = slate.games.filter((game) => game.analysisAllowed && game.analysisStage === "FINAL");
  assert.ok(ready.length > 0, `No FINAL-input pregame games available for ${targetDate}`);

  const c4 = new MlbC4CertifiedMaterializer({ maxConcurrency: 16, timeoutMs: 20_000 });
  const v15 = new MlbV15BullpenD1Materializer({ maxConcurrency: 12, timeoutMs: 20_000 });
  const failures: string[] = [];

  await Promise.all(ready.map(async (game) => {
    try {
      await c4.assessGame(game);
    } catch (error) {
      failures.push(`C4:${game.gamePk}:${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await v15.assessGame({
        gamePk: game.gamePk,
        officialDate: game.officialDate,
        homeTeamId: Number(game.homeTeam.id),
        awayTeamId: Number(game.awayTeam.id),
        now,
      });
    } catch (error) {
      failures.push(`V15_D1:${game.gamePk}:${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  resetMlbBullpenCachesForTests();
  const teams = new Map<number, string>();
  for (const game of ready) {
    if (game.homeTeam.id) teams.set(game.homeTeam.id, game.homeTeam.name);
    if (game.awayTeam.id) teams.set(game.awayTeam.id, game.awayTeam.name);
  }
  await Promise.all([...teams].map(async ([teamId, teamName]) => {
    try {
      await getBullpenStatus(teamId, teamName, { now: () => now });
    } catch (error) {
      failures.push(`BULLPEN:${teamId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  resetMlbBullpenCachesForTests();

  if (failures.length > 0) {
    failures.sort();
    throw new Error(`MLB_V16_CERTIFIED_EVIDENCE_LIVE_SMOKE_FAILED\n${failures.join("\n")}`);
  }

  console.log(JSON.stringify({
    proof: "MLB_V16_CERTIFIED_EVIDENCE_LIVE_SMOKE",
    targetDate,
    finalReadyGames: ready.length,
    teamsVerified: teams.size,
    c4: "READY",
    v15BullpenD1: "READY",
    bullpenAvailability: "READY",
    paidOddsRead: false,
    automaticBetPlacement: false,
    realFinancialExposure: 0,
  }, null, 2));
}

await main();
