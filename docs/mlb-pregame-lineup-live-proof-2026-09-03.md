# Live proof — 2026-09-03

At approximately 14:05 ET the production MLB predictor showed 9 scheduled games, 0 FINAL-ready, 6 provisional, and 0 pitchers pending.

At that same point, the official MLB starting-lineups surface already showed complete nine-player lineups for the 14:10 ET CWS @ HOU game. Therefore `FINAL-ready = 0` was not a valid reflection of official lineup availability.

The code path causing the mismatch was the P1 slate's exclusive dependency on `liveData.boxscore.teams[side].battingOrder`. The repair recognizes a complete official `batters` list as a pregame fallback and applies the same rule in C4 certified materialization.
