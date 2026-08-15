#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.stats import nbinom, poisson

SCHEMA = 'courtedge-p0-step12v24-f3-total-robustness.v1'
BASE_SCHEMA = 'courtedge-p0-step12v-game-anatomy-feature-table.v1'
V23_REPORT_SCHEMA = 'courtedge-p0-step12v23-f3-model-suite.v1'
V23_OUTCOME_SCHEMA = 'courtedge-p0-step12v23-f3-outcomes.v1'


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write('\n')


def finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except Exception:
        return False


def poisson_deviance_row(y, mu):
    y = float(y)
    mu = max(float(mu), 1e-12)
    if y < 0:
        raise SystemExit('V24_NEGATIVE_RUN_TARGET')
    if y == 0:
        return 2.0 * mu
    return 2.0 * (y * math.log(y / mu) - y + mu)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def score_mu(features, snapshot):
    linear = float(snapshot['intercept'])
    names = snapshot['featureNames']
    medians = snapshot['medianImpute']
    means = snapshot['mean']
    scales = snapshot['scale']
    coefs = snapshot['coef']
    if not (len(names) == len(medians) == len(means) == len(scales) == len(coefs) == 13):
        raise SystemExit('V24_MODEL_VECTOR_LENGTH_INVALID')
    for index, name in enumerate(names):
        value = features.get(name)
        x = float(value) if finite(value) else float(medians[index])
        scale = float(scales[index])
        if not finite(scale) or scale <= 0:
            raise SystemExit(f'V24_SCALE_INVALID:{name}')
        linear += float(coefs[index]) * ((x - float(means[index])) / scale)
    mu = math.exp(max(-50.0, min(50.0, linear)))
    if not finite(mu) or mu <= 0:
        raise SystemExit('V24_MODEL_MU_INVALID')
    return mu


def canonical_features(root, seasons, feature_names):
    rows = {}
    counts = {}
    for season in seasons:
        payload = load(os.path.join(root, season, 'game-anatomy-feature-table.json'))
        if payload.get('schemaVersion') != BASE_SCHEMA:
            raise SystemExit(f'V24_BASE_SCHEMA_INVALID:{season}')
        count = 0
        for raw in payload.get('rows', []):
            if not raw.get('t5PregameValid'):
                continue
            game_pk = int(raw['gamePk'])
            if game_pk in rows:
                raise SystemExit(f'V24_DUPLICATE_CANONICAL_GAME_PK:{game_pk}')
            features = raw.get('features') or {}
            rows[game_pk] = {
                'season': season,
                'date': raw['officialDate'],
                'features': {name: features.get(name) for name in feature_names},
            }
            count += 1
        counts[season] = count
    return rows, counts


def build_scored_rows(root, v23_outcomes, snapshot, seasons, lines):
    feature_names = tuple(snapshot['featureNames'])
    canonical, counts = canonical_features(root, seasons, feature_names)
    dispersion = float(snapshot['nb2Dispersion'])
    baseline_mu = float(snapshot['trainingMeanRuns'])
    baseline_line_probs = {float(key): float(value) for key, value in snapshot['trainingLineOverClimatology'].items()}
    if set(baseline_line_probs) != set(lines):
        raise SystemExit('V24_LINE_CLIMATOLOGY_MISMATCH')

    rows = []
    missing_features = []
    for outcome in v23_outcomes['rows']:
        game_pk = int(outcome['gamePk'])
        base = canonical.get(game_pk)
        if base is None:
            continue
        if base['season'] != outcome['season'] or base['date'] != outcome['officialDate']:
            raise SystemExit(f'V24_OUTCOME_IDENTITY_MISMATCH:{game_pk}')
        y = int(outcome['totalRuns'])
        mu = score_mu(base['features'], snapshot)
        model_dev = poisson_deviance_row(y, mu)
        baseline_dev = poisson_deviance_row(y, baseline_mu)
        model_briers = []
        baseline_briers = []
        line_rows = {}
        for line in lines:
            observed = 1.0 if y > line else 0.0
            model_prob = over_probability(mu, dispersion, line)
            baseline_prob = baseline_line_probs[line]
            model_brier = (model_prob - observed) ** 2
            baseline_brier = (baseline_prob - observed) ** 2
            model_briers.append(model_brier)
            baseline_briers.append(baseline_brier)
            line_rows[str(line)] = {
                'observedOver': observed,
                'modelProbability': model_prob,
                'baselineProbability': baseline_prob,
                'modelBrier': model_brier,
                'baselineBrier': baseline_brier,
                'improvement': baseline_brier - model_brier,
            }
        rows.append({
            'gamePk': game_pk,
            'season': base['season'],
            'date': base['date'],
            'month': base['date'][:7],
            'y': y,
            'mu': mu,
            'baselineMu': baseline_mu,
            'modelDeviance': model_dev,
            'baselineDeviance': baseline_dev,
            'devianceImprovement': baseline_dev - model_dev,
            'modelAverageBrier': float(np.mean(model_briers)),
            'baselineAverageBrier': float(np.mean(baseline_briers)),
            'averageBrierImprovement': float(np.mean(baseline_briers) - np.mean(model_briers)),
            'lineRows': line_rows,
        })

    return rows, counts


def partition_metrics(rows, lines):
    if not rows:
        raise SystemExit('V24_EMPTY_PARTITION')
    observed_mean = float(np.mean([row['y'] for row in rows]))
    predicted_mean = float(np.mean([row['mu'] for row in rows]))
    baseline_mean = float(rows[0]['baselineMu'])
    model_bias = abs(observed_mean - predicted_mean)
    baseline_bias = abs(observed_mean - baseline_mean)
    per_line = {}
    for line in lines:
        model = float(np.mean([row['lineRows'][str(line)]['modelBrier'] for row in rows]))
        baseline = float(np.mean([row['lineRows'][str(line)]['baselineBrier'] for row in rows]))
        per_line[str(line)] = {
            'modelBrier': model,
            'baselineBrier': baseline,
            'improvement': baseline - model,
        }
    model_dev = float(np.mean([row['modelDeviance'] for row in rows]))
    baseline_dev = float(np.mean([row['baselineDeviance'] for row in rows]))
    model_brier = float(np.mean([row['modelAverageBrier'] for row in rows]))
    baseline_brier = float(np.mean([row['baselineAverageBrier'] for row in rows]))
    return {
        'rows': len(rows),
        'observedMeanRuns': observed_mean,
        'meanPredictedRuns': predicted_mean,
        'constantBaselineMeanRuns': baseline_mean,
        'modelAbsoluteMeanBias': model_bias,
        'constantBaselineAbsoluteMeanBias': baseline_bias,
        'meanBiasNoWorseThanBaseline': model_bias <= baseline_bias + 1e-15,
        'meanPoissonDeviance': model_dev,
        'constantBaselineMeanPoissonDeviance': baseline_dev,
        'poissonDevianceImprovement': baseline_dev - model_dev,
        'averageBrierAcrossFixedLines': model_brier,
        'averageBaselineBrierAcrossFixedLines': baseline_brier,
        'averageBrierImprovement': baseline_brier - model_brier,
        'fixedLineBrier': per_line,
    }


def monthly_diagnostics(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['month']].append(row)
    result = {}
    for month in sorted(grouped):
        part = grouped[month]
        result[month] = {
            'rows': len(part),
            'meanDevianceImprovement': float(np.mean([row['devianceImprovement'] for row in part])),
            'meanAverageBrierImprovement': float(np.mean([row['averageBrierImprovement'] for row in part])),
            'observedMeanRuns': float(np.mean([row['y'] for row in part])),
            'meanPredictedRuns': float(np.mean([row['mu'] for row in part])),
        }
    return result


def date_cluster_bootstrap(rows, replicates, seed, confidence):
    by_date = defaultdict(list)
    for row in rows:
        by_date[row['date']].append(row)
    dates = sorted(by_date)
    daily_dev = np.asarray([
        np.mean([row['devianceImprovement'] for row in by_date[day]]) for day in dates
    ], dtype=float)
    daily_brier = np.asarray([
        np.mean([row['averageBrierImprovement'] for row in by_date[day]]) for day in dates
    ], dtype=float)
    if len(dates) < 2:
        raise SystemExit('V24_BOOTSTRAP_TOO_FEW_DATES')
    rng = np.random.default_rng(seed)
    dev_samples = np.empty(replicates, dtype=float)
    brier_samples = np.empty(replicates, dtype=float)
    n = len(dates)
    for index in range(replicates):
        picks = rng.integers(0, n, size=n)
        dev_samples[index] = float(np.mean(daily_dev[picks]))
        brier_samples[index] = float(np.mean(daily_brier[picks]))
    alpha = (1.0 - confidence) / 2.0
    lower_q = 100.0 * alpha
    upper_q = 100.0 * (1.0 - alpha)
    return {
        'clusterUnit': 'OFFICIAL_DATE',
        'uniqueDates': len(dates),
        'replicates': replicates,
        'randomSeed': seed,
        'confidenceLevel': confidence,
        'devianceImprovement': {
            'equalDayPointEstimate': float(np.mean(daily_dev)),
            'ciLower': float(np.percentile(dev_samples, lower_q)),
            'ciUpper': float(np.percentile(dev_samples, upper_q)),
        },
        'averageBrierImprovement': {
            'equalDayPointEstimate': float(np.mean(daily_brier)),
            'ciLower': float(np.percentile(brier_samples, lower_q)),
            'ciUpper': float(np.percentile(brier_samples, upper_q)),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v23-report', required=True)
    parser.add_argument('--v23-outcomes', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    v23 = load(args.v23_report)
    outcomes = load(args.v23_outcomes)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v24-f3-total-robustness-contract.v1':
        raise SystemExit('V24_CONTRACT_INVALID')
    if v23.get('schemaVersion') != V23_REPORT_SCHEMA:
        raise SystemExit('V24_V23_REPORT_SCHEMA_INVALID')
    if outcomes.get('schemaVersion') != V23_OUTCOME_SCHEMA:
        raise SystemExit('V24_V23_OUTCOME_SCHEMA_INVALID')
    if v23.get('classification') != contract['parentEvidence']['requiredParentClassification']:
        raise SystemExit(f"V24_PARENT_CLASSIFICATION_INVALID:{v23.get('classification')}")
    if v23['total']['candidateRubricPassed'] is not True:
        raise SystemExit('V24_PARENT_TOTAL_RUBRIC_NOT_PASSED')
    if v23['marketBoundary']['historicalF3PricesUsed'] is not False or v23['marketBoundary']['positiveEvEstablished'] is not False:
        raise SystemExit('V24_PARENT_PRICE_BOUNDARY_INVALID')

    snapshot = v23['total']['modelSnapshot']
    lines = tuple(float(value) for value in contract['modelBoundary']['fixedLines'])
    if tuple(float(key) for key in sorted((float(key) for key in snapshot['trainingLineOverClimatology'].keys()))) != tuple(sorted(lines)):
        raise SystemExit('V24_FROZEN_LINE_SET_DRIFT')
    seasons = (
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['robustnessSeasons'],
    )
    rows, canonical_counts = build_scored_rows(args.root, outcomes, snapshot, seasons, lines)

    partition_results = {}
    season_checks = {}
    for season in seasons:
        part = [row for row in rows if row['season'] == season]
        metrics = partition_metrics(part, lines)
        partition_results[season] = metrics
        season_checks[season] = {
            'positivePoissonDevianceImprovement': metrics['poissonDevianceImprovement'] > 0,
            'positiveAverageBrierImprovement': metrics['averageBrierImprovement'] > 0,
            'modelAbsoluteMeanBiasNoWorseThanConstantBaseline': metrics['meanBiasNoWorseThanBaseline'],
        }

    evaluation_rows = [row for row in rows if row['season'] in contract['dateClusterBootstrapGate']['evaluationSeasons']]
    boot_cfg = contract['dateClusterBootstrapGate']
    bootstrap = date_cluster_bootstrap(
        evaluation_rows,
        int(boot_cfg['replicates']),
        int(boot_cfg['randomSeed']),
        float(boot_cfg['confidenceLevel']),
    )
    bootstrap_checks = {
        'devianceImprovementCiLowerGreaterThanZero': bootstrap['devianceImprovement']['ciLower'] > 0,
        'averageBrierImprovementCiLowerGreaterThanZero': bootstrap['averageBrierImprovement']['ciLower'] > 0,
    }

    all_season_checks = all(value for checks in season_checks.values() for value in checks.values())
    all_bootstrap_checks = all(bootstrap_checks.values())
    passed = all_season_checks and all_bootstrap_checks
    classification = (
        contract['promotionRubric']['passClassification']
        if passed
        else contract['promotionRubric']['failClassification']
    )

    report = {
        'schemaVersion': SCHEMA,
        'classification': classification,
        'scientificStatus': contract['scientificStatus'],
        'parentCustody': contract['parentEvidence'],
        'modelBoundary': {
            'unchangedV23Snapshot': True,
            'refitUsed': False,
            'recalibrationUsed': False,
            'featureChangeUsed': False,
            'lineSearchUsed': False,
            'historicalF3PricesUsed': False,
        },
        'data': {
            'canonicalSeasonRows': canonical_counts,
            'scoredRows': len(rows),
            'outcomeRowsAvailable': len(outcomes['rows']),
        },
        'partitionMetrics': partition_results,
        'seasonStabilityChecks': season_checks,
        'dateClusterBootstrap': bootstrap,
        'dateClusterBootstrapChecks': bootstrap_checks,
        'monthlyDiagnostics': monthly_diagnostics(rows),
        'robustnessGatePassed': passed,
        'marketBoundary': {
            'marketKey': v23['total']['marketKey'],
            'canonicalMarketType': v23['total']['canonicalMarketType'],
            'positiveEvEstablished': False,
            'liveFreezeAuthorizedByThisResearch': passed,
            'prospectiveShadowPriceCaptureAuthorizedByThisResearch': passed,
            'productionPromotionAuthorized': False,
        },
        'policy': {
            'researchOnly': True,
            'sameDateOutcomeLeakageAllowed': False,
            'futureGameDataAllowed': False,
            'thresholdSearchUsed': False,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'postResultRuleChangeUsed': False,
            'liveLookupAuthorizationChanged': False,
            'liveMarketDiscoveryChanged': False,
            'rankingChanged': False,
            'stakeChanged': False,
            'betEliteAllowed': False,
            'automaticBetPlacementAllowed': False,
            'realFinancialExposure': 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        'classification': classification,
        'robustnessGatePassed': passed,
        'seasonStabilityChecks': season_checks,
        'partitionMetrics': {
            season: {
                'rows': metrics['rows'],
                'poissonDevianceImprovement': metrics['poissonDevianceImprovement'],
                'averageBrierImprovement': metrics['averageBrierImprovement'],
                'modelAbsoluteMeanBias': metrics['modelAbsoluteMeanBias'],
                'constantBaselineAbsoluteMeanBias': metrics['constantBaselineAbsoluteMeanBias'],
            }
            for season, metrics in partition_results.items()
        },
        'dateClusterBootstrap': bootstrap,
        'bootstrapChecks': bootstrap_checks,
    }, indent=2))


if __name__ == '__main__':
    main()
