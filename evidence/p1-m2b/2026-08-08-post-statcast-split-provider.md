# P1-M2B post-split-source Statcast evidence — 2026-08-08

## Result

The live integration deployment at `68b48ca5cb017a6cf88ac7ed8f070f35a018a006` was measured across four real MLB pregame games after the split-source provider merged.

- All 8 lineup sides were confirmed.
- 3/8 sides reached 9/9 DIRECT batter coverage.
- No sampled game had 9/9 DIRECT on both sides.
- Statcast remained `DEGRADED` in 4/4 games.
- The previous `STATCAST_CERT_STARTER_XWOBA_MISMATCH` blocker was observed 0 times.
- QUALITY, DISCIPLINE_SPEED, SOS and ADVANCED_CONTEXT remained certified/fresh in all four samples, leaving ADVANCED_FACTORS at 4/5.
- INJURIES remained degraded in all four samples and no `READY_FINAL` state was observed.

## Interpretation

The split-source provider corrected the previously demonstrated engine/certifier source-semantic drift: the starter xwOBA reproduction mismatch disappeared. The current live limitation is now upstream eligibility coverage. Because none of the sampled games had 9/9 DIRECT on both sides, the strict certifier correctly refused to advance to full reproduction/certification.

This evidence does **not** support lowering the 9/9 DIRECT requirement, relaxing exact reproduction, or promoting Statcast automatically. The next research question is whether missing DIRECT rows are close to the existing 60% arsenal-coverage rule and whether additional legitimate source coverage can close those gaps without lowering the existing 30-pitch minimum or changing model formulas.

## Safety

Research was read-only and identity-free at the accepted artifact boundary. No predictions, settlements, bets, persistence writes, thresholds or formulas were changed.
