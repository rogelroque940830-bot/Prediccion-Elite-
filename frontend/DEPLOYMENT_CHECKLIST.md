# Court Edge Staging Promotion Checklist

- [ ] `npm ci` succeeds on Node 20.19.5.
- [ ] `npm run verify` succeeds.
- [ ] CI artifact contains `dist/` and `RELEASE_MANIFEST.json`.
- [ ] Core backend smoke succeeds.
- [ ] Extended MLB smoke succeeds for the target date.
- [ ] All 11 routes pass desktop visual QA.
- [ ] All 11 routes pass mobile visual QA.
- [ ] Browser network log contains no `pplx.app` requests.
- [ ] `/picks` uses `/api/picks/v2` only.
- [ ] CORS is restricted or explicitly accepted for the staging period.
- [ ] No public URL, DNS or Railway configuration is changed during staging.
- [ ] Rollback owner and promotion approver are identified.
