#!/usr/bin/env python3
import argparse
import json
import math
import os
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, timedelta

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, PoissonRegressor
from sklearn.metrics import log_loss, mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v23-f3-model-suite.v1'
OUTCOME_SCHEMA = 'courtedge-p0-step12v23-f3-outcomes.v1'
BASE_SCHEMA = 'courtedge-p0-step12v-game-anatomy-feature-table.v1'
CLASS_NAMES = ('HOME', 'DRAW', 'AWAY')
CLASS_TO_INT = {'HOME': 0, 'DRAW': 1, 'AWAY': 2}
INT_TO_CLASS = {value: key for key, value in CLASS_TO_INT.items()}


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


def safe_float(value):
    return float(value) if finite(value) else None


def http_json(url, timeout=30, attempts=4):
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'CourtEdge-P0-V23-F3-Research/1.0'})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f'HTTP_{response.status}')
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(0.75 * (2 ** attempt))
    raise RuntimeError(f'F3_HTTP_FAILED:{url}:{last}')


def date_windows(start, end, window_days):
    cursor = start
    step = timedelta(days=window_days - 1)
    while cursor <= end:
        right = min(end, cursor + step)
        yield cursor, right
        cursor = right + timedelta(days=1)


def team_id(raw, side):
    value = raw.get('teams', {}).get(side, {}).get('team', {}).get('id')
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def innings_to_f3(innings):
    if not isinstance(innings, list):
        return None
    by_num = {}
    for inning in innings:
        try:
            number = int(inning.get('num'))
        except Exception:
            continue
        if number not in (1, 2, 3):
            continue
        home = inning.get('home', {}).get('runs')
        away = inning.get('away', {}).get('runs')
        if home is None or away is None:
            continue
        try:
            home_runs = int(home)
            away_runs = int(away)
        except Exception:
            continue
        if home_runs < 0 or away_runs < 0:
            continue
        by_num[number] = (home_runs, away_runs)
    if set(by_num) != {1, 2, 3}:
        return None
    home = sum(by_num[number][0] for number in (1, 2, 3))
    away = sum(by_num[number][1] for number in (1, 2, 3))
    outcome = 'HOME' if home > away else 'AWAY' if away > home else 'DRAW'
    return {'homeRuns': home, 'awayRuns': away, 'totalRuns': home + away, 'outcome': outcome}


def canonical_rows(root, seasons, require_t5):
    rows = []
    season_counts = {}
    for season in seasons:
        payload = load(os.path.join(root, season, 'game-anatomy-feature-table.json'))
        if payload.get('schemaVersion') != BASE_SCHEMA:
            raise SystemExit(f'V23_BASE_SCHEMA_INVALID:{season}')
        count = 0
        for raw in payload.get('rows', []):
            if require_t5 and not raw.get('t5PregameValid'):
                continue
            game_pk = int(raw['gamePk'])
            row = {
                'season': season,
                'officialDate': raw['officialDate'],
                'gamePk': game_pk,
                'homeTeamId': int(raw['homeTeamId']),
                'awayTeamId': int(raw['awayTeamId']),
                'features': raw.get('features') or {},
            }
            rows.append(row)
            count += 1
        season_counts[season] = count
    if len({row['gamePk'] for row in rows}) != len(rows):
        raise SystemExit('V23_CANONICAL_DUPLICATE_GAME_PK')
    return rows, season_counts


def collect_schedule_linescores(contract, canonical):
    cfg = contract['outcomeAcquisition']
    base = cfg['baseUrl']
    sport_id = int(cfg['sportId'])
    window_days = int(cfg['windowDays'])
    expected = {row['gamePk']: row for row in canonical}
    min_date = min(date.fromisoformat(row['officialDate']) for row in canonical)
    max_date = max(date.fromisoformat(row['officialDate']) for row in canonical)
    found = {}
    schedule_requests = 0
    exact_duplicate_observations = 0
    conflicting_duplicates = []
    identity_mismatches = []

    for left, right in date_windows(min_date, max_date, window_days):
        query = urllib.parse.urlencode({
            'sportId': sport_id,
            'startDate': left.isoformat(),
            'endDate': right.isoformat(),
            'hydrate': 'linescore,team',
        })
        payload = http_json(f'{base}?{query}')
        schedule_requests += 1
        for entry in payload.get('dates', []) if isinstance(payload, dict) else []:
            for raw in entry.get('games', []) if isinstance(entry, dict) else []:
                try:
                    game_pk = int(raw.get('gamePk'))
                except Exception:
                    continue
                if game_pk not in expected:
                    continue
                expected_row = expected[game_pk]
                api_home = team_id(raw, 'home')
                api_away = team_id(raw, 'away')
                if api_home != expected_row['homeTeamId'] or api_away != expected_row['awayTeamId']:
                    identity_mismatches.append({
                        'gamePk': game_pk,
                        'expectedHomeTeamId': expected_row['homeTeamId'],
                        'expectedAwayTeamId': expected_row['awayTeamId'],
                        'apiHomeTeamId': api_home,
                        'apiAwayTeamId': api_away,
                    })
                    continue
                f3 = innings_to_f3((raw.get('linescore') or {}).get('innings'))
                if game_pk in found:
                    exact_duplicate_observations += 1
                    if f3 is not None:
                        existing = found[game_pk]
                        comparable = {
                            'homeRuns': existing['homeRuns'],
                            'awayRuns': existing['awayRuns'],
                            'totalRuns': existing['totalRuns'],
                            'outcome': existing['outcome'],
                        }
                        if f3 != comparable:
                            conflicting_duplicates.append({
                                'gamePk': game_pk,
                                'existing': comparable,
                                'duplicate': f3,
                            })
                    continue
                if f3 is not None:
                    found[game_pk] = {
                        'gamePk': game_pk,
                        'officialDate': expected_row['officialDate'],
                        'season': expected_row['season'],
                        'homeTeamId': expected_row['homeTeamId'],
                        'awayTeamId': expected_row['awayTeamId'],
                        **f3,
                        'source': 'SCHEDULE_HYDRATE_LINESCORE',
                    }

    if conflicting_duplicates:
        raise SystemExit(f'V23_API_CONFLICTING_DUPLICATE_GAME_PK:{conflicting_duplicates[:5]}')
    if identity_mismatches:
        raise SystemExit(f'V23_TEAM_IDENTITY_MISMATCH:{identity_mismatches[:5]}')

    missing = [game_pk for game_pk in expected if game_pk not in found]
    fallback_limit = int(cfg['maximumPerGameLinescoreFallbacks'])
    if len(missing) > fallback_limit:
        raise SystemExit(f'V23_LINESCORE_HYDRATE_COVERAGE_TOO_LOW:missing={len(missing)}:limit={fallback_limit}')

    fallback_requests = 0
    fallback_base = cfg['perGameLinescoreBaseUrl'].rstrip('/')
    for game_pk in missing:
        payload = http_json(f'{fallback_base}/{game_pk}/linescore')
        fallback_requests += 1
        f3 = innings_to_f3(payload.get('innings') if isinstance(payload, dict) else None)
        if f3 is None:
            continue
        expected_row = expected[game_pk]
        found[game_pk] = {
            'gamePk': game_pk,
            'officialDate': expected_row['officialDate'],
            'season': expected_row['season'],
            'homeTeamId': expected_row['homeTeamId'],
            'awayTeamId': expected_row['awayTeamId'],
            **f3,
            'source': 'PER_GAME_OFFICIAL_LINESCORE_FALLBACK',
        }

    coverage = len(found) / len(expected) if expected else 0.0
    if coverage < float(cfg['minimumOutcomeCoverageShare']):
        unresolved = sorted(game_pk for game_pk in expected if game_pk not in found)
        raise SystemExit(f'V23_F3_OUTCOME_COVERAGE_BELOW_FLOOR:{coverage:.8f}:{unresolved[:20]}')

    return found, {
        'canonicalGames': len(expected),
        'outcomeCompleteGames': len(found),
        'coverageShare': coverage,
        'scheduleWindowRequests': schedule_requests,
        'exactDuplicateApiObservationsDeduplicated': exact_duplicate_observations,
        'conflictingDuplicateApiObservations': 0,
        'perGameLinescoreFallbackRequests': fallback_requests,
        'unresolvedGamePks': sorted(game_pk for game_pk in expected if game_pk not in found),
    }


def multiclass_brier(y, probabilities):
    onehot = np.eye(3, dtype=float)[y]
    classwise = np.mean((probabilities - onehot) ** 2, axis=0)
    return float(np.mean(classwise)), [float(value) for value in classwise]


def class_rates(y):
    return {INT_TO_CLASS[index]: float(np.mean(y == index)) for index in (0, 1, 2)}


def mean_class_probabilities(probabilities):
    means = np.mean(probabilities, axis=0)
    return {INT_TO_CLASS[index]: float(means[index]) for index in (0, 1, 2)}


def evaluate_moneyline(frame, features, imputer, scaler, model, baseline_probs):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    y = frame['f3Class'].to_numpy(dtype=int)
    probs = model.predict_proba(X)
    if tuple(int(value) for value in model.classes_) != (0, 1, 2):
        raise SystemExit(f'V23_ML_CLASS_ORDER_INVALID:{model.classes_}')
    baseline = np.tile(np.asarray(baseline_probs, dtype=float), (len(frame), 1))
    model_brier, model_classwise = multiclass_brier(y, probs)
    baseline_brier, baseline_classwise = multiclass_brier(y, baseline)
    model_log_loss = float(log_loss(y, probs, labels=[0, 1, 2]))
    baseline_log_loss = float(log_loss(y, baseline, labels=[0, 1, 2]))
    return {
        'rows': int(len(frame)),
        'observedClassRates': class_rates(y),
        'meanPredictedClassProbabilities': mean_class_probabilities(probs),
        'trainingClimatologyClassProbabilities': {INT_TO_CLASS[index]: float(baseline_probs[index]) for index in (0, 1, 2)},
        'multiclassLogLoss': model_log_loss,
        'baselineMulticlassLogLoss': baseline_log_loss,
        'logLossImprovement': baseline_log_loss - model_log_loss,
        'multiclassBrier': model_brier,
        'baselineMulticlassBrier': baseline_brier,
        'brierImprovement': baseline_brier - model_brier,
        'classwiseBrier': {INT_TO_CLASS[index]: model_classwise[index] for index in (0, 1, 2)},
        'baselineClasswiseBrier': {INT_TO_CLASS[index]: baseline_classwise[index] for index in (0, 1, 2)},
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit('V23_NB2_DENOMINATOR_INVALID')
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def evaluate_total(frame, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    mu = np.maximum(model.predict(X), 1e-9)
    y = frame['f3TotalRuns'].to_numpy(dtype=float)
    baseline_mu = np.full(len(frame), float(train_mean), dtype=float)
    rows = {}
    model_briers = []
    baseline_briers = []
    for line in lines:
        binary = (y > line).astype(float)
        probs = np.asarray([over_probability(float(value), dispersion, line) for value in mu], dtype=float)
        baseline_prob = float(train_line_probs[line])
        baseline = np.full(len(frame), baseline_prob, dtype=float)
        model_brier = float(np.mean((probs - binary) ** 2))
        baseline_brier = float(np.mean((baseline - binary) ** 2))
        model_briers.append(model_brier)
        baseline_briers.append(baseline_brier)
        rows[str(line)] = {
            'observedOverRate': float(np.mean(binary)),
            'meanModelOverProbability': float(np.mean(probs)),
            'trainingClimatologyOverProbability': baseline_prob,
            'modelBrier': model_brier,
            'baselineBrier': baseline_brier,
            'brierImprovement': baseline_brier - model_brier,
        }
    model_deviance = float(mean_poisson_deviance(y, mu))
    baseline_deviance = float(mean_poisson_deviance(y, baseline_mu))
    return {
        'rows': int(len(frame)),
        'observedMeanRuns': float(np.mean(y)),
        'meanPredictedRuns': float(np.mean(mu)),
        'meanAbsoluteError': float(mean_absolute_error(y, mu)),
        'constantBaselineMeanAbsoluteError': float(mean_absolute_error(y, baseline_mu)),
        'meanPoissonDeviance': model_deviance,
        'constantBaselineMeanPoissonDeviance': baseline_deviance,
        'poissonDevianceImprovement': baseline_deviance - model_deviance,
        'fixedLineDiagnostics': rows,
        'averageBrierAcrossFixedLines': float(np.mean(model_briers)),
        'averageBaselineBrierAcrossFixedLines': float(np.mean(baseline_briers)),
        'averageBrierImprovement': float(np.mean(baseline_briers) - np.mean(model_briers)),
    }


def volume_diagnostics(frame):
    dates = sorted(frame['officialDate'].unique())
    counts = Counter(frame['officialDate'])
    game_counts = [counts[day] for day in dates]
    markets = [2 * value for value in game_counts]
    return {
        'eligibleSlateDays': len(dates),
        'outcomeCompleteGames': int(len(frame)),
        'meanGamesPerEligibleSlateDay': float(np.mean(game_counts)) if game_counts else 0.0,
        'medianGamesPerEligibleSlateDay': float(np.median(game_counts)) if game_counts else 0.0,
        'potentialMarketRowsBeforePriceFiltering': int(2 * len(frame)),
        'meanPotentialMarketRowsPerEligibleSlateDay': float(np.mean(markets)) if markets else 0.0,
        'note': 'Potential rows are F3 ML + F3 TOTAL quote opportunities before price/EV filtering and are not bet candidates.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--outcomes-out', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v23-f3-model-suite-contract.v1':
        raise SystemExit('V23_CONTRACT_INVALID')
    features = tuple(contract['features']['exactly'])
    if len(features) != 13 or len(set(features)) != 13:
        raise SystemExit('V23_FEATURE_CONTRACT_INVALID')
    seasons = (
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    )
    canonical, season_counts = canonical_rows(args.root, seasons, bool(contract['dataBoundary']['requiresT5PregameValid']))
    outcomes, acquisition = collect_schedule_linescores(contract, canonical)

    outcome_payload = {
        'schemaVersion': OUTCOME_SCHEMA,
        'source': contract['outcomeAcquisition']['source'],
        'acquisition': acquisition,
        'rows': [outcomes[game_pk] for game_pk in sorted(outcomes)],
        'policy': {
            'labelsOnly': True,
            'sameDateOutcomeUsedAsFeature': False,
            'futureGameDataUsedAsFeature': False,
            'currentMetadataFallbackUsed': False,
            'playByPlayFallbackUsed': False,
        },
    }
    dump(args.outcomes_out, outcome_payload)

    joined = []
    for row in canonical:
        outcome = outcomes.get(row['gamePk'])
        if outcome is None:
            continue
        model_row = {
            'season': row['season'],
            'officialDate': row['officialDate'],
            'gamePk': row['gamePk'],
            'f3HomeRuns': outcome['homeRuns'],
            'f3AwayRuns': outcome['awayRuns'],
            'f3TotalRuns': outcome['totalRuns'],
            'f3ClassName': outcome['outcome'],
            'f3Class': CLASS_TO_INT[outcome['outcome']],
        }
        for feature in features:
            model_row[feature] = safe_float(row['features'].get(feature))
        joined.append(model_row)
    frame = pd.DataFrame(joined)
    fit_season = contract['dataBoundary']['modelFitSeason']
    validation_season = contract['dataBoundary']['validationSeason']
    eval_seasons = tuple(contract['dataBoundary']['retrospectiveEvaluationSeasons'])
    train = frame[frame.season == fit_season].copy()
    validation = frame[frame.season == validation_season].copy()
    evaluation = frame[frame.season.isin(eval_seasons)].copy()
    if train.empty or validation.empty or evaluation.empty:
        raise SystemExit('V23_PARTITION_EMPTY')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = imputer.fit_transform(train[list(features)])
    X_train_scaled = scaler.fit_transform(X_train)

    ml_cfg = contract['moneylineModel']
    y_class = train['f3Class'].to_numpy(dtype=int)
    moneyline = LogisticRegression(
        C=float(ml_cfg['regularizationC']),
        max_iter=int(ml_cfg['maxIter']),
        random_state=int(ml_cfg['randomState']),
        solver='lbfgs',
    )
    moneyline.fit(X_train_scaled, y_class)
    if tuple(int(value) for value in moneyline.classes_) != (0, 1, 2):
        raise SystemExit(f'V23_ML_TRAIN_CLASS_ORDER_INVALID:{moneyline.classes_}')
    baseline_probs = np.asarray([np.mean(y_class == index) for index in (0, 1, 2)], dtype=float)
    if not np.isclose(np.sum(baseline_probs), 1.0):
        raise SystemExit('V23_ML_BASELINE_INVALID')

    ml_validation = evaluate_moneyline(validation, features, imputer, scaler, moneyline, baseline_probs)
    ml_evaluation = evaluate_moneyline(evaluation, features, imputer, scaler, moneyline, baseline_probs)
    ml_by_season = {
        season: evaluate_moneyline(frame[frame.season == season], features, imputer, scaler, moneyline, baseline_probs)
        for season in eval_seasons
    }
    ml_checks = {
        'validationLogLossBeatsBaseline': ml_validation['multiclassLogLoss'] < ml_validation['baselineMulticlassLogLoss'],
        'evaluationLogLossBeatsBaseline': ml_evaluation['multiclassLogLoss'] < ml_evaluation['baselineMulticlassLogLoss'],
        'validationBrierBeatsBaseline': ml_validation['multiclassBrier'] < ml_validation['baselineMulticlassBrier'],
        'evaluationBrierBeatsBaseline': ml_evaluation['multiclassBrier'] < ml_evaluation['baselineMulticlassBrier'],
    }
    ml_pass = all(ml_checks.values())

    total_cfg = contract['totalModel']
    y_total = train['f3TotalRuns'].to_numpy(dtype=float)
    total_model = PoissonRegressor(
        alpha=float(total_cfg['poissonRegressorAlpha']),
        max_iter=int(total_cfg['poissonRegressorMaxIter']),
    )
    total_model.fit(X_train_scaled, y_total)
    train_mu = np.maximum(total_model.predict(X_train_scaled), 1e-9)
    dispersion = nb2_dispersion(y_total, train_mu)
    train_mean = float(np.mean(y_total))
    lines = tuple(float(value) for value in total_cfg['fixedHalfRunLines'])
    train_line_probs = {line: float(np.mean(y_total > line)) for line in lines}
    total_validation = evaluate_total(validation, features, imputer, scaler, total_model, dispersion, train_mean, train_line_probs, lines)
    total_evaluation = evaluate_total(evaluation, features, imputer, scaler, total_model, dispersion, train_mean, train_line_probs, lines)
    total_by_season = {
        season: evaluate_total(frame[frame.season == season], features, imputer, scaler, total_model, dispersion, train_mean, train_line_probs, lines)
        for season in eval_seasons
    }
    total_checks = {
        'validationPoissonDevianceBeatsBaseline': total_validation['meanPoissonDeviance'] < total_validation['constantBaselineMeanPoissonDeviance'],
        'evaluationPoissonDevianceBeatsBaseline': total_evaluation['meanPoissonDeviance'] < total_evaluation['constantBaselineMeanPoissonDeviance'],
        'validationAverageBrierBeatsBaseline': total_validation['averageBrierAcrossFixedLines'] < total_validation['averageBaselineBrierAcrossFixedLines'],
        'evaluationAverageBrierBeatsBaseline': total_evaluation['averageBrierAcrossFixedLines'] < total_evaluation['averageBaselineBrierAcrossFixedLines'],
    }
    total_pass = all(total_checks.values())

    if ml_pass and total_pass:
        classification = 'F3_ML_AND_TOTAL_PROSPECTIVE_CAPTURE_CANDIDATES'
    elif ml_pass:
        classification = 'F3_ML_PROSPECTIVE_CAPTURE_CANDIDATE_ONLY'
    elif total_pass:
        classification = 'F3_TOTAL_PROSPECTIVE_CAPTURE_CANDIDATE_ONLY'
    else:
        classification = 'F3_MODEL_SUITE_NOT_READY'

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'scientificStatus': contract['scientificStatus'],
        'data': {
            'canonicalSeasonRows': season_counts,
            'joinedSeasonRows': {season: int(np.sum(frame.season == season)) for season in seasons},
            'featureCount': len(features),
            'features': list(features),
            'outcomeAcquisition': acquisition,
        },
        'volumeDiagnostics': volume_diagnostics(frame),
        'moneyline': {
            'marketKey': ml_cfg['marketKey'],
            'canonicalMarketType': ml_cfg['canonicalMarketType'],
            'settlement': ml_cfg['settlement'],
            'modelSnapshot': {
                'classOrder': [INT_TO_CLASS[int(value)] for value in moneyline.classes_],
                'featureNames': list(features),
                'medianImpute': [float(value) for value in imputer.statistics_],
                'mean': [float(value) for value in scaler.mean_],
                'scale': [float(value) for value in scaler.scale_],
                'intercept': [float(value) for value in moneyline.intercept_],
                'coef': [[float(value) for value in row] for row in moneyline.coef_],
                'regularizationC': float(moneyline.C),
                'trainingClassProbabilities': {INT_TO_CLASS[index]: float(baseline_probs[index]) for index in (0, 1, 2)},
                'trainingOnlyFit': True,
            },
            'validation2023': ml_validation,
            'evaluation2024_2026Ytd': ml_evaluation,
            'evaluationBySeason': ml_by_season,
            'candidateRubricChecks': ml_checks,
            'candidateRubricPassed': ml_pass,
            'positiveEvEstablished': False,
        },
        'total': {
            'marketKey': total_cfg['marketKey'],
            'canonicalMarketType': total_cfg['canonicalMarketType'],
            'modelSnapshot': {
                'featureNames': list(features),
                'medianImpute': [float(value) for value in imputer.statistics_],
                'mean': [float(value) for value in scaler.mean_],
                'scale': [float(value) for value in scaler.scale_],
                'intercept': float(total_model.intercept_),
                'coef': [float(value) for value in total_model.coef_],
                'poissonRegressorAlpha': float(total_model.alpha),
                'nb2Dispersion': float(dispersion),
                'trainingMeanRuns': train_mean,
                'trainingLineOverClimatology': {str(line): float(train_line_probs[line]) for line in lines},
                'trainingOnlyFit': True,
            },
            'validation2023': total_validation,
            'evaluation2024_2026Ytd': total_evaluation,
            'evaluationBySeason': total_by_season,
            'candidateRubricChecks': total_checks,
            'candidateRubricPassed': total_pass,
            'positiveEvEstablished': False,
        },
        'marketBoundary': {
            'twoWayF3MoneylineOnly': True,
            'threeWayF3MoneylineEvaluated': False,
            'f3RunLineEvaluated': False,
            'historicalF3PricesUsed': False,
            'positiveEvEstablished': False,
            'prospectivePriceCaptureRequired': bool(ml_pass or total_pass),
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
    dump(args.out, report)
    print(json.dumps({
        'classification': classification,
        'acquisition': acquisition,
        'volumeDiagnostics': report['volumeDiagnostics'],
        'moneyline': {
            'validation2023': ml_validation,
            'evaluation2024_2026Ytd': ml_evaluation,
            'candidateRubricChecks': ml_checks,
        },
        'total': {
            'validation2023': total_validation,
            'evaluation2024_2026Ytd': total_evaluation,
            'candidateRubricChecks': total_checks,
        },
    }, indent=2))


if __name__ == '__main__':
    main()
