#!/usr/bin/env python3
import argparse
import json
import math
import os
import runpy

SCHEMA = 'courtedge-p0-step12f-independent-2024-replication.v1'
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
    policy = cohort.get('policy', {})
    if policy.get('usedFor2025CandidateDiscovery') is not False or policy.get('usedFor2026LeaderSelection') is not False or policy.get('inspectedBeforeLeaderAndCriteriaFreeze') is not False:
        raise SystemExit('STEP12F_COHORT_INDEPENDENCE_NOT_ASSERTED')
    if any(policy.get(k) for k in (
        'thresholdTuningAllowed', 'atomMutationAllowed', 'leaderReplacementAllowed', 'historicalPricesUsed',
        'historicalEvClaimAllowed', 'livePickFiltersChanged', 'step11cCapturePopulationChanged',
        'betEliteLabelProduced', 'automaticBetPlacement')):
        raise SystemExit('STEP12F_RESEARCH_BOUNDARY_VIOLATION')

    pilot = runpy.run_path('scripts/p0-step12-pocket-pilot.py', run_name='p0_step12f_feature_library')
    build_features = pilot['build_features']
    atom_mask = pilot['atom_mask']
    binom_tail = pilot['binom_tail']
    wilson = pilot['wilson']
    rows = build_features(dataset, starter, lineup)
    if not rows:
        raise SystemExit('STEP12F_NO_FEATURE_ROWS')
    dates = sorted({r['officialDate'] for r in rows})
    if dates[0] < FROZEN_START_DATE or dates[-1] > FROZEN_END_DATE:
        raise SystemExit(f'STEP12F_FEATURE_DATE_ESCAPE:{dates[0]}:{dates[-1]}')

    selected = [r for r in rows if all(atom_mask(r, a) for a in leader['atoms'])]
    decisive = [r for r in selected if r['f5Result'] != 'PUSH']
    hits = sum(1 for r in decisive if r['f5Result'] == EXPECTED_SIDE)
    losses = len(decisive) - hits
    pushes = len(selected) - len(decisive)
    decisive_dates = len({r['officialDate'] for r in decisive})
    selected_dates = len({r['officialDate'] for r in selected})
    rate = hits / len(decisive) if decisive else None

    eligible = [r for r in rows if r['f5Result'] != 'PUSH']
    baseline_hits = sum(1 for r in eligible if r['f5Result'] == EXPECTED_SIDE)
    baseline = baseline_hits / len(eligible) if eligible else None
    if baseline is None or rate is None:
        raise SystemExit('STEP12F_NO_DECISIVE_EVIDENCE')

    raw_p = binom_tail(hits, len(decisive), baseline)
    lo, hi = wilson(hits, len(decisive))
    lift = rate - baseline
    drift = abs(rate - FROZEN_2026_FORWARD_HIT_RATE)
    sample_ok = len(decisive) >= MIN_DECISIVE_ROWS and decisive_dates >= MIN_DECISIVE_DATES
    supported = sample_ok and lift > 0 and raw_p <= ALPHA and drift <= MAX_ABSOLUTE_2026_TO_2024_DRIFT

    reasons = []
    if len(decisive) < MIN_DECISIVE_ROWS: reasons.append('DECISIVE_ROWS_BELOW_80')
    if decisive_dates < MIN_DECISIVE_DATES: reasons.append('DECISIVE_DATES_BELOW_30')
    if lift <= 0: reasons.append('NO_POSITIVE_REPLICATION_LIFT')
    if raw_p > ALPHA: reasons.append('EXACT_ONE_SIDED_P_GT_0_05')
    if drift > MAX_ABSOLUTE_2026_TO_2024_DRIFT: reasons.append('ABSOLUTE_2026_TO_2024_DRIFT_GT_15PP')
    if supported:
        reasons = ['SAMPLE_AND_DATE_FLOORS_MET', 'POSITIVE_REPLICATION_LIFT', 'EXACT_ONE_SIDED_P_LE_0_05', 'DRIFT_WITHIN_15PP']

    report = {
        'schemaVersion': SCHEMA,
        'evidenceStatus': 'STEP12F_INDEPENDENT_REPLICATION_RESEARCH_ONLY_NOT_BET_ELITE',
        'design': {
            'leaderFrozenFrom2025DiscoveryAnd2026ForwardWork': True,
            'replicationSeason': 2024,
            'replicationStartDate': FROZEN_START_DATE,
            'replicationEndDate': FROZEN_END_DATE,
            'replicationCohortInspectedBeforeFreeze': False,
            'thresholdRetuningAllowed': False,
            'leaderReplacementAllowed': False,
            'singlePrespecifiedHypothesis': True,
            'multiplicityCorrectionRequiredInside12F': False,
        },
        'leader': {
            'hypothesisKey': LEADER_HYPOTHESIS_KEY,
            'ruleKey': EXPECTED_RULE_KEY,
            'horizon': EXPECTED_HORIZON,
            'side': EXPECTED_SIDE,
            'atoms': leader['atoms'],
            'frozen2026ForwardHitRate': FROZEN_2026_FORWARD_HIT_RATE,
        },
        'supportCriteria': {
            'minimumDecisiveRows': MIN_DECISIVE_ROWS,
            'minimumDecisiveDates': MIN_DECISIVE_DATES,
            'positiveLiftRequired': True,
            'exactOneSidedBinomialPValueMax': ALPHA,
            'maximumAbsolute2026To2024Drift': MAX_ABSOLUTE_2026_TO_2024_DRIFT,
        },
        'cohortSummary': {
            'featureRows': len(rows),
            'featureDates': len(dates),
            'firstFeatureDate': dates[0],
            'lastFeatureDate': dates[-1],
            'completeLineupCoveragePct': cohort.get('cohort', {}).get('completeLineupCoveragePct'),
        },
        'replication': {
            'selectedRows': len(selected),
            'decisiveRows': len(decisive),
            'decisiveUniqueDates': decisive_dates,
            'selectedUniqueDates': selected_dates,
            'hits': hits,
            'losses': losses,
            'pushes': pushes,
            'decisiveHitRate': rate,
            'wilson95': {'lower': lo, 'upper': hi},
            'selectedSideBaselineHitRate': baseline,
            'liftVsBaseline': lift,
            'exactOneSidedBinomialPValue': raw_p,
            'absolute2026To2024HitRateDrift': drift,
        },
        'classification': 'INDEPENDENT_REPLICATION_SUPPORTED' if supported else ('PROMISING_NEEDS_MORE_SAMPLE' if not sample_ok and lift > 0 else 'INDEPENDENT_REPLICATION_NOT_SUPPORTED'),
        'reasons': reasons,
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
        'replication': report['replication'],
        'researchOnly': True,
    }, indent=2))


if __name__ == '__main__':
    main()
