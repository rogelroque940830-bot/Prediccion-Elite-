# P1-M2B Post Discipline / SOS Wiring Evidence

## Result

The production-integrated backend commit `f5b38116d87b38a4e21f1af3cda8f9af6660ad65` was measured by temporary research PR #400 using three real analysis-allowed MLB pregame ML evaluations.

All three evaluations remained `READY_PROVISIONAL`. The new wiring itself succeeded:

- `DISCIPLINE_SPEED`: `CERTIFIED`, explicit timestamp and `FRESH` in 3/3.
- `SOS`: `CERTIFIED`, explicit timestamp and `FRESH` in 3/3.

The advanced aggregate nevertheless remained 2/5 certified because two other components were still served through legacy surfaces that do not expose their already-built certification metadata:

- `QUALITY`: HTTP 200 in 3/3, but no top-level certified status or explicit timestamp.
- `ADVANCED_CONTEXT`: HTTP 200 in 3/3, but no top-level certified status or explicit timestamp.

`STATCAST_MATCHUP` remained `DEGRADED` in 3/3 under its strict certifier and must remain fail-closed until its own evidence requirements are satisfied.

`INJURIES` remained `DEGRADED` (`PARTIAL+PARTIAL`) in all three samples.

## Interpretation

PR #399 is validated live for its intended scope. It did not falsely promote unavailable evidence: Discipline/Speed and SOS certify only because their strict certifiers succeeded on the measured games.

The unchanged 2/5 aggregate is not evidence that #399 failed. It reveals the next integration debt: the already-validated QUALITY and ADVANCED_CONTEXT certifiers from P1-M3F3B1 and P1-M3F3B4 have not yet been wired into the legacy endpoints M2B consumes.

The next action is therefore to connect those two certifiers with the same fail-closed compatibility pattern. No formula, probability, threshold, stake or recommendation rule should change. Statcast remains a separate scientific blocker and must be re-audited after the wiring debt is removed.

## Chain of custody

- Temporary research PR: #400
- Workflow run: `31271708169`
- Sanitized artifact: `9025801851`
- Accepted artifact passed an identity-free assertion before upload.
- No game, team, player or pitcher identity is preserved in the permanent evidence.
- No production writes, settlements, bets or sportsbook calls were made by the research runner.
