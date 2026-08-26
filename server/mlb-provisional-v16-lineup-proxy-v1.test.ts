import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_PROVISIONAL_V16_LINEUP_PROXY_METHOD,
  assessMlbProvisionalV16LineupProxy,
  type MlbProvisionalV16HistoricalSnapshotSource,
} from "./mlb-provisional-v16-lineup-proxy-v1";

const targetDate = "2026-08-26";
const gamePk = 900001;
const homeTeamId = 10;
const awayTeamId = 20;
const homeStarterId = 101;
const awayStarterId = 202;

function priorDates(): string[] {
  return ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-25"];
}

function lineup(teamBase: number, date: string, sourcePk: number) {
  return {
    officialDate: date,
    gamePk: sourcePk,
    battingOrder: Array.from({ length: 9 }, (_, index) => teamBase + index + 1),
  };
}

function snapshotSource(options: {
  includeSameDateTemptation?: boolean;
  mismatchCounts?: boolean;
  noPriorLineup?: boolean;
} = {}): MlbProvisionalV16HistoricalSnapshotSource {
  return {
    async getHistoricalSnapshot(season, cutoffDate) {
      assert.equal(season, 2026);
      assert.equal(cutoffDate, targetDate);
      const dates = priorDates();
      const homeTeamHistory = dates.map((officialDate, i) => ({
        officialDate,
        gamePk: 700000 + i,
        runsFor: 4 + (i % 2),
        runsAgainst: 3 + (i % 2),
      }));
      const awayTeamHistory = dates.map((officialDate, i) => ({
        officialDate,
        gamePk: 710000 + i,
        runsFor: 3 + (i % 2),
        runsAgainst: 4 + (i % 2),
      }));
      let homeLineups = options.noPriorLineup
        ? []
        : dates.map((officialDate, i) => lineup(1000, officialDate, 720000 + i));
      let awayLineups = options.noPriorLineup
        ? []
        : dates.map((officialDate, i) => lineup(2000, officialDate, 730000 + i));
      if (options.includeSameDateTemptation) {
        homeTeamHistory.push({ officialDate: targetDate, gamePk: 799991, runsFor: 99, runsAgainst: 0 });
        awayTeamHistory.push({ officialDate: targetDate, gamePk: 799992, runsFor: 99, runsAgainst: 0 });
        homeLineups = [...homeLineups, lineup(3000, targetDate, 799991)];
        awayLineups = [...awayLineups, lineup(4000, targetDate, 799992)];
      }
      if (options.mismatchCounts && homeLineups.length > 0) homeLineups = homeLineups.slice(0, -1);

      const pitcherLine = (pitcherId: number, officialDate: string, pk: number, k: number, bb: number) => ({
        officialDate,
        gamePk: pk,
        pitcherId,
        battersFaced: 24,
        strikeOuts: k,
        baseOnBalls: bb,
        earnedRuns: 2,
        homeRuns: 1,
      });
      const homeStarterHistory = dates.slice(0, 3).map((d, i) => pitcherLine(homeStarterId, d, 740000 + i, 7, 2));
      const awayStarterHistory = dates.slice(0, 3).map((d, i) => pitcherLine(awayStarterId, d, 750000 + i, 5, 3));
      const leagueStarterHistory = [
        ...homeStarterHistory,
        ...awayStarterHistory,
        pitcherLine(303, "2026-08-24", 760000, 6, 2),
      ];

      return {
        season: 2026,
        cutoffDate: targetDate,
        teamHistoryByTeam: new Map([
          [homeTeamId, homeTeamHistory],
          [awayTeamId, awayTeamHistory],
        ]),
        lineupHistoryByTeam: new Map([
          [homeTeamId, homeLineups],
          [awayTeamId, awayLineups],
        ]),
        starterHistoryByPitcher: new Map([
          [homeStarterId, homeStarterHistory],
          [awayStarterId, awayStarterHistory],
        ]),
        leagueStarterHistory,
      };
    },
  };
}

function provisionalGame(overrides: Record<string, unknown> = {}) {
  return {
    gamePk,
    startTime: "2026-08-26T23:10:00.000Z",
    officialDate: targetDate,
    homeTeam: { id: homeTeamId, name: "Home Club" },
    awayTeam: { id: awayTeamId, name: "Away Club" },
    homePitcher: { id: homeStarterId, name: "Home Starter", hand: "R", confirmed: true },
    awayPitcher: { id: awayStarterId, name: "Away Starter", hand: "L", confirmed: true },
    lineupState: "NOT_POSTED",
    analysisStage: "PROVISIONAL",
    analysisAllowed: true,
    ...overrides,
  } as any;
}

function currentIdentityFetch(options: { homeStarterId?: number; includeCurrentLineup?: boolean } = {}) {
  return async () => new Response(JSON.stringify({
    gamePk,
    gameData: {
      datetime: { officialDate: targetDate },
      teams: { home: { id: homeTeamId }, away: { id: awayTeamId } },
      probablePitchers: {
        home: { id: options.homeStarterId ?? homeStarterId },
        away: { id: awayStarterId },
      },
    },
    liveData: options.includeCurrentLineup ? {
      boxscore: {
        teams: {
          home: { battingOrder: Array.from({ length: 9 }, (_, i) => 9000 + i) },
          away: { battingOrder: Array.from({ length: 9 }, (_, i) => 9100 + i) },
        },
      },
    } : undefined,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("provisional game scores frozen V16 from strictly prior lineup proxy", async () => {
  const result = await assessMlbProvisionalV16LineupProxy(provisionalGame(), {
    snapshotSource: snapshotSource(),
    fetchImpl: currentIdentityFetch(),
    generatedAt: "2026-08-26T14:00:00.000Z",
  });

  assert.equal(result.projection.method, MLB_PROVISIONAL_V16_LINEUP_PROXY_METHOD);
  assert.equal(result.projection.homeSourceOfficialDate, "2026-08-25");
  assert.equal(result.projection.awaySourceOfficialDate, "2026-08-25");
  assert.equal(result.projection.homeProjectedBattingOrder.length, 9);
  assert.equal(result.projection.awayProjectedBattingOrder.length, 9);
  assert.equal(result.c4Assessment.featureVector.lineup_exposure_rate_adv, 0);
  assert.ok(Object.values(result.c4Assessment.featureVector).every((value) => typeof value === "number" && Number.isFinite(value)));
  assert.ok(Math.abs(result.v16Evidence.fullGame.homeWinProbability + result.v16Evidence.fullGame.awayWinProbability - 1) < 1e-10);
  assert.equal(result.policy.currentGameOfficialLineupRead, false);
  assert.equal(result.policy.outcomesRead, false);
  assert.equal(result.policy.marketPricesRead, false);
  assert.equal(result.policy.v68Changed, false);
  assert.equal(result.policy.v80Changed, false);
});

test("current official battingOrder is irrelevant to provisional projection", async () => {
  const withoutCurrentLineup = await assessMlbProvisionalV16LineupProxy(provisionalGame(), {
    snapshotSource: snapshotSource(),
    fetchImpl: currentIdentityFetch({ includeCurrentLineup: false }),
    generatedAt: "2026-08-26T14:00:00.000Z",
  });
  const withCurrentLineup = await assessMlbProvisionalV16LineupProxy(provisionalGame(), {
    snapshotSource: snapshotSource(),
    fetchImpl: currentIdentityFetch({ includeCurrentLineup: true }),
    generatedAt: "2026-08-26T14:00:00.000Z",
  });
  assert.deepEqual(withCurrentLineup.projection, withoutCurrentLineup.projection);
  assert.deepEqual(withCurrentLineup.c4Assessment.featureVector, withoutCurrentLineup.c4Assessment.featureVector);
  assert.deepEqual(withCurrentLineup.v16Evidence.fullGame, withoutCurrentLineup.v16Evidence.fullGame);
});

test("same-date lineup temptation cannot become the projection source", async () => {
  await assert.rejects(
    assessMlbProvisionalV16LineupProxy(provisionalGame(), {
      snapshotSource: snapshotSource({ includeSameDateTemptation: true }),
      fetchImpl: currentIdentityFetch(),
    }),
    /C4_HISTORY_NOT_STRICTLY_PREGAME|C4_CERTIFIED|MLB_PROVISIONAL_V16/,
  );
});

test("FINAL stage is rejected because this scorer is provisional-only", async () => {
  await assert.rejects(
    assessMlbProvisionalV16LineupProxy(provisionalGame({ analysisStage: "FINAL", lineupState: "CONFIRMED" }), {
      snapshotSource: snapshotSource(),
      fetchImpl: currentIdentityFetch(),
    }),
    /MLB_PROVISIONAL_V16_STAGE_REQUIRED/,
  );
});

test("current probable-pitcher identity mismatch fails closed", async () => {
  await assert.rejects(
    assessMlbProvisionalV16LineupProxy(provisionalGame(), {
      snapshotSource: snapshotSource(),
      fetchImpl: currentIdentityFetch({ homeStarterId: 999 }),
    }),
    /MLB_PROVISIONAL_V16_CURRENT_IDENTITY_MISMATCH/,
  );
});

test("historical lineup custody count mismatch fails closed", async () => {
  await assert.rejects(
    assessMlbProvisionalV16LineupProxy(provisionalGame(), {
      snapshotSource: snapshotSource({ mismatchCounts: true }),
      fetchImpl: currentIdentityFetch(),
    }),
    /MLB_PROVISIONAL_V16_HOME_LINEUP_HISTORY_INCOMPLETE/,
  );
});

test("missing prior complete lineup fails closed", async () => {
  await assert.rejects(
    assessMlbProvisionalV16LineupProxy(provisionalGame(), {
      snapshotSource: snapshotSource({ noPriorLineup: true }),
      fetchImpl: currentIdentityFetch(),
    }),
    /MLB_PROVISIONAL_V16_HOME_LINEUP_HISTORY_INCOMPLETE|MLB_PROVISIONAL_V16_PRIOR_LINEUP_UNAVAILABLE/,
  );
});
