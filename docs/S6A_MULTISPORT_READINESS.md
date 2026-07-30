# S6A Multisport Readiness Audit

## Purpose

S6A measures whether the existing NBA, WNBA, and NHL data surfaces are ready for a future controlled shadow-mode phase. It does not generate predictions, place wagers, modify formulas, or authorize any market.

## Runtime

The worker is enabled by default only in Railway environment `p0-integration`.

- default interval: 6 hours;
- startup delay: 180 seconds;
- reads existing internal schedule, context, injury, support, and odds routes;
- writes only S6A-owned JSON audit files;
- creates a snapshot only when the material readiness state changes.

Environment overrides:

- `MULTISPORT_READINESS_ENABLED`
- `MULTISPORT_READINESS_INTERVAL_MS`
- `MULTISPORT_READINESS_INITIAL_DELAY_MS`
- `MULTISPORT_READINESS_DIR`

## Probe coverage

### NBA

- `/api/nba/schedule`
- `/api/nba/all`
- `/api/odds/nba`

### WNBA

- `/api/wnba/games`
- `/api/wnba/all`
- `/api/wnba/injuries`
- `/api/wnba/fatigue`
- `/api/wnba/sos`
- `/api/wnba/players`
- `/api/odds/wnba`

### NHL

- `/api/nhl/all`
- `/api/odds/nhl`

## Readiness states

- `READY`: games are scheduled and required context plus market prices are available.
- `NO_GAMES`: no games are scheduled; this is not treated as an outage.
- `DEGRADED`: the slate is partially usable but a fallback, optional source failure, or missing market price requires caution.
- `BLOCKED`: an active slate is missing a required context or odds source.

Probe states are `HEALTHY`, `DEGRADED`, `EMPTY`, and `FAILED`.

A WNBA production read-only fallback is explicitly marked `DEGRADED`; it is never presented as a direct healthy source.

## Endpoints

Public sanitized health:

- `GET /health/s6a-readiness`

Protected detail:

- `GET /api/multisport/readiness/v1/status`
- `GET /api/multisport/readiness/v1/latest`
- `GET /api/multisport/readiness/v1/sports/:sport`

The public endpoint exposes only aggregate state, counts, timestamps, and safety invariants. It does not expose teams, selections, market rows, probabilities, or user data.

## Safety boundary

Every audit states and enforces:

- predictions created: 0;
- real financial exposure: 0;
- no sportsbook integration;
- no automatic wager placement;
- no production writes;
- no automatic promotion;
- no formula, filter, market, threshold, or stake-policy changes.

S6A is an inventory and quality gate only. A separate human-reviewed phase is required before any sport can enter shadow prediction capture.
