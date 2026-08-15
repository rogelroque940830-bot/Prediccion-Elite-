#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA = 'courtedge-p0-step12v27-nrfi-yrfi-i1-causal-core.v1'
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


def valid_positive_int(value):
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
    home = valid_positive_int(audit.get('homeProbablePitcherId'))
    away = valid_positive_int(audit.get('awayProbablePitcherId'))
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


def top3_continuity(current, prior):
    if current is None or prior is None:
        return None
    return len(set(current[:3]).intersection(prior[:3])) / 3.0


def shrunk_binary(successes, trials, prior_mean, prior_strength):
    return (float(successes) + float(prior_strength) * float(prior_mean)) / (float(trials) + float(prior_strength))


def pitcher_line(raw):
    if not raw:
        return None
    pid = valid_positive_int(raw.get('pitcherId'))
    if pid is None:
        return None
    fields = {}
    for key in ('battersFaced', 'strikeOuts', 'baseOnBalls', 'earnedRuns', 'homeRuns'):
        value = raw.get(key, 0)
        if not finite(value) or float(value) < 0:
            raise SystemExit(f'V27_INVALID_STARTER_LINE:{pid}:{key}:{value}')
        fields[key] = float(value)
    return {'pitcherId': pid, **fields}


def league_pitcher_rates(lines):
    valid = [line for line in lines if line['battersFaced'] > 0]
    bf = sum(line['battersFaced'] for line in valid)
    if bf <= 0:
        return None
    return {
        'erbf': sum(line['earnedRuns'] for line in valid) / bf,
        'hrbf': sum(line['homeRuns'] for line in valid) / bf,
    }


def starter_quality(lines, league, prior_bf):
    valid = [line for line in lines if line['battersFaced'] > 0]
    bf = sum(line['battersFaced'] for line in valid)
    er = sum(line['earnedRuns'] for line in valid)
    hr = sum(line['homeRuns'] for line in valid)
    return {
        'erbf': (er + prior_bf * league['erbf']) / (bf + prior_bf),
        'hrbf': (hr + prior_bf * league['hrbf']) / (bf + prior_bf),
    }


def evaluate(frame, feature_names, imputer, scaler, model, baseline_prob):
    X = scaler.transform(imputer.transform(frame[list(feature_names)]))
    y = frame['yrfi'].to_numpy(dtype=int)
    probs = model.predict_proba(X)[:, 1]
    baseline = np.full(len(frame), baseline_prob, dtype=float)
    model_log = float(log_loss(y, probs, labels=[0, 1]))
    baseline_log = float(log_loss(y, baseline, labels=[0, 1]))
    model_brier = float(brier_score_loss(y, probs))
    baseline_brier = float(brier_score_loss(y, baseline))
    observed = float(np.mean(y))
    predicted = float(np.mean(probs))
    auc = float(roc_auc_score(y, probs)) if len(np.unique(y)) == 2 else None
    return {
        'rows': int(len(frame)),
        'observedYrfiRate': observed,
        'observedNrfiRate': 1.0 - observed,
        'meanPredictedYrfiProbability': predicted,
        'trainingClimatologyYrfiProbability': baseline_prob,
        'binaryLogLoss': model_log,
        'baselineBinaryLogLoss': baseline_log,
        'logLossImprovement': baseline_log - model_log,
        'brierScore': model_brier,
        'baselineBrierScore': baseline_brier,
        'brierImprovement': baseline_brier - model_brier,
        'rocAuc': auc,
        'absoluteMeanCalibrationBias': abs(predicted - observed),
        'baselineAbsoluteMeanCalibrationBias': abs(baseline_prob - observed),
    }


def build_season_rows(root, season, outcomes, contract):
    base = os.path.join(root, season)
    canonical = load(os.path.join(base, 'game-anatomy-feature-table.json'))
    starters_json = load(os.path.join(base, 'cohort', 'starting-pitcher-history.json'))
    lineups_json = load(os.path.join(base, 'cohort', 'pregame-lineup-history.json'))
    audit_json = load(os.path.join(base, 't5-audit', 't5-starter-identity-audit.json'))
    if canonical.get('schemaVersion') != BASE_SCHEMA:
        raise SystemExit(f'V27_BASE_SCHEMA_INVALID:{season}')

    starter_map = {int(row['gamePk']): row for row in starters_json.get('games', [])}
    lineup_map = {int(row['gamePk']): row for row in lineups_json.get('snapshots', [])}
    audit_map = {int(row['gamePk']): row for row in audit_json.get('rows', [])}

    canonical_rows = [row for row in canonical.get('rows', []) if row.get('t5PregameValid')]
    by_date = defaultdict(list)
    for row in canonical_rows:
        game_pk = int(row['gamePk'])
        if game_pk in outcomes:
            by_date[str(row['officialDate'])].append(row)

    team_state = defaultdict(lambda: {'games': 0, 'scored': 0, 'allowed': 0})
    starter_i1_state = defaultdict(lambda: {'games': 0, 'allowed': 0})
    pitcher_quality_state = defaultdict(list)
    league_pitcher_lines = []
    prior_lineup = {}
    league_half_trials = 0
    league_half_successes = 0
    team_prior_strength = int(contract['firstInningHistory']['teamRatePriorStrengthHalfInnings'])
    starter_prior_strength = int(contract['firstInningHistory']['starterRatePriorStrengthGames'])
    opening_prior = float(contract['firstInningHistory']['openingDayFallbackPriorMean'])
    prior_bf = float(contract['starterQuality']['shrinkagePriorBattersFaced'])
    rows = []
    current_valid_probables = 0
    current_complete_lineups = 0

    for official_date in sorted(by_date):
        day_games = sorted(by_date[official_date], key=lambda row: int(row['gamePk']))
        league_i1_mean = (league_half_successes / league_half_trials) if league_half_trials > 0 else opening_prior
        league_quality = league_pitcher_rates(league_pitcher_lines)

        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_id = int(raw['homeTeamId'])
            away_id = int(raw['awayTeamId'])
            outcome = outcomes[game_pk]
            audit = audit_map.get(game_pk)
            lineup = lineup_map.get(game_pk)
            home_probable, away_probable = probable_ids(audit)
            if home_probable is not None and away_probable is not None:
                current_valid_probables += 1
            current_home_order, current_away_order = complete_lineup(lineup, audit)
            if current_home_order is not None and current_away_order is not None:
                current_complete_lineups += 1

            hs = team_state[home_id]
            aws = team_state[away_id]
            feature = {
                'home_offense_i1_score_rate_shrunk': shrunk_binary(hs['scored'], hs['games'], league_i1_mean, team_prior_strength),
                'away_offense_i1_score_rate_shrunk': shrunk_binary(aws['scored'], aws['games'], league_i1_mean, team_prior_strength),
                'home_defense_i1_allow_rate_shrunk': shrunk_binary(hs['allowed'], hs['games'], league_i1_mean, team_prior_strength),
                'away_defense_i1_allow_rate_shrunk': shrunk_binary(aws['allowed'], aws['games'], league_i1_mean, team_prior_strength),
            }

            if home_probable is not None:
                st = starter_i1_state[home_probable]
                feature['home_starter_opening_team_i1_allow_rate_shrunk'] = shrunk_binary(st['allowed'], st['games'], league_i1_mean, starter_prior_strength)
            else:
                feature['home_starter_opening_team_i1_allow_rate_shrunk'] = None
            if away_probable is not None:
                st = starter_i1_state[away_probable]
                feature['away_starter_opening_team_i1_allow_rate_shrunk'] = shrunk_binary(st['allowed'], st['games'], league_i1_mean, starter_prior_strength)
            else:
                feature['away_starter_opening_team_i1_allow_rate_shrunk'] = None

            if home_probable is not None and away_probable is not None and league_quality is not None:
                home_q = starter_quality(pitcher_quality_state[home_probable], league_quality, prior_bf)
                away_q = starter_quality(pitcher_quality_state[away_probable], league_quality, prior_bf)
                feature['combined_starter_erbf'] = home_q['erbf'] + away_q['erbf']
                feature['combined_starter_hrbf'] = home_q['hrbf'] + away_q['hrbf']
            else:
                feature['combined_starter_erbf'] = None
                feature['combined_starter_hrbf'] = None

            full13 = raw.get('features') or {}
            feature['combined_starter_kbb'] = float(full13['combined_starter_kbb']) if finite(full13.get('combined_starter_kbb')) else None
            feature['combined_team_rs10'] = float(full13['combined_team_rs10']) if finite(full13.get('combined_team_rs10')) else None
            feature['combined_team_ra10'] = float(full13['combined_team_ra10']) if finite(full13.get('combined_team_ra10')) else None
            feature['home_top3_continuity'] = top3_continuity(current_home_order, prior_lineup.get(home_id))
            feature['away_top3_continuity'] = top3_continuity(current_away_order, prior_lineup.get(away_id))

            row = {
                'season': season,
                'officialDate': official_date,
                'gamePk': game_pk,
                'yrfi': int(outcome['yrfi']),
                **feature,
            }
            rows.append(row)

        # Update every state only after all target games on this official date were scored.
        for raw in day_games:
            game_pk = int(raw['gamePk'])
            home_id = int(raw['homeTeamId'])
            away_id = int(raw['awayTeamId'])
            outcome = outcomes[game_pk]
            home_runs = int(outcome['homeRuns'])
            away_runs = int(outcome['awayRuns'])

            hs = team_state[home_id]
            hs['games'] += 1
            hs['scored'] += int(home_runs > 0)
            hs['allowed'] += int(away_runs > 0)
            aws = team_state[away_id]
            aws['games'] += 1
            aws['scored'] += int(away_runs > 0)
            aws['allowed'] += int(home_runs > 0)
            league_half_trials += 2
            league_half_successes += int(home_runs > 0) + int(away_runs > 0)

            starter_game = starter_map.get(game_pk)
            if starter_game:
                home_line = pitcher_line(starter_game.get('homeStarter'))
                away_line = pitcher_line(starter_game.get('awayStarter'))
                if home_line is not None:
                    starter_i1_state[home_line['pitcherId']]['games'] += 1
                    starter_i1_state[home_line['pitcherId']]['allowed'] += int(away_runs > 0)
                    pitcher_quality_state[home_line['pitcherId']].append(home_line)
                    league_pitcher_lines.append(home_line)
                if away_line is not None:
                    starter_i1_state[away_line['pitcherId']]['games'] += 1
                    starter_i1_state[away_line['pitcherId']]['allowed'] += int(home_runs > 0)
                    pitcher_quality_state[away_line['pitcherId']].append(away_line)
                    league_pitcher_lines.append(away_line)

            audit = audit_map.get(game_pk)
            current_home_order, current_away_order = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home_order is not None:
                prior_lineup[home_id] = current_home_order
            if current_away_order is not None:
                prior_lineup[away_id] = current_away_order

    return rows, {
        'canonicalT5Rows': len(canonical_rows),
        'outcomeJoinedRows': len(rows),
        'validProbableStarterPairs': current_valid_probables,
        'completeAuditValidLineupPairs': current_complete_lineups,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--v26-outcomes', required=True)
    parser.add_argument('--v26-report', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v27-nrfi-yrfi-i1-causal-core-contract.v1':
        raise SystemExit('V27_CONTRACT_SCHEMA_INVALID')
    v26_report = load(args.v26_report)
    if v26_report.get('classification') != contract['parentEvidence']['v26ClassificationRequired']:
        raise SystemExit('V27_V26_PARENT_CLASSIFICATION_INVALID')
    v26_outcomes = load(args.v26_outcomes)
    outcome_map = {int(row['gamePk']): row for row in v26_outcomes.get('rows', [])}
    if len(outcome_map) != int(v26_outcomes['acquisition']['outcomeCompleteGames']):
        raise SystemExit('V27_V26_OUTCOME_MAP_DUPLICATE_OR_DRIFT')

    seasons = [
        contract['dataBoundary']['modelFitSeason'],
        contract['dataBoundary']['validationSeason'],
        *contract['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    records = []
    custody = {}
    for season in seasons:
        season_rows, season_custody = build_season_rows(args.root, season, outcome_map, contract)
        records.extend(season_rows)
        custody[season] = season_custody

    feature_names = tuple(contract['features']['exactly'])
    frame = pd.DataFrame.from_records(records)
    train_season = contract['dataBoundary']['modelFitSeason']
    validation_season = contract['dataBoundary']['validationSeason']
    evaluation_seasons = contract['dataBoundary']['retrospectiveEvaluationSeasons']
    train = frame[frame['season'] == train_season].copy()
    validation = frame[frame['season'] == validation_season].copy()
    evaluation = frame[frame['season'].isin(evaluation_seasons)].copy()
    if min(len(train), len(validation), len(evaluation)) <= 0:
        raise SystemExit('V27_EMPTY_PARTITION')

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
    baseline_prob = float(np.mean(y_train))

    validation_metrics = evaluate(validation, feature_names, imputer, scaler, model, baseline_prob)
    evaluation_metrics = evaluate(evaluation, feature_names, imputer, scaler, model, baseline_prob)
    by_season = {}
    for season in [validation_season, *evaluation_seasons]:
        by_season[season] = evaluate(frame[frame['season'] == season].copy(), feature_names, imputer, scaler, model, baseline_prob)

    checks = {
        'validationLogLossBeatsBaseline': validation_metrics['logLossImprovement'] > 0,
        'validationBrierBeatsBaseline': validation_metrics['brierImprovement'] > 0,
        'validationRocAucAboveHalf': validation_metrics['rocAuc'] is not None and validation_metrics['rocAuc'] > 0.5,
        'evaluationLogLossBeatsBaseline': evaluation_metrics['logLossImprovement'] > 0,
        'evaluationBrierBeatsBaseline': evaluation_metrics['brierImprovement'] > 0,
        'evaluationRocAucAboveHalf': evaluation_metrics['rocAuc'] is not None and evaluation_metrics['rocAuc'] > 0.5,
    }
    passed = all(checks.values())
    classification = 'NRFI_YRFI_I1_CAUSAL_CORE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'NRFI_YRFI_I1_CAUSAL_CORE_REJECTED'

    coefficient_map = {feature_names[i]: float(model.coef_[0][i]) for i in range(len(feature_names))}
    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'candidateRubricPassed': passed,
        'parent': {
            'v26Classification': v26_report['classification'],
            'v26CandidateRubricPassed': v26_report['candidateRubricPassed'],
            'v26ArtifactId': contract['parentEvidence']['v26ArtifactId'],
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
            'trainingYrfiRate': baseline_prob,
            'regularizationC': float(cfg['regularizationC']),
            'solver': cfg['solver'],
            'maxIter': int(cfg['maxIter']),
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'probabilityThresholdSearchUsed': False,
            'coefficientsDescriptiveNotSelectionInput': coefficient_map,
        },
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeasonDescriptiveOnly': by_season,
        'candidateRubricChecks': checks,
        'marketBoundary': {
            'providerMarketKey': 'totals_1st_1_innings',
            'requiredExactLine': 0.5,
            'historicalNrfiYrfiPricesUsed': False,
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
        'custodyBySeason': custody,
        'validation2023': validation_metrics,
        'evaluation2024_2026Ytd': evaluation_metrics,
        'bySeason': by_season,
        'candidateRubricChecks': checks,
        'coefficientsDescriptiveOnly': coefficient_map,
    }, indent=2))


if __name__ == '__main__':
    main()
