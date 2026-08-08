# P1-M2B Certified Advanced Component Routes

## Live evidence basis

Post-repair live evidence #398 showed MLB advanced certification improving from 0/5 to 2/5 components after the `/api/mlb/advanced/:gamePk` runtime repair. `DISCIPLINE_SPEED` and `SOS` still appeared to M2B as missing/untimed certification even though their standalone certifiers had already been built and validated in P1-M3F3B2 and P1-M3F3B3.

Code inspection confirmed the cause: the historical GET routes still called the legacy functions `getDisciplineSpeedForGame()` and `getTeamSos()`. Those legacy functions intentionally return the existing numerical results but do not expose the `sourceStatus=CERTIFIED` plus explicit `generatedAt` required by M2B.

This is therefore an integration/wiring repair, not a new predictive hypothesis.

## Repair

The compatibility middleware is registered by `registerMlbP1PregameReadinessRoutes()`, which already runs before `registerMlbCoreRoutes()`. This keeps the integration owned by M2B readiness and leaves the global route composition root unchanged. It intercepts exactly two existing GET paths:

- `/api/mlb/discipline-speed/:gamePk`
- `/api/mlb/sos/:gamePk`

The historical `app.get` registrations remain in `mlb-core-routes.ts` for route-contract stability. GET requests are intercepted first and served through the already-validated certifiers.

### Discipline / Speed

The middleware acquires doubleheader-safe `feed/live` metadata, probable-pitcher IDs/names and the current batting-order IDs. It calls `getDisciplineSpeedCertifiedSnapshot()`.

When certification succeeds, the existing numerical shape is preserved and the response additionally exposes:

- `sourceStatus=CERTIFIED`
- explicit `generatedAt`
- the certifier provenance object.

If certification fails, the middleware calls the historical `getDisciplineSpeedForGame()` only as a compatibility fallback. The numerical output is preserved, but the top-level response is explicitly `sourceStatus=DEGRADED` and has no certifiable `generatedAt`. M2B therefore cannot count the component as certified.

### Strength of Schedule

The middleware calls `getTeamSosCertifiedSnapshot()` independently for both clubs. The public response preserves the historical `home` and `away` TeamSos values. Top-level certification is emitted only when both team snapshots certify.

The aggregate `generatedAt` is the older of the two certified timestamps, preserving the conservative oldest-evidence policy.

If either team certifier fails, both historical `getTeamSos()` values are used only for compatibility and the top-level component remains `DEGRADED` and untimed for certification purposes.

## Scientific boundary

This package does not change:

- discipline or sprint-speed formulas;
- SOS formulas or weights;
- Statcast logic;
- model probabilities;
- thresholds;
- odds;
- stakes;
- ledger or settlement behavior;
- sportsbook integration;
- automatic betting;
- automatic model promotion.

The repair only connects previously validated provenance/certification to the routes M2B already consumes.

## Next measurement

After merge and deployment, the live M2B audit must be repeated. The expected result is not assumed in advance. If Discipline and SOS certify on real source conditions, advanced coverage may increase from 2/5 toward 4/5. Statcast remains independently fail-closed and must not be forced to `CERTIFIED`; its current `DEGRADED` provenance must be diagnosed from its own blockers after this wiring repair.
