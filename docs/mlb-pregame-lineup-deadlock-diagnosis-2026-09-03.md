# MLB pregame lineup deadlock diagnosis — 2026-09-03

At approximately 14:05 ET, the production MLB predictor reported 9 games, 0 FINAL-ready, 6 provisional, and 0 pitchers pending. At the same time, the official MLB starting-lineups page already showed complete 9-player lineups for CWS @ HOU, scheduled for 14:10 ET.

The current P1 slate code determines lineup readiness only from `liveData.boxscore.teams[side].battingOrder`. MLB StatsAPI can expose posted pregame lineups in the boxscore `batters` list before `battingOrder` is populated. That creates a dead zone: a game remains PROVISIONAL despite official lineups being posted, then once the game enters IN_PROGRESS it is correctly blocked as no longer pregame.

Required repair: for pregame lineup authority, prefer a valid 9-player `battingOrder`, but fall back to a valid 9-player `batters` list from the same official MLB game feed. The C4 live materializer must use the same fallback so a game promoted to FINAL by the slate cannot fail immediately in certified feature assembly.

This is a data-readiness bug. It is independent of model weights, route hit rate, odds, EV, V68, and V80.
