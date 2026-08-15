#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v35-pitcher-earned-runs-baseline.v1'
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


def positive_int(value):
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except Exception:
        return None


def audit_valid(audit):
    return bool(audit and audit.get('identityOk') and audit.get('sourceHistorical') and audit.get('pregame'))


def probable_ids(audit):
    if not audit_valid(audit) or not audit.get('probableBothKnown'):
        return None, None
    home = positive_int(audit.get('homeProbablePitcherId'))
    away = positive_int(audit.get('awayProbablePitcherId'))
    return (home, away) if home is not None and away is not None else (None, None)


def complete_lineup(lineup, audit):
    if not audit_valid(audit) or not lineup or not lineup.get('complete'):
        return None, None
    try:
        home = [int(v) for v in lineup.get('homeBattingOrder', [])]
        away = [int(v) for v in lineup.get('awayBattingOrder', [])]
    except Exception:
        return None, None
    if len(home) != 9 or len(away) != 9 or len(set(home)) != 9 or len(set(away)) != 9 or min(home + away) <= 0:
        return None, None
    return home, away


def continuity(current, prior):
    if current is None or prior is None:
        return None
    return len(set(current).intersection(prior)) / 9.0


def parse_starter_line(raw):
    if not raw:
        return None
    pitcher_id = positive_int(raw.get('pitcherId'))
    if pitcher_id is None:
        return None
    mapping = {'bf': 'battersFaced', 'k': 'strikeOuts', 'bb': 'baseOnBalls', 'er': 'earnedRuns', 'hr': 'homeRuns'}
    values = {}
    for key, source in mapping.items():
        value = raw.get(source, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f'V35_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}')
        values[key] = float(value)
    return {'pitcherId': pitcher_id, **values}


def empty_pitcher_state():
    return {'starts': 0, 'bf': 0.0, 'k': 0.0, 'bb': 0.0, 'er': 0.0, 'hr': 0.0, 'recent': []}


def empty_opponent_state():
    return {'games': 0, 'bf': 0.0, 'er': 0.0}


def add_pitcher_line(state, line, recent_window):
    state['starts'] += 1
    for key in ('bf', 'k', 'bb', 'er', 'hr'):
        state[key] += line[key]
    state['recent'].append({'bf': line['bf'], 'er': line['er']})
    if len(state['recent']) > recent_window:
        state['recent'] = state['recent'][-recent_window:]


def league_priors(state):
    if state['bf'] <= 0 or state['starts'] <= 0:
        return None
    bf = state['bf']
    return {
        'kbf': state['k'] / bf,
        'bbbf': state['bb'] / bf,
        'erbf': state['er'] / bf,
        'hrbf': state['hr'] / bf,
        'bfPerStart': bf / state['starts'],
    }


def shrunk_rate(numerator, denominator, league_rate, prior_bf):
    return (float(numerator) + prior_bf * float(league_rate)) / (float(denominator) + prior_bf)


def shrunk_mean(total, trials, league_mean, prior_trials):
    return (float(total) + prior_trials * float(league_mean)) / (float(trials) + prior_trials)


def pitcher_features(state, priors, rate_prior_bf, workload_prior_starts):
    recent = state['recent']
    if priors is None:
        return {
            'pitcher_erbf_shrunk': None,
            'pitcher_hrbf_shrunk': None,
            'pitcher_bbbf_shrunk': None,
            'pitcher_kbf_shrunk': None,
            'pitcher_bf_per_start_shrunk': None,
            'pitcher_recent5_er_per_start': None,
            'pitcher_recent5_bf_per_start': None,
            'pitcher_prior_bf': float(state['bf']),
        }
    return {
        'pitcher_erbf_shrunk': shrunk_rate(state['er'], state['bf'], priors['erbf'], rate_prior_bf),
        'pitcher_hrbf_shrunk': shrunk_rate(state['hr'], state['bf'], priors['hrbf'], rate_prior_bf),
        'pitcher_bbbf_shrunk': shrunk_rate(state['bb'], state['bf'], priors['bbbf'], rate_prior_bf),
        'pitcher_kbf_shrunk': shrunk_rate(state['k'], state['bf'], priors['kbf'], rate_prior_bf),
        'pitcher_bf_per_start_shrunk': shrunk_mean(state['bf'], state['starts'], priors['bfPerStart'], workload_prior_starts),
        'pitcher_recent5_er_per_start': float(np.mean([row['er'] for row in recent])) if recent else None,
        'pitcher_recent5_bf_per_start': float(np.mean([row['bf'] for row in recent])) if recent else None,
        'pitcher_prior_bf': float(state['bf']),
    }


def opponent_features(state, priors, rate_prior_bf, workload_prior_games):
    if priors is None:
        return {
            'opponent_vs_starters_erbf_scored_shrunk': None,
            'opponent_vs_starters_bf_per_game_shrunk': None,
        }
    return {
        'opponent_vs_starters_erbf_scored_shrunk': shrunk_rate(state['er'], state['bf'], priors['erbf'], rate_prior_bf),
        'opponent_vs_starters_bf_per_game_shrunk': shrunk_mean(state['bf'], state['games'], priors['bfPerStart'], workload_prior_games),
    }


def opponent_rs10(full13, target_side):
    combined = full13.get('combined_team_rs10')
    diff = full13.get('team_rs10_diff')
    if not finite(combined) or not finite(diff):
        return None
    home = (float(combined) + float(diff)) / 2.0
    away = (float(combined) - float(diff)) / 2.0
    return away if target_side == 'home' else home


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit('V35_NB2_DENOMINATOR_INVALID')
    return max(0.0, numerator / denominator)


def over_probability(mu, dispersion, line):
    cutoff = math.floor(float(line))
    mu = max(float(mu), 1e-9)
    if dispersion <= 1e-12:
        return float(1.0 - poisson.cdf(cutoff, mu))
    r = 1.0 / dispersion
    p = r / (r + mu)
    return float(1.0 - nbinom.cdf(cutoff, r, p))


def evaluate(frame, features, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines):
    X = scaler.transform(imputer.transform(frame[list(features)]))
    model_mu = np.maximum(model.predict(X), 1e-9)
    y = frame['earnedRuns'].to_numpy(dtype=float)
    constant_mu = np.full(len(frame), train_mean, dtype=float)
    pitcher_mu = frame['pitcherOnlyMuRaw'].to_numpy(dtype=float)
    pitcher_mu = np.where(np.isfinite(pitcher_mu) & (pitcher_mu > 0), pitcher_mu, train_mean)

    model_dev = float(mean_poisson_deviance(y, model_mu))
    constant_dev = float(mean_poisson_deviance(y, constant_mu))
    pitcher_dev = float(mean_poisson_deviance(y, pitcher_mu))

    model_briers, constant_briers, pitcher_briers = [], [], []
    diagnostics = {}
    for line in lines:
        observed = (y > line).astype(float)
        model_probs = np.asarray([over_probability(mu, dispersion, line) for mu in model_mu], dtype=float)
        pitcher_probs = np.asarray([over_probability(mu, dispersion, line) for mu in pitcher_mu], dtype=float)
        constant_prob = float(constant_line_probs[line])
        constant_probs = np.full(len(frame), constant_prob, dtype=float)
        model_brier = float(np.mean((model_probs - observed) ** 2))
        constant_brier = float(np.mean((constant_probs - observed) ** 2))
        pitcher_brier = float(np.mean((pitcher_probs - observed) ** 2))
        model_briers.append(model_brier)
        constant_briers.append(constant_brier)
        pitcher_briers.append(pitcher_brier)
        diagnostics[str(line)] = {
            'observedOverRate': float(np.mean(observed)),
            'meanModelOverProbability': float(np.mean(model_probs)),
            'meanPitcherOnlyOverProbability': float(np.mean(pitcher_probs)),
            'trainingClimatologyOverProbability': constant_prob,
            'modelBrier': model_brier,
            'constantBaselineBrier': constant_brier,
            'pitcherOnlyBaselineBrier': pitcher_brier,
            'modelVsConstantBrierImprovement': constant_brier - model_brier,
            'modelVsPitcherOnlyBrierImprovement': pitcher_brier - model_brier,
        }

    return {
        'rows': int(len(frame)),
        'observedMeanEarnedRuns': float(np.mean(y)),
        'meanModelEarnedRuns': float(np.mean(model_mu)),
        'meanPitcherOnlyEarnedRuns': float(np.mean(pitcher_mu)),
        'trainingConstantMeanEarnedRuns': float(train_mean),
        'modelAbsoluteMeanCalibrationBias': abs(float(np.mean(model_mu)) - float(np.mean(y))),
        'constantAbsoluteMeanCalibrationBias': abs(float(train_mean) - float(np.mean(y))),
        'pitcherOnlyAbsoluteMeanCalibrationBias': abs(float(np.mean(pitcher_mu)) - float(np.mean(y))),
        'modelMeanAbsoluteError': float(mean_absolute_error(y, model_mu)),
        'constantMeanAbsoluteError': float(mean_absolute_error(y, constant_mu)),
        'pitcherOnlyMeanAbsoluteError': float(mean_absolute_error(y, pitcher_mu)),
        'modelPoissonDeviance': model_dev,
        'constantPoissonDeviance': constant_dev,
        'pitcherOnlyPoissonDeviance': pitcher_dev,
        'modelVsConstantDevianceImprovement': constant_dev - model_dev,
        'modelVsPitcherOnlyDevianceImprovement': pitcher_dev - model_dev,
        'fixedLineDiagnostics': diagnostics,
        'modelAverageBrier': float(np.mean(model_briers)),
        'constantAverageBrier': float(np.mean(constant_briers)),
        'pitcherOnlyAverageBrier': float(np.mean(pitcher_briers)),
        'modelVsConstantAverageBrierImprovement': float(np.mean(constant_briers) - np.mean(model_briers)),
        'modelVsPitcherOnlyAverageBrierImprovement': float(np.mean(pitcher_briers) - np.mean(model_briers)),
    }


def build_season_rows(root, season, contract):
    base = os.path.join(root, season)
    canonical = load(os.path.join(base, 'game-anatomy-feature-table.json'))
    starters_json = load(os.path.join(base, 'cohort', 'starting-pitcher-history.json'))
    lineups_json = load(os.path.join(base, 'cohort', 'pregame-lineup-history.json'))
    audit_json = load(os.path.join(base, 't5-audit', 't5-starter-identity-audit.json'))
    if canonical.get('schemaVersion') != BASE_SCHEMA:
        raise SystemExit(f'V35_BASE_SCHEMA_INVALID:{season}')

    starter_map = {int(row['gamePk']): row for row in starters_json.get('games', [])}
    lineup_map = {int(row['gamePk']): row for row in lineups_json.get('snapshots', [])}
    audit_map = {int(row['gamePk']): row for row in audit_json.get('rows', [])}
    canonical_rows = [row for row in canonical.get('rows', []) if row.get('t5PregameValid')]
    by_date = defaultdict(list)
    for row in canonical_rows:
        by_date[str(row['officialDate'])].append(row)

    pitcher_state = defaultdict(empty_pitcher_state)
    opponent_state = defaultdict(empty_opponent_state)
    league_state = empty_pitcher_state()
    prior_lineup = {}
    cfg = contract['featureEngineering']
    rows = []
    eligible_slots = 0
    probable_slots = 0
    complete_lineup_pairs = 0

    for official_date in sorted(by_date):
        games = sorted(by_date[official_date], key=lambda row: int(row['gamePk']))
        priors = league_priors(league_state)

        for raw in games:
            game_pk = int(raw['gamePk'])
            home_team = int(raw['homeTeamId'])
            away_team = int(raw['awayTeamId'])
            audit = audit_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            if home_probable is not None and away_probable is not None:
                probable_slots += 2
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None and current_away is not None:
                complete_lineup_pairs += 1
            starter_game = starter_map.get(game_pk)
            if not starter_game:
                continue
            actual_home = parse_starter_line(starter_game.get('homeStarter'))
            actual_away = parse_starter_line(starter_game.get('awayStarter'))
            full13 = raw.get('features') or {}

            for side, probable_id, actual, opponent_team, opponent_lineup in [
                ('home', home_probable, actual_home, away_team, current_away),
                ('away', away_probable, actual_away, home_team, current_home),
            ]:
                if probable_id is None or actual is None or actual['bf'] <= 0 or probable_id != actual['pitcherId']:
                    continue
                eligible_slots += 1
                features = pitcher_features(
                    pitcher_state[probable_id],
                    priors,
                    float(cfg['rateShrinkagePriorBattersFaced']),
                    float(cfg['workloadShrinkagePriorStarts']),
                )
                features.update(opponent_features(
                    opponent_state[opponent_team],
                    priors,
                    float(cfg['opponentRateShrinkagePriorBattersFaced']),
                    float(cfg['opponentWorkloadShrinkagePriorGames']),
                ))
                features['opponent_rs10'] = opponent_rs10(full13, side)
                features['opponent_lineup_continuity'] = continuity(opponent_lineup, prior_lineup.get(opponent_team))
                raw_mu = None
                if finite(features['pitcher_erbf_shrunk']) and finite(features['pitcher_bf_per_start_shrunk']):
                    raw_mu = float(features['pitcher_erbf_shrunk']) * float(features['pitcher_bf_per_start_shrunk'])
                rows.append({
                    'season': season,
                    'officialDate': official_date,
                    'gamePk': game_pk,
                    'side': side,
                    'pitcherId': probable_id,
                    'opponentTeamId': opponent_team,
                    'earnedRuns': int(actual['er']),
                    'actualBattersFaced': float(actual['bf']),
                    'pitcherOnlyMuRaw': raw_mu,
                    **features,
                })

        # Strict same-date batch update.
        for raw in games:
            game_pk = int(raw['gamePk'])
            home_team = int(raw['homeTeamId'])
            away_team = int(raw['awayTeamId'])
            starter_game = starter_map.get(game_pk)
            if starter_game:
                home_line = parse_starter_line(starter_game.get('homeStarter'))
                away_line = parse_starter_line(starter_game.get('awayStarter'))
                if home_line is not None and home_line['bf'] > 0:
                    add_pitcher_line(pitcher_state[home_line['pitcherId']], home_line, int(cfg['recentStartsWindow']))
                    add_pitcher_line(league_state, home_line, int(cfg['recentStartsWindow']))
                    opponent_state[away_team]['games'] += 1
                    opponent_state[away_team]['bf'] += home_line['bf']
                    opponent_state[away_team]['er'] += home_line['er']
                if away_line is not None and away_line['bf'] > 0:
                    add_pitcher_line(pitcher_state[away_line['pitcherId']], away_line, int(cfg['recentStartsWindow']))
                    add_pitcher_line(league_state, away_line, int(cfg['recentStartsWindow']))
                    opponent_state[home_team]['games'] += 1
                    opponent_state[home_team]['bf'] += away_line['bf']
                    opponent_state[home_team]['er'] += away_line['er']

            audit = audit_map.get(game_pk)
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None:
                prior_lineup[home_team] = current_home
            if current_away is not None:
                prior_lineup[away_team] = current_away

    slots = 2 * len(canonical_rows)
    return rows, {
        'canonicalT5Games': len(canonical_rows),
        'canonicalStarterSlots': slots,
        'auditValidProbableStarterSlots': probable_slots,
        'exactProbableRecordedStarterEligibleSlots': eligible_slots,
        'eligibilityShareOfCanonicalStarterSlots': eligible_slots / slots if slots else 0.0,
        'completeAuditValidLineupPairs': complete_lineup_pairs,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v35-pitcher-earned-runs-baseline-contract.v1':
        raise SystemExit('V35_CONTRACT_SCHEMA_INVALID')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records, custody = [], {}
    for season in seasons:
        season_rows, season_custody = build_season_rows(args.root, season, contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    feature_names = tuple(contract['features']['exactly'])
    train = frame[frame['season'] == '2022'].copy()
    validation = frame[frame['season'] == '2023'].copy()
    evaluation = frame[frame['season'].isin(['2024', '2025', '2026_YTD'])].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit('V35_EMPTY_PARTITION')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['earnedRuns'].to_numpy(dtype=float)
    cfg = contract['model']
    model = PoissonRegressor(alpha=float(cfg['poissonAlpha']), max_iter=int(cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in cfg['fixedHalfRunLines']]
    line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = evaluate(validation, feature_names, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    evaluation_metrics = evaluate(evaluation, feature_names, imputer, scaler, model, dispersion, train_mean, line_probs, lines)
    by_season = {
        season: evaluate(
            frame[frame['season'] == season].copy(), feature_names, imputer, scaler, model,
            dispersion, train_mean, line_probs, lines,
        )
        for season in ['2023', '2024', '2025', '2026_YTD']
    }

    checks = {
        'validationDevianceBeatsConstant': validation_metrics['modelVsConstantDevianceImprovement'] > 0,
        'validationDevianceBeatsPitcherOnly': validation_metrics['modelVsPitcherOnlyDevianceImprovement'] > 0,
        'validationBrierBeatsConstant': validation_metrics['modelVsConstantAverageBrierImprovement'] > 0,
        'validationBrierBeatsPitcherOnly': validation_metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0,
        'evaluationDevianceBeatsConstant': evaluation_metrics['modelVsConstantDevianceImprovement'] > 0,
        'evaluationDevianceBeatsPitcherOnly': evaluation_metrics['modelVsPitcherOnlyDevianceImprovement'] > 0,
        'evaluationBrierBeatsConstant': evaluation_metrics['modelVsConstantAverageBrierImprovement'] > 0,
        'evaluationBrierBeatsPitcherOnly': evaluation_metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0,
    }
    passed = all(checks.values())
    classification = 'PITCHER_EARNED_RUNS_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'PITCHER_EARNED_RUNS_BASELINE_REJECTED'

    total_slots = sum(row['canonicalStarterSlots'] for row in custody.values())
    counts = Counter(frame['officialDate'])
    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'candidateRubricPassed': passed,
        'data': {
            'scoredRows': int(len(frame)),
            'custodyBySeason': custody,
            'featureCount': len(feature_names),
            'features': list(feature_names),
            'sameDateHistoryAllowed': False,
            'seasonHistoryReset': True,
        },
        'model': {
            'providerMarketKey': 'pitcher_earned_runs',
            'canonicalResearchMarketType': 'PITCHER_EARNED_RUNS',
            'trainingSeason': '2022',
            'trainingRows': int(len(train)),
            'trainingMeanEarnedRuns': train_mean,
            'poissonAlpha': float(cfg['poissonAlpha']),
            'maxIter': int(cfg['maxIter']),
            'nb2Dispersion': float(dispersion),
            'fixedHalfRunLines': lines,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'coefficientsDescriptiveNotSelectionInput': {
                feature_names[i]: float(model.coef_[i]) for i in range(len(feature_names))
            },
        },
        'baselines': {
            'constantMeanEarnedRuns': train_mean,
            'pitcherOnlyFormula': contract['baselines']['pitcherOnlyMechanistic'],
            'sharedTrainingOnlyNb2Dispersion': float(dispersion),
            'constantFixedLineOverProbabilities': {str(k): v for k, v in line_probs.items()},
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': {
            'eligibleSlateDays': len(counts),
            'eligiblePitcherStarts': int(len(frame)),
            'canonicalStarterSlots': int(total_slots),
            'eligibilityShare': len(frame) / total_slots if total_slots else 0.0,
            'meanEligiblePitcherStartsPerSlateDay': float(np.mean(list(counts.values()))) if counts else 0.0,
            'medianEligiblePitcherStartsPerSlateDay': float(np.median(list(counts.values()))) if counts else 0.0,
            'note': 'Eligible starts are research observations, not bet candidates.',
        },
        'marketBoundary': {
            'providerMarketKey': 'pitcher_earned_runs',
            'repositoryRegistryFamily': 'PITCHER_PROP',
            'hardRockFloridaPerEventAvailabilityEstablished': False,
            'productionRegistryChanged': False,
            'historicalPitcherEarnedRunPricesUsed': False,
            'positiveEvEstablished': False,
            'priceCaptureAuthorized': False,
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
        'candidateRubricPassed': passed,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeason': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': report['volumeDiagnostics'],
    }, indent=2))


if __name__ == '__main__':
    main()
