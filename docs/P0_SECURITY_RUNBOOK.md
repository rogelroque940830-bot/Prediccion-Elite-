# Court Edge — P0 Security Runbook

This branch is isolated from `main`. Do not deploy or merge it until every item below is complete.

## 1. Rotate exposed provider credentials

Treat the existing Odds API and BALLDONTLIE credentials as compromised because they appeared in a public repository.

1. Revoke each old credential in the provider dashboard.
2. Generate a new credential.
3. Store the new value only in Railway variables:
   - `ODDS_API_KEY`
   - `BDL_API_KEY`
4. Never paste the values into GitHub, documentation, screenshots, issues, commits, or the frontend.
5. Confirm the revoked keys no longer work.

Deleting a secret from the latest commit does not make the old value safe. Rotation is mandatory.

## 2. Configure backend security variables

Set these Railway variables before deploying this branch:

- `NODE_ENV=production`
- `COURTEDGE_ALLOWED_ORIGINS=https://<approved-frontend-domain>`
- `COURTEDGE_WRITE_TOKEN=<long-random-secret>`
- `ALLOW_LEGACY_PICKS_SYNC=false`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_READ_MAX=180`
- `RATE_LIMIT_WRITE_MAX=30`

`COURTEDGE_ALLOWED_ORIGINS` accepts a comma-separated list. Do not use `*` in production.

## 3. Write-operation policy

The following route families require `COURTEDGE_WRITE_TOKEN` for non-read methods:

- `/api/picks...`
- `/api/clv...`
- `/api/sharp...`

The caller must send one of:

- `Authorization: Bearer <token>`
- `X-CourtEdge-Write-Key: <token>`

The legacy endpoint `POST /api/picks/sync` returns HTTP 410 unless `ALLOW_LEGACY_PICKS_SYNC=true`. It should remain disabled after migration because it can overwrite the full picks state.

## 4. Required validation before merge

- Backend build passes on Node 20.
- `/` and `/health` return 200.
- Approved frontend origin succeeds.
- Unapproved origin returns 403.
- Protected writes without a token return 401 or 503.
- Protected writes with the valid token succeed.
- Legacy picks sync returns 410.
- Rate limiting returns 429 after the configured threshold.
- No provider key literals remain in tracked files.
- Existing production deployment remains untouched until the above checks pass in staging.

## 5. Promotion rule

Merge into `main` only after credential rotation, Railway variable configuration, staging smoke tests, and a reviewed pull request. Do not push this branch directly to the production Railway service.
