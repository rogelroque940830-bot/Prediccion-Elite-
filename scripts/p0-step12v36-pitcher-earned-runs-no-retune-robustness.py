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

REPORT_SCHEMA = 'courtedge-p0-step12v36-pitcher-earned-runs-no-retune-robustness.v1'


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write('\n')


def load_v35_module(path):
    spec = importlib.util.spec_from_file_location('courtedge_v35_pitcher_earned_runs', path)
    if spec is None or spec.loader is None:
        raise SystemExit('V36_V35_MODULE_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close(label, actual, expected, tolerance):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
        raise SystemExit(f'V36_PARITY_NONFINITE:{label}:{actual}:{expected}')
    if abs(float(actual) - float(expected)) > tolerance:
        raise SystemExit(f'V36_V35_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tolerance}')


def poisson_deviance_per_row(y, mu):
    y = np.asarray(y, dtype=float)
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    result = np.empty_like(mu, dtype=float)
    zero = y <= 0.0
    result[zero] = 2.0 * mu[zero]
    positive = ~zero
    result[positive] = 2.0 * (y[positive] * np.log(y[positive] / mu[positive]) - (y[positive] - mu[positive]))
    return result


def bootstrap_date_means(frame, metric_arrays, replicates, seed, confidence):
    work = frame[['officialDate']].copy().reset_index(drop=True)
    names = list(metric_arrays)
    for name, values in metric_arrays.items():
        work[name] = np.asarray(values, dtype=float)
    daily = work.groupby('officialDate', sort=True)[names].mean()
    if len(daily) < 2:
        raise SystemExit('V36_BOOTSTRAP_TOO_FEW_DATES')
    values = daily.to_numpy(dtype=float)
    point = np.mean(values, axis=0)
    rng = np.random.default_rng(seed)
    n_dates = len(values)
    boot = np.empty((replicates, len(names)), dtype=float)
    cursor = 0
    chunk = 500
    while cursor < replicates:
        count = min(chunk, replicates - cursor)
        idx = rng.integers(0, n_dates, size=(count, n_dates))
        boot[cursor:cursor + count] = np.mean(values[idx], axis=1)
        cursor += count
    alpha = 1.0 - confidence
    lower = np.percentile(boot, 100.0 * alpha / 2.0, axis=0)
    upper = np.percentile(boot, 100.0 * (1.0 - alpha / 2.0), axis=0)
    metrics = {}
    for i, name in enumerate(names):
        metrics[name] = {
            'equalDayPointEstimate': float(point[i]),
            'ciLower': float(lower[i]),
            'ciUpper': float(upper[i]),
        }
    return {
        'clusterUnit': 'OFFICIAL_DATE',
        'uniqueDates': int(n_dates),
        'replicates': int(replicates),
        'randomSeed': int(seed),
        'confidenceLevel': float(confidence),
        'aggregationWithinCluster': 'MEAN_PER_PITCHER_START_LOSS_IMPROVEMENT_WITHIN_DATE',
        'aggregationAcrossClusters': 'EQUAL_WEIGHT_MEAN_ACROSS_OFFICIAL_DATES',
        'metrics': metrics,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v35-contract', required=True)
    parser.add_argument('--v35-script', required=True)
    parser.add_argument('--v35-report', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v36-pitcher-earned-runs-no-retune-robustness-contract.v1':
        raise SystemExit('V36_CONTRACT_SCHEMA_INVALID')
    v35_contract = load(args.v35_contract)
    v35_report = load(args.v35_report)
    if v35_report.get('classification') != contract['parentEvidence']['v35ClassificationRequired']:
        raise SystemExit('V36_V35_PARENT_CLASSIFICATION_INVALID')
    if not v35_report.get('candidateRubricPassed'):
        raise SystemExit('V36_V35_PARENT_GATE_NOT_PASSED')

    v35 = load_v35_module(args.v35_script)
    seasons = [
        v35_contract['dataBoundary']['modelFitSeason'],
        v35_contract['dataBoundary']['validationSeason'],
        *v35_contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records, custody = [], {}
    for season in seasons:
        rows, season_custody = v35.build_season_rows(args.root, season, v35_contract)
        records.extend(rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    feature_names = tuple(v35_contract['features']['exactly'])
    train = frame[frame['season'] == '2022'].copy()
    validation = frame[frame['season'] == '2023'].copy()
    evaluation = frame[frame['season'].isin(['2024', '2025', '2026_YTD'])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit('V36_EMPTY_PARTITION')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['earnedRuns'].to_numpy(dtype=float)
    model_cfg = v35_contract['model']
    model = PoissonRegressor(alpha=float(model_cfg['poissonAlpha']), max_iter=int(model_cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = v35.nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in model_cfg['fixedHalfRunLines']]
    constant_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = v35.evaluate(validation, feature_names, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
    evaluation_metrics = v35.evaluate(evaluation, feature_names, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)

    tolerance = float(contract['replayParity']['absoluteTolerance'])
    for metric in contract['replayParity']['requiredMetrics']:
        assert_close(f'validation2023.{metric}', validation_metrics[metric], v35_report['validation2023'][metric], tolerance)
        assert_close(
            f'evaluation2024_2026Ytd.{metric}',
            evaluation_metrics[metric],
            v35_report['evaluation2024_2026Ytd'][metric],
            tolerance,
        )

    season_metrics = {}
    season_checks = {}
    for season in contract['seasonStabilityGate']['partitions']:
        part = frame[frame['season'] == season].copy()
        metrics = v35.evaluate(part, feature_names, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
        season_metrics[season] = metrics
        season_checks[season] = {
            'modelDevianceBeatsConstant': metrics['modelVsConstantDevianceImprovement'] > 0.0,
            'modelDevianceBeatsPitcherOnly': metrics['modelVsPitcherOnlyDevianceImprovement'] > 0.0,
            'modelAverageBrierBeatsConstant': metrics['modelVsConstantAverageBrierImprovement'] > 0.0,
            'modelAverageBrierBeatsPitcherOnly': metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0.0,
            'modelAbsoluteMeanBiasNoWorseThanConstant': metrics['modelAbsoluteMeanCalibrationBias'] <= metrics['constantAbsoluteMeanCalibrationBias'],
            'modelAbsoluteMeanBiasNoWorseThanPitcherOnly': metrics['modelAbsoluteMeanCalibrationBias'] <= metrics['pitcherOnlyAbsoluteMeanCalibrationBias'],
        }

    eval_frame = evaluation.reset_index(drop=True)
    X_eval = scaler.transform(imputer.transform(eval_frame[list(feature_names)]))
    model_mu = np.maximum(model.predict(X_eval), 1e-9)
    y_eval = eval_frame['earnedRuns'].to_numpy(dtype=float)
    constant_mu = np.full(len(eval_frame), train_mean, dtype=float)
    pitcher_mu = eval_frame['pitcherOnlyMuRaw'].to_numpy(dtype=float)
    pitcher_mu = np.where(np.isfinite(pitcher_mu) & (pitcher_mu > 0), pitcher_mu, train_mean)

    model_dev = poisson_deviance_per_row(y_eval, model_mu)
    constant_dev = poisson_deviance_per_row(y_eval, constant_mu)
    pitcher_dev = poisson_deviance_per_row(y_eval, pitcher_mu)

    constant_brier_improvements = []
    pitcher_brier_improvements = []
    for line in lines:
        observed = (y_eval > line).astype(float)
        model_prob = np.asarray([v35.over_probability(mu, dispersion, line) for mu in model_mu], dtype=float)
        pitcher_prob = np.asarray([v35.over_probability(mu, dispersion, line) for mu in pitcher_mu], dtype=float)
        constant_prob = float(constant_line_probs[line])
        model_loss = (model_prob - observed) ** 2
        constant_loss = (constant_prob - observed) ** 2
        pitcher_loss = (pitcher_prob - observed) ** 2
        constant_brier_improvements.append(constant_loss - model_loss)
        pitcher_brier_improvements.append(pitcher_loss - model_loss)

    metric_arrays = {
        'devianceVsConstant': constant_dev - model_dev,
        'devianceVsPitcherOnly': pitcher_dev - model_dev,
        'averageBrierVsConstant': np.mean(np.vstack(constant_brier_improvements), axis=0),
        'averageBrierVsPitcherOnly': np.mean(np.vstack(pitcher_brier_improvements), axis=0),
    }
    boot_cfg = contract['dateClusterBootstrapGate']
    bootstrap = bootstrap_date_means(
        eval_frame,
        metric_arrays,
        int(boot_cfg['replicates']),
        int(boot_cfg['randomSeed']),
        float(boot_cfg['confidenceLevel']),
    )
    bootstrap_checks = {name: values['ciLower'] > 0.0 for name, values in bootstrap['metrics'].items()}

    season_gate_passed = all(all(checks.values()) for checks in season_checks.values())
    bootstrap_gate_passed = all(bootstrap_checks.values())
    gate_passed = season_gate_passed and bootstrap_gate_passed
    classification = contract['classification']['pass'] if gate_passed else contract['classification']['fail']

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'robustnessGatePassed': gate_passed,
        'parent': {
            'v35Classification': v35_report['classification'],
            'v35CandidateRubricPassed': v35_report['candidateRubricPassed'],
            'v35WorkflowRunId': contract['parentEvidence']['v35WorkflowRunId'],
            'v35ArtifactId': contract['parentEvidence']['v35ArtifactId'],
        },
        'modelBoundary': {
            'unchangedV35ImplementationReplayed': True,
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
            'baselineFormulaChangeUsed': False,
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
            'providerMarketKey': 'pitcher_earned_runs',
            'repositoryRegistryFamily': 'PITCHER_PROP',
            'historicalPitcherEarnedRunPricesUsed': False,
            'positiveEvEstablished': False,
            'hardRockFloridaPerEventAvailabilityEstablished': False,
            'prospectivePriceCaptureEngineeringAuthorized': bool(gate_passed),
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
            'productionMarketRegistryChanged': False,
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
