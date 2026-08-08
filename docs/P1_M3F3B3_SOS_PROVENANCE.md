# P1-M3F3B3 — SOS certifiable provenance

## Purpose

P1-M3F3B3 creates a strict certification path for the existing recent-batting Strength of Schedule (SOS) adjustment without changing its numerical formula.

The existing calculation estimates the quality of pitching faced over the latest games using:

- opponent probable-starter season ERA;
- opponent staff season ERA as the existing bullpen proxy;
- recent team runs scored;
- the existing 60% starter / 40% staff weighting and SOS adjustment formula.

## Why a separate strict path is required

The legacy runtime intentionally tolerates several missing sub-sources for UI continuity: schedule errors can become an empty list, pitcher ERA failures can be skipped, staff ERA failures can be skipped, and the calculation can fall back to league-average bullpen ERA.

Those behaviors must not be re-labeled as `CERTIFIED` source evidence.

## Certified coverage rule

The strict `getTeamSosCertifiedSnapshot()` path uses its own one-hour certified cache. It may certify only evidence that was itself produced by the strict path.

If fewer than five completed games exist, the schedule acquisition may be certified with `sampleStatus=INSUFFICIENT_GAMES` and no SOS signal. This is a legitimate no-sample state, not a provider failure.

Once at least five completed games are selected, certification requires full critical coverage:

- every selected game has an identifiable opponent;
- every selected game has a probable-pitcher identity;
- every selected probable pitcher has a valid season ERA;
- every unique opponent has a valid team/staff season ERA;
- no league-average fallback is used in the certified path;
- any HTTP, transport, JSON or required-shape failure throws fail-closed.

## Certified snapshot

A certified snapshot exposes:

- schema `courtedge-mlb-sos-evidence.v1`;
- `sourceStatus=CERTIFIED`;
- `generatedAt` equal to the certified cache observation time;
- sample status (`AVAILABLE` or `INSUFFICIENT_GAMES`);
- selected game count;
- pitcher ERAs verified;
- opponent staff ERAs verified;
- certified cache hit/age;
- cache maximum age = 3,600 seconds;
- `failureDisposition=THROW_FAIL_CLOSED`.

## Backward compatibility and staging

The existing `getTeamSos()` remains available for legacy runtime/UI behavior. The certified cache is separate so a legacy result created with partial source coverage can never be mistaken for certified evidence.

P1-M2B is not switched in this phase. All five Advanced Factor certifiers will be integrated together only after their individual contracts pass falsification.

## Safety / non-claims

No live `ADVANCED_FACTORS=FRESH` claim follows from this PR alone.

No model formula, probability, threshold, odds, ledger, settlement, sportsbook, UI, stake/actionability or promotion change is authorized.
