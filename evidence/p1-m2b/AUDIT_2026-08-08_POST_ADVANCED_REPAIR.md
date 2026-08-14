# P1-M2B Post Advanced-Route Repair Evidence — 2026-08-08

## Decision

The advanced-route runtime repair in #396 is validated live.

The former runtime reference failures (`getGameMeta` / `MLB_SEASON_CURRENT`) no longer appear, and the ML advanced aggregate improved from **0/5 certified components to 2/5** on the post-repair live sample.

However, `READY_FINAL` is still not supported. All six sampled readiness evaluations remained `READY_PROVISIONAL`.

## Chain of custody

- deployed repaired backend commit: `6f259cb7d4aaf483b53834a53c44f616db2b5095`;
- temporary research PR: #397;
- authoritative sanitized workflow run: `31270837955`;
- sanitized aggregate artifact id: `9025517825`;
- raw game/team/player/pitcher identities were not persisted in the sanitized artifact.

An earlier temporary run on the same PR retained public MLB game identifiers inside endpoint URLs in its diagnostic errors. That artifact is not accepted as permanent evidence. The authoritative rerun sanitized all component errors into stable codes and retained the artifact for one day only.

## Baseline versus post-repair

Baseline evidence #395:

- 0/6 `READY_FINAL`;
- 6/6 `READY_PROVISIONAL`;
- ML `ADVANCED_FACTORS_DEGRADED` 3/3;
- advanced certification 0/5;
- concrete advanced-route runtime reference error observed.

Post-repair:

- 0/6 `READY_FINAL`;
- 6/6 `READY_PROVISIONAL`;
- 0 blocked and 0 request failures;
- ML `ADVANCED_FACTORS_DEGRADED` remains 3/3;
- advanced certification improved to **2/5**;
- former runtime reference error is gone.

Therefore #396 repaired a real source path and recovered usable advanced evidence, but it did not by itself make ML FINAL-ready.

## Remaining ML advanced blockers

The three uncaptured advanced components now fail with explicit endpoint-level evidence:

1. `STATCAST_MATCHUP` — `ADVANCED_ENDPOINT_ERROR`;
2. `DISCIPLINE_SPEED` — `DISCIPLINE_ENDPOINT_ERROR`;
3. `SOS` — `SOS_ENDPOINT_ERROR`.

These are now the next proven advanced-factor blockers. The correct action is to inspect their route availability/wiring before modifying formulas or readiness policy.

`INJURIES_DEGRADED` also remained present in all six market evaluations and is independently sufficient to prevent FINAL status because injuries are a universal FINAL-only field.

## F5 remained unchanged

F5_ML still has:

- PITCHER_FORM available but `DERIVED_WITHOUT_EXPLICIT_TIMESTAMP`;
- LINEUP_MATCHUP available but `DERIVED_WITHOUT_EXPLICIT_TIMESTAMP`;
- INJURIES_DEGRADED.

No F5 provenance change should be made from this repair. The post-repair audit was specifically intended to determine what the advanced-route correction recovered before moving to another component.

## Scientific interpretation

The important result is not that FINAL is still absent. It is that the repair moved the system in the expected direction under the same strict gate:

- no gate relaxation;
- no threshold change;
- no model change;
- no synthetic evidence;
- real advanced certification increased from 0/5 to 2/5.

That is the correct pattern for incremental source-integrity hardening.

## Next work

Inspect the current P1-M2B source wiring for the three explicit missing/unavailable advanced endpoints and repair only the routes that are proven absent or miswired.

After each bounded repair, re-run live readiness before changing the next component.

## Safety

The research performed zero production writes, zero prediction creation, zero settlements, zero bets and zero sportsbook calls from the research runner.
