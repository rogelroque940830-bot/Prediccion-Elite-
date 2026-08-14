#!/usr/bin/env python3
import argparse
import json
import math
import os

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

SCHEMA = 'courtedge-p0-step12v20-team-total-count-model.v1'
BASE_SCHEMA = 'courtedge-p0-step12v-game-anatomy-feature-table.v1'


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except Exception:
        return False


def safe_float(value):
    return float(value) if finite(value) else None


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit('V20_NB2_DISPERSION_DENOMINATOR_INVALID')
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def model_snapshot(target, features, imputer, scaler, model, dispersion, train_mean, train_line_probs):
    return {
        'target': target,
        'featureNames': list(features),
        'medianImpute': [float(x) for x in imputer.statistics_],
        'mean': [float(x) for x in scaler.mean_],
        'scale': [float(x) for x in scaler.scale_],
        'intercept': float(model.intercept_),
        'coef': [float(x) for x in model.coef_],
        'poissonRegressorAlpha': float(model.alpha),
        'nb2Dispersion': float(dispersion),
        'trainingMeanRuns': float(train_mean),
        'trainingLineOverClimatology': {str(line): float(prob) for line, prob in train_line_probs.items()},
        'trainingOnlyFit': True,
    }


def evaluate_partition(frame, target, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    mu = np.maximum(model.predict(X), 1e-9)
    y = frame[target].to_numpy(dtype=float)
    constant_mu = np.full(len(frame), float(train_mean), dtype=float)
    line_rows = {}
    model_briers = []
    baseline_briers = []
    for line in lines:
        binary = (y > float(line)).astype(float)
        probs = np.array([over_probability(float(m), dispersion, float(line)) for m in mu], dtype=float)
        baseline_prob = float(train_line_probs[line])
        baseline = np.full(len(frame), baseline_prob, dtype=float)
        model_brier = float(np.mean((probs - binary) ** 2))
        baseline_brier = float(np.mean((baseline - binary) ** 2))
        model_briers.append(model_brier)
        baseline_briers.append(baseline_brier)
        line_rows[str(line)] = {
            'observedOverRate': float(np.mean(binary)),
            'meanModelOverProbability': float(np.mean(probs)),
            'trainingClimatologyOverProbability': baseline_prob,
            'modelBrier': model_brier,
            'baselineBrier': baseline_brier,
            'brierImprovement': baseline_brier - model_brier,
        }
    model_deviance = float(mean_poisson_deviance(y, mu))
    baseline_deviance = float(mean_poisson_deviance(y, constant_mu))
    return {
        'rows': int(len(frame)),
        'observedMeanRuns': float(np.mean(y)),
        'meanPredictedRuns': float(np.mean(mu)),
        'meanAbsoluteError': float(mean_absolute_error(y, mu)),
        'constantBaselineMeanAbsoluteError': float(mean_absolute_error(y, constant_mu)),
        'meanPoissonDeviance': model_deviance,
        'constantBaselineMeanPoissonDeviance': baseline_deviance,
        'poissonDevianceImprovement': baseline_deviance - model_deviance,
        'fixedLineDiagnostics': line_rows,
        'averageBrierAcrossFixedLines': float(np.mean(model_briers)),
        'averageBaselineBrierAcrossFixedLines': float(np.mean(baseline_briers)),
        'averageBrierImprovement': float(np.mean(baseline_briers) - np.mean(model_briers)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v20-team-total-count-model-contract.v1':
        raise SystemExit('V20_CONTRACT_INVALID')

    features = tuple(contract['features']['exactly'])
    if len(features) != 13 or len(set(features)) != 13:
        raise SystemExit('V20_FEATURE_CONTRACT_INVALID')
    lines = tuple(float(x) for x in contract['probabilityDiagnostics']['fixedHalfRunLines'])
    if lines != (2.5, 3.5, 4.5, 5.5, 6.5):
        raise SystemExit('V20_LINE_CONTRACT_INVALID')

    seasons = (
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    )
    rows = []
    season_counts = {}
    for season in seasons:
        table = load(os.path.join(args.root, season, 'game-anatomy-feature-table.json'))
        if table.get('schemaVersion') != BASE_SCHEMA:
            raise SystemExit(f'V20_BASE_SCHEMA_INVALID:{season}')
        count = 0
        for raw in table['rows']:
            if contract['dataBoundary']['requiresT5PregameValid'] and not raw.get('t5PregameValid'):
                continue
            outcome = raw['outcomes']['FULL_GAME']
            feature_values = raw.get('features') or {}
            row = {
                'season': season,
                'officialDate': raw['officialDate'],
                'gamePk': int(raw['gamePk']),
                'home_runs': int(outcome['homeRuns']),
                'away_runs': int(outcome['awayRuns']),
            }
            for feature in features:
                row[feature] = safe_float(feature_values.get(feature))
            rows.append(row)
            count += 1
        season_counts[season] = count

    frame = pd.DataFrame(rows)
    fit_season = contract['dataBoundary']['modelFitSeason']
    validation_season = contract['dataBoundary']['validationSeason']
    eval_seasons = tuple(contract['dataBoundary']['retrospectiveEvaluationSeasons'])
    train = frame[frame.season == fit_season].copy()
    validation = frame[frame.season == validation_season].copy()
    evaluation = frame[frame.season.isin(eval_seasons)].copy()
    if train.empty or validation.empty or evaluation.empty:
        raise SystemExit('V20_PARTITION_EMPTY')

    alpha = float(contract['model']['poissonRegressorAlpha'])
    max_iter = int(contract['model']['poissonRegressorMaxIter'])
    targets = {
        'HOME_FULL_GAME_RUNS': 'home_runs',
        'AWAY_FULL_GAME_RUNS': 'away_runs',
    }

    snapshots = {}
    validation_metrics = {}
    evaluation_metrics = {}
    by_season = {}
    rubric_checks = {}

    for target_name, target_col in targets.items():
        imputer = SimpleImputer(strategy='median')
        scaler = StandardScaler()
        X_train = imputer.fit_transform(train[list(features)])
        X_train_scaled = scaler.fit_transform(X_train)
        y_train = train[target_col].to_numpy(dtype=float)
        model = PoissonRegressor(alpha=alpha, max_iter=max_iter)
        model.fit(X_train_scaled, y_train)
        train_mu = np.maximum(model.predict(X_train_scaled), 1e-9)
        dispersion = nb2_dispersion(y_train, train_mu)
        train_mean = float(np.mean(y_train))
        train_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

        snapshots[target_name] = model_snapshot(
            target_name, features, imputer, scaler, model, dispersion, train_mean, train_line_probs,
        )
        validation_metrics[target_name] = evaluate_partition(
            validation, target_col, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines,
        )
        evaluation_metrics[target_name] = evaluate_partition(
            evaluation, target_col, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines,
        )
        by_season[target_name] = {}
        for season in eval_seasons:
            part = frame[frame.season == season]
            by_season[target_name][season] = evaluate_partition(
                part, target_col, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines,
            )

        v = validation_metrics[target_name]
        e = evaluation_metrics[target_name]
        rubric_checks[target_name] = {
            'validationPoissonDevianceBeatsBaseline': v['meanPoissonDeviance'] < v['constantBaselineMeanPoissonDeviance'],
            'evaluationPoissonDevianceBeatsBaseline': e['meanPoissonDeviance'] < e['constantBaselineMeanPoissonDeviance'],
            'validationAverageBrierBeatsBaseline': v['averageBrierAcrossFixedLines'] < v['averageBaselineBrierAcrossFixedLines'],
            'evaluationAverageBrierBeatsBaseline': e['averageBrierAcrossFixedLines'] < e['averageBaselineBrierAcrossFixedLines'],
        }

    all_checks = [value for target in rubric_checks.values() for value in target.values()]
    passes = all(all_checks)
    classification = (
        'PROSPECTIVE_TEAM_TOTAL_PRICE_CAPTURE_CANDIDATE'
        if passes
        else 'TEAM_TOTAL_COUNT_MODEL_NOT_READY'
    )

    report = {
        'schemaVersion': SCHEMA,
        'classification': classification,
        'scientificStatus': contract['scientificStatus'],
        'data': {
            'seasonRows': season_counts,
            'modelFitSeason': fit_season,
            'validationSeason': validation_season,
            'retrospectiveEvaluationSeasons': list(eval_seasons),
            'featureCount': len(features),
            'features': list(features),
        },
        'modelSnapshots': snapshots,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'evaluationBySeason': by_season,
        'candidateRubricChecks': rubric_checks,
        'candidateRubricPassed': passes,
        'marketBoundary': {
            'providerMarketKey': contract['marketBoundary']['candidateProviderMarketKey'],
            'canonicalMarketType': contract['marketBoundary']['candidateCanonicalMarketType'],
            'historicalTeamTotalPricesUsed': False,
            'positiveEvEstablished': False,
            'retrospectiveBetProfitabilityEstablished': False,
            'prospectivePriceCaptureRequired': True,
        },
        'policy': {
            'researchOnly': True,
            'sameDateOutcomeLeakageAllowed': False,
            'futureGameDataAllowed': False,
            'featureSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'probabilityThresholdSearchUsed': False,
            'liveLookupAuthorizationChanged': False,
            'liveMarketDiscoveryChanged': False,
            'rankingChanged': False,
            'stakeChanged': False,
            'betEliteAllowed': False,
            'automaticBetPlacementAllowed': False,
            'realFinancialExposure': 0,
        },
    }
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write('\n')

    print(json.dumps({
        'classification': classification,
        'seasonRows': season_counts,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'candidateRubricChecks': rubric_checks,
    }, indent=2))


if __name__ == '__main__':
    main()
