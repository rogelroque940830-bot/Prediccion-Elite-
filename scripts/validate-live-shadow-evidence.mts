import {
  classifyMlbInjuryShadow,
  fetchOfficialMlbInjurySnapshot,
  summarizeMlbInjuryShadow,
} from "../server/mlb-injury-shadow.ts";

const date = "2026-07-27";
const backend = "https://web-p0-integration.up.railway.app";
const payload = await (await fetch(`${backend}/api/mlb/all?date=${date}`)).json();
const games = payload.games ?? [];
const teamIds = [...new Set(games.flatMap((game) => [game.homeTeam.id, game.awayTeam.id]))];
const started = Date.now();
const snapshots = Object.fromEntries(await Promise.all(teamIds.map(async (teamId) => [teamId, await fetchOfficialMlbInjurySnapshot(teamId, date)])));
const verified = Object.values(snapshots).filter((snapshot) => snapshot.status === "VERIFIED").length;
console.log(`COVERAGE teams=${teamIds.length} verified=${verified} partial=${teamIds.length - verified} elapsedMs=${Date.now() - started}`);
if (verified < Math.ceil(teamIds.length * 0.9)) throw new Error("Official source coverage below 90%");

const game = games.find((item) => item.gamePk === 822868 || item.gameId === 822868);
if (!game) throw new Error("SEA-TEX missing");
const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
async function resolve(name, teamId) {
  const url = new URL("https://statsapi.mlb.com/api/v1/people/search");
  url.searchParams.set("names", name);
  url.searchParams.set("season", "2026");
  url.searchParams.set("hydrate", "currentTeam");
  const data = await (await fetch(url)).json();
  return data.people?.find((person) => person.currentTeam?.id === teamId && normalize(person.fullName) === normalize(name))?.id ?? null;
}
for (const side of ["home", "away"]) {
  const team = game[`${side}Team`];
  const pitcher = game[`${side}Pitcher`];
  const injuries = game[`${side}Injuries`] ?? [];
  const snapshot = snapshots[team.id];
  const shadows = [];
  const bdlIds = new Set();
  console.log(`TEAM ${team.name} detected=${injuries.length}`);
  for (const player of injuries) {
    const playerId = await resolve(player.name, team.id);
    if (!playerId) throw new Error(`Unresolved identity: ${player.name}`);
    bdlIds.add(playerId);
    const roster = snapshot.rosterByPlayerId[playerId];
    const shadow = classifyMlbInjuryShadow({
      playerId,
      name: player.name,
      isPitcher: Boolean(player.isPitcher),
      position: player.position,
      rosterStatusCode: roster?.statusCode ?? null,
      rosterStatusDescription: roster?.statusDescription ?? null,
      latestTransaction: snapshot.latestTransactionByPlayerId[playerId] ?? null,
      probablePitcherId: pitcher?.id ?? null,
      gamesStarted: player.gamesStarted,
      saves: player.saves,
      holds: player.holds,
      gamesFinished: player.gamesFinished,
      inningsPitched: player.inningsPitched,
      plateAppearances: player.plateAppearances,
      ops: player.ops,
      obp: player.obp,
      slg: player.slg,
      asOfDate: date,
    });
    shadows.push(shadow);
    console.log(`PLAYER ${player.name} | MLB=${roster?.statusDescription ?? "none"} | ${shadow.decision}/${shadow.confidence} | ${shadow.reasonCode}`);
  }
  const officialOnly = Object.values(snapshot.rosterByPlayerId)
    .filter((entry) => /^D\d+$/i.test(String(entry.statusCode || "")) || /injured/i.test(String(entry.statusDescription || "")))
    .filter((entry) => !bdlIds.has(Number(entry.playerId))).length;
  console.log(`SUMMARY ${team.name} ${JSON.stringify({ ...summarizeMlbInjuryShadow(shadows), officialOnly })}`);
}
