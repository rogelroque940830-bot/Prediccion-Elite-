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
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v26-nrfi-yrfi-baseline.v1'
OUTCOME_SCHEMA = 'courtedge-p0-step12v26-first-inning-outcomes.v1'
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
            request = urllib.request.Request(url, headers={'User-Agent': 'CourtEdge-P0-V26-NRFI-YRFI-Research/1.0'})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f'HTTP_{response.status}')
                return json.loads(response.read().decode('utf-8'))
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(0.75 * (2 ** attempt))
    raise RuntimeError(f'V26_HTTP_FAILED:{url}:{last}')


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


def inning1_outcome(innings):
    if not isinstance(innings, list):
        return None
    candidates = []
    for inning in innings:
        try:
            number = int(inning.get('num'))
        except Exception:
            continue
        if number != 1:
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
        candidates.append((home_runs, away_runs))
    if len(candidates) != 1:
        return None
    home_runs, away_runs = candidates[0]
    total = home_runs + away_runs
    return {
        'homeRuns': home_runs,
        'awayRuns': away_runs,
        'firstInningRuns': total,
        'yrfi': int(total >= 1),
        'nrfi': int(total == 0),
    }


def canonical_rows(root, seasons, require_t5):
    rows = []
    season_counts = {}
    for season in seasons:
        payload = load(os.path.join(root, season, 'game-anatomy-feature-table.json'))
        if payload.get('schemaVersion') != BASE_SCHEMA:
            raise SystemExit(f'V26_BASE_SCHEMA_INVALID:{season}')
        count = 0
        for raw in payload.get('rows', []):
            if require_t5 and not raw.get('t5PregameValid'):
                continue
            game_pk = int(raw['gamePk'])
            rows.append({
                'season': season,
                'officialDate': raw['officialDate'],
                'gamePk': game_pk,
                'homeTeamId': int(raw['homeTeamId']),
                'awayTeamId': int(raw['awayTeamId']),
                'features': raw.get('features') or {},
            })
            count += 1
        season_counts[season] = count
    if len({row['gamePk'] for row in rows}) != len(rows):
        raise SystemExit('V26_CANONICAL_DUPLICATE_GAME_PK')
    return rows, season_counts


def collect_first_inning_outcomes(contract, canonical):
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
                outcome = inning1_outcome((raw.get('linescore') or {}).get('innings'))
                if game_pk in found:
                    exact_duplicates += 1
                    if outcome is not None:
                        existing = {key: found[game_pk][key] for key in ('homeRuns','awayRuns','firstInningRuns','yrfi','nrfi')}
                        if outcome != existing:
                            conflicting_duplicates.append({'gamePk': game_pk, 'existing': existing, 'duplicate': outcome})
                    continue
                if outcome is not None:
                    found[game_pk] = {
                        'gamePk': game_pk,
                        'officialDate': expected_row['officialDate'],
                        'season': expected_row['season'],
                        'homeTeamId': expected_row['homeTeamId'],
                        'awayTeamId': expected_row['awayTeamId'],
                        **outcome,
                        'source': 'SCHEDULE_HYDRATE_LINESCORE',
                    }

    if conflicting_duplicates:
        raise SystemExit(f'V26_API_CONFLICTING_DUPLICATE_GAME_PK:{conflicting_duplicates[:5]}')
    if identity_mismatches:
        raise SystemExit(f'V26_TEAM_IDENTITY_MISMATCH:{identity_mismatches[:5]}')

    missing = [game_pk for game_pk in expected if game_pk not in found]
    fallback_limit = int(cfg['maximumPerGameLinescoreFallbacks'])
    if len(missing) > fallback_limit:
        raise SystemExit(f'V26_LINESCORE_HYDRATE_COVERAGE_TOO_LOW:missing={len(missing)}:limit={fallback_limit}')

    fallback_requests = 0
    fallback_base = cfg['perGameLinescoreBaseUrl'].rstrip('/')
    for game_pk in missing:
        payload = http_json(f'{fallback_base}/{game_pk}/linescore')
        fallback_requests += 1
        outcome = inning1_outcome(payload.get('innings') if isinstance(payload, dict) else None)
        if outcome is None:
            continue
        expected_row = expected[game_pk]
        found[game_pk] = {
            'gamePk': game_pk,
            'officialDate': expected_row['officialDate'],
            'season': expected_row['season'],
            'homeTeamId': expected_row['homeTeamId'],
            'awayTeamId': expected_row['awayTeamId'],
            **outcome,
            'source': 'PER_GAME_OFFICIAL_LINESCORE_FALLBACK',
        }

    coverage = len(found) / len(expected) if expected else 0.0
    if coverage < float(cfg['minimumOutcomeCoverageShare']):
        unresolved = sorted(game_pk for game_pk in expected if game_pk not in found)
        raise SystemExit(f'V26_OUTCOME_COVERAGE_BELOW_FLOOR:{coverage:.8f}:{unresolved[:20]}')

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


def evaluate(frame, feature_names, imputer, scaler, model, baseline_prob):
    X = scaler.transform(imputer.transform(frame[list(feature_names)]))
    y = frame['yrfi'].to_numpy(dtype=int)
    probs = model.predict_proba(X)[:, 1]
    baseline = np.full(len(frame), float(baseline_prob), dtype=float)
    model_log = float(log_loss(y, probs, labels=[0, 1]))
    baseline_log = float(log_loss(y, baseline, labels=[0, 1]))
    model_brier = float(brier_score_loss(y, probs))
    baseline_brier = float(brier_score_loss(y, baseline))
    observed = float(np.mean(y))
    mean_pred = float(np.mean(probs))
    auc = float(roc_auc_score(y, probs)) if len(np.unique(y)) == 2 else None
    return {
        'rows': int(len(frame)),
        'observedYrfiRate': observed,
        'observedNrfiRate': 1.0 - observed,
        'meanPredictedYrfiProbability': mean_pred,
        'trainingClimatologyYrfiProbability': float(baseline_prob),
        'binaryLogLoss': model_log,
        'baselineBinaryLogLoss': baseline_log,
        'logLossImprovement': baseline_log - model_log,
        'brierScore': model_brier,
        'baselineBrierScore': baseline_brier,
        'brierImprovement': baseline_brier - model_brier,
        'rocAuc': auc,
        'absoluteMeanCalibrationBias': abs(mean_pred - observed),
        'baselineAbsoluteMeanCalibrationBias': abs(float(baseline_prob) - observed),
    }


def volume_diagnostics(frame):
    counts = Counter(frame['officialDate'])
    game_counts = list(counts.values())
    return {
        'eligibleSlateDays': len(counts),
        'outcomeCompleteGames': int(len(frame)),
        'meanGamesPerEligibleSlateDay': float(np.mean(game_counts)) if game_counts else 0.0,
        'medianGamesPerEligibleSlateDay': float(np.median(game_counts)) if game_counts else 0.0,
        'potentialNrfiYrfiMarketPairsBeforePriceFiltering': int(len(frame)),
        'meanPotentialMarketPairsPerEligibleSlateDay': float(np.mean(game_counts)) if game_counts else 0.0,
        'twoSidesPerMarketPair': ['NRFI', 'YRFI'],
        'note': 'NRFI and YRFI are complementary sides of one first-inning 0.5 total market and are not counted as independent markets or bet candidates.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--outcomes-out', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v26-nrfi-yrfi-baseline-contract.v1':
        raise SystemExit('V26_CONTRACT_SCHEMA_INVALID')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    canonical, season_counts = canonical_rows(args.root, seasons, bool(contract['dataBoundary']['requiresT5PregameValid']))
    outcomes, acquisition = collect_first_inning_outcomes(contract, canonical)

    outcome_payload = {
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
    }
    dump(args.outcomes_out, outcome_payload)

    records = []
    feature_names = tuple(contract['features']['exactly'])
    for row in canonical:
        outcome = outcomes.get(row['gamePk'])
        if outcome is None:
            continue
        record = {
            'season': row['season'],
            'officialDate': row['officialDate'],
            'gamePk': row['gamePk'],
            'yrfi': outcome['yrfi'],
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
        raise SystemExit('V26_EMPTY_PARTITION')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['yrfi'].to_numpy(dtype=int)
    cfg = contract['model']
    model = LogisticRegression(
        C=float(cfg['regularizationC']),
        solver=str(cfg['solver']),
        max_iter=int(cfg['maxIter']),
        random_state=int(cfg['randomState']),
        class_weight=None,
    )
    model.fit(X_train, y_train)
    if tuple(int(v) for v in model.classes_) != (0, 1):
        raise SystemExit(f'V26_CLASS_ORDER_INVALID:{model.classes_}')
    baseline_prob = float(np.mean(y_train))

    validation_metrics = evaluate(validation, feature_names, imputer, scaler, model, baseline_prob)
    evaluation_metrics = evaluate(evaluation, feature_names, imputer, scaler, model, baseline_prob)
    by_season = {}
    for season in [validation_season, *evaluation_seasons]:
        part = frame[frame['season'] == season].copy()
        by_season[season] = evaluate(part, feature_names, imputer, scaler, model, baseline_prob)

    checks = {
        'validationLogLossBeatsBaseline': validation_metrics['logLossImprovement'] > 0.0,
        'evaluationLogLossBeatsBaseline': evaluation_metrics['logLossImprovement'] > 0.0,
        'validationBrierBeatsBaseline': validation_metrics['brierImprovement'] > 0.0,
        'evaluationBrierBeatsBaseline': evaluation_metrics['brierImprovement'] > 0.0,
        'validationRocAucAboveHalf': validation_metrics['rocAuc'] is not None and validation_metrics['rocAuc'] > 0.5,
        'evaluationRocAucAboveHalf': evaluation_metrics['rocAuc'] is not None and evaluation_metrics['rocAuc'] > 0.5,
    }
    passed = all(checks.values())
    classification = 'NRFI_YRFI_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'NRFI_YRFI_FULL13_BASELINE_REJECTED'

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
            'canonicalMarketTypes': cfg['canonicalMarketTypes'],
            'target': cfg['target'],
            'trainingSeason': train_season,
            'trainingRows': int(len(train)),
            'trainingYrfiRate': baseline_prob,
            'regularizationC': float(cfg['regularizationC']),
            'solver': str(cfg['solver']),
            'maxIter': int(cfg['maxIter']),
            'firstInningSpecificFeaturesAdded': False,
            'featureSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'probabilityThresholdSearchUsed': False,
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': volume_diagnostics(frame),
        'marketBoundary': {
            'providerMarketKey': 'totals_1st_1_innings',
            'requiredExactLine': 0.5,
            'underMapsTo': 'NRFI',
            'overMapsTo': 'YRFI',
            'historicalNrfiYrfiPricesUsed': False,
            'positiveEvEstablished': False,
            'productionPromotionAuthorized': False,
        },
        'policy': {
            'sameDateOutcomeLeakageAllowed': False,
            'futureGameDataAllowed': False,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'probabilityThresholdSearchUsed': False,
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
        'candidateRubricChecks': checks,
        'volumeDiagnostics': report['volumeDiagnostics'],
    }, indent=2))


if __name__ == '__main__':
    main()
