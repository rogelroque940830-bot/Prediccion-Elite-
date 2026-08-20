import assert from "node:assert/strict";
import { mergeV80AuditHistoryRows, mergeV80UniqueHistoryRows } from "./p0-step12v80-history-merge";

type Row = Record<string, unknown>;

function historical(gamePk: number, overrides: Row = {}): Row {
  return {
    gamePk,
    officialDate: "2026-08-17",
    identityOk: true,
    sourceHistorical: true,
    pregame: true,
    probableBothKnown: true,
    homeProbablePitcherId: 592288,
    awayProbablePitcherId: 687273,
    finalHomeStarterId: 592288,
    finalAwayStarterId: 687273,
    homeMatchesFinal: true,
    awayMatchesFinal: true,
    lineupComplete: true,
    cutoffAt: "2026-08-17T17:35:00.000Z",
    requestedTimecode: "20260817_173500",
    sourceMetadataTimecode: "20260817_172608",
    ...overrides,
  };
}

const frozenPlaceholder: Row = {
  gamePk: 824514,
  officialDate: "2026-08-17",
  identityOk: true,
  sourceHistorical: false,
  pregame: false,
  probableBothKnown: false,
  homeProbablePitcherId: null,
  awayProbablePitcherId: null,
  finalHomeStarterId: null,
  finalAwayStarterId: null,
  homeMatchesFinal: null,
  awayMatchesFinal: null,
  lineupComplete: false,
  cutoffAt: "2026-05-24T17:35:00.000Z",
  requestedTimecode: "20260524_173500",
  sourceMetadataTimecode: "20260813_022540",
};

const realHistorical = historical(824514);
const upgraded = mergeV80AuditHistoryRows([frozenPlaceholder], [realHistorical]);
assert.equal(upgraded.length, 1);
assert.deepEqual(upgraded[0], realHistorical);

const invalidOnly = mergeV80AuditHistoryRows([frozenPlaceholder], []);
assert.deepEqual(invalidOnly, []);

const identical = mergeV80AuditHistoryRows([realHistorical], [{ ...realHistorical }]);
assert.equal(identical.length, 1);
assert.deepEqual(identical[0], realHistorical);

assert.throws(
  () => mergeV80AuditHistoryRows([realHistorical], [historical(824514, { awayProbablePitcherId: 999999 })]),
  /V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:AUDIT:824514/,
);

assert.throws(
  () => mergeV80AuditHistoryRows([realHistorical], [historical(824514, { officialDate: "2026-08-18" })]),
  /V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:AUDIT:824514/,
);

assert.throws(
  () => mergeV80AuditHistoryRows([realHistorical], [historical(824514, { lineupComplete: false })]),
  /V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:AUDIT:824514/,
);

assert.throws(
  () => mergeV80UniqueHistoryRows([{ gamePk: 1, officialDate: "2026-01-01", value: 1 }], [{ gamePk: 1, officialDate: "2026-01-01", value: 2 }], "OFFICIAL"),
  /V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:OFFICIAL:1/,
);

assert.throws(
  () => mergeV80UniqueHistoryRows([{ gamePk: 0, officialDate: "2026-01-01" }], [], "OFFICIAL"),
  /V80_LIVE_CONTEXT_INVALID_GAME_PK:OFFICIAL/,
);

console.log("P0_STEP12V80_HISTORY_MERGE_TEST_OK");
