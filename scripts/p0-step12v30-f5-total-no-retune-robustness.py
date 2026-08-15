#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v30-f5-total-no-retune-robustness.v1'


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write('\n')


def load_v29_module(path):
    spec = importlib.util.spec_from_file_location('courtedge_v29_f5_symmetric_core', path)
    if spec is None or spec.loader is None:
        raise SystemExit('V30_V29_MODULE_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close(label, actual, expected, tolerance):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
        raise SystemExit(f'V30_PARITY_NONFINITE:{label}:{actual}:{expected}')
    if abs(float(actual) - float(expected)) > tolerance:
        raise SystemExit(f'V30_V29_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tolerance}')


def poisson_deviance_per_row(y, mu):
    y = np.asarray(y, dtype=float)
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    result = np.empty_like(mu, dtype=float)
    zero = y <= 0.0
    result[zero] = 2.0 * mu[zero]
    positive = ~zero
    result[positive] = 2.0 * (y[positive] * np.log(y[positive] / mu[positive]) - (y[positive] - mu[positive]))
    return result


def bootstrap_date_means(frame, dev_improvement, brier_improvement, replicates, seed, confidence):
    work = frame[['officialDate']].copy().reset_index(drop=True)
    work['devImprovement'] = np.asarray(dev_improvement, dtype=float)
    work['brierImprovement'] = np.asarray(brier_improvement, dtype=float)
    daily = work.groupby('officialDate', sort=True)[['devImprovement', 'brierImprovement']].mean()
    if len(daily) < 2:
        raise SystemExit('V30_BOOTSTRAP_TOO_FEW_DATES')
    values = daily.to_numpy(dtype=float)
    point = np.mean(values, axis=0)
    rng = np.random.default_rng(seed)
    n_dates = len(values)
    boot = np.empty((replicates, 2), dtype=float)
    # Chunked to keep memory bounded while preserving deterministic RNG order.
    chunk = 500
    cursor = 0
    while cursor < replicates:
        count = min(chunk, replicates - cursor)
        idx = rng.integers(0, n_dates, size=(count, n_dates))
        boot[cursor:cursor + count] = np.mean(values[idx], axis=1)
        cursor += count
    alpha = 1.0 - confidence
    lower_q = 100.0 * (alpha / 2.0)
    upper_q = 100.0 * (1.0 - alpha / 2.0)
    lower = np.percentile(boot, lower_q, axis=0)
    upper = np.percentile(boot, upper_q, axis=0)
    return {
        'clusterUnit': 'OFFICIAL_DATE',
        'uniqueDates': int(n_dates),
        'replicates': int(replicates),
        'randomSeed': int(seed),
        'confidenceLevel': float(confidence),
        'aggregationWithinCluster': 'MEAN_PER_GAME_LOSS_IMPROVEMENT_WITHIN_DATE',
        'aggregationAcrossClusters': 'EQUAL_WEIGHT_MEAN_ACROSS_OFFICIAL_DATES',
        'devianceImprovement': {
            'equalDayPointEstimate': float(point[0]),
            'ciLower': float(lower[0]),
            'ciUpper': float(upper[0]),
        },
        'averageBrierImprovement': {
            'equalDayPointEstimate': float(point[1]),
            'ciLower': float(lower[1]),
            'ciUpper': float(upper[1]),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v29-contract', required=True)
    parser.add_argument('--v29-script', required=True)
    parser.add_argument('--v29-report', required=True)
    parser.add_argument('--v28-outcomes', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v30-f5-total-no-retune-robustness-contract.v1':
        raise SystemExit('V30_CONTRACT_SCHEMA_INVALID')
    v29_contract = load(args.v29_contract)
    v29_report = load(args.v29_report)
    if v29_report.get('classification') != contract['parentEvidence']['v29ClassificationRequired']:
        raise SystemExit('V30_V29_PARENT_CLASSIFICATION_INVALID')
    if not v29_report.get('candidateRubricPassed'):
        raise SystemExit('V30_V29_PARENT_GATE_NOT_PASSED')
    v28_outcomes = load(args.v28_outcomes)
    outcomes = {int(row['gamePk']): row for row in v28_outcomes.get('rows', [])}
    if len(outcomes) != int(v28_outcomes['acquisition']['outcomeCompleteGames']):
        raise SystemExit('V30_V28_OUTCOME_MAP_DUPLICATE_OR_DRIFT')

    v29 = load_v29_module(args.v29_script)
    seasons = [
        v29_contract['dataBoundary']['modelFitSeason'],
        v29_contract['dataBoundary']['validationSeason'],
        *v29_contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records = []
    custody = {}
    for season in seasons:
        season_rows, season_custody = v29.build_season_rows(args.root, season, outcomes, v29_contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    feature_names = tuple(v29_contract['features']['exactly'])
    train_season = v29_contract['dataBoundary']['modelFitSeason']
    validation_season = v29_contract['dataBoundary']['validationSeason']
    evaluation_seasons = v29_contract['dataBoundary']['retrospectiveEvaluationSeasons']
    train = frame[frame['season'] == train_season].copy()
    validation = frame[frame['season'] == validation_season].copy()
    evaluation = frame[frame['season'].isin(evaluation_seasons)].copy()

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['f5TotalRuns'].to_numpy(dtype=float)
    model_cfg = v29_contract['model']
    model = PoissonRegressor(alpha=float(model_cfg['poissonAlpha']), max_iter=int(model_cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = v29.nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in model_cfg['fixedHalfRunLines']]
    train_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = v29.evaluate(validation, feature_names, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines)
    evaluation_metrics = v29.evaluate(evaluation, feature_names, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines)

    parity_metrics = contract['replayParity']['requiredMetrics']
    tolerance = float(contract['replayParity']['absoluteTolerance'])
    for metric in parity_metrics:
        assert_close(f'validation2023.{metric}', validation_metrics[metric], v29_report['validation2023'][metric], tolerance)
        assert_close(f'evaluation2024_2026Ytd.{metric}', evaluation_metrics[metric], v29_report['evaluation2024_2026Ytd'][metric], tolerance)

    season_metrics = {}
    season_checks = {}
    gate_cfg = contract['seasonStabilityGate']
    for season in gate_cfg['partitions']:
        part = frame[frame['season'] == season].copy()
        metrics = v29.evaluate(part, feature_names, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines)
        season_metrics[season] = metrics
        season_checks[season] = {
            'positivePoissonDevianceImprovement': metrics['poissonDevianceImprovement'] > 0.0,
            'positiveAverageBrierImprovement': metrics['averageBrierImprovement'] > 0.0,
            'modelAbsoluteMeanBiasNoWorseThanConstantBaseline': metrics['absoluteMeanCalibrationBias'] <= metrics['constantBaselineAbsoluteMeanCalibrationBias'],
        }

    eval_frame = evaluation.reset_index(drop=True)
    X_eval = scaler.transform(imputer.transform(eval_frame[list(feature_names)]))
    mu_eval = np.maximum(model.predict(X_eval), 1e-9)
    y_eval = eval_frame['f5TotalRuns'].to_numpy(dtype=float)
    baseline_mu = np.full(len(eval_frame), train_mean, dtype=float)
    model_dev = poisson_deviance_per_row(y_eval, mu_eval)
    baseline_dev = poisson_deviance_per_row(y_eval, baseline_mu)
    dev_improvement = baseline_dev - model_dev

    line_improvements = []
    for line in lines:
        observed = (y_eval > line).astype(float)
        model_prob = np.asarray([v29.over_probability(float(mu), dispersion, line) for mu in mu_eval], dtype=float)
        baseline_prob = float(train_line_probs[line])
        model_loss = (model_prob - observed) ** 2
        baseline_loss = (baseline_prob - observed) ** 2
        line_improvements.append(baseline_loss - model_loss)
    brier_improvement = np.mean(np.vstack(line_improvements), axis=0)

    boot_cfg = contract['dateClusterBootstrapGate']
    bootstrap = bootstrap_date_means(
        eval_frame,
        dev_improvement,
        brier_improvement,
        int(boot_cfg['replicates']),
        int(boot_cfg['randomSeed']),
        float(boot_cfg['confidenceLevel']),
    )
    bootstrap_checks = {
        'devianceImprovementCiLowerGreaterThanZero': bootstrap['devianceImprovement']['ciLower'] > 0.0,
        'averageBrierImprovementCiLowerGreaterThanZero': bootstrap['averageBrierImprovement']['ciLower'] > 0.0,
    }

    season_gate_passed = all(all(checks.values()) for checks in season_checks.values())
    bootstrap_gate_passed = all(bootstrap_checks.values())
    gate_passed = season_gate_passed and bootstrap_gate_passed
    classification = contract['classification']['pass'] if gate_passed else contract['classification']['fail']

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'robustnessGatePassed': gate_passed,
        'parent': {
            'v29Classification': v29_report['classification'],
            'v29CandidateRubricPassed': v29_report['candidateRubricPassed'],
            'v29WorkflowRunId': contract['parentEvidence']['v29WorkflowRunId'],
            'v29ArtifactId': contract['parentEvidence']['v29ArtifactId'],
        },
        'modelBoundary': {
            'unchangedV29ImplementationReplayed': True,
            'replayParityTolerance': tolerance,
            'replayParityPassed': True,
            'refitWithAdditionalSeasonsUsed': False,
            'recalibrationUsed': False,
            'coefficientChangeUsed': False,
            'featureChangeUsed': False,
            'imputationChangeUsed': False,
            'scalingChangeUsed': False,
            'dispersionChangeUsed': False,
            'lineSetChangeUsed': False,
            'thresholdSearchUsed': False,
        },
        'data': {
            'scoredRows': int(len(frame)),
            'custodyBySeason': custody,
            'featureCount': len(feature_names),
            'features': list(feature_names),
        },
        'seasonMetrics': season_metrics,
        'seasonStabilityChecks': season_checks,
        'seasonStabilityGatePassed': season_gate_passed,
        'dateClusterBootstrap': bootstrap,
        'bootstrapChecks': bootstrap_checks,
        'bootstrapGatePassed': bootstrap_gate_passed,
        'marketBoundary': {
            'providerMarketKey': 'totals_1st_5_innings',
            'canonicalMarketType': 'F5_TOTAL',
            'historicalF5PricesUsed': False,
            'positiveEvEstablished': False,
            'prospectiveShadowPriceCaptureAuthorized': bool(gate_passed),
            'productionPromotionAuthorized': False,
        },
        'policy': {
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'thresholdSearchUsed': False,
            'subsetMiningUsed': False,
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
        'robustnessGatePassed': gate_passed,
        'seasonStabilityGatePassed': season_gate_passed,
        'seasonStabilityChecks': season_checks,
        'seasonMetrics': season_metrics,
        'bootstrapGatePassed': bootstrap_gate_passed,
        'dateClusterBootstrap': bootstrap,
        'bootstrapChecks': bootstrap_checks,
    }, indent=2))


if __name__ == '__main__':
    main()
