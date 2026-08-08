# P1-M3F3A — Advanced-factor aggregate provenance

## Purpose

P1-M3F2 live evidence established that all five detailed MLB `ADVANCED_FACTORS` endpoints can return HTTP 200 while exposing no timestamp recognized by P1-M2B. P1-M3F3A hardens the *consumer-side aggregation contract* before any endpoint is made certifiable.

This phase does **not** change any predictor formula, probability, threshold, market price, stake, ledger record, settlement, sportsbook integration, actionability or promotion state.

## Problem being fixed

The prior generic derived-source aggregation had two unsafe properties for a multi-component field:

1. it selected the **newest** timestamp found anywhere in the successful payloads, so one fresh component could mask another old or untimed component;
2. `maxAge(ADVANCED_FACTORS)` inherited the minimum freshness bound from every source definition for that field, including the separate `/api/mlb/all` aggregate payload (600 seconds), even though the five detailed factor endpoints have a 21,600-second registered bound.

A request-time `generatedAt` is not sufficient evidence. P1-M3F1 established the precedent that a derived source may call itself temporally certified only after its required internal source acquisition has succeeded under a fail-closed contract.

## M3F3A contract

For the exact detailed `ADVANCED_FACTORS` set queried by P1-M2B:

- `/api/mlb/quality/:gamePk`
- `/api/mlb/statcast-matchup/:gamePk`
- `/api/mlb/discipline-speed/:gamePk`
- `/api/mlb/sos/:gamePk`
- `/api/mlb/advanced/:gamePk`

P1-M2B must require all five HTTP/usable responses before the field can be fresh.

Each successful component must independently expose:

- a recognized direct/provenance timestamp; and
- `sourceStatus=CERTIFIED` (top-level or in provenance).

The aggregate observation time is the **oldest component observation time**. A newer sibling cannot overwrite or conceal an older component.

The detailed five-endpoint set uses the registered detailed/supporting-factor freshness contract (21,600 seconds), not the separate `/api/mlb/all` aggregate-analysis 600-second contract.

Classification is conservative:

- no successful component -> `MISSING`;
- partial HTTP/source coverage -> `DEGRADED`;
- any successful but uncertified component -> `DEGRADED`;
- any successful but untimed component -> `DEGRADED`;
- all certified/timed but at least one stale -> `STALE`;
- all five certified, timed and fresh -> `FRESH`.

## Important non-claim

The live advanced-factor endpoints are **not** declared certified by this phase. P1-M3F2 showed that they are currently untimed. Therefore a live ML decision is expected to remain `READY_PROVISIONAL` after M3F3A until P1-M3F3B establishes honest per-endpoint provenance.

M3F3A is an aggregation-integrity prerequisite, not evidence that `READY_FINAL` is currently attainable.

## Falsification requirements

CI must prove:

1. five certified/fresh components can produce `ADVANCED_FACTORS=FRESH` and the oldest timestamp is retained;
2. one untimed component prevents `FRESH` even when four siblings are fresh;
3. one stale component makes the aggregate stale rather than being masked by newer timestamps;
4. a timestamp without certified source status cannot certify the component;
5. the detailed factor set uses the 21,600-second source contract and does not inherit the unrelated 600-second `/api/mlb/all` aggregate bound.

## Safety

P1-M3F3A remains decision-support infrastructure only:

- real financial exposure: 0;
- automatic bet placement: false;
- automatic model changes: false;
- automatic promotion: false;
- no output probability or economic-decision formula changes.
