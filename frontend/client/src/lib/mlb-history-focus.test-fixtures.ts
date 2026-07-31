import { buildMlbHistoryFocus, type MlbHistoryFocusPick } from "./mlb-history-focus";

const base: MlbHistoryFocusPick = {
  id: "fixture",
  recordedAt: "2026-07-31T15:00:00.000Z",
  gameDate: "2026-07-31",
  commenceTime: "2026-07-31T23:00:00.000Z",
  gamePk: 1,
  homeTeam: "Home",
  awayTeam: "Away",
  marketType: "F5_ML",
  marketLabel: "F5",
  selection: "Home",
  line: null,
  oddsAmerican: -110,
  book: "fanduel, draftkings",
  modelProbabilityPct: 57,
  marketImpliedProbabilityPct: 52.4,
  edgePp: 4.6,
  signal: "BET",
  confidenceLabel: "HIGH",
  analysisStage: "FINAL",
  result: "PENDING",
  settlementResult: null,
  settledAt: null,
  profitUnits: 0,
  closingOddsAmerican: null,
  clvPp: null,
  finalScore: null,
  analyticalDuplicate: false,
};

export function validateMlbHistoryFocusFixture(): boolean {
  const provisional = { ...base, id: "provisional", analysisStage: "PROVISIONAL", recordedAt: "2026-07-31T14:00:00.000Z" };
  const final = { ...base, id: "final" };
  const duplicate = { ...base, id: "duplicate", gamePk: 2, analyticalDuplicate: true };
  const pass = { ...base, id: "pass", gamePk: 3, signal: "PASS", edgePp: -1 };
  const view = buildMlbHistoryFocus([provisional, final, duplicate, pass], Date.parse("2026-07-31T16:00:00.000Z"));
  return view.priority.length === 1
    && view.priority[0]?.id === "final"
    && view.collapsedRevisions === 3
    && view.hiddenStudyRecords === 3;
}
