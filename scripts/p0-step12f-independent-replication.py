#!/usr/bin/env python3
import argparse
import json
import math
import os
import runpy

SCHEMA = 'courtedge-p0-step12f-independent-2024-replication.v2'
COHORT_SCHEMA = 'courtedge-p0-step12f-2024-replication-cohort.v1'
CANDIDATE_SCHEMA = 'courtedge-p0-step12d-frozen-candidates.v1'
LEADER_HYPOTHESIS_KEY = 'FIRST_5:46a7cbb6ff5c2458'
EXPECTED_RULE_KEY = '46a7cbb6ff5c2458'
EXPECTED_SIDE = 'HOME'
EXPECTED_HORIZON = 'FIRST_5'
EXPECTED_ATOMS = (
    ('starter_runrisk_adv', 'GTE', 0.015491875429068415),
    ('starter_hr_adv', 'GTE', 0.006388417337263681),
    ('lineup_exp_adv', 'GTE', 2.5555555555555536),
)
FROZEN_START_DATE = '2024-03-01'
FROZEN_END_DATE = '2024-09-30'
MIN_DECISIVE_ROWS = 80
MIN_DECISIVE_DATES = 30
MAX_ABSOLUTE_2026_TO_2024_DRIFT = 0.15
ALPHA = 0.05
FROZEN_2026_FORWARD_HIT_RATE = 62 / 90

KNOWN_METHODOLOGY_BLOCKERS = [
    'TARGET_STARTER_IDENTITY_FROM_FINAL_BOXSCORE_NOT_T5_ASOF',
    'INCOMPLETE_T5_LINEUPS_CAN_SILENTLY_CHANGE_ELIGIBLE_POPULATION',
    '2024_AND_2026_CALENDAR_EXPOSURE_NOT_MATCHED_FOR_CUMULATIVE_LINEUP_FEATURE',
    'PLUGIN_BINOMIAL_BASELINE_TREATS_SAME_COHORT_ESTIMATE_AS_FIXED',
    'LEADER_DISCOVERY_ITSELF_USED_NON_T5_TARGET_STARTER_IDENTITY',
]


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def canonical_atoms(atoms):
    return tuple((a['feature'], a['operator'], float(a['threshold'])) for a in atoms)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--candidates', required=True)
    ap.add_argument('--dataset', required=True)
    ap.add_argument('--starter-history', required=True)
    ap.add_argument('--lineup-history', required=True)
    ap.add_argument('--cohort-manifest', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    candidates_manifest = load(args.candidates)
    dataset = load(args.dataset)
    starter = load(args.starter_history)
    lineup = load(args.lineup_history)
    cohort = load(args.cohort_manifest)

    if candidates_manifest.get('schemaVersion') != CANDIDATE_SCHEMA:
        raise SystemExit('STEP12F_CANDIDATE_SCHEMA_INVALID')
    leaders = [x for x in candidates_manifest.get('frozenFamily', {}).get('candidates', []) if x.get('hypothesisKey') == LEADER_HYPOTHESIS_KEY]
    if len(leaders) != 1:
        raise SystemExit(f'STEP12F_LEADER_COUNT_INVALID:{len(leaders)}')
    leader = leaders[0]
    if leader.get('ruleKey') != EXPECTED_RULE_KEY or leader.get('side') != EXPECTED_SIDE or leader.get('horizon') != EXPECTED_HORIZON:
        raise SystemExit('STEP12F_LEADER_IDENTITY_MUTATED')
    if canonical_atoms(leader.get('atoms', [])) != EXPECTED_ATOMS:
        raise SystemExit('STEP12F_LEADER_ATOMS_MUTATED')

    if cohort.get('schemaVersion') != COHORT_SCHEMA:
        raise SystemExit('STEP12F_COHORT_SCHEMA_INVALID')
    frozen = cohort.get('frozenRange', {})
    if frozen.get('startDate') != FROZEN_START_DATE or frozen.get('endDate') != FROZEN_END_DATE:
        raise SystemExit('STEP12F_COHORT_RANGE_MUTATED')

    pilot = runpy.run_path('scripts/p0-step12-pocket-pilot.py', run_name='p0_step12f_legacy_feature_library')
    build_features = pilot['build_features']
    atom_mask = pilot['atom_mask']
    binom_tail = pilot['binom_tail']
    wilson = pilot['wilson']
    rows = build_features(dataset, starter, lineup)
    if not rows:
        raise SystemExit('STEP12F_NO_FEATURE_ROWS')
    dates = sorted({r['officialDate'] for r in rows})

    selected = [r for r in rows if all(atom_mask(r, a) for a in leader['atoms'])]
    decisive = [r for r in selected if r['f5Result'] != 'PUSH']
    hits = sum(1 for r in decisive if r['f5Result'] == EXPECTED_SIDE)
    losses = len(decisive) - hits
    pushes = len(selected) - len(decisive)
    decisive_dates = len({r['officialDate'] for r in decisive})
    rate = hits / len(decisive) if decisive else None
    eligible = [r for r in rows if r['f5Result'] != 'PUSH']
    baseline_hits = sum(1 for r in eligible if r['f5Result'] == EXPECTED_SIDE)
    baseline = baseline_hits / len(eligible) if eligible else None
    if baseline is None or rate is None:
        raise SystemExit('STEP12F_NO_DECISIVE_EVIDENCE')
    raw_p = binom_tail(hits, len(decisive), baseline)
    lo, hi = wilson(hits, len(decisive))

    report = {
        'schemaVersion': SCHEMA,
        'evidenceStatus': 'STEP12F_LEGACY_DIAGNOSTIC_INVALID_FOR_CONFIRMATION',
        'classification': 'METHODOLOGY_INVALID_PENDING_T5_REBUILD',
        'knownMethodologyBlockers': KNOWN_METHODOLOGY_BLOCKERS,
        'interpretationBoundary': {
            'legacyMetricsMayBeUsedForDiagnosticsOnly': True,
            'legacyMetricsMaySupportOrRejectHypothesis': False,
            'freshIndependentConfirmationClaimAllowed': False,
            'revised2024AnalysisWillRemainFreshConfirmation': False,
            'reason2024NoLongerFreshAfterMethodInspection': '2024_OUTCOMES_AND_FAILURE_MODE_HAVE_NOW_BEEN_INSPECTED',
            'newDiscoveryRequiredAfterT5StarterIdentityCorrection': True,
        },
        'leader': {
            'hypothesisKey': LEADER_HYPOTHESIS_KEY,
            'ruleKey': EXPECTED_RULE_KEY,
            'horizon': EXPECTED_HORIZON,
            'side': EXPECTED_SIDE,
            'atoms': leader['atoms'],
        },
        'legacyDiagnosticMetrics': {
            'featureRows': len(rows),
            'featureDates': len(dates),
            'selectedRows': len(selected),
            'decisiveRows': len(decisive),
            'decisiveUniqueDates': decisive_dates,
            'hits': hits,
            'losses': losses,
            'pushes': pushes,
            'decisiveHitRate': rate,
            'wilson95': {'lower': lo, 'upper': hi},
            'pluginSelectedSideBaselineHitRate': baseline,
            'pluginLiftVsBaseline': rate - baseline,
            'pluginOneSidedBinomialPValue': raw_p,
            'absolute2026To2024HitRateDrift': abs(rate - FROZEN_2026_FORWARD_HIT_RATE),
            'warning': 'THESE_METRICS_ARE_NOT_CONFIRMATORY_AFTER_P1_P2_METHODOLOGY_FINDINGS',
        },
        'requiredRebuild': {
            'targetStarterIdentityMustBeT5AsOf': True,
            'completeT5LineupEligibilityMustBeExplicit': True,
            'calendarExposureComparisonMustBeLikeForLike': True,
            'selectedVsBaselineComparisonMustBeJointlyClustered': True,
            'discoveryMustBeRerunFromCleanPregameFeatureTable': True,
            'futureIndependentReplicationMustUseUninspectedCohort': True,
        },
        'promotionBoundary': {
            'canProduceBetElite': False,
            'canChangeLiveFilters': False,
            'canTuneAtomsOrThresholds': False,
            'canChangeStep11cCapturePopulation': False,
            'canCalculateStake': False,
            'canPlaceBet': False,
        },
        'policy': {
            'historicalPricesUsed': False,
            'historicalEvClaimProduced': False,
            'livePickFiltersChanged': False,
            'step11cCapturePopulationChanged': False,
            'betEliteProduced': False,
            'stakeCalculated': False,
            'automaticBetPlacement': False,
        },
    }

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write('\n')
    print(json.dumps({
        'ok': True,
        'classification': report['classification'],
        'knownMethodologyBlockers': KNOWN_METHODOLOGY_BLOCKERS,
        'legacyDiagnosticMetrics': report['legacyDiagnosticMetrics'],
        'researchOnly': True,
    }, indent=2))


if __name__ == '__main__':
    main()
