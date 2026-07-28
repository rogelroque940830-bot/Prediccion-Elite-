import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbInjuryAuditSnapshot } from "../frontend/client/src/lib/mlb-injury-audit";
import { mlbInjuryAuditSchema } from "./mlb-injury-audit";

function teamInput(side: "HOME" | "AWAY") {
  return {
    side,
    teamName: side === "HOME" ? "Home Club" : "Away Club",
    teamId: side === "HOME" ? 100 : 200,
    feed: {
      source: "BALLDONTLIE",
      validationSource: "MLB_STATS",
      status: "PARTIAL",
      fetchedAt: "2026-07-28T01:00:00.000Z",
      stale: false,
      officialValidationStatus: "VERIFIED",
      officialFetchedAt: "2026-07-28T01:00:05.000Z",
      rejectedCount: 1,
      shadowSummary: { officialOnly: 2 },
      autoApplyAllowed: true,
      phaseB: {
        enabled: true,
        mode: "AUTO_CONSERVATIVE" as const,
        coverage: "PARTIAL" as const,
        candidateCount: 2,
        eligiblePlayerNames: ["Closer One"],
        withheldCandidateNames: ["Hitter One"],
        scale: 0.35,
        maxAbsRuns: 0.35,
        autoApplyAllowed: true,
        requiresBullpenReconciliation: true,
        reason: "Conservative Phase B test plan",
      },
    },
    roster: [
      {
        playerId: 1,
        name: "Closer One",
        position: "P",
        isPitcher: true,
        status: "Out",
        source: "BALLDONTLIE",
        officialStatusCode: "D15",
        officialStatus: "Injured 15-Day",
        officialTransaction: {
          date: "2026-07-27",
          effectiveDate: "2026-07-27",
          typeDesc: "Status Change",
          description: "Placed on the 15-day injured list.",
        },
        shadow: {
          decision: "APPLY_CANDIDATE" as const,
          confidence: "HIGH" as const,
          impact: "HIGH" as const,
          reasonCode: "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
          reason: "Official recent high-leverage reliever injury.",
          daysSinceOfficialTransaction: 1,
        },
      },
      {
        playerId: 2,
        name: "Hitter One",
        position: "3B",
        isPitcher: false,
        status: "Out",
        source: "BALLDONTLIE",
        officialStatusCode: "D10",
        officialStatus: "Injured 10-Day",
        officialTransaction: null,
        shadow: {
          decision: "APPLY_CANDIDATE" as const,
          confidence: "HIGH" as const,
          impact: "HIGH" as const,
          reasonCode: "OFFICIAL_IL_IMPACT_HITTER",
          reason: "Important hitter, retained to avoid lineup double counting.",
          daysSinceOfficialTransaction: 2,
        },
      },
      {
        playerId: 3,
        name: "Old Injury",
        position: "P",
        isPitcher: true,
        status: "Out",
        source: "BALLDONTLIE",
        officialStatusCode: "D60",
        officialStatus: "Injured 60-Day",
        officialTransaction: null,
        shadow: {
          decision: "IGNORE" as const,
          confidence: "HIGH" as const,
          impact: "LOW" as const,
          reasonCode: "LONG_TERM_IL_ALREADY_ADAPTED",
          reason: "Long-term injury already reflected.",
          daysSinceOfficialTransaction: 45,
        },
      },
    ],
    selectedPlayerNames: ["Closer One"],
    autoAppliedPlayerNames: ["Closer One"],
    rawAutomaticRuns: -0.8,
    scaledAutomaticRuns: -0.28,
    finalRuns: -0.28,
    manualOverride: false,
    factors: { off: 1, def: 0.8, type: "Fase B automática" },
    bullpenSide: {
      runsAdjustment: 0,
      closerAvailable: true,
      bullpenCompromised: false,
    },
    blockedReason: null,
    statusText: "1 reliever auto-applied",
  };
}

test("injury audit records sources, decisions, reconciliation and final adjustment", () => {
  const audit = buildMlbInjuryAuditSnapshot({
    capturedAt: "2026-07-28T01:05:00.000Z",
    home: teamInput("HOME"),
    away: {
      ...teamInput("AWAY"),
      selectedPlayerNames: [],
      autoAppliedPlayerNames: [],
      rawAutomaticRuns: 0,
      scaledAutomaticRuns: 0,
      finalRuns: 0,
      blockedReason: "BULLPEN_EFFECT_ALREADY_APPLIED",
      bullpenSide: { runsAdjustment: 0.3, closerAvailable: false, bullpenCompromised: true },
    },
  });

  const parsed = mlbInjuryAuditSchema.parse(audit);
  assert.equal(parsed.schemaVersion, "mlb-injury-audit.v1");
  assert.equal(parsed.home.adjustment.scaledAutomaticRuns, -0.28);
  assert.equal(parsed.home.players.find((player) => player.name === "Closer One")?.disposition, "AUTO_APPLIED");
  assert.equal(parsed.home.players.find((player) => player.name === "Hitter One")?.disposition, "WITHHELD_POLICY");
  assert.equal(parsed.home.players.find((player) => player.name === "Old Injury")?.disposition, "IGNORED");
  assert.equal(parsed.away.players.find((player) => player.name === "Closer One")?.disposition, "WITHHELD_BULLPEN");
  assert.equal(parsed.away.reconciliation.blockedReason, "BULLPEN_EFFECT_ALREADY_APPLIED");
  assert.equal(parsed.home.counts.officialOnly, 2);
});

test("manual override is explicit and never masquerades as an automatic application", () => {
  const home = teamInput("HOME");
  const audit = buildMlbInjuryAuditSnapshot({
    capturedAt: "2026-07-28T01:05:00.000Z",
    home: {
      ...home,
      selectedPlayerNames: ["Hitter One"],
      autoAppliedPlayerNames: [],
      rawAutomaticRuns: 0,
      scaledAutomaticRuns: 0,
      finalRuns: -0.6,
      manualOverride: true,
      factors: { off: 1, def: 0.5, type: "Manual" },
    },
    away: teamInput("AWAY"),
  });

  assert.equal(audit.home.adjustment.manualOverride, true);
  assert.deepEqual(audit.home.adjustment.autoAppliedPlayerNames, []);
  assert.equal(audit.home.players.find((player) => player.name === "Hitter One")?.disposition, "MANUAL_SELECTED");
  assert.equal(audit.home.players.find((player) => player.name === "Closer One")?.disposition, "WITHHELD_MANUAL_OVERRIDE");
});

test("injury audit schema rejects malformed automatic evidence", () => {
  const audit: any = buildMlbInjuryAuditSnapshot({
    capturedAt: "2026-07-28T01:05:00.000Z",
    home: teamInput("HOME"),
    away: teamInput("AWAY"),
  });
  audit.home.adjustment.finalRuns = "not-a-number";
  assert.throws(() => mlbInjuryAuditSchema.parse(audit));
});
