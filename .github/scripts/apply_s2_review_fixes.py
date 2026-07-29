from pathlib import Path

routes = Path("server/mlb-ledger-multiuser.ts")
text = routes.read_text()
old_list = "res.json({ success: true, userId, data: records.map((record) => ({ ...record.prediction, ownership: record.ownership })) });"
new_list = "res.json({ success: true, userId, data: records });"
if old_list in text:
    text = text.replace(old_list, new_list, 1)
elif new_list not in text:
    raise SystemExit("list prediction response anchor missing")

old_single = "res.json({ success: true, data: { ...record.prediction, ownership: record.ownership } });"
new_single = "res.json({ success: true, data: record });"
if old_single in text:
    text = text.replace(old_single, new_single, 1)
elif new_single not in text:
    raise SystemExit("single prediction response anchor missing")
routes.write_text(text)

ownership = Path("server/mlb-ledger-ownership-store.ts")
text = ownership.read_text()
existing_method = '''  getOwnership(predictionId: string): OwnershipRow | undefined {
    return this.db.prepare(
      "SELECT * FROM mlb_prediction_owners_v1 WHERE prediction_id = ?",
    ).get(predictionId) as OwnershipRow | undefined;
  }
'''
enhanced_method = existing_method + '''
  getOwnershipByClientRequestId(clientRequestId: string): OwnershipRow | undefined {
    return this.db.prepare(
      "SELECT * FROM mlb_prediction_owners_v1 WHERE client_request_id = ?",
    ).get(clientRequestId.trim()) as OwnershipRow | undefined;
  }
'''
if "getOwnershipByClientRequestId" not in text:
    if existing_method not in text:
        raise SystemExit("getOwnership anchor missing")
    text = text.replace(existing_method, enhanced_method, 1)

start = text.index("  ensureExistingOwnership(")
end = text.index("  status(): {", start)
new_ensure = '''  ensureExistingOwnership(_store: MlbLedgerStore, defaultUserId: number): {
    scanned: number;
    repaired: number;
    migrated: number;
    remainingUnowned: number;
  } {
    const owner = positiveUserId(defaultUserId);
    const rows = this.db.prepare(`
      SELECT p.id, p.client_request_id
      FROM mlb_prediction_ledger_v1 p
      LEFT JOIN mlb_prediction_owners_v1 o ON o.prediction_id = p.id
      WHERE o.prediction_id IS NULL
      ORDER BY p.recorded_at_ms ASC, p.id ASC
    `).all() as Array<{ id: string; client_request_id: string | null }>;
    let repaired = 0;
    let migrated = 0;

    const migrateAll = this.db.transaction(() => {
      for (const row of rows) {
        const clientRequestId = row.client_request_id;
        const claim = clientRequestId
          ? (this.db.prepare(
              "SELECT user_id FROM mlb_prediction_owner_claims_v1 WHERE client_request_id = ?",
            ).get(clientRequestId) as { user_id: number } | undefined)
          : undefined;
        if (claim) {
          this.bind(row.id, clientRequestId, Number(claim.user_id), "repair");
          repaired += 1;
        } else {
          this.bind(row.id, clientRequestId, owner, "migration");
          migrated += 1;
        }
      }
    });
    migrateAll();

    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_ledger_v1").get() as any)?.n || 0,
    );
    const owned = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_owners_v1").get() as any)?.n || 0,
    );
    return {
      scanned: rows.length,
      repaired,
      migrated,
      remainingUnowned: Math.max(0, total - owned),
    };
  }

'''
text = text[:start] + new_ensure + text[end:]

start = text.index("export function appendOwnedPrediction(")
end = text.index("export function appendOwnedSettlement(", start)
new_append = '''export function appendOwnedPrediction(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  raw: unknown,
  userId: number,
  source: OwnershipSource = "session",
): ReturnType<MlbLedgerStore["appendPrediction"]> {
  const parsed = mlbPredictionInputSchema.parse(raw) as MlbPredictionInput;
  const rawClientRequestId = parsed.clientRequestId?.trim();
  const migratedOwnership = rawClientRequestId
    ? ownershipStore.getOwnershipByClientRequestId(rawClientRequestId)
    : undefined;

  if (migratedOwnership && Number(migratedOwnership.user_id) === positiveUserId(userId)) {
    const result = store.appendPrediction({
      ...parsed,
      clientRequestId: rawClientRequestId,
    });
    ownershipStore.bind(result.data.id, rawClientRequestId!, userId, source);
    return result;
  }

  const clientRequestId = scopedLedgerClientRequestId(userId, rawClientRequestId);
  ownershipStore.claim(clientRequestId, userId);
  const result = store.appendPrediction({ ...parsed, clientRequestId });
  ownershipStore.bind(result.data.id, clientRequestId, userId, source);
  return result;
}

'''
text = text[:start] + new_append + text[end:]
ownership.write_text(text)

tests = Path("server/mlb-ledger-ownership-store.test.ts")
text = tests.read_text()
if "retries a migrated raw clientRequestId without duplicating" not in text:
    text += r'''

test("S2 retries a migrated raw clientRequestId without duplicating", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-idempotency-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);

  try {
    const legacy = store.appendPrediction(prediction("legacy-idempotent")).data;
    const ownership = new MlbLedgerOwnershipStore(filename);
    try {
      ownership.ensureExistingOwnership(store, 11);
      const retry = appendOwnedPrediction(
        store,
        ownership,
        prediction("legacy-idempotent"),
        11,
      );
      assert.equal(retry.idempotent, true);
      assert.equal(retry.data.id, legacy.id);
      assert.equal(store.status().predictions, 1);
      assert.equal(ownedRecordsForUser(store, ownership, 11).length, 1);
    } finally {
      ownership.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 migrates every unowned ledger row beyond the historical 10000 limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-large-migration-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);

  try {
    store.appendPrediction(prediction("bulk-anchor"));
    const sqlite = new Database(filename);
    try {
      sqlite.exec(`
        WITH digits(d) AS (
          VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
        ), nums(n) AS (
          SELECT a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 + 1
          FROM digits a, digits b, digits c, digits d, digits e
          WHERE a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 < 10005
        )
        INSERT INTO mlb_prediction_ledger_v1 (
          id, client_request_id, recorded_at_ms, game_pk, game_date, commence_time,
          home_team, away_team, market_type, selection, line, odds_american, book,
          model_prob, market_implied_prob, no_vig_prob, edge_pp, signal,
          confidence_label, confidence_pct, stake_units, analysis_stage,
          model_name, model_version, git_commit, environment, supersedes_id,
          source, payload_sha256, payload_json
        )
        SELECT
          'bulk-' || n, NULL, 1753815600000 + n, NULL, '2026-07-29', NULL,
          'Home', 'Away', 'ML', 'Home', NULL, -110, NULL,
          0.55, 0.52381, NULL, 2.619, 'BET',
          NULL, NULL, 1, 'FINAL',
          'Bulk', '1.0.0', NULL, NULL, NULL,
          'migration', 'hash-' || n, '{}'
        FROM nums;
      `);
    } finally {
      sqlite.close();
    }

    const ownership = new MlbLedgerOwnershipStore(filename);
    try {
      const migration = ownership.ensureExistingOwnership(store, 13);
      assert.ok(migration.scanned > 10000);
      assert.equal(migration.remainingUnowned, 0);
      assert.equal(ownership.status().assignments, store.status().predictions);
    } finally {
      ownership.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 prediction routes preserve the LedgerRecord response contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "server", "mlb-ledger-multiuser.ts"),
    "utf-8",
  );
  assert.match(source, /data: records/);
  assert.match(source, /data: record/);
  assert.doesNotMatch(source, /data: records\.map\(\(record\) => \(\{ \.\.\.record\.prediction/);
});
'''
tests.write_text(text)
