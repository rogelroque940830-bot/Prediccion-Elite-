import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMlbInjuryShadow,
  summarizeMlbInjuryShadow,
  type MlbInjuryShadowInput,
} from "./mlb-injury-shadow";

function base(overrides: Partial<MlbInjuryShadowInput> = {}): MlbInjuryShadowInput {
  return {
    playerId: 1,
    name: "Test Player",
    isPitcher: false,
    position: "OF",
    rosterStatusCode: "D10",
    rosterStatusDescription: "Injured 10-Day",
    latestTransaction: {
      date: "2026-07-24",
      effectiveDate: "2026-07-24",
      typeDesc: "Status Change",
      description: "Placed on the 10-day injured list.",
    },
    plateAppearances: 300,
    ops: 0.820,
    obp: 0.350,
    slg: 0.470,
    asOfDate: "2026-07-27",
    ...overrides,
  };
}

test("active MLB roster conflicts with a secondary-source injury record", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "A",
    rosterStatusDescription: "Active",
    latestTransaction: null,
  }));
  assert.equal(result.decision, "CONFLICT");
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.reasonCode, "OFFICIAL_ACTIVE_ROSTER_CONFLICT");
});

test("recent official activation blocks injury application", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D10",
    latestTransaction: {
      date: "2026-07-27",
      typeDesc: "Activated",
      description: "Activated from the 10-day injured list.",
    },
  }));
  assert.equal(result.decision, "CONFLICT");
  assert.equal(result.reasonCode, "OFFICIAL_ACTIVATION_CONFLICT");
});

test("recent 60-day IL stays pending until absence age is established", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D60",
    rosterStatusDescription: "Injured 60-Day",
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "LONG_TERM_IL_NEEDS_AGE_CONFIRMATION");
});

test("older 60-day IL is ignored after the environment has adapted", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D60",
    rosterStatusDescription: "Injured 60-Day",
    latestTransaction: {
      date: "2026-06-01",
      effectiveDate: "2026-06-01",
      typeDesc: "Status Change",
      description: "Placed on the 60-day injured list.",
    },
  }));
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reasonCode, "LONG_TERM_IL_ALREADY_ADAPTED");
});

test("minor-league assignment does not create an MLB injury adjustment", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "RM",
    rosterStatusDescription: "Reassigned to Minors",
  }));
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reasonCode, "NOT_ACTIVE_MLB_ROSTER");
});

test("starting pitcher injury is already reflected by replacement starter", () => {
  const result = classifyMlbInjuryShadow(base({
    playerId: 10,
    isPitcher: true,
    gamesStarted: 18,
    plateAppearances: null,
    ops: null,
    probablePitcherId: 99,
  }));
  assert.equal(result.decision, "ALREADY_REFLECTED");
  assert.equal(result.reasonCode, "STARTER_REPLACEMENT_CAPTURED");
});

test("starting pitcher remains pending while replacement is unconfirmed", () => {
  const result = classifyMlbInjuryShadow(base({
    playerId: 10,
    isPitcher: true,
    gamesStarted: 18,
    probablePitcherId: null,
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "STARTER_REPLACEMENT_UNCONFIRMED");
});

test("injured pitcher simultaneously listed as probable becomes a conflict", () => {
  const result = classifyMlbInjuryShadow(base({
    playerId: 10,
    isPitcher: true,
    gamesStarted: 18,
    probablePitcherId: 10,
  }));
  assert.equal(result.decision, "CONFLICT");
  assert.equal(result.reasonCode, "INJURED_PLAYER_LISTED_AS_PROBABLE");
});

test("official IL high-leverage reliever is an automatic-adjustment candidate", () => {
  const result = classifyMlbInjuryShadow(base({
    playerId: 20,
    isPitcher: true,
    gamesStarted: 0,
    saves: 14,
    holds: 2,
    gamesFinished: 20,
    inningsPitched: 35,
  }));
  assert.equal(result.decision, "APPLY_CANDIDATE");
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.reasonCode, "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER");
});

test("official IL high-impact hitter becomes an apply candidate", () => {
  const result = classifyMlbInjuryShadow(base());
  assert.equal(result.decision, "APPLY_CANDIDATE");
  assert.equal(result.impact, "HIGH");
  assert.equal(result.reasonCode, "OFFICIAL_IL_HIGH_IMPACT_HITTER");
});

test("extended absence is held for decay calibration instead of applied", () => {
  const result = classifyMlbInjuryShadow(base({
    latestTransaction: {
      date: "2026-06-20",
      effectiveDate: "2026-06-20",
      typeDesc: "Status Change",
      description: "Placed on the 10-day injured list.",
    },
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "EXTENDED_ABSENCE_REQUIRES_DECAY");
});

test("rehab assignment stays pending", () => {
  const result = classifyMlbInjuryShadow(base({
    latestTransaction: {
      date: "2026-07-26",
      effectiveDate: "2026-07-26",
      typeDesc: "Assigned",
      description: "Sent to Triple-A on a rehab assignment.",
    },
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "REHAB_ASSIGNMENT");
});

test("shadow summary counts all decisions without applying anything", () => {
  const results = [
    classifyMlbInjuryShadow(base()),
    classifyMlbInjuryShadow(base({ rosterStatusCode: "A", rosterStatusDescription: "Active", latestTransaction: null })),
    classifyMlbInjuryShadow(base({ rosterStatusCode: "D60", rosterStatusDescription: "Injured 60-Day" })),
  ];
  const summary = summarizeMlbInjuryShadow(results);
  assert.deepEqual(summary, {
    total: 3,
    applyCandidates: 1,
    alreadyReflected: 0,
    ignored: 0,
    conflicts: 1,
    pending: 1,
    highConfidence: 2,
    officialOnly: 0,
    mode: "SHADOW",
  });
});
