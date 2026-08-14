import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVsTeamStatsUrl,
  getStatcastMatchupCombinedIdentitySafe,
  recomputeStatcastRunsDelta,
} from "./mlb-statcast-matchup-vsteam-identity";

test("vsTeam URL requires a numeric MLB opposing team id", () => {
  const url = buildVsTeamStatsUrl(101, 116, 2026);
  assert.match(url, /opposingTeamId=116(?:&|$)/);
  assert.doesNotMatch(url, /opposingTeamId=DET/);
  assert.throws(
    () => buildVsTeamStatsUrl(101, "DET" as unknown as number, 2026),
    /STATCAST_VSTEAM_OPPOSING_TEAM_ID_REQUIRED/,
  );
});

test("50/25/25 statcast weights remain frozen", () => {
  const value = recomputeStatcastRunsDelta({
    starterRunsDelta: 0.40,
    bullpenRunsDelta: 0.20,
    teamOpsVsOpp: 0.820,
  });
  // 0.40*0.50 + 0.20*0.25 + ((0.820-0.720)*4)*0.25 = 0.35
  assert.equal(value, 0.35);
});

test("identity-safe combined result queries numeric opponent ids and only recomputes the vs-team term", async () => {
  const urls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const opponent = new URL(url).searchParams.get("opposingTeamId");
    const ops = opponent === "116" ? "0.820" : opponent === "112" ? "0.620" : "0.720";
    return new Response(JSON.stringify({
      stats: [{ splits: [{ stat: {
        plateAppearances: "10",
        avg: ".250",
        ops,
        homeRuns: "1",
        rbi: "3",
      } }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const legacyEngine = async () => ({
    homeLineupVsAwaySP: {
      expectedTeamRunsDelta: 0.40,
      perBatter: [{ batterId: 101, batterName: "Home Batter" }],
      bullpenMatchup: [{ expectedRunsDelta: 0.20 }],
    },
    awayLineupVsHomeSP: {
      expectedTeamRunsDelta: -0.20,
      perBatter: [{ batterId: 202, batterName: "Away Batter" }],
      bullpenMatchup: [{ expectedRunsDelta: -0.10 }],
    },
    homeLineupVsAwayTeam: { rows: [], teamOpsVsOpp: 0.720, signal: "legacy neutral" },
    awayLineupVsHomeTeam: { rows: [], teamOpsVsOpp: 0.720, signal: "legacy neutral" },
    homeRunsDelta: 0.25,
    awayRunsDelta: -0.10,
    untouchedMarker: "PRESERVED",
  }) as any;

  const result = await getStatcastMatchupCombinedIdentitySafe({
    gamePk: 765432,
    homeTeamId: 112,
    awayTeamId: 116,
    homePitcherId: 11,
    homePitcherName: "Home Starter",
    awayPitcherId: 22,
    awayPitcherName: "Away Starter",
    homeTeamAbbrev: "CHC",
    awayTeamAbbrev: "DET",
    season: 2026,
    fetchImpl,
    legacyEngine: legacyEngine as any,
  });

  assert.equal(urls.length, 2);
  assert.ok(urls.some((url) => /opposingTeamId=116(?:&|$)/.test(url)));
  assert.ok(urls.some((url) => /opposingTeamId=112(?:&|$)/.test(url)));
  assert.ok(urls.every((url) => !/opposingTeamId=(CHC|DET)/.test(url)));

  assert.equal(result.homeLineupVsAwayTeam.identity.opposingTeamId, 116);
  assert.equal(result.awayLineupVsHomeTeam.identity.opposingTeamId, 112);
  assert.equal(result.homeLineupVsAwayTeam.teamOpsVsOpp, 0.820);
  assert.equal(result.awayLineupVsHomeTeam.teamOpsVsOpp, 0.620);
  assert.equal(result.homeRunsDelta, 0.35);
  // -0.20*0.50 + -0.10*0.25 + ((0.620-0.720)*4)*0.25 = -0.225;
  // production uses Math.round(value*100)/100, and Math.round(-22.5) is -22.
  assert.equal(result.awayRunsDelta, -0.22);
  assert.equal(result.untouchedMarker, "PRESERVED");
  assert.deepEqual(result.identityCorrection.weightsPreserved, { starter: 0.50, bullpen: 0.25, vsTeam: 0.25 });
});

test("no usable current lineup keeps the historical term at the existing neutral 0.720", async () => {
  let calls = 0;
  const result = await getStatcastMatchupCombinedIdentitySafe({
    gamePk: 765432,
    homeTeamId: 112,
    awayTeamId: 116,
    homePitcherId: 0,
    homePitcherName: "",
    awayPitcherId: 0,
    awayPitcherName: "",
    homeTeamAbbrev: "CHC",
    awayTeamAbbrev: "DET",
    season: 2026,
    fetchImpl: async () => { calls++; return new Response("unexpected", { status: 500 }); },
    legacyEngine: (async () => ({
      homeLineupVsAwaySP: { expectedTeamRunsDelta: 0, perBatter: [], bullpenMatchup: [] },
      awayLineupVsHomeSP: { expectedTeamRunsDelta: 0, perBatter: [], bullpenMatchup: [] },
    })) as any,
  });

  assert.equal(calls, 0);
  assert.equal(result.homeLineupVsAwayTeam.teamOpsVsOpp, 0.720);
  assert.equal(result.awayLineupVsHomeTeam.teamOpsVsOpp, 0.720);
  assert.equal(result.homeRunsDelta, 0);
  assert.equal(result.awayRunsDelta, 0);
});
