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
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v28-f5-total-baseline.v1'
OUTCOME_SCHEMA = 'courtedge-p0-step12v28-f5-outcomes.v1'
BASE_SCHEMA = 'courtedge-p0-step12v-game-anatomy-feature-table.v1'


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


def http_json(url, timeout=30, attempts=4):
    last = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'CourtEdge-P0-V28-F5-Total-Research/1.0'})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f'HTTP_{response.status}')
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(0.75 * (2 ** attempt))
    raise RuntimeError(f'V28_HTTP_FAILED:{url}:{last}')


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


def innings_to_f5(innings):
    if not isinstance(innings, list):
        return None
    by_num = {}
    for inning in innings:
        try:
            number = int(inning.get('num'))
        except Exception:
            continue
        if number not in (1, 2, 3, 4, 5):
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
    if set(by_num) != {1, 2, 3, 4, 5}:
        return None
    home = sum(by_num[number][0] for number in (1, 2, 3, 4, 5))
    away = sum(by_num[number][1] for number in (1, 2, 3, 4, 5))
    return {'homeRuns': home, 'awayRuns': away, 'totalRuns': home + away}


def canonical_rows(root, seasons, require_t5):
    rows = []
    season_counts = {}
    for season in seasons:
        payload = load(os.path.join(root, season, 'game-anatomy-feature-table.json'))
        if payload.get('schemaVersion') != BASE_SCHEMA:
            raise SystemExit(f'V28_BASE_SCHEMA_INVALID:{season}')
        count = 0
        for raw in payload.get('rows', []):
            if require_t5 and not raw.get('t5PregameValid'):
                continue
            rows.append({
                'season': season,
                'officialDate': raw['officialDate'],
                'gamePk': int(raw['gamePk']),
                'homeTeamId': int(raw['homeTeamId']),
                'awayTeamId': int(raw['awayTeamId']),
                'features': raw.get('features') or {},
            })
            count += 1
        season_counts[season] = count
    if len({row['gamePk'] for row in rows}) != len(rows):
        raise SystemExit('V28_CANONICAL_DUPLICATE_GAME_PK')
    return rows, season_counts


def collect_f5_outcomes(contract, canonical):
    cfg = contract['outcomeAcquisition']
    expected = {row['gamePk']: row for row in canonical}
    min_date = min(date.fromisoformat(row['officialDate']) for row in canonical)
    max_date = max(date.fromisoformat(row['officialDate']) for row in canonical)
    found = {}
    schedule_requests = 0
    exact_duplicates = 0
    conflicting_duplicates = []
    identity_mismatches = []

    for left, right in date_windows(min_date, max_date, int(cfg['windowDays'])):
        query = urllib.parse.urlencode({
            'sportId': int(cfg['sportId']),
            'startDate': left.isoformat(),
            'endDate': right.isoformat(),
            'hydrate': 'linescore,team',
        })
        payload = http_json(f"{cfg['baseUrl']}?{query}")
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
                f5 = innings_to_f5((raw.get('linescore') or {}).get('innings'))
                if game_pk in found:
                    if f5 is not None:
                        existing = {key: found[game_pk][key] for key in ('homeRuns', 'awayRuns', 'totalRuns')}
                        if f5 == existing:
                            exact_duplicates += 1
                        else:
                            conflicting_duplicates.append({'gamePk': game_pk, 'existing': existing, 'duplicate': f5})
                    continue
                if f5 is not None:
                    found[game_pk] = {
                        'gamePk': game_pk,
                        'officialDate': expected_row['officialDate'],
                        'season': expected_row['season'],
                        'homeTeamId': expected_row['homeTeamId'],
                        'awayTeamId': expected_row['awayTeamId'],
                        **f5,
                        'source': 'SCHEDULE_HYDRATE_LINESCORE',
                    }

    if conflicting_duplicates:
        raise SystemExit(f'V28_API_CONFLICTING_DUPLICATE_GAME_PK:{conflicting_duplicates[:5]}')
    if identity_mismatches:
        raise SystemExit(f'V28_TEAM_IDENTITY_MISMATCH:{identity_mismatches[:5]}')

    missing = [game_pk for game_pk in expected if game_pk not in found]
    fallback_limit = int(cfg['maximumPerGameLinescoreFallbacks'])
    if len(missing) > fallback_limit:
        raise SystemExit(f'V28_LINESCORE_HYDRATE_COVERAGE_TOO_LOW:missing={len(missing)}:limit={fallback_limit}')

    fallback_requests = 0
    fallback_base = cfg['perGameLinescoreBaseUrl'].rstrip('/')
    for game_pk in missing:
        payload = http_json(f'{fallback_base}/{game_pk}/linescore')
        fallback_requests += 1
        f5 = innings_to_f5(payload.get('innings') if isinstance(payload, dict) else None)
        if f5 is None:
            continue
        expected_row = expected[game_pk]
        found[game_pk] = {
            'gamePk': game_pk,
            'officialDate': expected_row['officialDate'],
            'season': expected_row['season'],
            'homeTeamId': expected_row['homeTeamId'],
            'awayTeamId': expected_row['awayTeamId'],
            **f5,
            'source': 'PER_GAME_OFFICIAL_LINESCORE_FALLBACK',
        }

    coverage = len(found) / len(expected) if expected else 0.0
    if coverage < float(cfg['minimumOutcomeCoverageShare']):
        unresolved = sorted(game_pk for game_pk in expected if game_pk not in found)
        raise SystemExit(f'V28_F5_OUTCOME_COVERAGE_BELOW_FLOOR:{coverage:.8f}:{unresolved[:20]}')

    return found, {
        'canonicalGames': len(expected),
        'outcomeCompleteGames': len(found),
        'coverageShare': coverage,
        'scheduleWindowRequests': schedule_requests,
        'exactDuplicateApiObservationsDeduplicated': exact_duplicates,
        'conflictingDuplicateApiObservations': 0,
        'perGameLinescoreFallbackRequests': fallback_requests,
        'unresolvedGamePks': sorted(game_pk for game_pk in expected if game_pk not in found),
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit('V28_NB2_DENOMINATOR_INVALID')
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def evaluate(frame, features, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    mu = np.maximum(model.predict(X), 1e-9)
    y = frame['f5TotalRuns'].to_numpy(dtype=float)
    baseline_mu = np.full(len(frame), float(train_mean), dtype=float)
    line_rows = {}
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
        line_rows[str(line)] = {
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
        'trainingConstantMeanRuns': float(train_mean),
        'absoluteMeanCalibrationBias': abs(float(np.mean(mu)) - float(np.mean(y))),
        'constantBaselineAbsoluteMeanCalibrationBias': abs(float(train_mean) - float(np.mean(y))),
        'meanAbsoluteError': float(mean_absolute_error(y, mu)),
        'constantBaselineMeanAbsoluteError': float(mean_absolute_error(y, baseline_mu)),
        'meanPoissonDeviance': model_deviance,
        'constantBaselineMeanPoissonDeviance': baseline_deviance,
        'poissonDevianceImprovement': baseline_deviance - model_deviance,
        'fixedLineDiagnostics': line_rows,
        'averageBrierAcrossFixedLines': float(np.mean(model_briers)),
        'averageBaselineBrierAcrossFixedLines': float(np.mean(baseline_briers)),
        'averageBrierImprovement': float(np.mean(baseline_briers) - np.mean(model_briers)),
    }


def volume_diagnostics(frame):
    counts = Counter(frame['officialDate'])
    game_counts = list(counts.values())
    return {
        'eligibleSlateDays': len(counts),
        'outcomeCompleteGames': int(len(frame)),
        'meanGamesPerEligibleSlateDay': float(np.mean(game_counts)) if game_counts else 0.0,
        'medianGamesPerEligibleSlateDay': float(np.median(game_counts)) if game_counts else 0.0,
        'potentialF5TotalMarketPairsBeforePriceFiltering': int(len(frame)),
        'meanPotentialF5TotalMarketPairsPerEligibleSlateDay': float(np.mean(game_counts)) if game_counts else 0.0,
        'note': 'Each game contributes one F5 Total over/under market pair before price/EV filtering; these are not bet candidates.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--outcomes-out', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v28-f5-total-baseline-contract.v1':
        raise SystemExit('V28_CONTRACT_SCHEMA_INVALID')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    canonical, season_counts = canonical_rows(args.root, seasons, bool(contract['dataBoundary']['requiresT5PregameValid']))
    outcomes, acquisition = collect_f5_outcomes(contract, canonical)
    dump(args.outcomes_out, {
        'schemaVersion': OUTCOME_SCHEMA,
        'source': contract['outcomeAcquisition']['source'],
        'acquisition': acquisition,
        'policy': {
            'labelsOnly': True,
            'sameDateOutcomeUsedAsFeature': False,
            'futureGameDataUsedAsFeature': False,
            'playByPlayFallbackUsed': False,
            'currentMetadataFallbackUsed': False,
        },
        'rows': [outcomes[key] for key in sorted(outcomes)],
    })

    feature_names = tuple(contract['features']['exactly'])
    records = []
    for row in canonical:
        outcome = outcomes.get(row['gamePk'])
        if outcome is None:
            continue
        record = {
            'season': row['season'],
            'officialDate': row['officialDate'],
            'gamePk': row['gamePk'],
            'f5TotalRuns': int(outcome['totalRuns']),
        }
        for feature in feature_names:
            value = row['features'].get(feature)
            record[feature] = float(value) if finite(value) else np.nan
        records.append(record)
    frame = pd.DataFrame.from_records(records)

    train_season = contract['dataBoundary']['modelFitSeason']
    validation_season = contract['dataBoundary']['validationSeason']
    evaluation_seasons = contract['dataBoundary']['retrospectiveEvaluationSeasons']
    train = frame[frame['season'] == train_season].copy()
    validation = frame[frame['season'] == validation_season].copy()
    evaluation = frame[frame['season'].isin(evaluation_seasons)].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit('V28_EMPTY_PARTITION')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['f5TotalRuns'].to_numpy(dtype=float)
    cfg = contract['model']
    model = PoissonRegressor(alpha=float(cfg['poissonAlpha']), max_iter=int(cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in cfg['fixedHalfRunLines']]
    train_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = evaluate(validation, feature_names, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines)
    evaluation_metrics = evaluate(evaluation, feature_names, imputer, scaler, model, dispersion, train_mean, train_line_probs, lines)
    by_season = {}
    for season in [validation_season, *evaluation_seasons]:
        by_season[season] = evaluate(
            frame[frame['season'] == season].copy(), feature_names, imputer, scaler, model,
            dispersion, train_mean, train_line_probs, lines,
        )

    checks = {
        'validationPoissonDevianceBeatsBaseline': validation_metrics['poissonDevianceImprovement'] > 0.0,
        'validationAverageBrierBeatsBaseline': validation_metrics['averageBrierImprovement'] > 0.0,
        'evaluationPoissonDevianceBeatsBaseline': evaluation_metrics['poissonDevianceImprovement'] > 0.0,
        'evaluationAverageBrierBeatsBaseline': evaluation_metrics['averageBrierImprovement'] > 0.0,
    }
    passed = all(checks.values())
    classification = 'F5_TOTAL_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'F5_TOTAL_FULL13_BASELINE_REJECTED'

    model_snapshot = {
        'intercept': float(model.intercept_),
        'coefficientsByFeature': {feature_names[i]: float(model.coef_[i]) for i in range(len(feature_names))},
        'imputerMedianByFeature': {feature_names[i]: float(imputer.statistics_[i]) for i in range(len(feature_names))},
        'scalerMeanByFeature': {feature_names[i]: float(scaler.mean_[i]) for i in range(len(feature_names))},
        'scalerScaleByFeature': {feature_names[i]: float(scaler.scale_[i]) for i in range(len(feature_names))},
        'nb2Dispersion': float(dispersion),
        'trainingMeanRuns': train_mean,
        'trainingFixedLineOverProbabilities': {str(line): train_line_probs[line] for line in lines},
    }

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'candidateRubricPassed': passed,
        'data': {
            'canonicalSeasonRows': season_counts,
            'outcomeAcquisition': acquisition,
            'scoredRows': int(len(frame)),
            'featureCount': len(feature_names),
            'features': list(feature_names),
        },
        'model': {
            'providerMarketKey': cfg['providerMarketKey'],
            'canonicalMarketType': cfg['canonicalMarketType'],
            'trainingSeason': train_season,
            'trainingRows': int(len(train)),
            'poissonAlpha': float(cfg['poissonAlpha']),
            'maxIter': int(cfg['maxIter']),
            'fixedHalfRunLines': lines,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'snapshot': model_snapshot,
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': volume_diagnostics(frame),
        'marketBoundary': {
            'providerMarketKey': 'totals_1st_5_innings',
            'canonicalMarketType': 'F5_TOTAL',
            'historicalF5PricesUsed': False,
            'positiveEvEstablished': False,
            'shadowPriceCaptureAuthorized': False,
            'productionPromotionAuthorized': False,
        },
        'policy': {
            'sameDateOutcomeLeakageAllowed': False,
            'futureGameDataAllowed': False,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'thresholdSearchUsed': False,
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
        'candidateRubricPassed': passed,
        'acquisition': acquisition,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeason': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': report['volumeDiagnostics'],
    }, indent=2))


if __name__ == '__main__':
    main()
