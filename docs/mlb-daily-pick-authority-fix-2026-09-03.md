# MLB Daily Pick authority regression fix — 2026-09-03

## Root cause

PR #689 changed the visible `Ejecutar V16` control from the certified sporting Daily BEST PICK hierarchy to the priced whole-slate Daily Opportunity authority.

That changed the meaning of the top-level result. A sporting selection could exist in the frozen hierarchy while the priced Daily Opportunity layer returned `NO_PLAY` because no candidate survived economic/EV evaluation. This made price/EV behavior suppress the visible Daily Pick and broke comparability with the historically validated sporting-route coverage.

## Correct authority contract

1. The visible MLB Daily BEST PICK is selected only by the certified sporting hierarchy:
   `A+ -> Premium -> PP_HORIZON -> Full Modular -> NO PLAY`.
2. The visible sporting selector returns at most one Daily Pick.
3. Odds/EV are an economic layer applied after the sporting selection.
4. A non-positive or unavailable price may block a wager at the current price, but it does not erase the sporting Daily Pick.
5. The whole-slate Daily Opportunity engine remains available as research/diagnostic infrastructure and is not the visible Daily Pick authority.
6. No model coefficients, sporting thresholds, V68, V80, or historical validation rules are changed by this fix.

## UI behavior

The MLB page now uses a dedicated sporting Daily Pick control backed by `/api/mlb/unified-v16/ui-run`.

The control shows:
- one sporting Daily Pick maximum;
- a separate price/EV validation card;
- explicit language that price/EV does not change the Daily Pick.

This resolves the two-authority problem without making economic EV a prerequisite for the historical sporting-route selection.
