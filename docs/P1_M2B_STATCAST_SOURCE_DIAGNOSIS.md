# P1-M2B Statcast Source Diagnosis

## What remains after 4/5 advanced certification

Permanent evidence #404 established that Quality, Discipline/Speed, SOS and Advanced Context certify live while Statcast Matchup remains the only degraded ADVANCED_FACTORS component.

Temporary research #405 decomposed the Statcast failure on three real pregame games. The measured games had confirmed nine-player lineups, non-empty starter arsenals, evaluated bullpens, 9/9 history requests, 9/9 successful history queries, zero history failures and valid opposing-team identity. The universal visible-coverage failure was batter source quality: every measured side had fewer than nine DIRECT batter rows and one or more TEAM_PROXY rows.

The strict certification rule remains correct and must not be relaxed merely to produce a 5/5 state.

## Source acquisition finding

The production engine and strict provider use snake_case query names such as `min_pa`, `min_pitches` and `pitch_type` when requesting the Baseball Savant pitch-arsenal leaderboard. The official Savant page uses `min`, `minPitches` and `pitchType`.

A first research pass confirmed that changing values under the unsupported snake_case names produced the same source dataset. The authoritative second pass used the official parameter names.

With the current qualified pitch filter, the source returned 895 rows across 356 players. With the official inclusive query, the source returned 4,979 rows across 622 players.

The experiment did **not** lower the model's evidence threshold. Every projected DIRECT classification still required at least 30 pitches for a pitch type in August and direct evidence for at least 60% of the opposing starter's arsenal.

Under those unchanged internal rules, aggregate projected DIRECT coverage increased from 13 batter slots to 41 across six measured sides. Three sides reached 9/9 DIRECT. The remaining sides correctly stayed below the certification requirement.

## Engineering conclusion

The source-side Qualified filter is stricter than the engine's own August evidence rule and suppresses direct rows that would otherwise satisfy the internal 30-pitch / 60%-arsenal standard.

The next engineering step is to align batter source acquisition with the official Savant query parameters while keeping the internal evidence rule unchanged. Statcast must remain fail-closed for games that still do not reach 9/9 DIRECT coverage.

This is not authorization to relax certification, change formulas, change probabilities or automatically promote recommendations. Any source-acquisition change must pass focused tests and then be measured live before 5/5 certification is claimed.

## Chain of custody

- Statcast blocker research: #405
- Visible-coverage run: `31272416324`
- Visible-coverage artifact: `9026005676`
- Source-coverage research: #406
- Authoritative official-parameter run: `31272690518`
- Source-coverage artifact: `9026084797`
- Exact deployed commit measured: `f7f6cbc3cb857ea5a4f2a6e74fc8016a73fff726`
- Accepted artifacts passed identity-free checks before upload.
