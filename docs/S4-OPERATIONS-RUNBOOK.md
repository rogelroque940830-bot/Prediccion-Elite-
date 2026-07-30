# CourtEdge S4 Operations Runbook

## Objective

Protect the immutable MLB ledger, authentication database, user-owned picks and market history. S4 provides verified backups, isolated restore drills, diagnostics and deduplicated alerts. It does **not** expose a web endpoint that overwrites active data.

## Routine checks

1. Confirm `/health` returns the expected commit and preserves `ledgerOwnership.immutable=true` with `unownedPredictions=0`.
2. Authenticate as an administrator and inspect:
   - `GET /api/ops/v1/status`
   - `GET /api/ops/v1/backups`
   - `GET /api/ops/v1/metrics`
   - `GET /api/ops/v1/diagnostics`
   - `GET /api/ops/v1/alerts`
3. A healthy backup should be verified and no older than `COURTEDGE_BACKUP_MAX_AGE_HOURS` (default 36 hours).
4. A restore drill should pass at least every `COURTEDGE_RESTORE_DRILL_MAX_AGE_DAYS` (default 7 days).

## Manual backup and validation

1. `POST /api/ops/v1/backups` with administrator session + CSRF or the service token.
2. Record the returned `backupId`.
3. `POST /api/ops/v1/backups/{backupId}/verify`.
4. Confirm every present asset reports `integrity=OK`, has a SHA-256 hash and the overall result is valid.

## Isolated restore drill

1. Select a verified backup.
2. `POST /api/ops/v1/backups/{backupId}/restore-drill`.
3. Confirm `valid=true` and `sourceUntouched=true`.
4. Compare restored SQLite table counts with the expected ledger/auth counts.
5. The drill directory is temporary and is deleted automatically. Results remain append-only in `restore-drills.jsonl`.

## Actual disaster restoration

Actual replacement is intentionally an offline maintenance procedure:

1. Declare a maintenance window and stop the backend so SQLite writers and WAL workers are closed.
2. Preserve the damaged volume and create a final forensic copy when readable.
3. Select a backup that passed both verification and an isolated restore drill.
4. Copy restored files to new temporary destination names on the persistent volume.
5. Run `PRAGMA integrity_check` on both SQLite files and parse every JSON asset.
6. Atomically rename the temporary files into their configured source paths.
7. Remove stale `-wal` and `-shm` files only while the application is stopped and only after the restored main SQLite files are in place.
8. After an auth database restoration, delete expired sessions or require fresh login if the incident involved credential/session uncertainty.
9. Start the backend and verify:
   - deployed commit;
   - ledger immutable and WAL;
   - prediction and settlement counts;
   - ownership assignments equal prediction count;
   - zero unowned predictions and zero unowned picks;
   - backup worker and alert worker enabled.
10. Run a new backup and a new isolated restore drill after recovery.

## Rollback

If post-restore validation fails, stop the backend immediately, restore the pre-maintenance volume snapshot, and keep the failed restored files for analysis. Never modify or delete immutable ledger rows to reconcile counts; corrections must remain append-only settlement events.

## Alert interpretation

- `WARN`: resilience is degraded but active data invariants remain intact, such as a missing/stale drill.
- `CRITICAL`: ledger/ownership invariant failed, backup verification failed, backup is severely stale, restore drill failed, or runtime resource/error thresholds are exceeded.
- Identical alerts are deduplicated during `COURTEDGE_ALERT_COOLDOWN_MS` (default 1 hour).
- `COURTEDGE_ALERT_WEBHOOK_URL` is optional. Alerts always remain in `operational-alerts.jsonl` and backend logs even without a webhook.

## Recovery objectives

With daily backups, the default recovery point objective is at most 24 hours for persisted operational assets. Recovery time depends on volume replacement and verification; target an operator-led restoration within 60 minutes after a valid backup is selected.
