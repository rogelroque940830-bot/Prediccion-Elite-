import assert from "node:assert/strict";
import test from "node:test";
import {
  certifyStatcastMatchupReadiness,
  createStrictStatcastEvidenceProvider,
  resetStatcastMatchupCertificationCacheForTests,
  type StrictBatterPitchRow,
  type StrictBullpenPitcher,
  type StrictPitch,
  type StrictRecentStats,
  type StrictStatcastEvidenceProvider,
  type StrictVsPitcherStats,
} from "./mlb-statcast-matchup-certifier";

const NOW = new Date("2026-08-08T02:45:00.000Z");
const HOME_TEAM = 112;
const AWAY_TEAM = 116;
const HOME_SP = 101;
const AWAY_SP = 201;
const HOME_RP = 111;
const AWAY_RP = 211;
const HOME_BATTERS = Array.from({ length: 9 }, (_, index) => index + 1);
const AWAY_BATTERS = Array.from({ length: 9 }, (_, index) => index + 11);

const ARSENAL: StrictPitch[] = [
  { type: "FF", name: "4-Seam Fastball", usage: 50, wobaAgainst: 0.300, whiff: 25 },
  { type: "SL", name: "Slider", usage: 30, wobaAgainst: 0.290, whiff: 32 },
  { type: "CH", name: "Changeup", usage: 20, wobaAgainst: 0.280, whiff: 30 },
];

function batterRows(season: number): StrictBatterPitchRow[] {
  const rows: StrictBatterPitchRow[] = [];
  for (const batterId of [...HOME_BATTERS, ...AWAY_BATTERS]) {
    const team = batterId < 10 ? "CHC" : "DET";
    rows.push(
      { playerId: batterId, team, pitchType: "FF", pitches: 100, pa: 80, xwoba: 0.330, whiff: 20, runValue100: 0 },
      { playerId: batterId, team, pitchType: "SL", pitches: 100, pa: 80, xwoba: 0.340, whiff: 25, runValue100: 0 },
      { playerId: batterId, team, pitchType: "CH", pitches: 100, pa: 80, xwoba: 0.320, whiff: 28, runValue100: 0 },
    );
  }
  return season === 2026 ? rows : rows.map((row) => ({ ...row, pa: 100 }));
}

class FakeProvider implements StrictStatcastEvidenceProvider {
  calls = 0;
  fail: string | null = null;
  bullpenMismatch = false;
  arsenalMismatch = false;

  async getPitcherArsenalMap(): Promise<Record<number, StrictPitch[]>> {
    this.calls++;
    if (this.fail === "arsenal") throw new Error("FAKE_ARSENAL_FAILURE");
    const away = this.arsenalMismatch ? [{ ...ARSENAL[0], usage: 40 }, ARSENAL[1], ARSENAL[2]] : ARSENAL;
    return { [HOME_SP]: ARSENAL, [AWAY_SP]: away, [HOME_RP]: ARSENAL, [AWAY_RP]: ARSENAL };
  }

  async getBatterPitchRows(season: number): Promise<StrictBatterPitchRow[]> {
    this.calls++;
    if (this.fail === "batters") throw new Error("FAKE_BATTER_FAILURE");
    return batterRows(season);
  }

  async getRecentBatterStats(): Promise<StrictRecentStats> {
    this.calls++;
    if (this.fail === "recent") throw new Error("FAKE_RECENT_FAILURE");
    return { ops: 0.750, pa: 20, tier: "NEUTRAL" };
  }

  async getProjectedBullpen(teamId: number): Promise<StrictBullpenPitcher[]> {
    this.calls++;
    if (this.fail === "bullpen") throw new Error("FAKE_BULLPEN_FAILURE");
    if (this.bullpenMismatch && teamId === AWAY_TEAM) return [{ pitcherId: 999, pitcherName: "Wrong", role: "Closer" }];
    return teamId === HOME_TEAM
      ? [{ pitcherId: HOME_RP, pitcherName: "Home RP", role: "Closer" }]
      : [{ pitcherId: AWAY_RP, pitcherName: "Away RP", role: "Closer" }];
  }

  async getVsPitcherCareer(): Promise<StrictVsPitcherStats | null> {
    this.calls++;
    if (this.fail === "career") throw new Error("FAKE_CAREER_FAILURE");
    return null;
  }

  oldestObservedAt(): string | null {
    return NOW.toISOString();
  }
}

function starter(pitcherId: number, batters: number[], bullpenPitcherId: number) {
  return {
    pitcherId,
    pitcherName: `Pitcher ${pitcherId}`,
    arsenal: ARSENAL.map((pitch) => ({ ...pitch })),
    lineupSize: 9,
    battersAnalyzed: 9,
    expectedTeamRunsDelta: 0.10,
    perBatter: batters.map((batterId) => ({
      batterId,
      batterName: `Batter ${batterId}`,
      expectedXwoba: 0.319,
      dataQuality: "DIRECT",
    })),
    bullpenMatchup: [{ pitcherId: bullpenPitcherId, pitcherName: `RP ${bullpenPitcherId}`, role: "Closer", expectedRunsDelta: 0.10 }],
    lineupSource: "CONFIRMED",
  };
}

function history(opposingTeamId: number) {
  return {
    rows: [],
    teamOpsVsOpp: 0.720,
    identity: { opposingTeamId, requestedBatters: 9, successfulQueries: 9, usableRows: 0, failures: 0 },
  };
}

function resultFixture() {
  return {
    homeLineupVsAwaySP: starter(AWAY_SP, HOME_BATTERS, AWAY_RP),
    awayLineupVsHomeSP: starter(HOME_SP, AWAY_BATTERS, HOME_RP),
    homeLineupVsAwayTeam: history(AWAY_TEAM),
    awayLineupVsHomeTeam: history(HOME_TEAM),
    homeRunsDelta: 0.08,
    awayRunsDelta: 0.08,
    identityCorrection: {
      opposingTeamIdContract: "NUMERIC_MLB_TEAM_ID",
      weightsPreserved: { starter: 0.50, bullpen: 0.25, vsTeam: 0.25 },
    },
  };
}

function feedFixture(options: { homeLineup?: number[]; awayLineup?: number[] } = {}) {
  return {
    gameData: {
      datetime: { officialDate: "2026-08-08" },
      teams: {
        home: { id: HOME_TEAM, abbreviation: "CHC" },
        away: { id: AWAY_TEAM, abbreviation: "DET" },
      },
      probablePitchers: {
        home: { id: HOME_SP, fullName: "Home SP" },
        away: { id: AWAY_SP, fullName: "Away SP" },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: options.homeLineup ?? HOME_BATTERS },
          away: { battingOrder: options.awayLineup ?? AWAY_BATTERS },
        },
      },
    },
  };
}

async function certify(provider: FakeProvider, result = resultFixture(), feed = feedFixture()) {
  resetStatcastMatchupCertificationCacheForTests();
  return certifyStatcastMatchupReadiness({
    gamePk: 765432,
    result,
    feed,
    season: 2026,
    requestStartedAt: "2026-08-08T02:44:55.000Z",
    provider,
    now: () => new Date(NOW),
  });
}

test("strict B5B certifies only when starter rows, bullpen deltas and combined deltas are reproduced", async () => {
  const report = await certify(new FakeProvider());
  assert.equal(report.sourceStatus, "CERTIFIED");
  assert.equal(report.generatedAt, "2026-08-08T02:44:55.000Z");
  assert.equal(report.provenance.status, "CERTIFIED");
  assert.equal(report.provenance.currentLineupsConfirmed, true);
  assert.equal(report.provenance.visibleCoverageComplete, true);
  assert.equal(report.provenance.currentSeasonPitcherArsenalsReproduced, true);
  assert.equal(report.provenance.bullpenRosterAndStatsComplete, true);
  assert.equal(report.provenance.recentBatterStatsComplete, true);
  assert.equal(report.provenance.starterRowsReproduced, true);
  assert.equal(report.provenance.bullpenDeltasReproduced, true);
  assert.equal(report.provenance.combinedRunDeltasReproduced, true);
  assert.deepEqual(report.provenance.blockers, []);
  assert.equal(report.provenance.safety.runDeltaMutatedByCertifier, false);
});

test("unconfirmed current lineup degrades before strict source acquisition", async () => {
  const provider = new FakeProvider();
  const report = await certify(provider, resultFixture(), feedFixture({ homeLineup: HOME_BATTERS.slice(0, 8) }));
  assert.equal(report.sourceStatus, "DEGRADED");
  assert.equal(provider.calls, 0);
  assert.ok(report.provenance.blockers.includes("STATCAST_MATCHUP_CURRENT_LINEUP_NOT_CONFIRMED"));
});

test("strict source failure cannot be converted into a certified numeric result", async () => {
  const provider = new FakeProvider();
  provider.fail = "recent";
  const report = await certify(provider);
  assert.equal(report.sourceStatus, "DEGRADED");
  assert.equal(report.generatedAt, null);
  assert.ok(report.provenance.blockers.some((blocker) => blocker.includes("FAKE_RECENT_FAILURE")));
});

test("fresh arsenal mismatch detects a result that cannot be reproduced from current Savant", async () => {
  const provider = new FakeProvider();
  provider.arsenalMismatch = true;
  const report = await certify(provider);
  assert.equal(report.sourceStatus, "DEGRADED");
  assert.ok(report.provenance.blockers.includes("STATCAST_CERT_STARTER_ARSENAL_MISMATCH:HOME_OFFENSE"));
});

test("bullpen selection mismatch blocks certification", async () => {
  const provider = new FakeProvider();
  provider.bullpenMismatch = true;
  const report = await certify(provider);
  assert.equal(report.sourceStatus, "DEGRADED");
  assert.ok(report.provenance.blockers.some((blocker) => blocker.startsWith("STATCAST_CERT_BULLPEN_IDENTITY_MISMATCH")));
});

test("combined run delta mismatch blocks certification without mutating the result", async () => {
  const provider = new FakeProvider();
  const result = resultFixture();
  result.homeRunsDelta = 9.99;
  const report = await certify(provider, result);
  assert.equal(report.sourceStatus, "DEGRADED");
  assert.ok(report.provenance.blockers.includes("STATCAST_CERT_COMBINED_RUN_DELTA_MISMATCH"));
  assert.equal(result.homeRunsDelta, 9.99);
});

test("production strict provider fails closed on an unavailable Savant source", async () => {
  const provider = createStrictStatcastEvidenceProvider({
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    now: () => new Date(NOW),
  });
  await assert.rejects(
    () => provider.getPitcherArsenalMap(2026),
    /STATCAST_CERT_SOURCE_HTTP_503:SAVANT_PITCHER_ARSENAL_2026/,
  );
});
