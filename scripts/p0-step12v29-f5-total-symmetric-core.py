#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
import pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v29-f5-total-symmetric-core.v1'
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
    if len(home) != 9 or len(away) != 9 or len(set(home)) != 9 or len(set(away)) != 9:
        return None, None
    if min(home + away) <= 0:
        return None, None
    return home, away


def continuity(current, prior):
    if current is None or prior is None:
        return None
    return len(set(current).intersection(prior)) / 9.0


def shrunk_mean(total, trials, prior_mean, strength):
    return (float(total) + float(strength) * float(prior_mean)) / (float(trials) + float(strength))


def empty_pitcher_state():
    return {'bf': 0.0, 'k': 0.0, 'bb': 0.0, 'er': 0.0, 'hr': 0.0}


def parse_starter_line(raw):
    if not raw:
        return None
    pid = positive_int(raw.get('pitcherId'))
    if pid is None:
        return None
    values = {}
    mapping = {
        'bf': 'battersFaced',
        'k': 'strikeOuts',
        'bb': 'baseOnBalls',
        'er': 'earnedRuns',
        'hr': 'homeRuns',
    }
    for out_key, source_key in mapping.items():
        value = raw.get(source_key, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f'V29_INVALID_STARTER_LINE:{pid}:{source_key}:{value}')
        values[out_key] = float(value)
    return {'pitcherId': pid, **values}


def add_pitcher_line(state, line):
    for key in ('bf', 'k', 'bb', 'er', 'hr'):
        state[key] += line[key]


def league_rates(state):
    if state['bf'] <= 0:
        return None
    bf = state['bf']
    return {
        'erbf': state['er'] / bf,
        'hrbf': state['hr'] / bf,
        'kbb': (state['k'] - state['bb']) / bf,
    }


def pitcher_rates(state, league, prior_bf):
    bf = state['bf']
    return {
        'erbf': (state['er'] + prior_bf * league['erbf']) / (bf + prior_bf),
        'hrbf': (state['hr'] + prior_bf * league['hrbf']) / (bf + prior_bf),
        'kbb': ((state['k'] - state['bb']) + prior_bf * league['kbb']) / (bf + prior_bf),
        'priorBf': bf,
    }


def nb2_dispersion(y, mu):
    numerator = float(np.sum((y - mu) ** 2 - mu))
    denominator = float(np.sum(mu ** 2))
    if denominator <= 0:
        raise SystemExit('V29_NB2_DENOMINATOR_INVALID')
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
    baseline_mu = np.full(len(frame), train_mean, dtype=float)
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
    model_dev = float(mean_poisson_deviance(y, mu))
    base_dev = float(mean_poisson_deviance(y, baseline_mu))
    return {
        'rows': int(len(frame)),
        'observedMeanRuns': float(np.mean(y)),
        'meanPredictedRuns': float(np.mean(mu)),
        'trainingConstantMeanRuns': float(train_mean),
        'absoluteMeanCalibrationBias': abs(float(np.mean(mu)) - float(np.mean(y))),
        'constantBaselineAbsoluteMeanCalibrationBias': abs(float(train_mean) - float(np.mean(y))),
        'meanAbsoluteError': float(mean_absolute_error(y, mu)),
        'constantBaselineMeanAbsoluteError': float(mean_absolute_error(y, baseline_mu)),
        'meanPoissonDeviance': model_dev,
        'constantBaselineMeanPoissonDeviance': base_dev,
        'poissonDevianceImprovement': base_dev - model_dev,
        'fixedLineDiagnostics': line_rows,
        'averageBrierAcrossFixedLines': float(np.mean(model_briers)),
        'averageBaselineBrierAcrossFixedLines': float(np.mean(baseline_briers)),
        'averageBrierImprovement': float(np.mean(baseline_briers) - np.mean(model_briers)),
    }


def build_season_rows(root, season, outcomes, contract):
    base = os.path.join(root, season)
    canonical = load(os.path.join(base, 'game-anatomy-feature-table.json'))
    starters_json = load(os.path.join(base, 'cohort', 'starting-pitcher-history.json'))
    lineups_json = load(os.path.join(base, 'cohort', 'pregame-lineup-history.json'))
    audit_json = load(os.path.join(base, 't5-audit', 't5-starter-identity-audit.json'))
    if canonical.get('schemaVersion') != BASE_SCHEMA:
        raise SystemExit(f'V29_BASE_SCHEMA_INVALID:{season}')

    starter_map = {int(row['gamePk']): row for row in starters_json.get('games', [])}
    lineup_map = {int(row['gamePk']): row for row in lineups_json.get('snapshots', [])}
    audit_map = {int(row['gamePk']): row for row in audit_json.get('rows', [])}
    canonical_rows = [row for row in canonical.get('rows', []) if row.get('t5PregameValid') and int(row['gamePk']) in outcomes]
    by_date = defaultdict(list)
    for row in canonical_rows:
        by_date[str(row['officialDate'])].append(row)

    team_state = defaultdict(lambda: {'games': 0, 'scored': 0.0, 'allowed': 0.0})
    starter_f5_state = defaultdict(lambda: {'games': 0, 'oppRuns': 0.0})
    pitcher_state = defaultdict(empty_pitcher_state)
    league_pitcher_state = empty_pitcher_state()
    prior_lineup = {}
    league_team_obs = 0
    league_team_runs = 0.0
    team_strength = int(contract['f5History']['teamRunMeanPriorStrengthGames'])
    starter_strength = int(contract['f5History']['starterOpeningTeamRunMeanPriorStrengthGames'])
    opening_prior = float(contract['f5History']['openingDayFallbackPerTeamF5Runs'])
    prior_bf = float(contract['starterQuality']['shrinkagePriorBattersFaced'])
    rows = []
    valid_probable_pairs = 0
    complete_lineup_pairs = 0

    for official_date in sorted(by_date):
        day_games = sorted(by_date[official_date], key=lambda row: int(row['gamePk']))
        league_team_mean = league_team_runs / league_team_obs if league_team_obs > 0 else opening_prior
        lgr = league_rates(league_pitcher_state)

        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_id = int(raw['homeTeamId'])
            away_id = int(raw['awayTeamId'])
            audit = audit_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            if home_probable is not None and away_probable is not None:
                valid_probable_pairs += 1
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None and current_away is not None:
                complete_lineup_pairs += 1

            hs = team_state[home_id]
            aws = team_state[away_id]
            home_off = shrunk_mean(hs['scored'], hs['games'], league_team_mean, team_strength)
            away_off = shrunk_mean(aws['scored'], aws['games'], league_team_mean, team_strength)
            home_def = shrunk_mean(hs['allowed'], hs['games'], league_team_mean, team_strength)
            away_def = shrunk_mean(aws['allowed'], aws['games'], league_team_mean, team_strength)

            if home_probable is not None:
                hsf = starter_f5_state[home_probable]
                hsf5 = shrunk_mean(hsf['oppRuns'], hsf['games'], league_team_mean, starter_strength)
            else:
                hsf5 = None
            if away_probable is not None:
                asf = starter_f5_state[away_probable]
                asf5 = shrunk_mean(asf['oppRuns'], asf['games'], league_team_mean, starter_strength)
            else:
                asf5 = None

            if home_probable is not None and away_probable is not None and lgr is not None:
                hq = pitcher_rates(pitcher_state[home_probable], lgr, prior_bf)
                aq = pitcher_rates(pitcher_state[away_probable], lgr, prior_bf)
                combined_erbf = hq['erbf'] + aq['erbf']
                combined_hrbf = hq['hrbf'] + aq['hrbf']
                combined_kbb = hq['kbb'] + aq['kbb']
                min_bf = min(hq['priorBf'], aq['priorBf'])
            else:
                combined_erbf = combined_hrbf = combined_kbb = min_bf = None

            home_cont = continuity(current_home, prior_lineup.get(home_id))
            away_cont = continuity(current_away, prior_lineup.get(away_id))
            combined_cont = (home_cont + away_cont) if home_cont is not None and away_cont is not None else None
            full13 = raw.get('features') or {}

            rows.append({
                'season': season,
                'officialDate': official_date,
                'gamePk': game_pk,
                'f5TotalRuns': int(outcomes[game_pk]['totalRuns']),
                'combined_team_f5_offense_runs_shrunk': home_off + away_off,
                'combined_team_f5_defense_runs_shrunk': home_def + away_def,
                'combined_starter_opening_team_f5_allow_runs_shrunk': (hsf5 + asf5) if hsf5 is not None and asf5 is not None else None,
                'combined_starter_erbf': combined_erbf,
                'combined_starter_hrbf': combined_hrbf,
                'combined_starter_kbb': combined_kbb,
                'combined_team_rs10': float(full13['combined_team_rs10']) if finite(full13.get('combined_team_rs10')) else None,
                'combined_team_ra10': float(full13['combined_team_ra10']) if finite(full13.get('combined_team_ra10')) else None,
                'min_probable_prior_bf': min_bf,
                'combined_lineup_continuity': combined_cont,
            })

        # Strict same-date batch: update only after every target game on the date was scored.
        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_id = int(raw['homeTeamId'])
            away_id = int(raw['awayTeamId'])
            outcome = outcomes[game_pk]
            home_runs = float(outcome['homeRuns'])
            away_runs = float(outcome['awayRuns'])
            team_state[home_id]['games'] += 1
            team_state[home_id]['scored'] += home_runs
            team_state[home_id]['allowed'] += away_runs
            team_state[away_id]['games'] += 1
            team_state[away_id]['scored'] += away_runs
            team_state[away_id]['allowed'] += home_runs
            league_team_obs += 2
            league_team_runs += home_runs + away_runs

            starter_game = starter_map.get(game_pk)
            if starter_game:
                home_line = parse_starter_line(starter_game.get('homeStarter'))
                away_line = parse_starter_line(starter_game.get('awayStarter'))
                if home_line is not None:
                    pid = home_line['pitcherId']
                    starter_f5_state[pid]['games'] += 1
                    starter_f5_state[pid]['oppRuns'] += away_runs
                    add_pitcher_line(pitcher_state[pid], home_line)
                    add_pitcher_line(league_pitcher_state, home_line)
                if away_line is not None:
                    pid = away_line['pitcherId']
                    starter_f5_state[pid]['games'] += 1
                    starter_f5_state[pid]['oppRuns'] += home_runs
                    add_pitcher_line(pitcher_state[pid], away_line)
                    add_pitcher_line(league_pitcher_state, away_line)

            audit = audit_map.get(game_pk)
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None:
                prior_lineup[home_id] = current_home
            if current_away is not None:
                prior_lineup[away_id] = current_away

    return rows, {
        'canonicalOutcomeJoinedRows': len(canonical_rows),
        'validProbableStarterPairs': valid_probable_pairs,
        'completeAuditValidLineupPairs': complete_lineup_pairs,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v28-outcomes', required=True)
    parser.add_argument('--v28-report', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v29-f5-total-symmetric-core-contract.v1':
        raise SystemExit('V29_CONTRACT_SCHEMA_INVALID')
    v28_report = load(args.v28_report)
    if v28_report.get('classification') != contract['parentEvidence']['v28ClassificationRequired']:
        raise SystemExit('V29_V28_PARENT_CLASSIFICATION_INVALID')
    v28_outcomes = load(args.v28_outcomes)
    outcomes = {int(row['gamePk']): row for row in v28_outcomes.get('rows', [])}
    if len(outcomes) != int(v28_outcomes['acquisition']['outcomeCompleteGames']):
        raise SystemExit('V29_V28_OUTCOME_MAP_DUPLICATE_OR_DRIFT')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records = []
    custody = {}
    for season in seasons:
        season_rows, season_custody = build_season_rows(args.root, season, outcomes, contract)
        records.extend(season_rows)
        custody[season] = season_custody

    frame = pd.DataFrame.from_records(records)
    feature_names = tuple(contract['features']['exactly'])
    train_season = contract['dataBoundary']['modelFitSeason']
    validation_season = contract['dataBoundary']['validationSeason']
    evaluation_seasons = contract['dataBoundary']['retrospectiveEvaluationSeasons']
    train = frame[frame['season'] == train_season].copy()
    validation = frame[frame['season'] == validation_season].copy()
    evaluation = frame[frame['season'].isin(evaluation_seasons)].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit('V29_EMPTY_PARTITION')

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
    classification = 'F5_TOTAL_SYMMETRIC_CORE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'F5_TOTAL_SYMMETRIC_CORE_REJECTED_CLOSE_F5'

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'candidateRubricPassed': passed,
        'parent': {
            'v28Classification': v28_report['classification'],
            'v28CandidateRubricPassed': v28_report['candidateRubricPassed'],
            'v28ArtifactId': contract['parentEvidence']['v28ArtifactId'],
        },
        'data': {
            'scoredRows': int(len(frame)),
            'custodyBySeason': custody,
            'featureCount': len(feature_names),
            'features': list(feature_names),
            'sameDateHistoryAllowed': False,
            'seasonHistoryReset': True,
        },
        'model': {
            'trainingSeason': train_season,
            'trainingRows': int(len(train)),
            'trainingMeanRuns': train_mean,
            'poissonAlpha': float(cfg['poissonAlpha']),
            'maxIter': int(cfg['maxIter']),
            'fixedHalfRunLines': lines,
            'nb2Dispersion': float(dispersion),
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'coefficientsDescriptiveNotSelectionInput': {feature_names[i]: float(model.coef_[i]) for i in range(len(feature_names))},
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
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
        'custodyBySeason': custody,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeason': by_season,
        'candidateRubricChecks': checks,
        'coefficientsDescriptiveOnly': report['model']['coefficientsDescriptiveNotSelectionInput'],
    }, indent=2))


if __name__ == '__main__':
    main()
