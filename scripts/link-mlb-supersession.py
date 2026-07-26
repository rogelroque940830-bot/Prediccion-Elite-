from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# The browser refuses to label or submit an analysis as a pregame event once the
# official start has passed. Missing commence time remains explicitly provisional.
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    '''    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate);
    const injuryStatus = (status: MLBInjuryFeedStatus): MlbSourceStatus => status === "VERIFIED" ? "VERIFIED"''',
    '''    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate);
    if (commenceTime && Date.parse(capturedAt) > Date.parse(commenceTime)) {
      toast({
        title: "El juego ya comenzó",
        description: "No se puede guardar una predicción científica pregame después del inicio oficial.",
        variant: "destructive",
      });
      return;
    }
    const injuryStatus = (status: MLBInjuryFeedStatus): MlbSourceStatus => status === "VERIFIED" ? "VERIFIED"''',
)
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    '''      gamePkForTesi
      && selectedGameId
      && completeFactorFeeds >= 10''',
    '''      gamePkForTesi
      && selectedGameId
      && commenceTime
      && completeFactorFeeds >= 10''',
)

# The server rejects post-start timestamps regardless of FINAL/PROVISIONAL label.
replace_once(
    "server/mlb-scientific-snapshot.ts",
    '''  if (snapshot.analysis.stage === "FINAL") {
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
''',
    '''  if (snapshot.analysis.stage === "FINAL"
    && (!snapshot.game.gamePk || !snapshot.game.commenceTime || !snapshot.market.capturedAt)) {
    const error = new Error("FINAL scientific snapshots require gamePk, commenceTime and capturedAt");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
  if (snapshot.game.commenceTime && snapshot.market.capturedAt
    && Date.parse(snapshot.market.capturedAt) > Date.parse(snapshot.game.commenceTime)) {
    const error = new Error("Scientific snapshot was captured after the official game start");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
''',
)

# Supersession is server-derived from prior immutable records; clients cannot forge it.
replace_once(
    "server/mlb-scientific-snapshot.ts",
    '''  type MlbPredictionInput,
} from "./mlb-ledger-store";''',
    '''  type LedgerRecord,
  type MlbPredictionInput,
} from "./mlb-ledger-store";''',
)
insert_before = '''export function buildMlbLedgerPredictionFromPick(pick: SavedMlbPickLike): MlbPredictionInput {
'''
helper = '''function sameOptionalNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Math.abs(left - right) < 0.000001;
}

export function findMlbSupersedesId(
  records: LedgerRecord[],
  next: MlbPredictionInput,
): string | undefined {
  const candidates = records.filter(({ prediction }) => {
    const sameOfficialGame = next.game.gamePk != null && prediction.game.gamePk != null
      ? next.game.gamePk === prediction.game.gamePk
      : next.game.gameDate === prediction.game.gameDate
        && normalize(next.game.homeTeam) === normalize(prediction.game.homeTeam)
        && normalize(next.game.awayTeam) === normalize(prediction.game.awayTeam);
    return sameOfficialGame
      && next.market.type === prediction.market.type
      && normalize(next.market.selection) === normalize(prediction.market.selection)
      && sameOptionalNumber(next.market.line, prediction.market.line)
      && prediction.source === "app";
  });
  if (!candidates.length) return undefined;
  candidates.sort((left, right) =>
    left.prediction.recordedAtMs - right.prediction.recordedAtMs
    || left.prediction.id.localeCompare(right.prediction.id));
  return candidates[candidates.length - 1]?.prediction.id;
}

'''
replace_once("server/mlb-scientific-snapshot.ts", insert_before, helper + insert_before)

# Build the canonical input once, derive any prior version from SQLite, then append.
replace_once(
    "server/picks-v2.ts",
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint, mlbScientificSnapshotSchema } from "./mlb-scientific-snapshot";',
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint, findMlbSupersedesId, mlbScientificSnapshotSchema } from "./mlb-scientific-snapshot";',
)
replace_once(
    "server/picks-v2.ts",
    '''function mirrorMlbPickToScientificLedger(pick: SavedPickV2): void {
  if (pick.sport !== "mlb") return;
  getMlbLedgerStore().appendPrediction(buildMlbLedgerPredictionFromPick(pick as Parameters<typeof buildMlbLedgerPredictionFromPick>[0]));
}
''',
    '''function mirrorMlbPickToScientificLedger(pick: SavedPickV2): void {
  if (pick.sport !== "mlb") return;
  const store = getMlbLedgerStore();
  const prediction = buildMlbLedgerPredictionFromPick(
    pick as Parameters<typeof buildMlbLedgerPredictionFromPick>[0],
  );
  if (pick.scientificSnapshot) {
    const records = store.listRecords({
      from: prediction.game.gameDate,
      to: prediction.game.gameDate,
      market: prediction.market.type,
      limit: 1_000,
    });
    const supersedesId = findMlbSupersedesId(records, prediction);
    store.appendPrediction(supersedesId ? { ...prediction, supersedesId } : prediction);
    return;
  }
  store.appendPrediction(prediction);
}
''',
)

# Test chain selection and the stronger pregame rule.
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint } from "./mlb-scientific-snapshot";',
    'import { buildMlbLedgerPredictionFromPick, canonicalMlbPickFingerprint, findMlbSupersedesId } from "./mlb-scientific-snapshot";',
)
replace_once(
    "server/mlb-scientific-snapshot.test.ts",
    '/captured after the official game start/i,',
    '/captured after the official game start/i,',
)
append = '''

test("latest matching immutable prediction is selected as supersedesId", () => {
  const next = buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: fullSnapshot() });
  const record = (id: string, recordedAtMs: number, model: number) => ({
    prediction: {
      id,
      clientRequestId: `picks-v2:${id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: { gamePk: 822950, gameDate: "2026-07-26", commenceTime: "2026-07-26T17:35:00.000Z", homeTeam: "Tampa Bay Rays", awayTeam: "Cleveland Guardians" },
      market: { type: "ML", selection: "Tampa Bay Rays ML", line: null, oddsAmerican: -110, book: "Hard Rock" },
      probabilities: { model, marketImplied: 0.5238, noVig: 0.5, edgePp: (model - 0.5238) * 100 },
      decision: { signal: "BET", confidenceLabel: "A", confidencePct: model * 100, stakeUnits: 1 },
      analysisStage: "FINAL",
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v1", gitCommit: null, environment: null },
      supersedesId: null,
      source: "app",
      payloadSha256: id.padEnd(64, "0").slice(0, 64),
      payload: {},
    },
    settlement: null,
  });
  const records = [record("mlb-pred-old", 1_000, 0.58), record("mlb-pred-newer", 2_000, 0.60)];
  assert.equal(findMlbSupersedesId(records as any, next), "mlb-pred-newer");
});

test("provisional snapshot captured after known game start is also rejected", () => {
  const snapshot = fullSnapshot();
  snapshot.analysis.stage = "PROVISIONAL";
  snapshot.market.capturedAt = "2026-07-26T17:36:00.000Z";
  assert.throws(
    () => buildMlbLedgerPredictionFromPick({ ...basePick(), scientificSnapshot: snapshot }),
    /captured after the official game start/i,
  );
});
'''
path = ROOT / "server/mlb-scientific-snapshot.test.ts"
text = path.read_text(encoding="utf-8")
if append.strip() in text:
    raise RuntimeError("Supersession tests already present")
path.write_text(text.rstrip() + append + "\n", encoding="utf-8")

print("MLB supersession and pregame integrity patch applied")
