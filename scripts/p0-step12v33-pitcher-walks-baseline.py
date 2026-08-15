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

REPORT_SCHEMA = 'courtedge-p0-step12v33-pitcher-walks-baseline.v1'
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
            raise SystemExit(f'V33_INVALID_STARTER_LINE:{pitcher_id}:{source}:{value}')
        values[key] = float(value)
    return {'pitcherId': pitcher_id, **values}


def empty_pitcher_state():
    return {'starts': 0, 'bf': 0.0, 'k': 0.0, 'bb': 0.0, 'er': 0.0, 'hr': 0.0, 'recent': []}


def empty_opponent_state():
    return {'games': 0, 'bf': 0.0, 'bb': 0.0}


def add_pitcher_line(state, line, recent_window):
    state['starts'] += 1
    for key in ('bf', 'k', 'bb', 'er', 'hr'):
        state[key] += line[key]
    state['recent'].append({'bf': line['bf'], 'bb': line['bb']})
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
            'pitcher_bbbf_shrunk': None,
            'pitcher_kbf_shrunk': None,
            'pitcher_erbf_shrunk': None,
            'pitcher_hrbf_shrunk': None,
            'pitcher_bf_per_start_shrunk': None,
            'pitcher_recent5_bb_per_start': None,
            'pitcher_recent5_bf_per_start': None,
            'pitcher_prior_bf': float(state['bf']),
        }
    return {
        'pitcher_bbbf_shrunk': shrunk_rate(state['bb'], state['bf'], priors['bbbf'], rate_prior_bf),
        'pitcher_kbf_shrunk': shrunk_rate(state['k'], state['bf'], priors['kbf'], rate_prior_bf),
        'pitcher_erbf_shrunk': shrunk_rate(state['er'], state['bf'], priors['erbf'], rate_prior_bf),
        'pitcher_hrbf_shrunk': shrunk_rate(state['hr'], state['bf'], priors['hrbf'], rate_prior_bf),
        'pitcher_bf_per_start_shrunk': shrunk_mean(state['bf'], state['starts'], priors['bfPerStart'], workload_prior_starts),
        'pitcher_recent5_bb_per_start': float(np.mean([row['bb'] for row in recent])) if recent else None,
        'pitcher_recent5_bf_per_start': float(np.mean([row['bf'] for row in recent])) if recent else None,
        'pitcher_prior_bf': float(state['bf']),
    }


def opponent_features(state, priors, rate_prior_bf, workload_prior_games):
    if priors is None:
        return {
            'opponent_vs_starters_bbbf_drawn_shrunk': None,
            'opponent_vs_starters_bf_per_game_shrunk': None,
        }
    return {
        'opponent_vs_starters_bbbf_drawn_shrunk': shrunk_rate(state['bb'], state['bf'], priors['bbbf'], rate_prior_bf),
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
        raise SystemExit('V33_NB2_DENOMINATOR_INVALID')
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
    y = frame['walks'].to_numpy(dtype=float)
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
        model_probs = np.asarray([over_probability(mu, dispersion, line) for mu in model_mu])
        pitcher_probs = np.asarray([over_probability(mu, dispersion, line) for mu in pitcher_mu])
        constant_prob = float(constant_line_probs[line])
        constant_probs = np.full(len(frame), constant_prob)
        model_brier = float(np.mean((model_probs - observed) ** 2))
        constant_brier = float(np.mean((constant_probs - observed) ** 2))
        pitcher_brier = float(np.mean((pitcher_probs - observed) ** 2))
        model_briers.append(model_brier); constant_briers.append(constant_brier); pitcher_briers.append(pitcher_brier)
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
        'observedMeanWalks': float(np.mean(y)),
        'meanModelWalks': float(np.mean(model_mu)),
        'meanPitcherOnlyWalks': float(np.mean(pitcher_mu)),
        'trainingConstantMeanWalks': float(train_mean),
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
        raise SystemExit(f'V33_BASE_SCHEMA_INVALID:{season}')
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
            game_pk = int(raw['gamePk']); home_team = int(raw['homeTeamId']); away_team = int(raw['awayTeamId'])
            audit = audit_map.get(game_pk)
            hp, ap = probable_ids(audit)
            if hp is not None and ap is not None:
                probable_slots += 2
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None and current_away is not None:
                complete_lineup_pairs += 1
            starter_game = starter_map.get(game_pk)
            if not starter_game:
                continue
            ah = parse_starter_line(starter_game.get('homeStarter')); aa = parse_starter_line(starter_game.get('awayStarter'))
            full13 = raw.get('features') or {}
            for side, probable_id, actual, opponent_team, opponent_lineup in [
                ('home', hp, ah, away_team, current_away), ('away', ap, aa, home_team, current_home)
            ]:
                if probable_id is None or actual is None or actual['bf'] <= 0 or probable_id != actual['pitcherId']:
                    continue
                eligible_slots += 1
                p = pitcher_features(pitcher_state[probable_id], priors, float(cfg['rateShrinkagePriorBattersFaced']), float(cfg['workloadShrinkagePriorStarts']))
                p.update(opponent_features(opponent_state[opponent_team], priors, float(cfg['opponentRateShrinkagePriorBattersFaced']), float(cfg['opponentWorkloadShrinkagePriorGames'])))
                p['opponent_rs10'] = opponent_rs10(full13, side)
                p['opponent_lineup_continuity'] = continuity(opponent_lineup, prior_lineup.get(opponent_team))
                raw_mu = float(p['pitcher_bbbf_shrunk']) * float(p['pitcher_bf_per_start_shrunk']) if finite(p['pitcher_bbbf_shrunk']) and finite(p['pitcher_bf_per_start_shrunk']) else None
                rows.append({
                    'season': season, 'officialDate': official_date, 'gamePk': game_pk, 'side': side,
                    'pitcherId': probable_id, 'opponentTeamId': opponent_team,
                    'walks': int(actual['bb']), 'actualBattersFaced': float(actual['bf']), 'pitcherOnlyMuRaw': raw_mu, **p,
                })
        for raw in games:
            game_pk = int(raw['gamePk']); home_team = int(raw['homeTeamId']); away_team = int(raw['awayTeamId'])
            starter_game = starter_map.get(game_pk)
            if starter_game:
                hl = parse_starter_line(starter_game.get('homeStarter')); al = parse_starter_line(starter_game.get('awayStarter'))
                if hl is not None and hl['bf'] > 0:
                    add_pitcher_line(pitcher_state[hl['pitcherId']], hl, int(cfg['recentStartsWindow']))
                    add_pitcher_line(league_state, hl, int(cfg['recentStartsWindow']))
                    opponent_state[away_team]['games'] += 1; opponent_state[away_team]['bf'] += hl['bf']; opponent_state[away_team]['bb'] += hl['bb']
                if al is not None and al['bf'] > 0:
                    add_pitcher_line(pitcher_state[al['pitcherId']], al, int(cfg['recentStartsWindow']))
                    add_pitcher_line(league_state, al, int(cfg['recentStartsWindow']))
                    opponent_state[home_team]['games'] += 1; opponent_state[home_team]['bf'] += al['bf']; opponent_state[home_team]['bb'] += al['bb']
            audit = audit_map.get(game_pk)
            current_home, current_away = complete_lineup(lineup_map.get(game_pk), audit)
            if current_home is not None: prior_lineup[home_team] = current_home
            if current_away is not None: prior_lineup[away_team] = current_away

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
    parser.add_argument('--root', required=True); parser.add_argument('--contract', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args()
    contract = load(args.contract)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v33-pitcher-walks-baseline-contract.v1':
        raise SystemExit('V33_CONTRACT_SCHEMA_INVALID')
    seasons = [contract['dataBoundary']['modelFitSeason'], contract['dataBoundary']['validationSeason'], *contract['dataBoundary']['retrospectiveEvaluationSeasons']]
    records, custody = [], {}
    for season in seasons:
        rows, c = build_season_rows(args.root, season, contract); records.extend(rows); custody[season] = c
    frame = pd.DataFrame.from_records(records)
    features = tuple(contract['features']['exactly'])
    train = frame[frame['season']=='2022'].copy(); validation = frame[frame['season']=='2023'].copy(); evaluation = frame[frame['season'].isin(['2024','2025','2026_YTD'])].copy()
    imputer = SimpleImputer(strategy='median'); scaler = StandardScaler()
    X_train = scaler.fit_transform(imputer.fit_transform(train[list(features)])); y_train = train['walks'].to_numpy(float)
    cfg = contract['model']; model = PoissonRegressor(alpha=float(cfg['poissonAlpha']), max_iter=int(cfg['maxIter'])); model.fit(X_train, y_train)
    train_mu = np.maximum(model.predict(X_train),1e-9); dispersion = nb2_dispersion(y_train, train_mu); train_mean = float(np.mean(y_train))
    lines=[float(v) for v in cfg['fixedHalfRunLines']]; line_probs={line:float(np.mean(y_train>line)) for line in lines}
    v=evaluate(validation,features,imputer,scaler,model,dispersion,train_mean,line_probs,lines); e=evaluate(evaluation,features,imputer,scaler,model,dispersion,train_mean,line_probs,lines)
    by={s:evaluate(frame[frame['season']==s].copy(),features,imputer,scaler,model,dispersion,train_mean,line_probs,lines) for s in ['2023','2024','2025','2026_YTD']}
    checks={
      'validationDevianceBeatsConstant':v['modelVsConstantDevianceImprovement']>0,'validationDevianceBeatsPitcherOnly':v['modelVsPitcherOnlyDevianceImprovement']>0,
      'validationBrierBeatsConstant':v['modelVsConstantAverageBrierImprovement']>0,'validationBrierBeatsPitcherOnly':v['modelVsPitcherOnlyAverageBrierImprovement']>0,
      'evaluationDevianceBeatsConstant':e['modelVsConstantDevianceImprovement']>0,'evaluationDevianceBeatsPitcherOnly':e['modelVsPitcherOnlyDevianceImprovement']>0,
      'evaluationBrierBeatsConstant':e['modelVsConstantAverageBrierImprovement']>0,'evaluationBrierBeatsPitcherOnly':e['modelVsPitcherOnlyAverageBrierImprovement']>0}
    passed=all(checks.values()); classification='PITCHER_WALKS_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'PITCHER_WALKS_BASELINE_REJECTED'
    total_slots=sum(c['canonicalStarterSlots'] for c in custody.values()); counts=Counter(frame['officialDate'])
    report={
      'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,
      'data':{'scoredRows':int(len(frame)),'custodyBySeason':custody,'featureCount':len(features),'features':list(features),'sameDateHistoryAllowed':False,'seasonHistoryReset':True},
      'model':{'providerMarketKey':'pitcher_walks','canonicalResearchMarketType':'PITCHER_WALKS','trainingSeason':'2022','trainingRows':int(len(train)),'trainingMeanWalks':train_mean,'poissonAlpha':1.0,'maxIter':1000,'nb2Dispersion':float(dispersion),'fixedHalfRunLines':lines,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'coefficientsDescriptiveNotSelectionInput':{features[i]:float(model.coef_[i]) for i in range(len(features))}},
      'baselines':{'constantMeanWalks':train_mean,'pitcherOnlyFormula':contract['baselines']['pitcherOnlyMechanistic'],'sharedTrainingOnlyNb2Dispersion':float(dispersion),'constantFixedLineOverProbabilities':{str(k):v for k,v in line_probs.items()}},
      'validation2023':v,'evaluation2024_2026Ytd':e,'bySeasonDescriptiveOnly':by,'candidateRubricChecks':checks,
      'volumeDiagnostics':{'eligibleSlateDays':len(counts),'eligiblePitcherStarts':int(len(frame)),'canonicalStarterSlots':int(total_slots),'eligibilityShare':len(frame)/total_slots,'meanEligiblePitcherStartsPerSlateDay':float(np.mean(list(counts.values()))),'medianEligiblePitcherStartsPerSlateDay':float(np.median(list(counts.values()))),'note':'Eligible starts are research observations, not bet candidates.'},
      'marketBoundary':{'providerMarketKey':'pitcher_walks','repositoryRegistryFamily':'PITCHER_PROP','hardRockFloridaPerEventAvailabilityEstablished':False,'productionRegistryChanged':False,'historicalPitcherWalkPricesUsed':False,'positiveEvEstablished':False,'priceCaptureAuthorized':False,'productionPromotionAuthorized':False},
      'policy':{'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'thresholdSearchUsed':False,'subsetMiningUsed':False,'postResultRuleChangeUsed':False,'productionMarketRegistryChanged':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(args.out,report)
    print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'validation2023':v,'evaluation2024_2026Ytd':e,'bySeason':by,'candidateRubricChecks':checks,'volumeDiagnostics':report['volumeDiagnostics']},indent=2))

if __name__=='__main__': main()
