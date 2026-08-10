# Sprint 2 - Staging Runbook

## Objective
Publish an isolated copy of the React/Vite frontend without changing the current Perplexity URL or the Railway backend.

## Required gates
1. `npm ci`
2. `npm run verify`
3. Download the CI artifact and confirm `RELEASE_MANIFEST.json`.
4. Deploy `dist/` to a disposable staging domain.
5. Set `COURTEDGE_STAGING_API_BASE_URL` in GitHub Actions and run **Court Edge Staging Smoke**.
6. Execute the visual matrix in `VISUAL_QA_MATRIX.md` on desktop and mobile.

## Recommended staging command
```bash
docker build   --build-arg VITE_API_BASE_URL=https://web-production-7067b.up.railway.app   -t courtedge-web:sprint2 .
docker run --rm -p 8080:8080 courtedge-web:sprint2
```

## No-write rule
Do not test POST/DELETE against the production picks endpoints during staging certification. The automated smoke test is read-only.

## Rollback
The current public application remains untouched. A failed staging candidate is discarded; no DNS, Railway or Perplexity rollback is required.

## Promotion decision
Promote only when CI, API smoke, route QA and visual comparison are all green. A successful Railway backend deployment is not proof that the independent frontend build is valid.
