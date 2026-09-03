# MLB pregame official-lineup fallback contract V1

- Primary pregame lineup field: official MLB game-feed `liveData.boxscore.teams[side].battingOrder` when it contains exactly nine unique player IDs.
- Pregame fallback: official MLB game-feed `liveData.boxscore.teams[side].batters` when it contains exactly nine unique player IDs and `battingOrder` is not yet hydrated.
- Both teams must still expose nine unique official player IDs before the game is marked FINAL-ready.
- Both probable pitchers are still required.
- Once the official game state is IN_PROGRESS, no new pregame prediction is allowed.
- The same lineup extraction rule is used by P1 readiness and C4 certified materialization so readiness cannot promote a game that C4 immediately rejects.
- No model coefficients, route thresholds, odds, EV, V68, or V80 logic changes.
