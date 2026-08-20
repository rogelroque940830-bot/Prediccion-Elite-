import assert from "node:assert/strict";
import { MlbFullModularTeamStrengthLiveMaterializer } from "../server/mlb-full-modular-team-strength-live-materializer";

const TARGET_DATE = "2026-08-19";

async function main(): Promise<void> {
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({ timeoutMs: 20_000 });
  const snapshot = await materializer.materializeDate(TARGET_DATE);
  const teamIds = Object.keys(snapshot.priorGames).map(Number).filter(Number.isFinite);
  assert.ok(teamIds.length >= 30, `expected at least 30 MLB teams, got ${teamIds.length}`);
  assert.equal(snapshot.officialDate, TARGET_DATE);
  assert.equal(snapshot.provenance.sameDateOutcomesUsed, false);
  assert.equal(
    snapshot.provenance.structuralRecovery,
    "MLB_OFFICIAL_LIVE_FEED_FOR_INVALID_FINAL_SCHEDULE_ROWS",
  );
  const counts = teamIds.map((teamId) => snapshot.priorGames[teamId]);
  assert.ok(counts.every((value) => Number.isInteger(value) && value > 0));
  console.log(JSON.stringify({
    status: "MLB_FULL_MODULAR_TEAM_STRENGTH_LIVE_SMOKE_PASSED",
    targetDate: TARGET_DATE,
    teamCount: teamIds.length,
    minPriorGames: Math.min(...counts),
    maxPriorGames: Math.max(...counts),
    provenance: snapshot.provenance,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});