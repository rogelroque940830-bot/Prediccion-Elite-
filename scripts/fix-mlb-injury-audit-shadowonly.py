from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

schema = Path("server/mlb-injury-audit.ts")
text = schema.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''  daysSinceOfficialTransaction: z.number().int().min(0).max(5000).nullable().optional(),
}).strict();
''',
    '''  daysSinceOfficialTransaction: z.number().int().min(0).max(5000).nullable().optional(),
  // Backward-compatible with the first deployed C1 frontend bundle.
  // New builders strip this internal marker before persistence.
  shadowOnly: z.literal(true).optional(),
}).strict();
''',
    "backend shadowOnly compatibility",
)
schema.write_text(text, encoding="utf-8")

builder = Path("frontend/client/src/lib/mlb-injury-audit.ts")
text = builder.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''    daysSinceOfficialTransaction?: number | null;
  };
''',
    '''    daysSinceOfficialTransaction?: number | null;
    shadowOnly?: true;
  };
''',
    "frontend shadow input type",
)
text = replace_once(
    text,
    '''      ...(player.shadow ? { shadow: player.shadow } : {}),
''',
    '''      ...(player.shadow ? {
        shadow: {
          decision: player.shadow.decision,
          confidence: player.shadow.confidence,
          impact: player.shadow.impact,
          reasonCode: player.shadow.reasonCode,
          reason: player.shadow.reason,
          ...(player.shadow.daysSinceOfficialTransaction !== undefined
            ? { daysSinceOfficialTransaction: player.shadow.daysSinceOfficialTransaction }
            : {}),
        },
      } : {}),
''',
    "strip internal shadow fields",
)
builder.write_text(text, encoding="utf-8")

tests = Path("server/mlb-injury-audit.test.ts")
text = tests.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''          daysSinceOfficialTransaction: 1,
        },
''',
    '''          daysSinceOfficialTransaction: 1,
          shadowOnly: true as const,
        },
''',
    "real frontend shadow shape fixture",
)
text = replace_once(
    text,
    '''  assert.equal(parsed.home.players.find((player) => player.name === "Closer One")?.disposition, "AUTO_APPLIED");
''',
    '''  const parsedCloser = parsed.home.players.find((player) => player.name === "Closer One");
  assert.equal(parsedCloser?.disposition, "AUTO_APPLIED");
  assert.equal(parsedCloser?.shadow && "shadowOnly" in parsedCloser.shadow, false);
''',
    "builder strips internal marker assertion",
)
append = '''

test("backend accepts the first deployed C1 bundle shadowOnly marker", () => {
  const audit: any = buildMlbInjuryAuditSnapshot({
    capturedAt: "2026-07-28T01:05:00.000Z",
    home: teamInput("HOME"),
    away: teamInput("AWAY"),
  });
  audit.home.players[0].shadow.shadowOnly = true;
  const parsed = mlbInjuryAuditSchema.parse(audit);
  assert.equal(parsed.home.players[0].shadow?.shadowOnly, true);
});
'''
if "backend accepts the first deployed C1 bundle shadowOnly marker" in text:
    raise SystemExit("compatibility test already present")
text += append
tests.write_text(text, encoding="utf-8")
