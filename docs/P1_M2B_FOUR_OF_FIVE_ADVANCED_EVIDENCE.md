# P1-M2B Live Advanced Certification — 4/5

## Result

Temporary research PR #403 measured the deployed backend commit `af6a711e5f73d84395cdbb86d13501afd6ebf48c` on three real analysis-allowed MLB pregame ML evaluations.

The advanced evidence set reached **4/5 certified components in all three samples**:

- QUALITY — certified, explicitly timed and fresh in 3/3.
- DISCIPLINE_SPEED — certified, explicitly timed and fresh in 3/3.
- SOS — certified, explicitly timed and fresh in 3/3.
- ADVANCED_CONTEXT — certified, explicitly timed and fresh in 3/3.
- STATCAST_MATCHUP — degraded and uncertified in 3/3.

This validates the provenance wiring completed by #399 and #402 without changing any predictive formula.

## Gate state

All three evaluations remained `READY_PROVISIONAL`. That is correct. The aggregate advanced field remains degraded while one of the five required advanced components is uncertified, and INJURIES also remained degraded (`PARTIAL+PARTIAL`) in all samples.

No readiness threshold should be relaxed to compensate for either condition.

## Next action

The only remaining advanced-factor blocker is STATCAST_MATCHUP. The next task is to inspect its already-strict certifier and identify the exact live blocker classes. The certification contract must remain unchanged during diagnosis; no missing evidence may be converted into `CERTIFIED` by fallback or threshold relaxation.

INJURIES is a separate remaining gate issue and should be handled independently after the advanced component diagnosis is complete.

## Chain of custody

- Research PR: #403
- Workflow run: `31272186139`
- Sanitized artifact: `9025940449`
- Exact deployed commit: `af6a711e5f73d84395cdbb86d13501afd6ebf48c`
- Accepted artifact passed an identity-free assertion before upload.
- No game, team, player or pitcher identity was preserved.
- No production write, prediction creation, settlement creation or sportsbook action was performed by the research runner.
