from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

picks = Path("server/picks-v2.ts")
text = picks.read_text(encoding="utf-8")
text = replace_once(
    text,
    "const savedPickSchema = z.object({",
    "export const savedPickSchema = z.object({",
    "export savedPickSchema",
)
text = replace_once(
    text,
    '''    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid pick payload", details: parsed.error.flatten() });
      return;
    }
''',
    '''    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issuePath = firstIssue?.path?.length ? firstIssue.path.join(".") : "payload";
      const issueMessage = firstIssue?.message || "validation failed";
      res.status(400).json({
        success: false,
        error: `Invalid pick payload: ${issuePath} — ${issueMessage}`,
        details: parsed.error.flatten(),
      });
      return;
    }
''',
    "detailed pick validation error",
)
picks.write_text(text, encoding="utf-8")

tests = Path("server/mlb-injury-audit.test.ts")
test_text = tests.read_text(encoding="utf-8")
test_text = replace_once(
    test_text,
    'import { mlbInjuryAuditSchema } from "./mlb-injury-audit";\n',
    'import { mlbInjuryAuditSchema } from "./mlb-injury-audit";\nimport { savedPickSchema } from "./picks-v2";\n',
    "savedPickSchema test import",
)
append = r'''

test("Picks V2 accepts and normalizes a realistic C1 scientific snapshot", () => {
  const audit: any = buildMlbInjuryAuditSnapshot({
    capturedAt: "2026-07-28T03:15:00.000Z",
    home: teamInput("HOME"),
    away: teamInput("AWAY"),
  });

  audit.home.source.detectorFetchedAt = "legacy-non-iso-date";
  audit.home.players[0].reportedStatus = "R".repeat(900);
  audit.home.players[0].shadow.shadowOnly = true;
  audit.home.players[0].shadow.vendorInternalDebug = "must be stripped";
  audit.home.players[0].vendorPayload = { extra: true };

  const parsed = savedPickSchema.parse({
    id: "ui-mlb-99",
    ts: Date.parse("2026-07-28T03:15:00.000Z"),
    sport: "mlb",
    homeTeam: "Home Club",
    awayTeam: "Away Club",
    pickType: "ML",
    pickSide: "Home Club ML",
    confidence: 62,
    edge: 7.5,
    odds: -120,
    source: "app",
    clientId: 99,
    date: "2026-07-29",
    team: "Home Club",
    opponent: "Away Club",
    market: "ML",
    pick: "Home Club ML",
    modelProb: 62,
    impliedProb: 54.55,
    stake: 1,
    result: "",
    profit: 0,
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1",
      model: {
        name: "CourtEdge MLB",
        version: "predictor-full-snapshot-v2",
        environment: "p0-integration",
      },
      game: {
        gamePk: 999999,
        gameDate: "2026-07-29",
        commenceTime: "2026-07-29T23:10:00.000Z",
        homeTeam: "Home Club",
        awayTeam: "Away Club",
      },
      market: {
        type: "ML",
        selection: "Home Club ML",
        oddsAmerican: -120,
        book: "Hard Rock",
        capturedAt: "2026-07-28T03:15:00.000Z",
      },
      probabilities: {
        model: 0.62,
        marketImplied: 0.5455,
        edgePp: 7.45,
      },
      decision: {
        signal: "LEAN",
        confidenceLabel: "B",
        confidencePct: 62,
        stakeUnits: 1,
      },
      analysis: {
        stage: "PROVISIONAL",
        injuryAudit: audit,
      },
    },
  });

  const normalizedAudit = parsed.scientificSnapshot?.analysis.injuryAudit;
  assert.ok(normalizedAudit);
  assert.equal(normalizedAudit.home.source.detectorFetchedAt, undefined);
  assert.equal(normalizedAudit.home.players[0].reportedStatus?.length, 500);
  assert.equal("vendorPayload" in (normalizedAudit.home.players[0] as any), false);
  assert.equal("vendorInternalDebug" in (normalizedAudit.home.players[0].shadow as any), false);
});
'''
if "Picks V2 accepts and normalizes a realistic C1 scientific snapshot" in test_text:
    raise SystemExit("end-to-end Picks V2 C1 test already exists")
tests.write_text(test_text + append, encoding="utf-8")
