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

REPORT_SCHEMA = 'courtedge-p0-step12v34-pitcher-walks-no-retune-robustness.v1'


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def dump(path, payload):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write('\n')


def load_v33(path):
    spec = importlib.util.spec_from_file_location('courtedge_v33_pitcher_walks', path)
    if spec is None or spec.loader is None:
        raise SystemExit('V34_V33_MODULE_LOAD_FAILED')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close(label, actual, expected, tolerance):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):
        raise SystemExit(f'V34_PARITY_NONFINITE:{label}')
    if abs(float(actual) - float(expected)) > tolerance:
        raise SystemExit(f'V34_V33_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tolerance}')


def poisson_deviance_per_row(y, mu):
    y = np.asarray(y, dtype=float)
    mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    out = np.empty_like(mu)
    zero = y <= 0
    out[zero] = 2.0 * mu[zero]
    positive = ~zero
    out[positive] = 2.0 * (y[positive] * np.log(y[positive] / mu[positive]) - (y[positive] - mu[positive]))
    return out


def bootstrap_by_date(frame, metrics, replicates, seed, confidence):
    work = frame[['officialDate']].copy().reset_index(drop=True)
    names = list(metrics)
    for name, values in metrics.items():
        work[name] = np.asarray(values, dtype=float)
    daily = work.groupby('officialDate', sort=True)[names].mean()
    values = daily.to_numpy(dtype=float)
    if len(values) < 2:
        raise SystemExit('V34_BOOTSTRAP_TOO_FEW_DATES')
    rng = np.random.default_rng(seed)
    boot = np.empty((replicates, len(names)), dtype=float)
    cursor = 0
    while cursor < replicates:
        count = min(500, replicates - cursor)
        idx = rng.integers(0, len(values), size=(count, len(values)))
        boot[cursor:cursor+count] = np.mean(values[idx], axis=1)
        cursor += count
    alpha = 1.0 - confidence
    lower = np.percentile(boot, 100 * alpha / 2, axis=0)
    upper = np.percentile(boot, 100 * (1 - alpha / 2), axis=0)
    point = np.mean(values, axis=0)
    return {
        'clusterUnit': 'OFFICIAL_DATE',
        'uniqueDates': int(len(values)),
        'replicates': int(replicates),
        'randomSeed': int(seed),
        'confidenceLevel': float(confidence),
        'metrics': {
            name: {'equalDayPointEstimate': float(point[i]), 'ciLower': float(lower[i]), 'ciUpper': float(upper[i])}
            for i, name in enumerate(names)
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v33-contract', required=True)
    parser.add_argument('--v33-script', required=True)
    parser.add_argument('--v33-report', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    v33_contract = load(args.v33_contract)
    v33_report = load(args.v33_report)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v34-pitcher-walks-no-retune-robustness-contract.v1':
        raise SystemExit('V34_CONTRACT_SCHEMA_INVALID')
    if v33_report.get('classification') != contract['parentEvidence']['v33ClassificationRequired'] or not v33_report.get('candidateRubricPassed'):
        raise SystemExit('V34_V33_PARENT_INVALID')

    v33 = load_v33(args.v33_script)
    seasons = [v33_contract['dataBoundary']['modelFitSeason'], v33_contract['dataBoundary']['validationSeason'], *v33_contract['dataBoundary']['retrospectiveEvaluationSeasons']]
    records, custody = [], {}
    for season in seasons:
        rows, c = v33.build_season_rows(args.root, season, v33_contract)
        records.extend(rows)
        custody[season] = c
    frame = pd.DataFrame.from_records(records)
    features = tuple(v33_contract['features']['exactly'])
    train = frame[frame['season'] == '2022'].copy()
    validation = frame[frame['season'] == '2023'].copy()
    evaluation = frame[frame['season'].isin(['2024','2025','2026_YTD'])].copy()

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)]))
    y_train = train['walks'].to_numpy(dtype=float)
    cfg = v33_contract['model']
    model = PoissonRegressor(alpha=float(cfg['poissonAlpha']), max_iter=int(cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = v33.nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in cfg['fixedHalfRunLines']]
    constant_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = v33.evaluate(validation, features, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
    evaluation_metrics = v33.evaluate(evaluation, features, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
    tol = float(contract['replayParity']['absoluteTolerance'])
    for metric in contract['replayParity']['requiredMetrics']:
        assert_close(f'validation2023.{metric}', validation_metrics[metric], v33_report['validation2023'][metric], tol)
        assert_close(f'evaluation2024_2026Ytd.{metric}', evaluation_metrics[metric], v33_report['evaluation2024_2026Ytd'][metric], tol)

    season_metrics, season_checks = {}, {}
    for season in contract['seasonStabilityGate']['partitions']:
        part = frame[frame['season'] == season].copy()
        metrics = v33.evaluate(part, features, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
        season_metrics[season] = metrics
        season_checks[season] = {
            'modelDevianceBeatsConstant': metrics['modelVsConstantDevianceImprovement'] > 0,
            'modelDevianceBeatsPitcherOnly': metrics['modelVsPitcherOnlyDevianceImprovement'] > 0,
            'modelAverageBrierBeatsConstant': metrics['modelVsConstantAverageBrierImprovement'] > 0,
            'modelAverageBrierBeatsPitcherOnly': metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0,
            'modelAbsoluteMeanBiasNoWorseThanConstant': metrics['modelAbsoluteMeanCalibrationBias'] <= metrics['constantAbsoluteMeanCalibrationBias'],
            'modelAbsoluteMeanBiasNoWorseThanPitcherOnly': metrics['modelAbsoluteMeanCalibrationBias'] <= metrics['pitcherOnlyAbsoluteMeanCalibrationBias'],
        }

    eval_frame = evaluation.reset_index(drop=True)
    X_eval = scaler.transform(imputer.transform(eval_frame[list(features)]))
    model_mu = np.maximum(model.predict(X_eval), 1e-9)
    y_eval = eval_frame['walks'].to_numpy(dtype=float)
    constant_mu = np.full(len(eval_frame), train_mean, dtype=float)
    pitcher_mu = eval_frame['pitcherOnlyMuRaw'].to_numpy(dtype=float)
    pitcher_mu = np.where(np.isfinite(pitcher_mu) & (pitcher_mu > 0), pitcher_mu, train_mean)
    model_dev = poisson_deviance_per_row(y_eval, model_mu)
    constant_dev = poisson_deviance_per_row(y_eval, constant_mu)
    pitcher_dev = poisson_deviance_per_row(y_eval, pitcher_mu)

    constant_brier, pitcher_brier = [], []
    for line in lines:
        observed = (y_eval > line).astype(float)
        model_prob = np.asarray([v33.over_probability(mu, dispersion, line) for mu in model_mu])
        pitcher_prob = np.asarray([v33.over_probability(mu, dispersion, line) for mu in pitcher_mu])
        constant_prob = float(constant_line_probs[line])
        model_loss = (model_prob - observed) ** 2
        constant_brier.append((constant_prob - observed) ** 2 - model_loss)
        pitcher_brier.append((pitcher_prob - observed) ** 2 - model_loss)

    boot_cfg = contract['dateClusterBootstrapGate']
    bootstrap = bootstrap_by_date(
        eval_frame,
        {
            'devianceVsConstant': constant_dev - model_dev,
            'devianceVsPitcherOnly': pitcher_dev - model_dev,
            'averageBrierVsConstant': np.mean(np.vstack(constant_brier), axis=0),
            'averageBrierVsPitcherOnly': np.mean(np.vstack(pitcher_brier), axis=0),
        },
        int(boot_cfg['replicates']), int(boot_cfg['randomSeed']), float(boot_cfg['confidenceLevel'])
    )
    bootstrap_checks = {name: metric['ciLower'] > 0 for name, metric in bootstrap['metrics'].items()}
    season_gate = all(all(x.values()) for x in season_checks.values())
    bootstrap_gate = all(bootstrap_checks.values())
    passed = season_gate and bootstrap_gate
    classification = contract['classification']['pass'] if passed else contract['classification']['fail']

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'robustnessGatePassed': passed,
        'parent': {'v33Classification': v33_report['classification'], 'v33CandidateRubricPassed': True, 'v33WorkflowRunId': contract['parentEvidence']['v33WorkflowRunId'], 'v33ArtifactId': contract['parentEvidence']['v33ArtifactId']},
        'modelBoundary': {
            'unchangedV33ImplementationReplayed': True, 'replayParityPassed': True, 'replayParityTolerance': tol,
            'refitWithAdditionalSeasonsUsed': False, 'recalibrationUsed': False, 'coefficientChangeUsed': False,
            'featureChangeUsed': False, 'imputationChangeUsed': False, 'scalingChangeUsed': False,
            'dispersionChangeUsed': False, 'lineSetChangeUsed': False, 'baselineFormulaChangeUsed': False,
            'thresholdSearchUsed': False,
        },
        'data': {'scoredRows': int(len(frame)), 'custodyBySeason': custody, 'featureCount': len(features), 'features': list(features)},
        'seasonMetrics': season_metrics,
        'seasonStabilityChecks': season_checks,
        'seasonStabilityGatePassed': season_gate,
        'dateClusterBootstrap': bootstrap,
        'bootstrapChecks': bootstrap_checks,
        'bootstrapGatePassed': bootstrap_gate,
        'marketBoundary': {
            'providerMarketKey': 'pitcher_walks', 'repositoryRegistryFamily': 'PITCHER_PROP',
            'historicalPitcherWalkPricesUsed': False, 'positiveEvEstablished': False,
            'hardRockFloridaPerEventAvailabilityEstablished': False,
            'prospectivePriceCaptureEngineeringAuthorized': bool(passed), 'productionPromotionAuthorized': False,
        },
        'policy': {
            'featureSearchUsed': False, 'modelSearchUsed': False, 'hyperparameterSearchUsed': False,
            'lineSearchUsed': False, 'thresholdSearchUsed': False, 'subsetMiningUsed': False,
            'postResultRuleChangeUsed': False, 'productionMarketRegistryChanged': False,
            'liveLookupAuthorizationChanged': False, 'liveMarketDiscoveryChanged': False,
            'rankingChanged': False, 'stakeChanged': False, 'betEliteAllowed': False,
            'automaticBetPlacementAllowed': False, 'realFinancialExposure': 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        'classification': classification,
        'robustnessGatePassed': passed,
        'seasonStabilityGatePassed': season_gate,
        'seasonStabilityChecks': season_checks,
        'seasonMetrics': season_metrics,
        'bootstrapGatePassed': bootstrap_gate,
        'dateClusterBootstrap': bootstrap,
        'bootstrapChecks': bootstrap_checks,
    }, indent=2))


if __name__ == '__main__':
    main()
