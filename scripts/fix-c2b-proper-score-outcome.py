from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

report = Path("server/mlb-injury-outcomes-report.ts")
text = report.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''function scoringOutcome(record: LedgerRecord): number | null {
  if (!record.settlement) return null;
  if (Number.isFinite(record.settlement.outcomeValue)) return Number(record.settlement.outcomeValue);
  if (record.settlement.result === "WIN") return 1;
  if (record.settlement.result === "LOSS") return 0;
  if (record.settlement.result === "HALF_WIN") return 0.75;
  if (record.settlement.result === "HALF_LOSS") return 0.25;
  return null;
}
''',
    '''function scoringOutcome(record: LedgerRecord): number | null {
  if (!record.settlement) return null;
  // settlement.outcomeValue is the graded market measurement (run margin,
  // total runs, team runs, etc.), not a Bernoulli target. Proper scoring
  // rules must use the immutable settlement classification instead.
  if (record.settlement.result === "WIN") return 1;
  if (record.settlement.result === "LOSS") return 0;
  if (record.settlement.result === "HALF_WIN") return 0.75;
  if (record.settlement.result === "HALF_LOSS") return 0.25;
  return null;
}
''',
    "scoring outcome",
)
text = replace_once(
    text,
    'scoring: "Brier and logarithmic loss use the saved pregame model probability and immutable settlement outcome.",',
    'scoring: "Brier and logarithmic loss use the saved pregame model probability and the immutable WIN/LOSS settlement classification; raw market outcomeValue is not a probability target.",',
    "methodology",
)
report.write_text(text, encoding="utf-8")

test_file = Path("server/mlb-injury-outcomes-report.test.ts")
test_text = test_file.read_text(encoding="utf-8")
test_text += '''

test("C2B derives proper-score targets from settlement result, not raw market margin", () => {
  const winRecord = record({
    id: "margin-win", probability: 0.6781014109277892, result: "WIN", profit: 0.7143, auditValue: audit(),
  });
  const lossRecord = record({
    id: "margin-loss", probability: 0.62, result: "LOSS", profit: -1, auditValue: audit(),
  });
  if (!winRecord.settlement || !lossRecord.settlement) throw new Error("settlements required");
  winRecord.settlement.outcomeValue = 14;
  lossRecord.settlement.outcomeValue = -3;

  const report = buildMlbInjuryOutcomesReport([winRecord, lossRecord]);
  assert.equal(report.summary.scored, 2);
  assert.ok(report.summary.brierScore != null && report.summary.brierScore >= 0 && report.summary.brierScore <= 1);
  assert.ok(report.summary.logLoss != null && report.summary.logLoss >= 0);

  const win = report.recentSettled.find((row) => row.predictionId === "margin-win");
  const loss = report.recentSettled.find((row) => row.predictionId === "margin-loss");
  assert.equal(win?.outcomeValue, 1);
  assert.equal(loss?.outcomeValue, 0);
  assert.ok((win?.brierScore ?? 2) < 1);
  assert.ok((loss?.brierScore ?? 2) < 1);
});
'''
test_file.write_text(test_text, encoding="utf-8")
