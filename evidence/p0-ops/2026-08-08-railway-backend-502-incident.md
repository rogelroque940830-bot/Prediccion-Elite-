# P0 Railway backend 502 incident — 2026-08-08

## Incident

The `integration/p0-staging-secure` backend became unavailable while the Predictor engineering work itself remained green. GitHub's Railway deployment context for integration commit `b9c403f5682792f397d814451a94b1467c8253ef` reported `failure`. Independent live checks observed HTTP 502 on `/health`, the P1 MLB slate, and `/api/mlb/all`.

A source-only redeploy marker was merged after S5A and S5B passed. A direct post-marker check still returned HTTP 502 on `/health`, with no deploy commit observable.

## Application-side falsification

Two independent GitHub Actions smokes failed to reproduce an application crash:

1. Node 24 + `npm ci` + production backend build + `node dist/index.cjs` returned localhost `/health` HTTP 200.
2. The exact repository Nixpacks contract — Node 20 + `npm install` + `npm run build:backend` + `node dist/index.cjs` — also returned localhost `/health` HTTP 200.

Therefore neither the current application bundle nor the repository's Nixpacks/Node20 build-and-start contract reproduces the Railway failure.

## Recovery capability

Railway CLI was available in GitHub Actions, but neither `RAILWAY_TOKEN` nor `RAILWAY_API_TOKEN` was configured in repository Actions secrets. No credential value was printed or persisted, and no Railway write action was attempted.

## Conclusion

The evidence supports a Railway deployment/service-layer incident, not a Predictor runtime, formula, readiness, or Nixpacks compatibility defect. Further blind code changes or repeated source markers are not justified. Recovery requires Railway service/deployment access or a valid Railway API/project token, after which live Predictor and INJURIES validation can resume.

## Safety

No predictor formula, probability, threshold, readiness policy, prediction record, settlement, bet, or persisted credential was changed by the incident investigation.
