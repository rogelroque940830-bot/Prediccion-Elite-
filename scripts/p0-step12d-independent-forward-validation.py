#!/usr/bin/env python3
import argparse
import json
import math
import os
import runpy
from collections import defaultdict

SCHEMA = 'courtedge-p0-step12d-independent-forward-validation.v1'
CANDIDATE_SCHEMA = 'courtedge-p0-step12d-frozen-candidates.v1'
COHORT_SCHEMA = 'courtedge-p0-step12d-forward-cohort.v1'
FROZEN_START_DATE = '2026-03-01'
FROZEN_END_DATE = '2026-08-10'
MIN_DECISIVE_ROWS = 80
MIN_DECISIVE_DATES = 30
MAX_ABSOLUTE_2025_HOLDOUT_FORWARD_DRIFT = 0.15
FAMILYWISE_ALPHA = 0.05
GLOBAL_FAMILY_SIZE = 20


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def canonical_rule(rule):
    return {
        'hypothesisKey': rule['hypothesisKey'],
        'ruleKey': rule['ruleKey'],
        'horizon': rule['horizon'],
        'side': rule['side'],
        'atoms': [
            {
                'feature': atom['feature'],
                'operator': atom['operator'],
                'threshold': atom['threshold'],
                'quantile': atom.get('quantile'),
            }
            for atom in rule['atoms']
        ],
    }


def baseline_home_rate(rows, horizon):
    if horizon == 'FULL_GAME':
        decisive = rows
        home = sum(1 for row in decisive if row['fullResult'] == 'HOME')
    elif horizon == 'FIRST_5':
        decisive = [row for row in rows if row['f5Result'] != 'PUSH']
        home = sum(1 for row in decisive if row['f5Result'] == 'HOME')
    else:
        raise ValueError(f'STEP12D_UNSUPPORTED_HORIZON:{horizon}')
    if not decisive:
        raise ValueError(f'STEP12D_NO_DECISIVE_BASELINE:{horizon}')
    return home / len(decisive), len(decisive)


def selected_rows(rows, atoms):
    output = []
    for row in rows:
        ok = True
        for atom in atoms:
            value = row.get(atom['feature'])
            if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
                ok = False
                break
            if atom['operator'] == 'GTE' and not value >= atom['threshold']:
                ok = False
                break
            if atom['operator'] == 'LTE' and not value <= atom['threshold']:
                ok = False
                break
        if ok:
            output.append(row)
    return output


def metrics(rows, candidate):
    selected = selected_rows(rows, candidate['atoms'])
    horizon = candidate['horizon']
    side = candidate['side']
    hits = losses = pushes = 0
    decisive_dates = set()
    selected_dates = set()
    monthly = defaultdict(lambda: {'hits': 0, 'losses': 0, 'pushes': 0, 'selected': 0, 'decisiveDates': set()})
    for row in selected:
        date = row['officialDate']
        month = date[:7]
        selected_dates.add(date)
        monthly[month]['selected'] += 1
        outcome = row['fullResult'] if horizon == 'FULL_GAME' else row['f5Result']
        if outcome == 'PUSH':
            pushes += 1
            monthly[month]['pushes'] += 1
        else:
            decisive_dates.add(date)
            monthly[month]['decisiveDates'].add(date)
            if outcome == side:
                hits += 1
                monthly[month]['hits'] += 1
            else:
                losses += 1
                monthly[month]['losses'] += 1
    decisive = hits + losses
    all_dates = len({row['officialDate'] for row in rows})
    monthly_report = []
    for month in sorted(monthly):
        item = monthly[month]
        dec = item['hits'] + item['losses']
        monthly_report.append({
            'month': month,
            'selectedRows': item['selected'],
            'decisiveRows': dec,
            'hits': item['hits'],
            'losses': item['losses'],
            'pushes': item['pushes'],
            'decisiveHitRate': item['hits'] / dec if dec else None,
            'decisiveUniqueDates': len(item['decisiveDates']),
        })
    return {
        'selectedRows': len(selected),
        'decisiveRows': decisive,
        'hits': hits,
        'losses': losses,
        'pushes': pushes,
        'decisiveHitRate': hits / decisive if decisive else None,
        'uniqueDates': len(selected_dates),
        'decisiveUniqueDates': len(decisive_dates),
        'retentionPct': 100 * len(selected) / len(rows) if rows else 0,
        'noPickDatePct': 100 * (all_dates - len(selected_dates)) / all_dates if all_dates else 0,
        'monthlyDiagnostics': monthly_report,
    }


def holm_adjust(raw_values):
    indexed = sorted(enumerate(raw_values), key=lambda pair: pair[1])
    adjusted = [None] * len(raw_values)
    running = 0.0
    m = len(raw_values)
    for rank, (index, raw) in enumerate(indexed):
        value = min(1.0, (m - rank) * raw)
        running = max(running, value)
        adjusted[index] = running
    return adjusted


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
    cohort_manifest = load(args.cohort_manifest)
    dataset = load(args.dataset)
    starter = load(args.starter_history)
    lineup = load(args.lineup_history)

    if candidates_manifest.get('schemaVersion') != CANDIDATE_SCHEMA:
        raise SystemExit('STEP12D_CANDIDATE_SCHEMA_INVALID')
    if candidates_manifest.get('hypothesisIdentity') != 'HORIZON_PLUS_RULE_KEY':
        raise SystemExit('STEP12D_HYPOTHESIS_IDENTITY_INVALID')
    family = candidates_manifest.get('frozenFamily', {})
    candidates = family.get('candidates', [])
    if family.get('candidateCount') != GLOBAL_FAMILY_SIZE or family.get('globalMultiplicityFamilySize') != GLOBAL_FAMILY_SIZE or len(candidates) != GLOBAL_FAMILY_SIZE:
        raise SystemExit('STEP12D_FROZEN_FAMILY_SIZE_INVALID')
    if len({candidate['hypothesisKey'] for candidate in candidates}) != GLOBAL_FAMILY_SIZE:
        raise SystemExit('STEP12D_HYPOTHESIS_KEYS_NOT_UNIQUE')
    if any(candidate.get('hypothesisKey') != f"{candidate.get('horizon')}:{candidate.get('ruleKey')}" for candidate in candidates):
        raise SystemExit('STEP12D_HYPOTHESIS_KEY_PARITY_INVALID')
    if cohort_manifest.get('schemaVersion') != COHORT_SCHEMA:
        raise SystemExit('STEP12D_COHORT_SCHEMA_INVALID')
    frozen_range = cohort_manifest.get('frozenRange', {})
    if frozen_range.get('startDate') != FROZEN_START_DATE or frozen_range.get('endDate') != FROZEN_END_DATE:
        raise SystemExit('STEP12D_COHORT_RANGE_MUTATED')
    if cohort_manifest.get('policy', {}).get('usedFor2025CandidateDiscovery') is not False:
        raise SystemExit('STEP12D_EXTERNAL_COHORT_INDEPENDENCE_NOT_ASSERTED')
    if any(cohort_manifest.get('policy', {}).get(key) for key in (
        'externalThresholdTuningAllowed', 'candidateMutationAllowed', 'historicalPricesUsed',
        'historicalEvClaimAllowed', 'livePickFiltersChanged', 'step11cCapturePopulationChanged',
        'betEliteLabelProduced', 'automaticBetPlacement')):
        raise SystemExit('STEP12D_COHORT_RESEARCH_BOUNDARY_VIOLATION')

    pilot_module = runpy.run_path('scripts/p0-step12-pocket-pilot.py', run_name='p0_step12_feature_library')
    build_features = pilot_module['build_features']
    wilson = pilot_module['wilson']
    binom_tail = pilot_module['binom_tail']
    rows = build_features(dataset, starter, lineup)
    if not rows:
        raise SystemExit('STEP12D_NO_FEATURE_ROWS')
    row_dates = sorted({row['officialDate'] for row in rows})
    if row_dates[0] < FROZEN_START_DATE or row_dates[-1] > FROZEN_END_DATE:
        raise SystemExit(f'STEP12D_FEATURE_DATE_ESCAPE:{row_dates[0]}:{row_dates[-1]}')

    baselines = {}
    for horizon in ('FULL_GAME', 'FIRST_5'):
        home_rate, decisive = baseline_home_rate(rows, horizon)
        baselines[horizon] = {'homeDecisiveHitRate': home_rate, 'decisiveRows': decisive}

    results = []
    raw_pvalues = []
    for candidate in candidates:
        rule = canonical_rule(candidate)
        if rule['horizon'] not in ('FULL_GAME', 'FIRST_5'):
            raise SystemExit(f"STEP12D_HORIZON_INVALID:{rule['hypothesisKey']}")
        current = metrics(rows, rule)
        home_baseline = baselines[rule['horizon']]['homeDecisiveHitRate']
        side_baseline = home_baseline if rule['side'] == 'HOME' else 1 - home_baseline
        rate = current['decisiveHitRate']
        raw_p = binom_tail(current['hits'], current['decisiveRows'], side_baseline) if current['decisiveRows'] else 1.0
        raw_pvalues.append(raw_p)
        lo, hi = wilson(current['hits'], current['decisiveRows']) if current['decisiveRows'] else (None, None)
        frozen_holdout_rate = candidate.get('frozen2025Holdout', {}).get('decisiveHitRate')
        drift = abs(rate - frozen_holdout_rate) if rate is not None and isinstance(frozen_holdout_rate, (int, float)) else None
        results.append({
            'hypothesisKey': rule['hypothesisKey'],
            'ruleKey': rule['ruleKey'],
            'horizon': rule['horizon'],
            'side': rule['side'],
            'atoms': rule['atoms'],
            'frozen2025DiscoveryHitRate': candidate.get('frozen2025Discovery', {}).get('decisiveHitRate'),
            'frozen2025HoldoutHitRate': frozen_holdout_rate,
            'forward2026': current,
            'forward2026Wilson95': {'lower': lo, 'upper': hi},
            'selectedSideBaselineHitRate': side_baseline,
            'forwardLiftVsBaseline': rate - side_baseline if rate is not None else None,
            'absolute2025HoldoutToForwardDrift': drift,
            'rawOneSidedExactBinomialPValue': raw_p,
        })

    adjusted = holm_adjust(raw_pvalues)
    status_counts = defaultdict(int)
    for result, holm_p in zip(results, adjusted):
        current = result['forward2026']
        rate = current['decisiveHitRate']
        lift = result['forwardLiftVsBaseline']
        drift = result['absolute2025HoldoutToForwardDrift']
        enough_sample = current['decisiveRows'] >= MIN_DECISIVE_ROWS and current['decisiveUniqueDates'] >= MIN_DECISIVE_DATES
        reasons = []
        result['holmAdjustedGlobalFamilyPValue'] = holm_p
        if not enough_sample:
            status = 'PROMISING_NEEDS_MORE_SAMPLE' if lift is not None and lift > 0 else 'INSUFFICIENT_FORWARD_SAMPLE'
            if current['decisiveRows'] < MIN_DECISIVE_ROWS:
                reasons.append('DECISIVE_ROWS_BELOW_80')
            if current['decisiveUniqueDates'] < MIN_DECISIVE_DATES:
                reasons.append('DECISIVE_DATES_BELOW_30')
        elif rate is None or lift is None or lift <= 0:
            status = 'INDEPENDENT_NOT_SUPPORTED'
            reasons.append('NO_POSITIVE_FORWARD_LIFT')
        elif drift is not None and drift > MAX_ABSOLUTE_2025_HOLDOUT_FORWARD_DRIFT:
            status = 'TEMPORALLY_UNSTABLE'
            reasons.append('ABSOLUTE_2025_HOLDOUT_FORWARD_DRIFT_GT_15PP')
        elif holm_p <= FAMILYWISE_ALPHA:
            status = 'INDEPENDENT_TEMPORAL_SUPPORTED'
            reasons.extend(['POSITIVE_FORWARD_LIFT', 'GLOBAL_HOLM_P_LE_0_05', 'SAMPLE_AND_DECISIVE_DATE_FLOORS_MET', 'TEMPORAL_DRIFT_WITHIN_15PP'])
        else:
            status = 'PROMISING_NOT_HOLM_SUPPORTED'
            reasons.extend(['POSITIVE_FORWARD_LIFT', 'GLOBAL_HOLM_P_GT_0_05', 'REMAINS_RESEARCH_ELIGIBLE'])
        result['status'] = status
        result['reasons'] = reasons
        status_counts[status] += 1

    report = {
        'schemaVersion': SCHEMA,
        'evidenceStatus': 'STEP12D_RESEARCH_ONLY_NOT_BET_ELITE',
        'frozenTemporalDesign': {
            'discoverySeason': 2025,
            'externalForwardSeason': 2026,
            'externalStartDate': FROZEN_START_DATE,
            'externalEndDate': FROZEN_END_DATE,
            'currentDayExcluded': True,
            'cohortEndWasFrozenBeforeExternalResultsWereInspected': True,
            'repeatedSequentialRetestingAllowed': False,
        },
        'hypothesisIdentity': 'HORIZON_PLUS_RULE_KEY',
        'multiplicity': {
            'method': 'HOLM_BONFERRONI_GLOBAL_FROZEN_FAMILY',
            'familySize': GLOBAL_FAMILY_SIZE,
            'familywiseAlpha': FAMILYWISE_ALPHA,
            'familyMutationAllowed': False,
        },
        'supportCriteria': {
            'minimumForwardDecisiveRows': MIN_DECISIVE_ROWS,
            'minimumForwardDecisiveDates': MIN_DECISIVE_DATES,
            'positiveLiftRequired': True,
            'maximumAbsolute2025HoldoutForwardDrift': MAX_ABSOLUTE_2025_HOLDOUT_FORWARD_DRIFT,
            'globalHolmAdjustedPValueMax': FAMILYWISE_ALPHA,
            'monthlyDiagnosticsAreDescriptiveOnly': True,
        },
        'baselines': baselines,
        'cohortSummary': {
            'featureRows': len(rows),
            'featureDates': len(row_dates),
            'firstFeatureDate': row_dates[0],
            'lastFeatureDate': row_dates[-1],
            'completeLineupGames': cohort_manifest.get('cohort', {}).get('completeLineupGames'),
            'completeLineupCoveragePct': cohort_manifest.get('cohort', {}).get('completeLineupCoveragePct'),
        },
        'statusCounts': dict(sorted(status_counts.items())),
        'results': results,
        'policy': {
            'externalThresholdTuningAllowed': False,
            'candidateAdditionAllowed': False,
            'candidateRemovalAllowed': False,
            'atomMutationAllowed': False,
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
        'out': args.out,
        'featureRows': len(rows),
        'featureDates': len(row_dates),
        'statusCounts': report['statusCounts'],
        'topByForwardHitRate': sorted([
            {'hypothesisKey': r['hypothesisKey'], 'ruleKey': r['ruleKey'], 'horizon': r['horizon'], 'hitRate': r['forward2026']['decisiveHitRate'], 'decisiveRows': r['forward2026']['decisiveRows'], 'holmP': r['holmAdjustedGlobalFamilyPValue'], 'status': r['status']}
            for r in results if r['forward2026']['decisiveHitRate'] is not None
        ], key=lambda x: (x['hitRate'], x['decisiveRows']), reverse=True)[:5],
        'researchOnly': True,
    }, indent=2))


if __name__ == '__main__':
    main()
