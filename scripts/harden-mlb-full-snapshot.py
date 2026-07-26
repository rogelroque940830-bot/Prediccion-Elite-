from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# Prevent repeated user clicks from producing another canonical history record.
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    '''    resolvedModelProb = Math.max(0.1, Math.min(99.9, resolvedModelProb));
    const implied = americanImpliedProbability(odds);''',
    '''    resolvedModelProb = Math.max(0.1, Math.min(99.9, resolvedModelProb));
    const duplicatePick = state.mlbPicks.some((existing) =>
      existing.date === selectedDate
      && existing.market.trim().toLowerCase() === normalizedMarket
      && existing.pick.trim().toLowerCase() === pick.trim().toLowerCase()
      && existing.odds === odds
      && Math.abs(existing.modelProb - resolvedModelProb) < 0.01
    );
    if (duplicatePick) {
      toast({
        title: "Este pick MLB ya está guardado",
        description: "No se creó otra entrada en el historial ni en el ledger.",
      });
      return;
    }
    const implied = americanImpliedProbability(odds);''',
)
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    '''    const stage = Boolean(gamePkForTesi && selectedGameId && homeInjuryFeed.status === "VERIFIED" && awayInjuryFeed.status === "VERIFIED")
      ? "FINAL" as const : "PROVISIONAL" as const;''',
    '''    const stage = Boolean(
      gamePkForTesi
      && selectedGameId
      && completeFactorFeeds >= 10
      && homeInjuryFeed.status === "VERIFIED"
      && awayInjuryFeed.status === "VERIFIED"
    ) ? "FINAL" as const : "PROVISIONAL" as const;''',
)
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    "            fetchedAt: homeInjuryFeed.fetchedAt || capturedAt,",
    "            fetchedAt: isoDateTimeOrUndefined(homeInjuryFeed.fetchedAt) || capturedAt,",
)
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    "            fetchedAt: awayInjuryFeed.fetchedAt || capturedAt,",
    "            fetchedAt: isoDateTimeOrUndefined(awayInjuryFeed.fetchedAt) || capturedAt,",
)

# If the detailed source payload is unusually large, retain the calculation core and
# mark the compacted portions instead of throwing an unhandled browser exception.
replace_once(
    "frontend/client/src/lib/mlb-scientific-snapshot.ts",
    '''export function createMlbScientificSnapshot(
  input: Omit<MlbScientificSnapshot, "schemaVersion">,
): MlbScientificSnapshot {
  const sanitized = sanitizeValue({
    schemaVersion: "mlb-scientific-snapshot.v1",
    ...input,
  }) as MlbScientificSnapshot;

  const bytes = snapshotBytes(sanitized);
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`El snapshot científico MLB excede ${MAX_SNAPSHOT_BYTES} bytes (${bytes}).`);
  }
  return sanitized;
}
''',
    '''export function createMlbScientificSnapshot(
  input: Omit<MlbScientificSnapshot, "schemaVersion">,
): MlbScientificSnapshot {
  const sanitized = sanitizeValue({
    schemaVersion: "mlb-scientific-snapshot.v1",
    ...input,
  }) as MlbScientificSnapshot;

  if (snapshotBytes(sanitized) <= MAX_SNAPSHOT_BYTES) return sanitized;

  const rawInputs = sanitized.analysis.rawInputs && typeof sanitized.analysis.rawInputs === "object"
    ? sanitized.analysis.rawInputs as Record<string, unknown>
    : {};
  const rawOutput = sanitized.analysis.rawOutput && typeof sanitized.analysis.rawOutput === "object"
    ? sanitized.analysis.rawOutput as Record<string, unknown>
    : {};
  const compacted: MlbScientificSnapshot = {
    ...sanitized,
    analysis: {
      ...sanitized.analysis,
      warnings: [
        ...(sanitized.analysis.warnings || []),
        "SNAPSHOT_COMPACTED: source payloads were omitted to remain below the scientific ledger size limit.",
      ].slice(0, 100),
      rawInputs: {
        compacted: true,
        selectedDate: rawInputs.selectedDate,
        selectedGameId: rawInputs.selectedGameId,
        gamePk: rawInputs.gamePk,
        teams: rawInputs.teams,
        pitchers: rawInputs.pitchers,
        bullpens: rawInputs.bullpens,
        lines: rawInputs.lines,
        context: rawInputs.context,
        injuries: rawInputs.injuries && typeof rawInputs.injuries === "object"
          ? sanitizeValue(rawInputs.injuries, 8)
          : rawInputs.injuries,
        omitted: ["sourcePayloads"],
      },
      rawOutput: {
        compacted: true,
        factorBreakdown: rawOutput.factorBreakdown,
        pickQualities: rawOutput.pickQualities,
        bestPlay: rawOutput.bestPlay,
        safePlay: rawOutput.safePlay,
        poisson: rawOutput.poisson,
      },
    },
  };
  if (snapshotBytes(compacted) <= MAX_SNAPSHOT_BYTES) return compacted;

  return {
    ...compacted,
    analysis: {
      ...compacted.analysis,
      rawInputs: { compacted: true, omitted: ["rawInputs", "sourcePayloads"] },
      rawOutput: { compacted: true, omitted: ["rawOutput"] },
    },
  };
}
''',
)

# Add server-side canonical identity, final-stage leakage guards and stronger matching.
replace_once(
    "server/mlb-scientific-snapshot.ts",
    'import { z } from "zod";',
    'import crypto from "crypto";\nimport { z } from "zod";',
)
replace_once(
    "server/mlb-scientific-snapshot.ts",
    '''function parseLineNumber(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const matches = line.match(/[+-]?\\d+(?:\\.\\d+)?/g);
  if (!matches?.length) return undefined;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : undefined;
}
''',
    '''function parseLineNumber(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const matches = line.match(/[+-]?\\d+(?:\\.\\d+)?/g);
  if (!matches?.length) return undefined;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : undefined;
}

export function canonicalMlbPickFingerprint(pick: SavedMlbPickLike): string {
  const odds = parseAmericanOdds(pick.odds);
  const gameDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);
  const identity = JSON.stringify({
    sport: pick.sport,
    gameDate,
    homeTeam: normalize(pick.homeTeam),
    awayTeam: normalize(pick.awayTeam),
    market: mapLedgerMarket(pick.pickType),
    selection: normalize(pick.pickSide),
    line: parseLineNumber(pick.line || pick.pickSide),
    odds,
    modelProbability: Math.round(normalizedProbability(pick.modelProb ?? pick.confidence) * 100_000) / 100_000,
  });
  return crypto.createHash("sha256").update(identity).digest("hex");
}
''',
)
replace_once(
    "server/mlb-scientific-snapshot.ts",
    '''  if (normalize(snapshot.market.selection) !== normalize(pick.pickSide)) {
    const error = new Error("Scientific snapshot selection does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  const canonicalModel = normalizedProbability(pick.modelProb ?? pick.confidence);''',
    '''  if (normalize(snapshot.market.selection) !== normalize(pick.pickSide)) {
    const error = new Error("Scientific snapshot selection does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  const expectedDate = /^\\d{4}-\\d{2}-\\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);
  if (snapshot.game.gameDate !== expectedDate) {
    const error = new Error("Scientific snapshot game date does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
  if (snapshot.market.type !== mapLedgerMarket(pick.pickType)) {
    const error = new Error("Scientific snapshot market type does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  if (snapshot.analysis.stage === "FINAL") {
    if (!snapshot.game.gamePk || !snapshot.game.commenceTime || !snapshot.market.capturedAt) {
      const error = new Error("FINAL scientific snapshots require gamePk, commenceTime and capturedAt");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }
    if (Date.parse(snapshot.market.capturedAt) > Date.parse(snapshot.game.commenceTime)) {
      const error = new Error("FINAL scientific snapshot was captured after the official game start");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }
  }

  const canonicalModel = normalizedProbability(pick.modelProb ?? pick.confidence);''',
)

# Backend suppresses canonical duplicates and stores the detailed snapshot only in SQLite.
replace_once(
    "server/picks-v2.ts",
    'import { buildMlbLedgerPredictionFromPick, mlbScientificSnapshotSchema } from "./mlb-scientific-snapshot";',
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint, mlbScientificSnapshotSchema } from "./mlb-scientific-snapshot";',
)
replace_once(
    "server/picks-v2.ts",
    '''    const originalPicks = loadPicks();
    const picks = originalPicks.map((item) => ({ ...item }));
    const existingIndex = picks.findIndex((item) => item.id === pick.id);
    if (existingIndex >= 0) picks[existingIndex] = { ...picks[existingIndex], ...pick };
    else picks.push(pick);

    savePicks(picks);''',
    '''    const originalPicks = loadPicks();
    if (pick.scientificSnapshot) {
      const incomingFingerprint = canonicalMlbPickFingerprint(pick as Parameters<typeof canonicalMlbPickFingerprint>[0]);
      const duplicate = originalPicks.find((item) => {
        if (item.id === pick.id || item.sport !== "mlb") return false;
        try {
          return canonicalMlbPickFingerprint(item as Parameters<typeof canonicalMlbPickFingerprint>[0]) === incomingFingerprint;
        } catch {
          return false;
        }
      });
      if (duplicate) {
        res.status(409).json({
          success: false,
          error: "This canonical MLB pick is already saved",
          existingPickId: duplicate.id,
        });
        return;
      }
    }

    const { scientificSnapshot: _scientificSnapshot, ...historyData } = pick;
    const storedPick = historyData as SavedPickV2;
    const picks = originalPicks.map((item) => ({ ...item }));
    const existingIndex = picks.findIndex((item) => item.id === pick.id);
    if (existingIndex >= 0) picks[existingIndex] = { ...picks[existingIndex], ...storedPick };
    else picks.push(storedPick);

    savePicks(picks);''',
)
replace_once(
    "server/picks-v2.ts",
    '''      data: pick,
      ledger: pick.sport === "mlb" ? {''',
    '''      data: storedPick,
      ledger: pick.sport === "mlb" ? {''',
)

# Expand focused tests for canonical duplicate identity and pregame FINAL integrity.
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    'import { buildMlbLedgerPredictionFromPick } from "./mlb-scientific-snapshot";',
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint } from "./mlb-scientific-snapshot";',
)
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    '    ts: Date.parse("2026-07-26T18:00:00.000Z"),',
    '    ts: Date.parse("2026-07-26T17:30:00.000Z"),',
)
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    '      capturedAt: "2026-07-26T18:00:00.000Z",',
    '      capturedAt: "2026-07-26T17:30:00.000Z",',
)
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    '          fetchedAt: "2026-07-26T17:55:00.000Z",',
    '          fetchedAt: "2026-07-26T17:25:00.000Z",',
)
append_marker = '''test("legacy MLB picks still map to an explicit provisional mirror", () => {
  const prediction = buildMlbLedgerPredictionFromPick(basePick());
  assert.equal(prediction.analysis.stage, "PROVISIONAL");
  assert.equal(prediction.decision.signal, "INFO");
  assert.equal(prediction.model.version, "picks-v2-mirror-v1");
  assert.equal(prediction.clientRequestId, "picks-v2:ui-mlb-42");
});
'''
append_tests = append_marker + '''

test("canonical fingerprint suppresses the same pick across different UI ids", () => {
  const first = basePick();
  const second = { ...basePick(), id: "ui-mlb-99", ts: first.ts + 15_000 };
  assert.equal(canonicalMlbPickFingerprint(first), canonicalMlbPickFingerprint(second));
});

test("FINAL snapshot captured after game start is rejected", () => {
  const snapshot = fullSnapshot();
  snapshot.market.capturedAt = "2026-07-26T17:36:00.000Z";
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /captured after the official game start/i,
  );
});

test("FINAL snapshot requires the official game identity", () => {
  const snapshot = fullSnapshot();
  delete snapshot.game.gamePk;
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /require gamePk/i,
  );
});
'''
replace_once("server/mlb-scientific-snapshot.test.ts", append_marker, append_tests)

print("MLB full snapshot hardening patch applied")
