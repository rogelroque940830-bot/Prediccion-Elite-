# P0 Odds Provider Quota Conservation — Live Evidence

## Scope

Permanent sanitized evidence for the provider-quota conservation repair merged as PR #466 and deployed at commit `211a8a102acbec847628d7aa35c562242a9cbc03`.

The repair does not create new odds or bypass provider limits. Its purpose is to prevent background services from spending a bounded provider quota while preserving the ability of interactive/readiness requests and decision-specific closing-line checkpoints to request fresh prices.

## Pre-fix root cause evidence

Temporary research PR #461 proved the active P1-M2 hard blocker was `OUT_OF_USAGE_CREDITS` from The Odds API. Static inventory PR #462 identified automatic consumption incompatible with a small monthly allowance:

- the legacy compatibility poller requested MLB, NHL and NBA automatically at boot and every two hours;
- S5C ran every five minutes in `p0-integration` and called the F5 odds route before filtering whether any pregame game remained;
- one uncached F5 refresh can require one events request plus one event-odds request per eligible MLB game;
- S5E also queried the F5 route near closing-capture windows;
- the decision-specific closing-line worker was preserved because its provider access is tied to actual due prediction checkpoints rather than broad all-sport polling.

## Production repair

PR #466 introduced the following operational boundaries without changing model probabilities, recommendations, thresholds or stakes:

- legacy all-sport polling is disabled by default and requires explicit `LEGACY_ODDS_BACKGROUND_POLLING=true` opt-in;
- S5C fetches the official schedule first and does not request F5 odds if no pregame game remains;
- S5C and S5E use F5 `background=cache-only` mode;
- background cache-only reads can reuse only a successful provider-backed F5 snapshot younger than five minutes, aligned with the P1-M2 price freshness window;
- a background cache miss returns `BACKGROUND_CACHE_MISS` and cannot refresh the provider;
- a total event-level provider failure is propagated explicitly rather than being represented as `success:true` with an empty slate;
- partial event-level provider failures remain visible through partial coverage metadata;
- normal foreground/readiness F5 requests retain provider refresh capability.

## Exact post-deploy verification

Temporary research PR #467 executed workflow run `31422419713`, job `93566098918`, against the exact deployed merge SHA.

Observed while the monthly external quota remained exhausted:

1. Background cache-only before a foreground request returned HTTP 200 with payload `success=false`, `code=BACKGROUND_CACHE_MISS`, `backgroundCacheOnly=true`, and zero games.
2. One normal F5 foreground request returned HTTP 200 with payload `success=false`, `code=OUT_OF_USAGE_CREDITS`, and zero games.
3. Background cache-only after that failed foreground request again returned `BACKGROUND_CACHE_MISS`, showing that a failed provider request did not create a successful background cache entry.
4. The smoke concluded `VALID_QUOTA_CONSERVATION_POSTDEPLOY`.
5. `oddsRestored=false`: the external quota remains unavailable until the provider resets or renews it.

Artifact ID `9075948411`; ZIP SHA-256 `98073a030fc3f3c061790484a63bf376dfbf6bfc90dd9eb884e5438310b2f6b8`.

## Scientific boundary

The repair conserves provider calls; it does not weaken freshness. Background services abstain when no <=5-minute cache exists. The Predictor must therefore remain blocked on required market odds while the provider quota is exhausted. A new exact-SHA live certification is required after quota reset before any `READY_FINAL` conclusion is permitted.

No model formula, probability, recommendation, threshold, Phase B, ledger, settlement, sportsbook write, automatic bet or automatic promotion was changed.
