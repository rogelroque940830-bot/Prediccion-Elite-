#!/usr/bin/env python3
import argparse
import json
import math
import os
import random
import runpy
from collections import Counter, defaultdict

SCHEMA = 'courtedge-p0-step12e-adversarial-stability.v2'
LEADER_HYPOTHESIS_KEY = 'FIRST_5:46a7cbb6ff5c2458'
EXPECTED_LEADER_RULE_KEY = '46a7cbb6ff5c2458'
EXPECTED_LEADER_SIDE = 'HOME'
EXPECTED_LEADER_HORIZON = 'FIRST_5'
EXPECTED_ATOMS = (
    ('starter_runrisk_adv', 'GTE', 0.015491875429068415),
    ('starter_hr_adv', 'GTE', 0.006388417337263681),
    ('lineup_exp_adv', 'GTE', 2.5555555555555536),
)
BOOTSTRAP_SEED = 12051205
BOOTSTRAP_REPLICATES = 10000
MIN_BOOTSTRAP_POSITIVE_LIFT_FRACTION = 0.95


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def canonical_atoms(atoms):
    return tuple((a['feature'], a['operator'], float(a['threshold'])) for a in atoms)


def hit_rate(rows):
    n = len(rows)
    return (sum(1 for r in rows if r['hit']) / n) if n else None


def lift(rows, baseline):
    rate = hit_rate(rows)
    return (rate - baseline) if rate is not None else None


def grouped_stress(rows, key, baseline):
    groups = defaultdict(list)
    for row in rows:
        groups[row[key]].append(row)
    total = len(rows)
    counts = Counter({str(k): len(v) for k, v in groups.items()})
    ordered = sorted(groups.items(), key=lambda kv: (-len(kv[1]), str(kv[0])))
    leave_one = []
    for value, cluster in ordered:
        remaining = [r for r in rows if r[key] != value]
        leave_one.append({
            'cluster': str(value),
            'removedRows': len(cluster),
            'removedShare': len(cluster) / total if total else 0,
            'remainingRows': len(remaining),
            'remainingHitRate': hit_rate(remaining),
            'remainingLiftVsBaseline': lift(remaining, baseline),
        })
    top = ordered[0] if ordered else (None, [])
    finite_lifts = [x['remainingLiftVsBaseline'] for x in leave_one if x['remainingLiftVsBaseline'] is not None]
    return {
        'clusterCount': len(groups),
        'topCluster': str(top[0]) if top[0] is not None else None,
        'topClusterRows': len(top[1]),
        'topClusterShare': len(top[1]) / total if total else 0,
        'effectiveClusterCountHhi': (1 / sum((c / total) ** 2 for c in counts.values())) if total else None,
        'minimumLeaveOneClusterOutLiftVsBaseline': min(finite_lifts) if finite_lifts else None,
        'maximumLeaveOneClusterOutLiftVsBaseline': max(finite_lifts) if finite_lifts else None,
        'allLeaveOneClusterOutLiftsPositive': bool(finite_lifts) and min(finite_lifts) > 0,
        'leaveOneClusterOut': leave_one,
    }


def joint_date_cluster_bootstrap(selected_rows, eligible_baseline_rows):
    selected_by_date = defaultdict(list)
    baseline_by_date = defaultdict(list)
    for row in selected_rows:
        selected_by_date[row['officialDate']].append(row)
    for row in eligible_baseline_rows:
        baseline_by_date[row['officialDate']].append(row)
    dates = sorted(baseline_by_date)
    if not dates:
        return None
    if any(row['officialDate'] not in baseline_by_date for row in selected_rows):
        raise SystemExit('STEP12E_SELECTED_DATE_NOT_IN_BASELINE_COHORT')

    rng = random.Random(BOOTSTRAP_SEED)
    positive = 0
    lifts = []
    valid = 0
    for _ in range(BOOTSTRAP_REPLICATES):
        sampled_dates = [rng.choice(dates) for _ in dates]
        selected_replicate = []
        baseline_replicate = []
        for date in sampled_dates:
            selected_replicate.extend(selected_by_date.get(date, []))
            baseline_replicate.extend(baseline_by_date[date])
        selected_rate = hit_rate(selected_replicate)
        baseline_rate = hit_rate(baseline_replicate)
        if selected_rate is None or baseline_rate is None:
            continue
        value = selected_rate - baseline_rate
        lifts.append(value)
        valid += 1
        if value > 0:
            positive += 1

    ordered = sorted(lifts)
    def empirical(q):
        if not ordered:
            return None
        idx = min(len(ordered) - 1, max(0, int(math.floor(q * (len(ordered) - 1)))))
        return ordered[idx]

    return {
        'method': 'JOINT_ELIGIBLE_COHORT_DATE_CLUSTER_BOOTSTRAP',
        'seed': BOOTSTRAP_SEED,
        'requestedReplicates': BOOTSTRAP_REPLICATES,
        'validReplicates': valid,
        'eligibleDateClusters': len(dates),
        'selectedDecisiveDateClusters': len(selected_by_date),
        'fractionReplicatesWithPositiveLift': positive / valid if valid else None,
        'liftPercentile025': empirical(0.025),
        'liftMedian': empirical(0.5),
        'liftPercentile975': empirical(0.975),
        'baselineRecomputedInsideEveryReplicate': True,
        'inferentialProbabilityClaimAllowed': False,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--candidates', required=True)
    ap.add_argument('--forward-report', required=True)
    ap.add_argument('--dataset', required=True)
    ap.add_argument('--starter-history', required=True)
    ap.add_argument('--lineup-history', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    candidates_manifest = load(args.candidates)
    forward_report = load(args.forward_report)
    dataset = load(args.dataset)
    starter = load(args.starter_history)
    lineup = load(args.lineup_history)

    if forward_report.get('evidenceStatus') != 'STEP12D_RESEARCH_ONLY_NOT_BET_ELITE':
        raise SystemExit('STEP12E_FORWARD_REPORT_NOT_RESEARCH_ONLY')
    leader_results = [r for r in forward_report.get('results', []) if r.get('hypothesisKey') == LEADER_HYPOTHESIS_KEY]
    if len(leader_results) != 1:
        raise SystemExit(f'STEP12E_LEADER_RESULT_COUNT_INVALID:{len(leader_results)}')
    forward_leader = leader_results[0]
    frozen_candidates = candidates_manifest.get('frozenFamily', {}).get('candidates', [])
    frozen_matches = [r for r in frozen_candidates if r.get('hypothesisKey') == LEADER_HYPOTHESIS_KEY]
    if len(frozen_matches) != 1:
        raise SystemExit(f'STEP12E_FROZEN_LEADER_COUNT_INVALID:{len(frozen_matches)}')
    leader = frozen_matches[0]

    if leader.get('ruleKey') != EXPECTED_LEADER_RULE_KEY or leader.get('side') != EXPECTED_LEADER_SIDE or leader.get('horizon') != EXPECTED_LEADER_HORIZON:
        raise SystemExit('STEP12E_LEADER_IDENTITY_MUTATED')
    if canonical_atoms(leader.get('atoms', [])) != EXPECTED_ATOMS:
        raise SystemExit('STEP12E_LEADER_ATOMS_MUTATED')
    if forward_leader.get('status') != 'PROMISING_NOT_HOLM_SUPPORTED':
        raise SystemExit(f"STEP12E_LEADER_12D_STATUS_CHANGED:{forward_leader.get('status')}")
    holm_p = float(forward_leader.get('holmAdjustedGlobalFamilyPValue'))
    if holm_p <= 0.05:
        raise SystemExit('STEP12E_MUST_NOT_RUN_AS_RESCUE_FOR_ALREADY_SUPPORTED_RULE')

    pilot = runpy.run_path('scripts/p0-step12-pocket-pilot.py', run_name='p0_step12e_feature_library')
    build_features = pilot['build_features']
    atom_mask = pilot['atom_mask']
    rows = build_features(dataset, starter, lineup)
    selected = [r for r in rows if all(atom_mask(r, a) for a in leader['atoms'])]

    dataset_full = {r['gamePk']: r for r in dataset['observations'] if r['horizon'] == 'FULL_GAME'}
    starters = {g['gamePk']: g for g in starter['games']}
    decisive = []
    pushes = 0
    for row in selected:
        outcome = row['f5Result']
        if outcome == 'PUSH':
            pushes += 1
            continue
        game = dataset_full.get(row['gamePk'])
        sg = starters.get(row['gamePk'])
        if not game or not sg:
            raise SystemExit(f"STEP12E_JOIN_EVIDENCE_MISSING:{row['gamePk']}")
        decisive.append({
            'gamePk': row['gamePk'],
            'officialDate': row['officialDate'],
            'month': row['officialDate'][:7],
            'hit': outcome == EXPECTED_LEADER_SIDE,
            'homeTeamId': int(game['homeTeamId']),
            'awayTeamId': int(game['awayTeamId']),
            'homeStarterId': int(sg['homeStarter']['pitcherId']),
            'awayStarterId': int(sg['awayStarter']['pitcherId']),
        })

    eligible_baseline_decisive = [
        {
            'gamePk': row['gamePk'],
            'officialDate': row['officialDate'],
            'hit': row['f5Result'] == EXPECTED_LEADER_SIDE,
        }
        for row in rows
        if row['f5Result'] != 'PUSH'
    ]

    expected = forward_leader['forward2026']
    hits = sum(1 for r in decisive if r['hit'])
    losses = len(decisive) - hits
    if len(selected) != expected['selectedRows'] or len(decisive) != expected['decisiveRows'] or hits != expected['hits'] or losses != expected['losses'] or pushes != expected['pushes']:
        raise SystemExit('STEP12E_12D_METRIC_PARITY_FAILURE')

    baseline = float(forward_leader['selectedSideBaselineHitRate'])
    recomputed_baseline = hit_rate(eligible_baseline_decisive)
    if recomputed_baseline is None or abs(recomputed_baseline - baseline) > 1e-15:
        raise SystemExit(f'STEP12E_BASELINE_PARITY_FAILURE:{recomputed_baseline}:{baseline}')

    full_rate = hit_rate(decisive)
    full_lift = lift(decisive, baseline)

    by_month = defaultdict(list)
    by_date = defaultdict(list)
    for row in decisive:
        by_month[row['month']].append(row)
        by_date[row['officialDate']].append(row)

    leave_one_month = []
    for month in sorted(by_month):
        remaining = [r for r in decisive if r['month'] != month]
        leave_one_month.append({
            'monthRemoved': month,
            'removedRows': len(by_month[month]),
            'remainingRows': len(remaining),
            'remainingHitRate': hit_rate(remaining),
            'remainingLiftVsBaseline': lift(remaining, baseline),
        })

    leave_one_date = []
    for date in sorted(by_date):
        remaining = [r for r in decisive if r['officialDate'] != date]
        leave_one_date.append({
            'dateRemoved': date,
            'removedRows': len(by_date[date]),
            'remainingRows': len(remaining),
            'remainingHitRate': hit_rate(remaining),
            'remainingLiftVsBaseline': lift(remaining, baseline),
        })

    cluster_stress = {
        key: grouped_stress(decisive, key, baseline)
        for key in ('homeTeamId', 'awayTeamId', 'homeStarterId', 'awayStarterId')
    }
    bootstrap = joint_date_cluster_bootstrap(decisive, eligible_baseline_decisive)

    month_lifts = [x['remainingLiftVsBaseline'] for x in leave_one_month if x['remainingLiftVsBaseline'] is not None]
    date_lifts = [x['remainingLiftVsBaseline'] for x in leave_one_date if x['remainingLiftVsBaseline'] is not None]
    gates = {
        'fullForwardLiftPositive': full_lift is not None and full_lift > 0,
        'everyLeaveOneMonthOutLiftPositive': bool(month_lifts) and min(month_lifts) > 0,
        'everyLeaveOneDateOutLiftPositive': bool(date_lifts) and min(date_lifts) > 0,
        'everyLeaveOneClusterOutLiftPositive': all(v['allLeaveOneClusterOutLiftsPositive'] for v in cluster_stress.values()),
        'jointDateClusterBootstrapPositiveLiftFractionAtLeast95Pct': bootstrap is not None and bootstrap['fractionReplicatesWithPositiveLift'] >= MIN_BOOTSTRAP_POSITIVE_LIFT_FRACTION,
    }
    stress_resilient = all(gates.values())

    report = {
        'schemaVersion': SCHEMA,
        'evidenceStatus': 'STEP12E_DIAGNOSTIC_ONLY_CANNOT_PROMOTE_BET_ELITE',
        'leader': {
            'hypothesisKey': LEADER_HYPOTHESIS_KEY,
            'ruleKey': EXPECTED_LEADER_RULE_KEY,
            'horizon': EXPECTED_LEADER_HORIZON,
            'side': EXPECTED_LEADER_SIDE,
            'atoms': leader['atoms'],
            'frozen2025Discovery': leader.get('frozen2025Discovery'),
            'frozen2025Holdout': leader.get('frozen2025Holdout'),
            'forward2026Status': forward_leader['status'],
            'forward2026HolmAdjustedGlobalFamilyPValue': holm_p,
        },
        'forwardParity': {
            'selectedRows': len(selected),
            'decisiveRows': len(decisive),
            'hits': hits,
            'losses': losses,
            'pushes': pushes,
            'decisiveHitRate': full_rate,
            'selectedSideBaselineHitRate': baseline,
            'eligibleBaselineDecisiveRows': len(eligible_baseline_decisive),
            'liftVsBaseline': full_lift,
        },
        'adversarialDiagnostics': {
            'leaveOneMonthOut': leave_one_month,
            'minimumLeaveOneMonthOutLiftVsBaseline': min(month_lifts) if month_lifts else None,
            'leaveOneDateOut': leave_one_date,
            'minimumLeaveOneDateOutLiftVsBaseline': min(date_lifts) if date_lifts else None,
            'clusterConcentrationAndLeaveOneOut': cluster_stress,
            'jointEligibleCohortDateClusterBootstrap': bootstrap,
        },
        'stressGates': gates,
        'classification': 'PROMISING_STRESS_RESILIENT_NOT_STATISTICALLY_SUPPORTED' if stress_resilient else 'PROMISING_BUT_FRAGILE_NOT_STATISTICALLY_SUPPORTED',
        'interpretationBoundary': {
            'leaderWasSelectedAfterInspecting12DResults': True,
            'stressTestsReuseSame2026CohortAs12D': True,
            'stressClassificationIsIndependentReplicationEvidence': False,
            'bootstrapFractionIsPosteriorOrFrequentistProbabilityOfTrueEdge': False,
            'stressClassificationCanOnlyDescribeOrDegradeRobustness': True,
        },
        'promotionBoundary': {
            'canUpgrade12DStatisticalStatus': False,
            'canProduceBetElite': False,
            'canChangeLiveFilters': False,
            'canTuneAtomsOrThresholds': False,
            'canDropBadMonthsTeamsPitchersOrDates': False,
            'canRecomputeMultiplicityOnReducedFamily': False,
        },
        'policy': {
            'diagnosticOnly': True,
            'leaderDefinitionFrozenBeforeStressTesting': True,
            'leaderWasNotFrozenBefore12DResults': True,
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
        'forwardParity': report['forwardParity'],
        'stressGates': report['stressGates'],
        'minimumLeaveOneMonthOutLiftVsBaseline': report['adversarialDiagnostics']['minimumLeaveOneMonthOutLiftVsBaseline'],
        'minimumLeaveOneDateOutLiftVsBaseline': report['adversarialDiagnostics']['minimumLeaveOneDateOutLiftVsBaseline'],
        'bootstrapPositiveLiftFraction': bootstrap['fractionReplicatesWithPositiveLift'] if bootstrap else None,
        'bootstrapLiftPercentile025': bootstrap['liftPercentile025'] if bootstrap else None,
        'researchOnly': True,
    }, indent=2))


if __name__ == '__main__':
    main()
