# S5A — Isolated Real-Save End-to-End Validation

## Objective

Validate the complete MLB operating path after S4 without modifying Railway, production, `main`, or the shared persistent volume.

The tested path is:

```text
Canonical Picks V2 save
  → sanitized scientific snapshot
  → immutable user-owned MLB ledger
  → process restart and persistence
  → official MLB settlement
  → immutable history and reproducible report
  → user-scoped export
  → operational backup, verification and restore drill
```

## Isolation boundary

The workflow creates temporary paths for:

- the MLB ledger and closing-line SQLite database;
- the authentication and session SQLite database;
- the editable Picks V2 JSON store;
- operational backups and restore-drill workspaces.

It does not connect to Railway, mount `/app/data`, use `web-volume-SqZG`, or send writes to a deployed service. Provider credentials are replaced by non-secret isolated placeholders. The official MLB Stats API is used only to identify and settle a recently completed real game.

## Validation contract

The S5A script verifies:

1. The isolated stores begin empty and have no unowned predictions.
2. An unauthenticated Picks V2 write is rejected.
3. A canonical MLB save with a complete scientific snapshot reaches the immutable ledger through the real Picks V2 route.
4. Editable history keeps only the lightweight record; the detailed snapshot remains in SQLite.
5. The immutable prediction receives the bootstrap user ownership claim.
6. An exact retry is idempotent.
7. The same canonical pick under a different UI identifier is rejected as a duplicate.
8. Picks, ownership and the immutable ledger survive a backend restart.
9. The global settlement endpoint grades the prediction from the official MLB final feed.
10. A second settlement pass performs no duplicate work.
11. User history, report and export contain the settled record and a stable dataset SHA-256.
12. Operational backup verification and restore drill pass without modifying the source files.
13. Deterministic diagnostics for backup freshness, restore freshness, immutability and ownership are healthy.
14. Direct SQLite updates and deletes remain blocked by immutable triggers.

The prediction is a zero-stake `INFO` technical canary. It is not a betting recommendation and cannot create financial exposure.

## Commands

```bash
npm ci
npm run build:backend
npm run test:s5a-e2e
```

The GitHub Actions workflow also runs the S1, S2, S3, S4 and complete MLB regression gates before executing S5A.

## Evidence

The workflow uploads a 30-day artifact containing:

- `evidence.json`;
- backend `server.log`;
- the user-scoped JSONL ledger export;
- isolated copies of the ledger, authentication database and lightweight Picks V2 file;
- the captured workflow console log.

S5A passes only when every deterministic assertion succeeds. A failure leaves evidence and logs for diagnosis while the workflow exits non-zero.
