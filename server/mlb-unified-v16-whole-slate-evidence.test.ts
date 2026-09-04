import assert from "node:assert/strict";
import test from "node:test";
import { screenMlbDailySlateCheap } from "./mlb-cheap-screening";
import { buildMlbShortlist } from "./mlb-shortlist";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { createMlbUnifiedV16CertifiedShortlistProvider } from "./mlb-unified-v16-live-providers";

const NOW = new Date("2026-09-04T14:00:00.000Z");

function slate(stage: "FINAL" | "PROVISIONAL" = "FINAL"): MlbP1DailySlate {
  const final = stage === "FINAL";
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-09-04",
    generatedAt: NOW.toISOString(),
    games: [{
      gamePk: 123,
      startTime: "2026-09-04T23:10:00.000Z",
      officialDate: "2026-09-04",
      venue: "Test Park",
      state: "PREGAME",
      detailedState: "Pre-Game",
      homeTeam: { id: 1, name: "Home" },
      awayTeam: { id: 2, name: "Away" },
      homePitcher: { id: 11, name: "Home SP", hand: "R", confirmed: true },
      awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
      lineupState: final ? "CONFIRMED" : "NOT_POSTED",
      homeLineupCount: final ? 9 : 0,
      awayLineupCount: final ? 9 : 0,
      homeLineupIds: final ? [101,102,103,104,105,106,107,108,109] : [],
      awayLineupIds: final ? [201,202,203,204,205,206,207,208,209] : [],
      readiness: final ? "READY_TO_ANALYZE" : "PROVISIONAL_WAITING_FOR_LINEUPS",
      analysisStage: stage,
      analysisAllowed: true,
      blockers: final ? [] : ["Los lineups oficiales todavía no están publicados."],
      source: { name: "MLB_STATS_API", fetchedAt: NOW.toISOString(), quality: "AUTHORITATIVE" },
    }],
    summary: {
      total: 1,
      ready: final ? 1 : 0,
      provisional: final ? 0 : 1,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function statcastSnapshot() {
  return {
    sourceStatus: "CERTIFIED",
    generatedAt: NOW.toISOString(),
    provenance: { status: "CERTIFIED" },
    pitcherMap: { 11: {}, 22: {} },
  } as any;
}

function disciplineSnapshot() {
  return {
    sourceStatus: "CERTIFIED",
    generatedAt: NOW.toISOString(),
    provenance: { status: "CERTIFIED" },
    homeSPDiscipline: null,
    awaySPDiscipline: null,
    homeBatterSpeed: [],
    awayBatterSpeed: [],
    homeRunsDelta: 0.2,
    awayRunsDelta: -0.1,
  } as any;
}

function sosSnapshot(teamId: number) {
  return {
    sourceStatus: "CERTIFIED",
    generatedAt: NOW.toISOString(),
    provenance: { status: "CERTIFIED" },
    teamSos: {
      teamId,
      teamName: teamId === 1 ? "Home" : "Away",
      games: 10,
      avgSpEraFaced: 4,
      avgBullpenEraFaced: 4,
      combinedEraFaced: 4,
      leagueDelta: 0,
      sosFactor: teamId === 1 ? 1.1 : 0.9,
      recentRpg: 4,
      adjustedRpg: teamId === 1 ? 4.4 : 3.6,
      tier: "REAL",
      signal: "fixture",
    },
  } as any;
}

function context(inputSlate: MlbP1DailySlate) {
  return {
    runId: "run-1",
    slate: inputSlate,
    now: NOW,
    analysisEligibleGamePks: [123],
    finalEligibleGamePks: inputSlate.games[0].analysisStage === "FINAL" ? [123] : [],
  } as any;
}

test("whole-slate shortlist receives Statcast + Discipline/Speed + SOS as independent certified evidence", async () => {
  let disciplineInput: any = null;
  const provider = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => statcastSnapshot(),
    evaluateStarter: (pitcher: any) => pitcher ? ({ runsDelta: pitcher === (statcastSnapshot() as any).pitcherMap?.[11] ? 0.1 : -0.1 } as any) : null,
    getDisciplineSpeedSnapshot: (async (input: any) => {
      disciplineInput = input;
      return disciplineSnapshot();
    }) as any,
    getTeamSosSnapshot: (async (teamId: number) => sosSnapshot(teamId)) as any,
  });

  // Use a stable starter evaluator rather than object identity from the fixture factory.
  const providerStable = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => statcastSnapshot(),
    evaluateStarter: (_pitcher: any) => ({ runsDelta: 0.1 } as any),
    getDisciplineSpeedSnapshot: (async (input: any) => {
      disciplineInput = input;
      return disciplineSnapshot();
    }) as any,
    getTeamSosSnapshot: (async (teamId: number) => sosSnapshot(teamId)) as any,
  });

  void provider;
  const inputSlate = slate("FINAL");
  const loaded = await providerStable(context(inputSlate));
  assert.equal(loaded.blockers, undefined);
  assert.ok(loaded.value?.[123]);
  assert.equal((loaded.value?.[123]?.statcastQuality as any)?.sourceStatus, "CERTIFIED");
  assert.equal((loaded.value?.[123]?.disciplineSpeed as any)?.sourceStatus, "CERTIFIED");
  assert.equal((loaded.value?.[123]?.sos as any)?.sourceStatus, "CERTIFIED");
  assert.deepEqual(disciplineInput.homeBatterIds, [101,102,103,104,105,106,107,108,109]);
  assert.deepEqual(disciplineInput.awayBatterIds, [201,202,203,204,205,206,207,208,209]);

  const shortlist = buildMlbShortlist({
    cheapScreen: screenMlbDailySlateCheap(inputSlate),
    evidenceByGame: loaded.value ?? {},
  });
  assert.equal(shortlist.candidates.length, 1);
  assert.equal(shortlist.candidates[0].qualifiedForShortlist, true);
  assert.equal(shortlist.candidates[0].certifiedComponentCount, 3);
  assert.equal(shortlist.candidates[0].independentSignalCount, 3);
  assert.deepEqual(
    new Set(shortlist.candidates[0].signals.map((signal) => signal.component)),
    new Set(["STATCAST_QUALITY", "DISCIPLINE_SPEED", "SOS"]),
  );
});

test("provisional games use pitcher discipline without inventing unposted batter-speed identities", async () => {
  let disciplineInput: any = null;
  const provider = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => statcastSnapshot(),
    evaluateStarter: () => ({ runsDelta: 0.1 } as any),
    getDisciplineSpeedSnapshot: (async (input: any) => {
      disciplineInput = input;
      return disciplineSnapshot();
    }) as any,
    getTeamSosSnapshot: (async (teamId: number) => sosSnapshot(teamId)) as any,
  });
  const loaded = await provider(context(slate("PROVISIONAL")));
  assert.ok(loaded.value?.[123]);
  assert.deepEqual(disciplineInput.homeBatterIds, []);
  assert.deepEqual(disciplineInput.awayBatterIds, []);
});

test("optional source failure does not become a new hard gate when another certified source exists", async () => {
  const provider = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => statcastSnapshot(),
    evaluateStarter: () => ({ runsDelta: 0.1 } as any),
    getDisciplineSpeedSnapshot: (async () => { throw new Error("discipline down"); }) as any,
    getTeamSosSnapshot: (async () => { throw new Error("sos down"); }) as any,
  });
  const loaded = await provider(context(slate("FINAL")));
  assert.equal(loaded.blockers, undefined);
  assert.equal((loaded.value?.[123]?.statcastQuality as any)?.sourceStatus, "CERTIFIED");
  assert.equal((loaded.value?.[123]?.disciplineSpeed as any)?.sourceStatus, "UNAVAILABLE");
  assert.equal((loaded.value?.[123]?.sos as any)?.sourceStatus, "UNAVAILABLE");
});

test("Statcast failure can be rescued by other certified sporting evidence", async () => {
  const provider = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => { throw new Error("statcast down"); },
    evaluateStarter: () => null,
    getDisciplineSpeedSnapshot: (async () => disciplineSnapshot()) as any,
    getTeamSosSnapshot: (async (teamId: number) => sosSnapshot(teamId)) as any,
  });
  const loaded = await provider(context(slate("FINAL")));
  assert.equal(loaded.blockers, undefined);
  assert.equal((loaded.value?.[123]?.statcastQuality as any)?.sourceStatus, "UNAVAILABLE");
  assert.equal((loaded.value?.[123]?.disciplineSpeed as any)?.sourceStatus, "CERTIFIED");
  assert.equal((loaded.value?.[123]?.sos as any)?.sourceStatus, "CERTIFIED");
});

test("total outage across all core whole-slate evidence blocks instead of masquerading as sporting NO PLAY", async () => {
  const provider = createMlbUnifiedV16CertifiedShortlistProvider({
    getSnapshot: async () => { throw new Error("statcast down"); },
    evaluateStarter: () => null,
    getDisciplineSpeedSnapshot: (async () => { throw new Error("discipline down"); }) as any,
    getTeamSosSnapshot: (async () => { throw new Error("sos down"); }) as any,
  });
  const loaded = await provider(context(slate("FINAL")));
  assert.equal(loaded.value, undefined);
  assert.equal(loaded.blockers?.[0].code, "SHORTLIST_EVIDENCE_UNAVAILABLE");
  assert.match(loaded.blockers?.[0].message ?? "", /infrastructure block/i);
});
