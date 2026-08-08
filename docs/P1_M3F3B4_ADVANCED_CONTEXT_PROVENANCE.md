# P1-M3F3B4 — Advanced contextual factor certifiable provenance

## Purpose

P1-M3F3B4 creates a strict certification path for the existing `/api/mlb/advanced/:gamePk` calculation (park factor, weather and opener/bullpen-game context) without changing its run-adjustment formulas.

The legacy route is intentionally tolerant: venue roof failures default to `open`, pitcher-stat failures become `null`, missing park factors contribute zero, and weather helpers contain neutral defaults. Those are useful continuity behaviors but cannot be re-labeled as certified P1 evidence.

## Venue identity correction

The existing static park-factor object contains historical/duplicate venue IDs. MLB Stats API venue identity is therefore not certified by looking up the static numeric key.

The strict path:

1. obtains `venue.id` and `venue.name` from the official game feed;
2. fetches `/venues/{id}?hydrate=fieldInfo`;
3. requires the returned venue id and normalized name to match the game-feed identity;
4. resolves the park factor by the official venue **name**, not by the potentially stale static id.

This protects cases such as Dodger Stadium, which MLB Stats API documents as venue id 22 while the legacy static object has historical id conflicts.

Two intended park-factor records lost through duplicate object keys (Dodger Stadium and Daikin Park) are reconstructed inside the strict name resolver using the same numerical factors already present in the legacy source text. No park-factor coefficient is re-estimated.

If the official venue name cannot be mapped to a known park factor, certification fails rather than assigning a neutral factor.

## Weather / roof rules

Venue `fieldInfo.roofType` must be acquired successfully.

- `Open` -> explicit game-feed temperature and wind are required.
- `Indoor` / dome -> weather effects are certified neutral by construction.
- `Retractable` -> an explicit current roof-open/roof-closed condition is required; merely knowing that the roof is retractable is not enough.

The strict path never defaults a failed venue lookup to `open` and never treats missing open-air weather as 72°F/calm for certification.

## Pitcher source rules

Both probable-pitcher identities must be present in the official game feed.

For each pitcher, the MLB season-stats request must succeed with valid response shape.

- a valid source response with no season split is an explicit `NO_SEASON_SAMPLE` result and the existing `analyzeOpener()` neutral/Unknown behavior is preserved;
- transport, HTTP, JSON or required-shape failure blocks certification.

## Certified snapshot

`getAdvancedContextCertifiedSnapshot()` emits:

- schema `courtedge-mlb-advanced-context-evidence.v1`;
- `sourceStatus=CERTIFIED`;
- request observation time as `generatedAt` after all required sources succeed;
- verified venue identity;
- resolved current roof mode;
- separate home/away pitcher sample statuses;
- the existing park/weather/opener outputs and total adjustment;
- registered 21,600-second Advanced Factor freshness bound;
- `failureDisposition=THROW_FAIL_CLOSED`.

## Staging

The legacy `/api/mlb/advanced/:gamePk` route is not switched in this phase. The strict certifier is isolated until all five Advanced Factor components pass falsification, after which one consolidated P1 integration will expose the certified set.

## Safety / non-claims

This phase does not claim live `ADVANCED_FACTORS=FRESH` and does not authorize READY_FINAL by itself.

No model formula, probability, threshold, odds, ledger, settlement, sportsbook, UI, stake/actionability or promotion change is authorized.
