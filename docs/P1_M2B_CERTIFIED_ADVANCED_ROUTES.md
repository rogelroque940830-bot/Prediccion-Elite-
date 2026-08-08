# P1-M2B Certified Advanced Component Routes

## Evidence basis

Live evidence #401 validated the first integration step: `DISCIPLINE_SPEED` and `SOS` became `CERTIFIED` + `FRESH` in 3/3 measured ML games after #399. The advanced aggregate nevertheless remained 2/5 because `QUALITY` and `ADVANCED_CONTEXT` still returned their legacy numerical payloads without top-level certification/timestamps, while `STATCAST_MATCHUP` remained strictly `DEGRADED`.

The standalone certifiers for Quality and Advanced Context already existed and had been validated in P1-M3F3B1 (#359) and P1-M3F3B4 (#362). Both original PRs explicitly left the P1 routes unswitched. This package completes that wiring; it does not introduce a new predictive hypothesis.

## Registration strategy

`registerMlbP1PregameReadinessRoutes()` owns the compatibility middleware and is already registered before the legacy MLB core/market-support routes. The global `server/routes.ts` remains unchanged.

The middleware now covers four historical GET paths:

- `/api/mlb/quality/:gamePk`
- `/api/mlb/advanced/:gamePk`
- `/api/mlb/discipline-speed/:gamePk`
- `/api/mlb/sos/:gamePk`

Historical `app.get` routes remain in place for route-contract and backward compatibility.

## Quality

The strict path calls `getStatcastQualityCertifiedSnapshot()`. It uses the certified pitcher/batter maps only inside the process to rebuild the same game-specific legacy surface:

- `homeSP`
- `awaySP`
- `homeBatters`
- `awayBatters`

The large certified maps are never exposed through the HTTP response. A successful response adds only `sourceStatus=CERTIFIED`, explicit `generatedAt` and provenance.

If the strict certifier throws, the middleware calls `next()` and the untouched legacy `/api/mlb/quality/:gamePk` route answers normally. Therefore compatibility is preserved and M2B cannot falsely count the component as certified.

## Advanced Context

The strict path calls `getAdvancedContextCertifiedSnapshot(gamePk)`, which already validates official game/venue identity, park mapping, roof/weather evidence and probable-pitcher season sources while retaining the existing park/weather/opener numerical formulas.

On certification success, the historical numerical shape is preserved and route-level certification metadata is added. If certification throws, the middleware calls `next()` and the untouched legacy `/api/mlb/advanced/:gamePk` route remains authoritative for compatibility but uncertified for M2B.

## Discipline / Speed

The previously merged path uses `getDisciplineSpeedCertifiedSnapshot()`. On strict-source failure, legacy numbers are preserved under explicit `sourceStatus=DEGRADED` without a certifiable timestamp.

## Strength of Schedule

The previously merged path certifies only when both `getTeamSosCertifiedSnapshot()` calls succeed. The aggregate timestamp is the older team timestamp. Any certifier failure preserves legacy numbers but remains `DEGRADED` and untimed.

## Scientific boundary

This package changes no:

- Quality, park, weather, opener, Discipline/Speed or SOS formula;
- Statcast matchup logic;
- model probability;
- recommendation threshold;
- odds or stake;
- ledger or settlement behavior;
- sportsbook integration;
- automatic bet or model promotion.

`STATCAST_MATCHUP` remains independently fail-closed and is intentionally untouched.

## Next measurement

After deployment, M2B must be re-audited on real pregame games. No certification count is assumed in advance. If both newly wired certifiers satisfy their strict source contracts, the aggregate can move toward 4/5; otherwise each request must remain on its legacy uncertified surface. Only after that measurement should Statcast's remaining strict blocker be investigated.
