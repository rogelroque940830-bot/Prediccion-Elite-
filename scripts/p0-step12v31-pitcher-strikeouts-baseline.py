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

REPORT_SCHEMA = 'courtedge-p0-step12v31-pitcher-strikeouts-baseline.v1'
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


def parse_starter_line(raw):
    if not raw:
        return None
    pitcher_id = positive_int(raw.get('pitcherId'))
    if pitcher_id is None:
        return None
    mapping = {
        'bf': 'battersFaced',
        'k': 'strikeOuts',
        'bb': 'baseOnBalls',
        'er': 'earnedRuns',
        'hr': 'homeRuns',
    }
    values = {}
    for key, source in mapping.items():
        value = raw.get(source, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f'V31_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}')
        values[key] = float(value)
    return {'pitcherId': pitcher_id, **values}


def empty_pitcher_state():
    return {'starts': 0, 'bf': 0.0, 'k': 0.0, 'bb': 0.0, 'er': 0.0, 'hr': 0.0, 'recent': []}


def empty_opponent_state():
    return {'games': 0, 'bf': 0.0, 'k': 0.0}


def add_pitcher_line(state, line, recent_window):
    state['starts'] += 1
    for key in ('bf', 'k', 'bb', 'er', 'hr'):
        state[key] += line[key]
    state['recent'].append({'bf': line['bf'], 'k': line['k']})
    if len(state['recent']) > recent_window:
        state['recent'] = state['recent'][-recent_window:]


def league_priors(league_state):
    if league_state['bf'] <= 0 or league_state['starts'] <= 0:
        return None
    bf = league_state['bf']
    return {
        'kbf': league_state['k'] / bf,
        'bbbf': league_state['bb'] / bf,
        'erbf': league_state['er'] / bf,
        'hrbf': league_state['hr'] / bf,
        'bfPerStart': bf / league_state['starts'],
    }


def shrunk_rate(numerator, denominator, league_rate, prior_bf):
    return (float(numerator) + prior_bf * float(league_rate)) / (float(denominator) + prior_bf)


def shrunk_mean(total, trials, league_mean, prior_trials):
    return (float(total) + prior_trials * float(league_mean)) / (float(trials) + prior_trials)


def pitcher_features(state, priors, rate_prior_bf, workload_prior_starts):
    if priors is None:
        return {
            'pitcher_kbf_shrunk': None,
            'pitcher_bbbf_shrunk': None,
            'pitcher_erbf_shrunk': None,
            'pitcher_hrbf_shrunk': None,
            'pitcher_bf_per_start_shrunk': None,
            'pitcher_recent5_k_per_start': None,
            'pitcher_recent5_bf_per_start': None,
            'pitcher_prior_bf': float(state['bf']),
        }
    recent = state['recent']
    return {
        'pitcher_kbf_shrunk': shrunk_rate(state['k'], state['bf'], priors['kbf'], rate_prior_bf),
        'pitcher_bbbf_shrunk': shrunk_rate(state['bb'], state['bf'], priors['bbbf'], rate_prior_bf),
        'pitcher_erbf_shrunk': shrunk_rate(state['er'], state['bf'], priors['erbf'], rate_prior_bf),
        'pitcher_hrbf_shrunk': shrunk_rate(state['hr'], state['bf'], priors['hrbf'], rate_prior_bf),
        'pitcher_bf_per_start_shrunk': shrunk_mean(state['bf'], state['starts'], priors['bfPerStart'], workload_prior_starts),
        'pitcher_recent5_k_per_start': float(np.mean([row['k'] for row in recent])) if recent else None,
        'pitcher_recent5_bf_per_start': float(np.mean([row['bf'] for row in recent])) if recent else None,
        'pitcher_prior_bf': float(state['bf']),
    }


def opponent_features(state, priors, rate_prior_bf, workload_prior_games):
    if priors is None:
        return {
            'opponent_vs_starters_kbf_allowed_shrunk': None,
            'opponent_vs_starters_bf_per_game_shrunk': None,
        }
    return {
        'opponent_vs_starters_kbf_allowed_shrunk': shrunk_rate(state['k'], state['bf'], priors['kbf'], rate_prior_bf),
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
        raise SystemExit('V31_NB2_DENOMINATOR_INVALID')
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
    y = frame['strikeouts'].to_numpy(dtype=float)
    constant_mu = np.full(len(frame), train_mean, dtype=float)
    pitcher_only_mu = frame['pitcherOnlyMuRaw'].to_numpy(dtype=float)
    pitcher_only_mu = np.where(np.isfinite(pitcher_only_mu) & (pitcher_only_mu > 0), pitcher_only_mu, train_mean)

    model_dev = float(mean_poisson_deviance(y, model_mu))
    constant_dev = float(mean_poisson_deviance(y, constant_mu))
    pitcher_dev = float(mean_poisson_deviance(y, pitcher_only_mu))

    line_rows = {}
    model_briers = []
    constant_briers = []
    pitcher_briers = []
    for line in lines:
        observed = (y > line).astype(float)
        model_probs = np.asarray([over_probability(mu, dispersion, line) for mu in model_mu], dtype=float)
        pitcher_probs = np.asarray([over_probability(mu, dispersion, line) for mu in pitcher_only_mu], dtype=float)
        constant_prob = float(constant_line_probs[line])
        constant_probs = np.full(len(frame), constant_prob, dtype=float)
        model_brier = float(np.mean((model_probs - observed) ** 2))
        constant_brier = float(np.mean((constant_probs - observed) ** 2))
        pitcher_brier = float(np.mean((pitcher_probs - observed) ** 2))
        model_briers.append(model_brier)
        constant_briers.append(constant_brier)
        pitcher_briers.append(pitcher_brier)
        line_rows[str(line)] = {
            'observedOverRate': float(np.mean(observed)),
            'meanModelOverProbability': float(np.mean(model_probs)),
            'meanPitcherOnlyOverProbability': float(np.mean(pitcher_probs)),
            'trainingClimatologyOverProbability': constant_prob,
            'modelBrier': model_brier,
            'constantBaselineBrier': constant_brier,
            'pitcherOnlyBaselineBrier': pitcher_brier,
            'modelMinusConstantBrierImprovement': constant_brier - model_brier,
            'modelMinusPitcherOnlyBrierImprovement': pitcher_brier - model_brier,
        }

    return {
        'rows': int(len(frame)),
        'observedMeanStrikeouts': float(np.mean(y)),
        'meanModelStrikeouts': float(np.mean(model_mu)),
        'meanPitcherOnlyStrikeouts': float(np.mean(pitcher_only_mu)),
        'trainingConstantMeanStrikeouts': float(train_mean),
        'modelAbsoluteMeanCalibrationBias': abs(float(np.mean(model_mu)) - float(np.mean(y))),
        'constantAbsoluteMeanCalibrationBias': abs(float(train_mean) - float(np.mean(y))),
        'pitcherOnlyAbsoluteMeanCalibrationBias': abs(float(np.mean(pitcher_only_mu)) - float(np.mean(y))),
        'modelMeanAbsoluteError': float(mean_absolute_error(y, model_mu)),
        'constantMeanAbsoluteError': float(mean_absolute_error(y, constant_mu)),
        'pitcherOnlyMeanAbsoluteError': float(mean_absolute_error(y, pitcher_only_mu)),
        'modelPoissonDeviance': model_dev,
        'constantPoissonDeviance': constant_dev,
        'pitcherOnlyPoissonDeviance': pitcher_dev,
        'modelVsConstantDevianceImprovement': constant_dev - model_dev,
        'modelVsPitcherOnlyDevianceImprovement': pitcher_dev - model_dev,
        'fixedLineDiagnostics': line_rows,
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
        raise SystemExit(f'V31_BASE_SCHEMA_INVALID:{season}')

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
    rate_prior_bf = float(cfg['rateShrinkagePriorBattersFaced'])
    workload_prior_starts = float(cfg['workloadShrinkagePriorStarts'])
    opp_rate_prior_bf = float(cfg['opponentRateShrinkagePriorBattersFaced'])
    opp_workload_games = float(cfg['opponentWorkloadShrinkagePriorGames'])
    recent_window = int(cfg['recentStartsWindow'])

    rows = []
    canonical_slots = 2 * len(canonical_rows)
    audit_probable_slots = 0
    exact_match_slots = 0
    current_complete_lineup_pairs = 0

    for official_date in sorted(by_date):
        day_games = sorted(by_date[official_date], key=lambda row: int(row['gamePk']))
        priors = league_priors(league_state)

        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_team = int(raw['homeTeamId'])
            away_team = int(raw['awayTeamId'])
            starter_game = starter_map.get(game_pk)
            audit = audit_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            if home_probable is not None and away_probable is not None:
                audit_probable_slots += 2
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None and current_away is not None:
                current_complete_lineup_pairs += 1
            if not starter_game:
                continue
            actual_home = parse_starter_line(starter_game.get('homeStarter'))
            actual_away = parse_starter_line(starter_game.get('awayStarter'))
            full13 = raw.get('features') or {}

            candidates = [
                ('home', home_probable, actual_home, away_team, current_away),
                ('away', away_probable, actual_away, home_team, current_home),
            ]
            for side, probable_id, actual, opponent_team, opponent_current_lineup in candidates:
                if probable_id is None or actual is None or actual['bf'] <= 0 or probable_id != actual['pitcherId']:
                    continue
                exact_match_slots += 1
                p_state = pitcher_state[probable_id]
                o_state = opponent_state[opponent_team]
                features = pitcher_features(p_state, priors, rate_prior_bf, workload_prior_starts)
                features.update(opponent_features(o_state, priors, opp_rate_prior_bf, opp_workload_games))
                features['opponent_rs10'] = opponent_rs10(full13, side)
                features['opponent_lineup_continuity'] = continuity(opponent_current_lineup, prior_lineup.get(opponent_team))
                raw_mu = None
                if finite(features['pitcher_kbf_shrunk']) and finite(features['pitcher_bf_per_start_shrunk']):
                    raw_mu = float(features['pitcher_kbf_shrunk']) * float(features['pitcher_bf_per_start_shrunk'])
                rows.append({
                    'season': season,
                    'officialDate': official_date,
                    'gamePk': game_pk,
                    'side': side,
                    'pitcherId': probable_id,
                    'opponentTeamId': opponent_team,
                    'strikeouts': int(actual['k']),
                    'actualBattersFaced': float(actual['bf']),
                    'pitcherOnlyMuRaw': raw_mu,
                    **features,
                })

        # Strict same-date batch: update histories only after every target on the date was scored.
        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_team = int(raw['homeTeamId'])
            away_team = int(raw['awayTeamId'])
            starter_game = starter_map.get(game_pk)
            if starter_game:
                home_line = parse_starter_line(starter_game.get('homeStarter'))
                away_line = parse_starter_line(starter_game.get('awayStarter'))
                if home_line is not None and home_line['bf'] > 0:
                    add_pitcher_line(pitcher_state[home_line['pitcherId']], home_line, recent_window)
                    add_pitcher_line(league_state, home_line, recent_window)
                    opponent_state[away_team]['games'] += 1
                    opponent_state[away_team]['bf'] += home_line['bf']
                    opponent_state[away_team]['k'] += home_line['k']
                if away_line is not None and away_line['bf'] > 0:
                    add_pitcher_line(pitcher_state[away_line['pitcherId']], away_line, recent_window)
                    add_pitcher_line(league_state, away_line, recent_window)
                    opponent_state[home_team]['games'] += 1
                    opponent_state[home_team]['bf'] += away_line['bf']
                    opponent_state[home_team]['k'] += away_line['k']

            audit = audit_map.get(game_pk)
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None:
                prior_lineup[home_team] = current_home
            if current_away is not None:
                prior_lineup[away_team] = current_away

    return rows, {
        'canonicalT5Games': len(canonical_rows),
        'canonicalStarterSlots': canonical_slots,
        'auditValidProbableStarterSlots': audit_probable_slots,
        'exactProbableRecordedStarterEligibleSlots': exact_match_slots,
        'eligibilityShareOfCanonicalStarterSlots': exact_match_slots / canonical_slots if canonical_slots else 0.0,
        'completeAuditValidLineupPairs': current_complete_lineup_pairs,
    }


def volume_diagnostics(frame, custody):
    counts = Counter(frame['officialDate'])
    total_slots = sum(row['canonicalStarterSlots'] for row in custody.values())
    eligible = len(frame)
    return {
        'eligibleSlateDays': len(counts),
        'eligiblePitcherStarts': int(eligible),
        'canonicalStarterSlots': int(total_slots),
        'eligibilityShare': eligible / total_slots if total_slots else 0.0,
        'meanEligiblePitcherStartsPerSlateDay': float(np.mean(list(counts.values()))) if counts else 0.0,
        'medianEligiblePitcherStartsPerSlateDay': float(np.median(list(counts.values()))) if counts else 0.0,
        'note': 'Eligible pitcher starts are research observations, not bet candidates. A game can contribute up to two exact probable-to-recorded starter rows.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v31-pitcher-strikeouts-baseline-contract.v1':
        raise SystemExit('V31_CONTRACT_SCHEMA_INVALID')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records = []
    custody = {}
    for season in seasons:
        season_rows, season_custody = build_season_rows(args.root, season, contract)
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
        raise SystemExit('V31_EMPTY_PARTITION')

    imputer = SimpleImputer(strategy='median')
    scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(feature_names)]))
    y_train = train['strikeouts'].to_numpy(dtype=float)
    model_cfg = contract['model']
    model = PoissonRegressor(alpha=float(model_cfg['poissonAlpha']), max_iter=int(model_cfg['maxIter']))
    model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train), 1e-9)
    dispersion = nb2_dispersion(y_train, train_mu)
    train_mean = float(np.mean(y_train))
    lines = [float(v) for v in model_cfg['fixedHalfRunLines']]
    constant_line_probs = {line: float(np.mean(y_train > line)) for line in lines}

    validation_metrics = evaluate(validation, feature_names, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
    evaluation_metrics = evaluate(evaluation, feature_names, imputer, scaler, model, dispersion, train_mean, constant_line_probs, lines)
    by_season = {}
    for season in [validation_season, *evaluation_seasons]:
        by_season[season] = evaluate(
            frame[frame['season'] == season].copy(), feature_names, imputer, scaler, model,
            dispersion, train_mean, constant_line_probs, lines,
        )

    checks = {
        'validationDevianceBeatsConstant': validation_metrics['modelVsConstantDevianceImprovement'] > 0.0,
        'validationDevianceBeatsPitcherOnly': validation_metrics['modelVsPitcherOnlyDevianceImprovement'] > 0.0,
        'validationBrierBeatsConstant': validation_metrics['modelVsConstantAverageBrierImprovement'] > 0.0,
        'validationBrierBeatsPitcherOnly': validation_metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0.0,
        'evaluationDevianceBeatsConstant': evaluation_metrics['modelVsConstantDevianceImprovement'] > 0.0,
        'evaluationDevianceBeatsPitcherOnly': evaluation_metrics['modelVsPitcherOnlyDevianceImprovement'] > 0.0,
        'evaluationBrierBeatsConstant': evaluation_metrics['modelVsConstantAverageBrierImprovement'] > 0.0,
        'evaluationBrierBeatsPitcherOnly': evaluation_metrics['modelVsPitcherOnlyAverageBrierImprovement'] > 0.0,
    }
    passed = all(checks.values())
    classification = 'PITCHER_STRIKEOUTS_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'PITCHER_STRIKEOUTS_BASELINE_REJECTED'

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
            'providerMarketKey': model_cfg['providerMarketKey'],
            'canonicalResearchMarketType': model_cfg['canonicalResearchMarketType'],
            'trainingSeason': train_season,
            'trainingRows': int(len(train)),
            'trainingMeanStrikeouts': train_mean,
            'poissonAlpha': float(model_cfg['poissonAlpha']),
            'maxIter': int(model_cfg['maxIter']),
            'nb2Dispersion': float(dispersion),
            'fixedHalfRunLines': lines,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'lineSearchUsed': False,
            'coefficientsDescriptiveNotSelectionInput': {feature_names[i]: float(model.coef_[i]) for i in range(len(feature_names))},
        },
        'baselines': {
            'constantMeanStrikeouts': train_mean,
            'pitcherOnlyFormula': contract['baselines']['pitcherOnlyMechanistic'],
            'pitcherOnlyMissingPredictionFallback': train_mean,
            'sharedTrainingOnlyNb2DispersionForFixedLineProbabilities': float(dispersion),
            'constantFixedLineOverProbabilities': {str(line): constant_line_probs[line] for line in lines},
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': volume_diagnostics(frame, custody),
        'marketBoundary': {
            'provider': contract['marketEvidence']['provider'],
            'providerMarketKey': 'pitcher_strikeouts',
            'hardRockFloridaPerEventAvailabilityEstablished': False,
            'productionRegistryChanged': False,
            'historicalPitcherStrikeoutPricesUsed': False,
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
        'custodyBySeason': custody,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeason': by_season,
        'candidateRubricChecks': checks,
        'volumeDiagnostics': report['volumeDiagnostics'],
        'coefficientsDescriptiveOnly': report['model']['coefficientsDescriptiveNotSelectionInput'],
    }, indent=2))


if __name__ == '__main__':
    main()
