#!/usr/bin/env python3
import argparse
import gzip
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import gammaln
from scipy.stats import poisson, nbinom

SEASONS = ('2022', '2023', '2024', '2025', '2026_YTD')
EVAL = ('2024', '2025', '2026_YTD')
EXPECTED = {'2022': 2398, '2023': 2399, '2024': 2406, '2025': 2423, '2026_YTD': 1781}
PARITY_TOL = 1e-12


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def load_custody(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    rows = []
    with opener(path, 'rt', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    counts = {s: sum(r.get('season') == s for r in rows) for s in SEASONS}
    if counts != EXPECTED:
        raise SystemExit(f'V67_CUSTODY_ROWS_DRIFT:{counts}')
    if len({(r['season'], int(r['gamePk'])) for r in rows}) != len(rows):
        raise SystemExit('V67_CUSTODY_DUPLICATE_GAME')
    return rows


def attach_f5(custody, path):
    payload = load(path)
    if payload.get('schemaVersion') != 'courtedge-p0-step12v28-f5-outcomes.v1':
        raise SystemExit('V67_F5_OUTCOME_SCHEMA_INVALID')
    if float((payload.get('acquisition') or {}).get('coverageShare', 0.0)) < 0.995:
        raise SystemExit('V67_F5_OUTCOME_COVERAGE_LOW')
    by = {(r['season'], int(r['gamePk'])): r for r in payload.get('rows', [])}
    if len(by) != len(payload.get('rows', [])):
        raise SystemExit('V67_F5_OUTCOME_DUPLICATE')
    rows, misses = [], []
    for r in custody:
        key = (r['season'], int(r['gamePk']))
        x = by.get(key)
        if x is None:
            misses.append(key)
            continue
        if str(x['officialDate']) != str(r['officialDate']) or int(x['homeTeamId']) != int(r['homeTeamId']) or int(x['awayTeamId']) != int(r['awayTeamId']):
            raise SystemExit(f'V67_F5_OUTCOME_IDENTITY_MISMATCH:{key}')
        z = dict(r); z['_totalRuns'] = int(x['totalRuns']); rows.append(z)
    coverage = len(rows) / len(custody)
    if coverage < 0.995:
        raise SystemExit(f'V67_F5_JOIN_COVERAGE_LOW:{coverage}')
    return rows, {'custodyRows': len(custody), 'joinedRows': len(rows), 'coverageShare': coverage, 'unresolvedKeys': [{'season': s, 'gamePk': g} for s, g in misses]}


def attach_fg(custody, root):
    maps = {}
    for season in SEASONS:
        payload = load(os.path.join(root, season, 'game-anatomy-feature-table.json'))
        if payload.get('schemaVersion') != 'courtedge-p0-step12v-game-anatomy-feature-table.v1':
            raise SystemExit(f'V67_FG_OUTCOME_SCHEMA_INVALID:{season}')
        rows = payload.get('rows', [])
        maps[season] = {int(r['gamePk']): r for r in rows}
        if len(maps[season]) != len(rows):
            raise SystemExit(f'V67_FG_OUTCOME_DUPLICATE:{season}')
    out = []
    for r in custody:
        x = maps[r['season']].get(int(r['gamePk']))
        if x is None:
            raise SystemExit(f'V67_FG_OUTCOME_MISSING:{r["season"]}:{r["gamePk"]}')
        if str(x['officialDate']) != str(r['officialDate']) or int(x['homeTeamId']) != int(r['homeTeamId']) or int(x['awayTeamId']) != int(r['awayTeamId']):
            raise SystemExit(f'V67_FG_OUTCOME_IDENTITY_MISMATCH:{r["gamePk"]}')
        o = (x.get('outcomes') or {}).get('FULL_GAME')
        if not o or not isinstance(o.get('totalRuns'), int) or int(o['totalRuns']) < 0:
            raise SystemExit(f'V67_FG_OUTCOME_INVALID:{r["gamePk"]}')
        if int(o['homeRuns']) + int(o['awayRuns']) != int(o['totalRuns']):
            raise SystemExit(f'V67_FG_OUTCOME_ARITHMETIC_INVALID:{r["gamePk"]}')
        z = dict(r); z['_totalRuns'] = int(o['totalRuns']); out.append(z)
    return out, {'custodyRows': len(custody), 'joinedRows': len(out), 'coverageShare': len(out) / len(custody)}


def transform(rows, p):
    X = np.empty((len(rows), len(p['features'])), dtype=float)
    for j, (feature, median, mean, scale) in enumerate(zip(p['features'], p['medianImpute'], p['mean'], p['scale'])):
        X[:, j] = [((float(r[feature]) if finite(r.get(feature)) else float(median)) - float(mean)) / float(scale) for r in rows]
    return X


def frozen_mu(model, rows):
    X = transform(rows, model['preprocessor'])
    eta = float(model['intercept']) + X @ np.asarray(model['coefficients'], dtype=float)
    mu = np.exp(eta)
    if not np.all(np.isfinite(mu)) or np.any(mu <= 0):
        raise SystemExit('V67_FROZEN_V66_MU_INVALID')
    return mu


def poisson_deviance_loss(y, mu):
    y = np.asarray(y, dtype=float); mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    term = np.zeros_like(y); mask = y > 0
    term[mask] = y[mask] * np.log(y[mask] / mu[mask])
    return 2.0 * (term - (y - mu))


def poisson_nll_loss(y, mu):
    return -poisson.logpmf(np.asarray(y, dtype=int), np.asarray(mu, dtype=float))


def nb2_logpmf(y, mu, alpha):
    y = np.asarray(y, dtype=float); mu = np.asarray(mu, dtype=float)
    a = float(alpha)
    if not math.isfinite(a) or a <= 0:
        return np.full(len(y), -np.inf)
    size = 1.0 / a
    p = size / (size + mu)
    return gammaln(y + size) - gammaln(size) - gammaln(y + 1.0) + size * np.log(p) + y * np.log1p(-p)


def nb2_nll_loss(y, mu, alpha):
    return -nb2_logpmf(y, mu, alpha)


def fit_alpha_2022(rows, model, bounds):
    train = [r for r in rows if r['season'] == '2022']
    y = np.asarray([int(r['_totalRuns']) for r in train], dtype=int)
    mu = frozen_mu(model, train)
    lo, hi = float(bounds[0]), float(bounds[1])
    def objective(log_alpha):
        alpha = math.exp(float(log_alpha))
        losses = nb2_nll_loss(y, mu, alpha)
        if not np.all(np.isfinite(losses)):
            return 1e100
        return float(np.mean(losses))
    result = minimize_scalar(objective, method='bounded', bounds=(lo, hi), options={'xatol': 1e-12, 'maxiter': 2000})
    if not result.success or not math.isfinite(float(result.x)):
        raise SystemExit(f'V67_ALPHA_FIT_FAILED:{result.message}')
    alpha = math.exp(float(result.x))
    return {
        'alpha': alpha,
        'logAlpha': float(result.x),
        'trainingRows': len(train),
        'trainingMeanRuns': float(np.mean(y)),
        'trainingVarianceRunsPopulation': float(np.var(y)),
        'trainingVarianceToMeanRatio': float(np.var(y) / np.mean(y)),
        'trainingPoissonMeanNll': float(np.mean(poisson_nll_loss(y, mu))),
        'trainingNb2MeanNll': float(np.mean(nb2_nll_loss(y, mu, alpha))),
        'trainingNllImprovementVsPoisson': float(np.mean(poisson_nll_loss(y, mu) - nb2_nll_loss(y, mu, alpha))),
        'optimizer': 'SCIPY_MINIMIZE_SCALAR_BOUNDED_LOG_ALPHA',
        'logAlphaBounds': [lo, hi],
        'meanEngineRefit': False,
    }


def poisson_line_losses(y, mu, lines):
    y = np.asarray(y, dtype=float); mu = np.asarray(mu, dtype=float)
    losses = []
    for line in lines:
        observed = (y > line).astype(float)
        prob = poisson.sf(math.floor(float(line)), mu)
        losses.append((prob - observed) ** 2)
    return np.mean(np.vstack(losses), axis=0)


def nb2_line_losses(y, mu, alpha, lines):
    y = np.asarray(y, dtype=float); mu = np.asarray(mu, dtype=float)
    size = 1.0 / float(alpha); p = size / (size + mu)
    losses = []
    for line in lines:
        observed = (y > line).astype(float)
        prob = nbinom.sf(math.floor(float(line)), size, p)
        losses.append((prob - observed) ** 2)
    return np.mean(np.vstack(losses), axis=0)


def climatology_line_losses(y, line_probs, lines):
    y = np.asarray(y, dtype=float); losses = []
    for line in lines:
        observed = (y > line).astype(float)
        losses.append((float(line_probs[str(line)]) - observed) ** 2)
    return np.mean(np.vstack(losses), axis=0)


def evaluate(rows, model, alpha, baseline, lines):
    y = np.asarray([int(r['_totalRuns']) for r in rows], dtype=int)
    mu = frozen_mu(model, rows)
    clim = climatology_line_losses(y, baseline['lineOverProbabilities'], lines)
    pois_b = poisson_line_losses(y, mu, lines)
    nb_b = nb2_line_losses(y, mu, alpha, lines)
    pois_nll = poisson_nll_loss(y, mu); nb_nll = nb2_nll_loss(y, mu, alpha)
    pois_dev = poisson_deviance_loss(y, mu)
    line_diag = {}
    size = 1.0 / alpha; p = size / (size + mu)
    for line in lines:
        observed = (y > line).astype(float)
        pp = poisson.sf(math.floor(line), mu)
        npb = nbinom.sf(math.floor(line), size, p)
        cp = float(baseline['lineOverProbabilities'][str(line)])
        line_diag[str(line)] = {
            'observedOverRate': float(np.mean(observed)),
            'climatologyOverProbability': cp,
            'meanV66PoissonOverProbability': float(np.mean(pp)),
            'meanNb2OverProbability': float(np.mean(npb)),
            'climatologyBrier': float(np.mean((cp-observed)**2)),
            'v66PoissonBrier': float(np.mean((pp-observed)**2)),
            'nb2Brier': float(np.mean((npb-observed)**2)),
        }
    return {
        'n': len(rows),
        'observedMeanRuns': float(np.mean(y)),
        'meanFrozenV66Mu': float(np.mean(mu)),
        'v66MeanPoissonDeviance': float(np.mean(pois_dev)),
        'climatologyAverageFixedLineBrier': float(np.mean(clim)),
        'v66PoissonAverageFixedLineBrier': float(np.mean(pois_b)),
        'nb2AverageFixedLineBrier': float(np.mean(nb_b)),
        'nb2BrierImprovementVsClimatology': float(np.mean(clim - nb_b)),
        'nb2BrierImprovementVsV66Poisson': float(np.mean(pois_b - nb_b)),
        'v66PoissonMeanCountNll': float(np.mean(pois_nll)),
        'nb2MeanCountNll': float(np.mean(nb_nll)),
        'nb2CountNllImprovementVsV66Poisson': float(np.mean(pois_nll - nb_nll)),
        'fixedLineDiagnostics': line_diag,
    }


def verify_v66_parity(route_name, rows, v66_route, lines):
    model = v66_route['primaryCandidate']['model']
    baseline = v66_route['formalBaseline']
    checks = {}
    for season in ('2023',) + EVAL:
        rs = [r for r in rows if r['season'] == season]
        y = np.asarray([int(r['_totalRuns']) for r in rs], dtype=int)
        mu = frozen_mu(model, rs)
        dev = float(np.mean(poisson_deviance_loss(y, mu)))
        brier = float(np.mean(poisson_line_losses(y, mu, lines)))
        prior = v66_route['bySeason'][season]
        ddev = abs(dev - float(prior['meanPoissonDeviance']))
        db = abs(brier - float(prior['averageFixedLineBrier']))
        if ddev > PARITY_TOL or db > PARITY_TOL:
            raise SystemExit(f'V67_V66_PARITY_FAILED:{route_name}:{season}:dev={ddev}:brier={db}')
        checks[season] = {'meanPoissonDevianceAbsoluteDelta': ddev, 'averageFixedLineBrierAbsoluteDelta': db}
    rs = [r for r in rows if r['season'] in EVAL]
    y = np.asarray([int(r['_totalRuns']) for r in rs], dtype=int); mu = frozen_mu(model, rs)
    dev = float(np.mean(poisson_deviance_loss(y, mu))); brier = float(np.mean(poisson_line_losses(y, mu, lines)))
    prior = v66_route['combinedEvaluation']; ddev = abs(dev-float(prior['meanPoissonDeviance'])); db=abs(brier-float(prior['averageFixedLineBrier']))
    if ddev > PARITY_TOL or db > PARITY_TOL:
        raise SystemExit(f'V67_V66_PARITY_FAILED:{route_name}:combined:dev={ddev}:brier={db}')
    checks['combined'] = {'meanPoissonDevianceAbsoluteDelta': ddev, 'averageFixedLineBrierAbsoluteDelta': db}
    return checks


def bootstrap(rows, model, alpha, baseline, lines, resamples=5000, seed=20260817):
    y = np.asarray([int(r['_totalRuns']) for r in rows], dtype=int); mu = frozen_mu(model, rows)
    clim = climatology_line_losses(y, baseline['lineOverProbabilities'], lines)
    pois_b = poisson_line_losses(y, mu, lines); nb_b = nb2_line_losses(y, mu, alpha, lines)
    pois_nll = poisson_nll_loss(y, mu); nb_nll = nb2_nll_loss(y, mu, alpha)
    d1 = clim - nb_b; d2 = pois_b - nb_b; d3 = pois_nll - nb_nll
    groups = defaultdict(list)
    for i,r in enumerate(rows): groups[str(r['officialDate'])].append(i)
    keys = sorted(groups); agg=[]
    for key in keys:
        idx=np.asarray(groups[key],dtype=int); agg.append((float(d1[idx].sum()),float(d2[idx].sum()),float(d3[idx].sum()),len(idx)))
    a=np.asarray(agg,dtype=float); rng=np.random.default_rng(seed); boot=np.empty((resamples,3),dtype=float)
    for b in range(resamples):
        picked=rng.integers(0,len(keys),size=len(keys)); x=a[picked]; n=x[:,3].sum(); boot[b]=x[:,:3].sum(axis=0)/n
    def pack(point, col): return {'pointEstimate':float(point),'ci95':[float(np.quantile(boot[:,col],.025)),float(np.quantile(boot[:,col],.975))]}
    return {'unit':'OFFICIAL_DATE_CLUSTER','distinctDates':len(keys),'resamples':resamples,'seed':seed,
            'brierImprovementVsClimatology':pack(np.mean(d1),0),'brierImprovementVsV66Poisson':pack(np.mean(d2),1),'countNllImprovementVsV66Poisson':pack(np.mean(d3),2)}


def score(route_key, rows, v66_route, contract, lines):
    model=v66_route['primaryCandidate']['model']; baseline=v66_route['formalBaseline']
    parity=verify_v66_parity(route_key, rows, v66_route, lines)
    fit=fit_alpha_2022(rows, model, contract['candidateDistribution']['logAlphaBoundsExactly']); alpha=fit['alpha']
    by={s:evaluate([r for r in rows if r['season']==s],model,alpha,baseline,lines) for s in ('2023',)+EVAL}
    combined_rows=[r for r in rows if r['season'] in EVAL]; combined=evaluate(combined_rows,model,alpha,baseline,lines)
    boot=bootstrap(combined_rows,model,alpha,baseline,lines,5000,20260817)
    seasons_both=sum(by[s]['nb2BrierImprovementVsClimatology']>0 and by[s]['nb2BrierImprovementVsV66Poisson']>0 for s in EVAL)
    any_worse_both=any(by[s]['nb2BrierImprovementVsClimatology']<0 and by[s]['nb2BrierImprovementVsV66Poisson']<0 for s in EVAL)
    checks={
        '2023BrierImprovementVsClimatologyPositive':by['2023']['nb2BrierImprovementVsClimatology']>0,
        '2023BrierImprovementVsV66PoissonPositive':by['2023']['nb2BrierImprovementVsV66Poisson']>0,
        '2023CountNllImprovementVsV66PoissonPositive':by['2023']['nb2CountNllImprovementVsV66Poisson']>0,
        'combinedBrierImprovementVsClimatologyPositive':combined['nb2BrierImprovementVsClimatology']>0,
        'combinedBrierImprovementVsV66PoissonPositive':combined['nb2BrierImprovementVsV66Poisson']>0,
        'combinedCountNllImprovementVsV66PoissonPositive':combined['nb2CountNllImprovementVsV66Poisson']>0,
        'bootstrapBrierVsClimatology95CiLowerBoundPositive':boot['brierImprovementVsClimatology']['ci95'][0]>0,
        'bootstrapBrierVsPoisson95CiLowerBoundPositive':boot['brierImprovementVsV66Poisson']['ci95'][0]>0,
        'bootstrapCountNllVsPoisson95CiLowerBoundPositive':boot['countNllImprovementVsV66Poisson']['ci95'][0]>0,
        'atLeastTwoOfThreeEvaluationSeasonsBrierImprovesVsBothComparators':seasons_both>=2,
        'noEvaluationSeasonBrierWorseVsBothComparators':not any_worse_both,
    }
    passed=all(checks.values())
    passing=contract['promotionRubric']['passingClassifications'][route_key]
    classification=passing if passed else f'{route_key}_NOT_ROBUST_ENOUGH_TO_ADVANCE'
    return {'route':route_key,'classification':classification,'passed':passed,'frozenV66MeanEngineParity':parity,'dispersionFit2022':fit,'bySeason':by,'combinedEvaluation':combined,'pairedBootstrap':boot,'promotionChecks':checks}


def main():
    p=argparse.ArgumentParser(); p.add_argument('--custody',required=True); p.add_argument('--v66-report',required=True); p.add_argument('--f5-outcomes',required=True); p.add_argument('--fullgame-root',required=True); p.add_argument('--contract',required=True); p.add_argument('--out',required=True); a=p.parse_args()
    c=load(a.contract); v66=load(a.v66_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v67-total-distribution-calibration-contract.v1' or c.get('scientificStatus')!='FROZEN_BEFORE_ANY_V67_OUTCOME_SCORER_EXISTS': raise SystemExit('V67_CONTRACT_INVALID')
    if v66.get('schemaVersion')!='courtedge-p0-step12v66-totals-score.v1': raise SystemExit('V67_V66_REPORT_INVALID')
    custody=load_custody(a.custody); f5,f5join=attach_f5(custody,a.f5_outcomes); fg,fgjoin=attach_fg(custody,a.fullgame_root)
    if fgjoin['coverageShare']!=1.0: raise SystemExit('V67_FG_JOIN_NOT_EXACT')
    vf=v66['routes']['V66_D_F5_TOTAL']; vg=v66['routes']['V66_E_FULL_GAME_TOTAL']
    if vf['primaryCandidate']['model']['features']!=c['frozenMeanEngine']['F5FeatureSetExactly']: raise SystemExit('V67_F5_MEAN_FEATURE_DRIFT')
    if vg['primaryCandidate']['model']['features']!=c['frozenMeanEngine']['FULL_GAMEFeatureSetExactly']: raise SystemExit('V67_FG_MEAN_FEATURE_DRIFT')
    routes={
        'V67_A_F5_TOTAL_NB2':score('V67_A_F5_TOTAL_NB2',f5,vf,c,[2.5,3.5,4.5,5.5,6.5]),
        'V67_B_FULL_GAME_TOTAL_NB2':score('V67_B_FULL_GAME_TOTAL_NB2',fg,vg,c,[6.5,7.5,8.5,9.5,10.5]),
    }
    report={'schemaVersion':'courtedge-p0-step12v67-total-distribution-calibration-score.v1','scientificStatus':'OUTCOME_SCORING_COMPLETED_WITH_FROZEN_V66_MEAN_AND_PREDECLARED_NB2_DISTRIBUTION','joins':{'F5':f5join,'FULL_GAME':fgjoin},'routes':routes,'policy':{'researchOnly':True,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'positiveEvEstablished':False,'v16ProductionChanged':False,'routingChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(a.out,report)
    print(json.dumps({k:{'classification':v['classification'],'passed':v['passed'],'alpha':v['dispersionFit2022']['alpha'],'trainingVarianceToMeanRatio':v['dispersionFit2022']['trainingVarianceToMeanRatio'],'validation2023':{m:v['bySeason']['2023'][m] for m in ('nb2BrierImprovementVsClimatology','nb2BrierImprovementVsV66Poisson','nb2CountNllImprovementVsV66Poisson')},'combined':{m:v['combinedEvaluation'][m] for m in ('nb2BrierImprovementVsClimatology','nb2BrierImprovementVsV66Poisson','nb2CountNllImprovementVsV66Poisson')},'bySeason':{s:{m:v['bySeason'][s][m] for m in ('nb2BrierImprovementVsClimatology','nb2BrierImprovementVsV66Poisson')} for s in EVAL},'bootstrap':v['pairedBootstrap'],'checks':v['promotionChecks']} for k,v in routes.items()},indent=2))


if __name__=='__main__': main()
